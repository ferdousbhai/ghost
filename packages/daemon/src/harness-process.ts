/**
 * One headless harness turn as a child process: spawned in its own process
 * group in the conversation directory, its stdout parsed line by line into
 * normalized events, and the whole group ended on abort. ghostd kills only
 * the group it spawned.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessEvent, HarnessLaunch } from "./harness-table.js";

/** How long a harness gets to exit after SIGTERM before the group is killed. */
const KILL_GRACE_MS = 3_000;
/** The stderr kept for an error message and limit classification. */
const STDERR_TAIL_BYTES = 8_192;
/** How long output may keep arriving after a harness or hook process itself exits. */
const PIPE_DRAIN_MS = 2_000;

export interface HarnessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last bytes of stderr, for a failure that printed no event. */
  readonly stderr: string;
  /** The process could not start (not installed, not executable). */
  readonly spawnError?: string;
}

interface HarnessProcessOptions {
  readonly launch: HarnessLaunch;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  /** Written to the process's stdin, which is then closed; omitted, stdin is /dev/null. */
  readonly stdin?: string;
}

/** Harness protocols are JSONL; owner shell output is streamed as raw chunks. */
export type HarnessRunOptions = HarnessProcessOptions & (
  | { readonly parse: (line: string) => HarnessEvent[]; readonly onEvent: (event: HarnessEvent) => void; readonly onStdout?: never }
  | { readonly onStdout: (chunk: string) => void; readonly parse?: never; readonly onEvent?: never }
);

/** Write the launch's files into the conversation directory. */
export async function writeLaunchFiles(cwd: string, files: Readonly<Record<string, string>> | undefined): Promise<void> {
  for (const [relative, content] of Object.entries(files ?? {})) {
    const path = join(cwd, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
  }
}

export function runHarness(options: HarnessRunOptions): Promise<HarnessExit> {
  const [command, ...args] = options.launch.argv;
  if (command === undefined) return Promise.resolve({ code: null, signal: null, stderr: "", spawnError: "empty command" });
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (exit: HarnessExit): void => {
      if (settled) return;
      settled = true;
      if (options.signal.aborted) signalGroup("SIGKILL");
      if (drainTimer) clearTimeout(drainTimer);
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      options.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      resolve(exit);
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...options.env, ...options.launch.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    // A process may exit without reading its stdin; its exit still decides.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const abort = (): void => {
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });

    let pending = "";
    const feed = (line: string): void => {
      if (settled || !options.parse || !options.onEvent || line.trim() === "") return;
      for (const event of options.parse(line)) options.onEvent(event);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      if (options.onStdout) { options.onStdout(chunk); return; }
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        feed(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => finish({ code: null, signal: null, stderr, spawnError: error.message }));
    // A detached descendant may keep the pipes open after the harness exits;
    // the turn ends with the harness, not with its grandchildren.
    const close = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      feed(pending);
      pending = "";
      finish({ code, signal, stderr });
    };
    child.on("exit", (code, signal) => {
      if (settled) return;
      drainTimer = setTimeout(() => close(code, signal), PIPE_DRAIN_MS);
      drainTimer.unref();
    });
    child.on("close", close);
  });
}
