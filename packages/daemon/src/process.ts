/**
 * A command as a child process (an owner's `!command`, a hook): spawned in
 * its own process group, its stdout handed on as it arrives, and the whole
 * group ended on abort. ghostd kills only the group it spawned.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** How long a command gets to exit after SIGTERM before the group is killed. */
const KILL_GRACE_MS = 3_000;
/** The stderr kept for an error message. */
const STDERR_TAIL_BYTES = 8_192;
/** How long output may keep arriving after the process itself exits. */
const PIPE_DRAIN_MS = 2_000;

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last bytes of stderr. */
  readonly stderr: string;
  /** The process could not start (not installed, not executable). */
  readonly spawnError?: string;
}

interface ProcessOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  /** Written to the process's stdin, which is then closed; omitted, stdin is /dev/null. */
  readonly stdin?: string;
  readonly onStdout: (chunk: string) => void;
}

export function runProcess(options: ProcessOptions): Promise<ProcessExit> {
  const [command, ...args] = options.argv;
  if (command === undefined) return Promise.resolve({ code: null, signal: null, stderr: "", spawnError: "empty command" });
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (exit: ProcessExit): void => {
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
      env: options.env,
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

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!settled) options.onStdout(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => finish({ code: null, signal: null, stderr, spawnError: error.message }));
    // A detached descendant may keep the pipes open after the command exits;
    // it ends with the command, not with its grandchildren.
    const close = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!settled) finish({ code, signal, stderr });
    };
    child.on("exit", (code, signal) => {
      if (settled) return;
      drainTimer = setTimeout(() => close(code, signal), PIPE_DRAIN_MS);
      drainTimer.unref();
    });
    child.on("close", close);
  });
}
