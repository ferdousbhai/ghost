import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OWNED_PROCESS_MAX_STDOUT_BYTES = 128 * 1024;
export const OWNED_PROCESS_TERM_GRACE_MS = 100;
export const OWNED_PROCESS_KILL_CONFIRM_MS = 1_000;

export interface OwnedCommandResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedCommandOptions {
  environment: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
  start?: (input: OwnedCommandInput) => void;
  onStdout?: (stdout: string, input: OwnedCommandInput) => void;
  scratchPrefix?: string;
  maxStdoutBytes?: number;
}

export interface OwnedCommandInput {
  write(value: string): void;
  end(value?: string): void;
}

export class OwnedProcessError extends Error {
  readonly _tag = "OwnedProcessError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwnedProcessError";
  }
}

function linuxProcessGroupHasLiveMembers(pid: number): boolean {
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let statLine: string;
    try {
      statLine = readFileSync(`/proc/${entry.name}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
    const commandEnd = statLine.lastIndexOf(")");
    const fields = commandEnd < 0 ? [] : statLine.slice(commandEnd + 2).split(" ");
    const state = fields[0];
    const processGroup = Number(fields[2]);
    if (processGroup === pid && state !== "Z" && state !== "X") return true;
  }
  return false;
}

export function ownedProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
  return process.platform === "linux" ? linuxProcessGroupHasLiveMembers(pid) : true;
}

function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function waitForOwnedProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ownedProcessGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return true;
}

export async function terminateOwnedProcessGroup(
  pid: number,
  termGraceMs = OWNED_PROCESS_TERM_GRACE_MS,
  killConfirmMs = OWNED_PROCESS_KILL_CONFIRM_MS,
): Promise<void> {
  if (!ownedProcessGroupExists(pid)) return;
  signalOwnedProcessGroup(pid, "SIGTERM");
  if (await waitForOwnedProcessGroupExit(pid, termGraceMs)) return;
  signalOwnedProcessGroup(pid, "SIGKILL");
  if (await waitForOwnedProcessGroupExit(pid, killConfirmMs)) return;
  throw new OwnedProcessError("Owned process-group teardown was not confirmed.");
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number.`);
  }
  return value;
}

/**
 * Run one probe in a private scratch cwd and own its complete Linux process
 * group. Output and failures are deliberately bounded and never include argv,
 * paths, child output, or environment values.
 */
export async function runOwnedCommand(
  executable: string,
  args: readonly string[],
  options: OwnedCommandOptions,
): Promise<OwnedCommandResult> {
  positiveFinite(options.timeoutMs, "Owned command timeout");
  const maxStdoutBytes = positiveFinite(
    options.maxStdoutBytes ?? OWNED_PROCESS_MAX_STDOUT_BYTES,
    "Owned command stdout limit",
  );
  const scratchPrefix = options.scratchPrefix ?? "ghost-native-probe-";
  if (!/^ghost-[a-z0-9-]+-$/u.test(scratchPrefix)) {
    throw new RangeError("Owned command scratch prefix is invalid.");
  }
  const scratch = await mkdtemp(join(tmpdir(), scratchPrefix));
  await chmod(scratch, 0o700);
  try {
    return await runOwnedCommandInDirectory(executable, args, options, scratch, maxStdoutBytes);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runOwnedCommandInDirectory(
  executable: string,
  args: readonly string[],
  options: OwnedCommandOptions,
  cwd: string,
  maxStdoutBytes: number,
): Promise<OwnedCommandResult> {
  if (options.stdin !== undefined && options.start) {
    throw new TypeError("Owned command accepts either fixed or interactive stdin, not both.");
  }
  if (options.signal?.aborted) throw new OwnedProcessError("Owned probe was aborted.");
  const hasInput = options.stdin !== undefined || options.start !== undefined;
  const child = spawn(executable, [...args], {
    cwd,
    detached: process.platform === "linux",
    env: options.environment,
    stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const chunks: Buffer[] = [];
  let stdoutBytes = 0;
  child.stderr?.resume();

  type Completion =
    | { kind: "close"; exitCode: number | null; signal: NodeJS.Signals | null }
    | { kind: "abort" | "error" | "overflow" | "timeout" };
  let settleCompletion!: (completion: Completion) => void;
  let completionRequested = false;
  const completion = new Promise<Completion>((resolveCompletion) => {
    settleCompletion = resolveCompletion;
  });
  const complete = (value: Completion) => {
    if (completionRequested) return;
    completionRequested = true;
    settleCompletion(value);
  };
  const input: OwnedCommandInput = {
    write: (value) => {
      if (!child.stdin?.writable) throw new OwnedProcessError("Owned probe input is closed.");
      child.stdin.write(value);
    },
    end: (value) => {
      if (!child.stdin?.writable) throw new OwnedProcessError("Owned probe input is closed.");
      child.stdin.end(value);
    },
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (completionRequested) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += bytes.length;
    if (stdoutBytes > maxStdoutBytes) {
      complete({ kind: "overflow" });
      return;
    }
    chunks.push(bytes);
    if (options.onStdout) {
      try {
        options.onStdout(Buffer.concat(chunks, stdoutBytes).toString("utf8"), input);
      } catch {
        complete({ kind: "error" });
      }
    }
  });
  child.once("error", () => complete({ kind: "error" }));
  child.once("close", (exitCode, signal) => {
    complete({ kind: "close", exitCode, signal });
  });
  const onAbort = () => complete({ kind: "abort" });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.stdin !== undefined) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin);
  } else if (options.start) {
    child.stdin?.on("error", () => undefined);
    try {
      options.start(input);
    } catch {
      complete({ kind: "error" });
    }
  }
  const deadline = setTimeout(() => complete({ kind: "timeout" }), options.timeoutMs);

  const outcome = await completion;
  clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  try {
    if (pid !== undefined) {
      if (process.platform === "linux") await terminateOwnedProcessGroup(pid);
      else if (!child.killed) child.kill("SIGKILL");
    }
  } finally {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  if (outcome.kind !== "close") {
    const reason = outcome.kind === "abort"
      ? "was aborted"
      : outcome.kind === "overflow"
        ? "produced too much output"
        : outcome.kind === "timeout" ? "exceeded its hard deadline" : "could not start";
    throw new OwnedProcessError(`Owned probe ${reason}.`);
  }
  return {
    stdout: Buffer.concat(chunks, stdoutBytes).toString("utf8"),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  };
}
