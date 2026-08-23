import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";

export const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;
export const GHOST_SESSION_STOP_CONTINUATION_CAP = 8;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

export function defaultGhostHooksPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const configHome = configured && isAbsolute(configured) ? configured : join(home, ".config");
  return join(configHome, "ghost", "hooks.json");
}

export interface GhostSessionStopEvent {
  type: "session_stop";
  messages: unknown[];
  turn_id: number;
  last_assistant_message?: unknown;
  session_id: string;
  session_file?: string;
  stop_hook_active: boolean;
  signal: AbortSignal;
  ghost_name: string;
  cwd: string;
  runtime: "pi" | "claude-code";
}

export interface GhostSessionStopResult {
  continue?: boolean;
  additionalContext?: string;
  decision?: "block";
  reason?: string;
}

export interface GhostHookContext {
  ghostName: string;
  cwd: string;
  runtime: "pi" | "claude-code";
  signal: AbortSignal;
}

export type GhostSessionStopHandler = (
  event: GhostSessionStopEvent,
  context: GhostHookContext,
) => Promise<GhostSessionStopResult | undefined | void> | GhostSessionStopResult | undefined | void;

export interface GhostHookAPI {
  on(event: "session_stop", handler: GhostSessionStopHandler): void;
}

export type GhostHookFactory = (hooks: GhostHookAPI) => void | Promise<void>;

interface CommandHook {
  type: "command";
  command: string;
  timeoutMs: number;
  source: string;
}

interface GhostHookRunnerOptions {
  logger?: Logger;
  handlerTimeoutMs?: number;
}

export function ghostSessionStopContinuation(
  result: GhostSessionStopResult | undefined,
): string | undefined {
  if (!result) return undefined;
  const additional = typeof result.additionalContext === "string" && result.additionalContext.length > 0
    ? result.additionalContext
    : undefined;
  const reason = typeof result.reason === "string" && result.reason.length > 0
    ? result.reason
    : undefined;
  if (result.continue === true) return additional ?? reason;
  if (result.decision === "block") return reason ?? additional;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCommandHooks(path: string): CommandHook[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load Ghost hooks from ${path}: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
  const hooks = parsed.hooks;
  if (hooks === undefined) return [];
  if (!isObject(hooks)) throw new Error(`${path}: "hooks" must be an object.`);
  for (const eventName of Object.keys(hooks)) {
    if (eventName !== "session_stop") {
      throw new Error(`${path}: unsupported hook event ${JSON.stringify(eventName)}.`);
    }
  }
  const groups = hooks.session_stop;
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error(`${path}: "hooks.session_stop" must be an array.`);

  const result: CommandHook[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      throw new Error(`${path}: hooks.session_stop[${groupIndex}].hooks must be an array.`);
    }
    for (const [handlerIndex, raw] of group.hooks.entries()) {
      const label = `hooks.session_stop[${groupIndex}].hooks[${handlerIndex}]`;
      if (!isObject(raw) || raw.type !== "command" || typeof raw.command !== "string" || !raw.command.trim()) {
        throw new Error(`${path}: ${label} must be a command hook with a non-empty command.`);
      }
      const timeoutSeconds = raw.timeout === undefined ? GHOST_HOOK_HANDLER_TIMEOUT_MS / 1_000 : raw.timeout;
      if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
        throw new Error(`${path}: ${label}.timeout must be a number in (0, 600].`);
      }
      result.push({
        type: "command",
        command: raw.command,
        timeoutMs: Math.floor(timeoutSeconds * 1_000),
        source: `${path}#${label}`,
      });
    }
  }
  return result;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

function runCommandHook(
  hook: CommandHook,
  event: GhostSessionStopEvent,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (event.signal.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "", aborted: true, timedOut: false });
      return;
    }
    const child = spawn(hook.command, {
      cwd: event.cwd,
      env: process.env,
      shell: process.platform === "win32" ? true : "/bin/bash",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      event.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, aborted, timedOut });
    };
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, hook.timeoutMs);
    timer.unref();
    event.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_HOOK_OUTPUT_BYTES) {
        timedOut = true;
        stderr = "Hook stdout exceeded 1 MB.";
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) <= MAX_HOOK_OUTPUT_BYTES) stderr += chunk;
    });
    child.on("error", (error) => {
      stderr = error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // A hook may exit without reading stdin; its process exit still decides
      // whether this is a block or a non-blocking failure.
    });
    child.stdin.end(JSON.stringify({ ...event, signal: undefined }));
  });
}

