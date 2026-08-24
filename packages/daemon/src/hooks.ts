import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";

export const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;
export const GHOST_SESSION_STOP_CONTINUATION_CAP = 2;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

export function defaultGhostHooksPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const configHome = configured && isAbsolute(configured) ? configured : join(home, ".config");
  return join(configHome, "ghost", "hooks.json");
}

interface GhostHookEventBase {
  session_id: string;
  session_file?: string;
  signal: AbortSignal;
  ghost_name: string;
  cwd: string;
  runtime: "omp" | "claude-code";
}

export interface GhostBeforePromptEvent extends GhostHookEventBase {
  type: "before_prompt";
  prompt: string;
  turn_id: number;
}

export interface GhostBeforePromptResult {
  additionalContext?: string;
}

export interface GhostSessionStopEvent extends GhostHookEventBase {
  type: "session_stop";
  messages: unknown[];
  turn_id: number;
  last_assistant_message?: unknown;
  stop_hook_active: boolean;
}

export interface GhostSessionStopResult {
  continue?: boolean;
  additionalContext?: string;
  decision?: "block";
  reason?: string;
}

export type GhostHookEvent = GhostBeforePromptEvent | GhostSessionStopEvent;
export type GhostHookResult = GhostBeforePromptResult | GhostSessionStopResult;

export interface GhostHookContext {
  ghostName: string;
  cwd: string;
  runtime: "omp" | "claude-code";
  signal: AbortSignal;
}

export type GhostBeforePromptHandler = (
  event: GhostBeforePromptEvent,
  context: GhostHookContext,
) => Promise<GhostBeforePromptResult | undefined | void> | GhostBeforePromptResult | undefined | void;

export type GhostSessionStopHandler = (
  event: GhostSessionStopEvent,
  context: GhostHookContext,
) => Promise<GhostSessionStopResult | undefined | void> | GhostSessionStopResult | undefined | void;

type GhostHookHandler = (
  event: GhostHookEvent,
  context: GhostHookContext,
) => Promise<GhostHookResult | undefined | void> | GhostHookResult | undefined | void;

export interface GhostHookAPI {
  on(event: "before_prompt", handler: GhostBeforePromptHandler): void;
  on(event: "session_stop", handler: GhostSessionStopHandler): void;
}

export type GhostHookFactory = (hooks: GhostHookAPI) => void | Promise<void>;

interface CommandHook {
  type: "command";
  eventName: GhostHookEvent["type"];
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
  const supported = new Set<GhostHookEvent["type"]>(["before_prompt", "session_stop"]);
  for (const eventName of Object.keys(hooks)) {
    if (!supported.has(eventName as GhostHookEvent["type"])) {
      throw new Error(`${path}: unsupported hook event ${JSON.stringify(eventName)}.`);
    }
  }

