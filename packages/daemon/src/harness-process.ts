/**
 * One headless harness turn as a child process: spawned in its own process
 * group in the conversation directory, its stdout parsed line by line into
 * normalized events, and the whole group ended on abort. ghostd kills only
 * the group it spawned.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessEvent, HarnessLaunch } from "./harness-table.js";

/** How long a harness gets to exit after SIGTERM before the group is killed. */
const KILL_GRACE_MS = 3_000;
/** The stderr kept for an error message and limit classification. */
const STDERR_TAIL_BYTES = 8_192;
/** How long output may keep arriving after the harness itself exits. */
const PIPE_DRAIN_MS = 2_000;

export interface HarnessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last bytes of stderr, for a failure that printed no event. */
  readonly stderr: string;
  /** The process could not start (not installed, not executable). */
  readonly spawnError?: string;
}

export interface HarnessRunOptions {
  readonly launch: HarnessLaunch;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly parse: (line: string) => HarnessEvent[];
  readonly onEvent: (event: HarnessEvent) => void;
  readonly signal: AbortSignal;
}

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
    const finish = (exit: HarnessExit): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      resolve(exit);
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...options.env, ...options.launch.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
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
      if (line.trim() === "") return;
      for (const event of options.parse(line)) options.onEvent(event);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
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
      setTimeout(() => close(code, signal), PIPE_DRAIN_MS).unref();
    });
    child.on("close", close);
  });
}