function parseCommandResult(
  hook: CommandHook,
  result: CommandResult,
  logger: Logger,
): GhostSessionStopResult | undefined {
  if (result.aborted) return undefined;
  if (result.timedOut) {
    logger.warn("session_stop hook timed out", { source: hook.source, timeoutMs: hook.timeoutMs });
    return undefined;
  }
  if (result.exitCode === 2) {
    return { decision: "block", reason: result.stderr.trim() || "A Ghost hook blocked the stop." };
  }
  if (result.exitCode !== 0) {
    logger.warn("session_stop hook failed open", {
      source: hook.source,
      exitCode: result.exitCode,
      error: result.stderr.trim() || "command failed",
    });
    return undefined;
  }
  const output = result.stdout.trim();
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output);
    if (!isObject(parsed)) throw new Error("hook output must be a JSON object");
    const decision = parsed.decision;
    if (decision !== undefined && decision !== "block") {
      throw new Error(`unsupported decision ${JSON.stringify(decision)}`);
    }
    return {
      ...(parsed.continue === true ? { continue: true } : {}),
      ...(typeof parsed.additionalContext === "string" ? { additionalContext: parsed.additionalContext } : {}),
      ...(decision === "block" ? { decision } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  } catch (error) {
    logger.warn("session_stop hook returned invalid JSON", {
      source: hook.source,
      error: (error as Error).message,
    });
    return undefined;
  }
}

export class GhostHookRunner {
  private readonly logger: Logger;
  private readonly handlerTimeoutMs: number;
  private readonly handlers: GhostSessionStopHandler[] = [];
  private readonly commands: CommandHook[];

  constructor(options: GhostHookRunnerOptions & { commands?: CommandHook[] } = {}) {
    this.logger = options.logger ?? silentLogger;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? GHOST_HOOK_HANDLER_TIMEOUT_MS;
    this.commands = options.commands ?? [];
  }

  static fromConfig(path: string, options: GhostHookRunnerOptions = {}): GhostHookRunner {
    return new GhostHookRunner({ ...options, commands: existsSync(path) ? parseCommandHooks(path) : [] });
  }

  async register(factory: GhostHookFactory): Promise<void> {
    await factory({
      on: (event, handler) => {
        if (event !== "session_stop") throw new Error(`Unsupported Ghost hook event: ${event}`);
        this.handlers.push(handler);
      },
    });
  }

  hasHandlers(event: "session_stop"): boolean {
    return event === "session_stop" && (this.handlers.length > 0 || this.commands.length > 0);
  }

  async emitSessionStop(event: GhostSessionStopEvent): Promise<GhostSessionStopResult | undefined> {
    if (event.signal.aborted) return undefined;
    const context: GhostHookContext = {
      ghostName: event.ghost_name,
      cwd: event.cwd,
      runtime: event.runtime,
      signal: event.signal,
    };

    for (const handler of this.handlers) {
      if (event.signal.aborted) return undefined;
      let timer: NodeJS.Timeout | undefined;
      let resolveAbort: (() => void) | undefined;
      const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), this.handlerTimeoutMs);
        timer.unref();
      });
      const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
        resolveAbort = () => resolve({ kind: "aborted" });
        event.signal.addEventListener("abort", resolveAbort, { once: true });
      });
      const handled = Promise.resolve()
        .then(() => handler(event, context))
        .then((result) => ({ kind: "result" as const, result: result ?? undefined }))
        .catch((error) => {
          this.logger.warn("session_stop hook failed open", {
            ghost: event.ghost_name,
            error: error instanceof Error ? error.message : String(error),
          });
          return { kind: "result" as const, result: undefined };
        });
      const settled = await Promise.race([handled, timeout, aborted]);
      if (timer) clearTimeout(timer);
      if (resolveAbort) event.signal.removeEventListener("abort", resolveAbort);
      if (settled.kind === "timeout") {
        this.logger.warn("session_stop hook timed out", {
          ghost: event.ghost_name,
          timeoutMs: this.handlerTimeoutMs,
        });
        continue;
      }
      if (settled.kind === "aborted") return undefined;
      if (ghostSessionStopContinuation(settled.result)) return settled.result;
    }

    for (const command of this.commands) {
      const result = parseCommandResult(command, await runCommandHook(command, event), this.logger);
      if (ghostSessionStopContinuation(result)) return result;
    }
    return undefined;
  }
}