  const result: CommandHook[] = [];
  for (const eventName of supported) {
    const groups = hooks[eventName];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) throw new Error(`${path}: "hooks.${eventName}" must be an array.`);
    for (const [groupIndex, group] of groups.entries()) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        throw new Error(`${path}: hooks.${eventName}[${groupIndex}].hooks must be an array.`);
      }
      for (const [handlerIndex, raw] of group.hooks.entries()) {
        const label = `hooks.${eventName}[${groupIndex}].hooks[${handlerIndex}]`;
        if (!isObject(raw) || raw.type !== "command" || typeof raw.command !== "string" || !raw.command.trim()) {
          throw new Error(`${path}: ${label} must be a command hook with a non-empty command.`);
        }
        const timeoutSeconds = raw.timeout === undefined ? GHOST_HOOK_HANDLER_TIMEOUT_MS / 1_000 : raw.timeout;
        if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
          throw new Error(`${path}: ${label}.timeout must be a number in (0, 600].`);
        }
        result.push({
          type: "command",
          eventName,
          command: raw.command,
          timeoutMs: Math.floor(timeoutSeconds * 1_000),
          source: `${path}#${label}`,
        });
      }
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
  event: GhostHookEvent,
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
): GhostHookResult | undefined {
  if (result.aborted) return undefined;
  if (result.timedOut) {
    logger.warn(`${hook.eventName} hook timed out`, { source: hook.source, timeoutMs: hook.timeoutMs });
    return undefined;
  }
  if (result.exitCode === 2) {
    if (hook.eventName === "before_prompt") {
      logger.warn("before_prompt hook attempted to block and was ignored", { source: hook.source });
      return undefined;
    }
    return { decision: "block", reason: result.stderr.trim() || "A Ghost hook blocked the stop." };
  }
  if (result.exitCode !== 0) {
    logger.warn(`${hook.eventName} hook failed open`, {
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
    if (hook.eventName === "before_prompt") {
      if (parsed.decision !== undefined || parsed.continue !== undefined || parsed.reason !== undefined) {
        throw new Error("before_prompt only supports additionalContext");
      }
      return typeof parsed.additionalContext === "string"
        ? { additionalContext: parsed.additionalContext }
        : undefined;
    }
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
    logger.warn(`${hook.eventName} hook returned invalid JSON`, {
      source: hook.source,
      error: (error as Error).message,
    });
    return undefined;
  }
}

export class GhostHookRunner {
  private readonly logger: Logger;
  private readonly handlerTimeoutMs: number;
  private readonly handlers: Record<GhostHookEvent["type"], GhostHookHandler[]> = {
    before_prompt: [],
    session_stop: [],
  };
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
      on: (event: GhostHookEvent["type"], handler: GhostHookHandler) => {
        this.handlers[event].push(handler);
      },
    } as GhostHookAPI);
  }

  hasHandlers(event: GhostHookEvent["type"]): boolean {
    return this.handlers[event].length > 0 || this.commands.some((hook) => hook.eventName === event);
  }

  private async runHandler(
    handler: GhostHookHandler,
    event: GhostHookEvent,
  ): Promise<GhostHookResult | undefined> {
    if (event.signal.aborted) return undefined;
    const context: GhostHookContext = {
      ghostName: event.ghost_name,
      cwd: event.cwd,
      runtime: event.runtime,
      signal: event.signal,
    };
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
        this.logger.warn(`${event.type} hook failed open`, {
          ghost: event.ghost_name,
          error: error instanceof Error ? error.message : String(error),
        });
        return { kind: "result" as const, result: undefined };
      });
    const settled = await Promise.race([handled, timeout, aborted]);
    if (timer) clearTimeout(timer);
    if (resolveAbort) event.signal.removeEventListener("abort", resolveAbort);
    if (settled.kind === "timeout") {
      this.logger.warn(`${event.type} hook timed out`, {
        ghost: event.ghost_name,
        timeoutMs: this.handlerTimeoutMs,
      });
      return undefined;
    }
    if (settled.kind === "aborted") return undefined;
    return settled.result;
  }

  async emitBeforePrompt(event: GhostBeforePromptEvent): Promise<GhostBeforePromptResult | undefined> {
    if (event.signal.aborted) return undefined;
    const contexts: string[] = [];
    for (const handler of this.handlers.before_prompt) {
      const result = await this.runHandler(handler, event);
      if (event.signal.aborted) return undefined;
      if (typeof result?.additionalContext === "string" && result.additionalContext.length > 0) {
        contexts.push(result.additionalContext);
      }
    }
    for (const command of this.commands.filter((hook) => hook.eventName === "before_prompt")) {
      const result = parseCommandResult(command, await runCommandHook(command, event), this.logger);
      if (event.signal.aborted) return undefined;
      if (typeof result?.additionalContext === "string" && result.additionalContext.length > 0) {
        contexts.push(result.additionalContext);
      }
    }
    return contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : undefined;
  }

  async emitSessionStop(event: GhostSessionStopEvent): Promise<GhostSessionStopResult | undefined> {
    if (event.signal.aborted) return undefined;
    for (const handler of this.handlers.session_stop) {
      const result = await this.runHandler(handler, event) as GhostSessionStopResult | undefined;
      if (event.signal.aborted) return undefined;
      if (ghostSessionStopContinuation(result)) return result;
    }
    for (const command of this.commands.filter((hook) => hook.eventName === "session_stop")) {
      const result = parseCommandResult(
        command,
        await runCommandHook(command, event),
        this.logger,
      ) as GhostSessionStopResult | undefined;
      if (ghostSessionStopContinuation(result)) return result;
    }
    return undefined;
  }
}
