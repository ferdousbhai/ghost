import { execFile, spawn } from "node:child_process";
import { constants } from "node:os";
import { promisify } from "node:util";
import { appendHandoff, handoffLogPath, type HandoffOutcome, type HandoffReceipt } from "../handoffs.js";
import { readHarnessReport } from "../harnesses.js";
import { classifyLimitMessage } from "../pi-messages.js";
import type { ParsedCliArgs } from "./args.js";
import { CliError, EXIT_CODE } from "./client.js";
import type { CliContext } from "./types.js";

const exec = promisify(execFile);
/** Enough trailing output to find a harness's limit message. */
const TAIL_CHARS = 8192;
/**
 * After the harness exits, how long its pipes may sit idle before we stop
 * reading: a descendant can keep them open (pi's `waitForChildProcess` rule).
 */
const EXIT_IDLE_MS = 100;
const FORWARDED = ["SIGINT", "SIGTERM"] as const;

interface RunResult {
  exit: number | null;
  signal: NodeJS.Signals | null;
  tail: string;
}

/** Runs the harness in the foreground, streaming its output through unchanged. */
function run(id: string, args: string[], ctx: CliContext): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(id, args, { env: ctx.runtime.env, stdio: ["inherit", "pipe", "pipe"] });
    // An interrupted handoff stops the harness too, and is still recorded.
    const forward: NodeJS.SignalsListener = (signal) => {
      child.kill(signal);
    };
    let settled = false;
    let exited: Pick<RunResult, "exit" | "signal"> | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let tail = "";
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      // Bun's Process typings hide EventEmitter's off() for signal events.
      for (const signal of FORWARDED) (process as NodeJS.EventEmitter).off(signal, forward);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => exited && settle({ ...exited, tail }), EXIT_IDLE_MS);
    };
    const keep = (chunk: string) => {
      tail = (tail + chunk).slice(-TAIL_CHARS);
      if (exited) armIdle();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      ctx.runtime.stdout.write(chunk);
      keep(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      ctx.runtime.stderr.write(chunk);
      keep(chunk);
    });
    for (const signal of FORWARDED) process.on(signal, forward);
    // A launch failure is a failed run, like a shell's "command not found".
    child.on("error", (error) => {
      ctx.runtime.stderr.write(`ghost: cannot start ${id}: ${error.message}\n`);
      settle({ exit: 127, signal: null, tail });
    });
    child.on("exit", (exit, signal) => {
      exited = { exit, signal };
      armIdle();
    });
    child.on("close", (exit, signal) => settle({ exit, signal, tail }));
  });
}

/**
 * `ghost delegate <harness> -- <args>`: refresh the harness's usage, refuse it
 * without room, else run it here and exit with its status. Each attempt appends
 * one receipt to the handoff log.
 */
export async function delegateCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [id, ...args] = parsed.positionals as [string, ...string[]];
  const { env, home } = ctx.runtime;
  const started = Date.now();
  // Omarchy measures; a harness it has no collector for simply fails here.
  await exec("omarchy", ["agent", "usage", "update", "--limits-only", id], { env, timeout: 15_000 }).catch(() => {});
  const report = await readHarnessReport(env, home).catch((error: Error) => {
    throw new CliError(EXIT_CODE.failure, `cannot check harnesses: ${error.message}`);
  });
  const harness = report.harnesses.find((candidate) => candidate.id === id);
  // Evidence, not a gate: a log that cannot be written never hides what the
  // harness did or masks a refusal, it only leaves a warning.
  const record = (outcome: HandoffOutcome) => {
    const receipt: HandoffReceipt = {
      v: 1,
      at: new Date(started).toISOString(),
      ghost: env.GHOST?.trim() || null,
      session: env.GHOST_SESSION?.trim() || null,
      harness: id,
      cwd: process.cwd(),
      eligible: report.harnesses.filter((candidate) => candidate.eligible).map((candidate) => candidate.id),
      windows: harness?.usage?.windows ?? [],
      outcome,
    };
    const path = handoffLogPath(env, home);
    try {
      appendHandoff(path, receipt);
    } catch (error) {
      ctx.runtime.stderr.write(`ghost: cannot record the handoff in ${path}: ${(error as Error).message}\n`);
    }
  };

  if (!harness) {
    record({ refused: "not installed" });
    throw new CliError(EXIT_CODE.notFound, `${id} is not an installed agent CLI; see ghost harnesses`);
  }
  if (!harness.eligible) {
    record({ refused: harness.reason ?? "no room" });
    throw new CliError(EXIT_CODE.conflict, `${id} has no room: ${harness.reason}; see ghost harnesses`);
  }

  const launched = Date.now();
  const result = await run(id, args, ctx);
  const failed = result.exit !== 0;
  record({
    exit: result.exit,
    signal: result.signal,
    durationMs: Date.now() - launched,
    limit: failed ? classifyLimitMessage(result.tail) : null,
  });
  if (result.exit !== null) return result.exit;
  return 128 + (result.signal ? constants.signals[result.signal] : 0);
}
