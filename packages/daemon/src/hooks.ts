import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";

export const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;
export const GHOST_SESSION_STOP_CONTINUATION_CAP = 6;
export const GHOST_CONVERSATION_IDLE_DELAY_MS = 60_000;
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
  /** Stable Ghost conversation id. Older extension callers may omit it. */
  conversation_id?: string;
}

export interface GhostBeforePromptResult {
  additionalContext?: string;
  /**
   * In-process delivery acknowledgement. The runtime calls this only after the
   * hidden context has been durably attached to the conversation. Command
   * hooks cannot supply callbacks.
   */
  acknowledge?: () => Promise<void> | void;
}

export interface GhostSessionStopEvent extends GhostHookEventBase {
  type: "session_stop";
  /** Stable Ghost conversation id. Older extension callers may omit it. */
  conversation_id?: string;
  owner_prompt: string;
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

export interface GhostConversationIdleEvent extends GhostHookEventBase {
  type: "conversation_idle";
  conversation_id: string;
  turn_id: number;
  idle_for_ms: number;
  last_turn_outcome: "completed" | "failed" | "aborted";
}

export type GhostHookEvent = GhostBeforePromptEvent | GhostSessionStopEvent | GhostConversationIdleEvent;
export type GhostHookResult = GhostBeforePromptResult | GhostSessionStopResult;

export interface GhostHookEventStatus {
  event: GhostHookEvent["type"];
  count: number;
}

export interface GhostHookStatusItem {
  event: GhostHookEvent["type"];
  name: string;
  description: string;
  idle_seconds?: number;
}

/** Safe for owner-facing diagnostics: no commands, paths, or injected context. */
export interface GhostHookStatus {
  active: boolean;
  total: number;
  events: GhostHookEventStatus[];
  hooks: GhostHookStatusItem[];
  session_stop_continuation_cap: number;
}

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

export type GhostConversationIdleHandler = (
  event: GhostConversationIdleEvent,
  context: GhostHookContext,
) => Promise<void> | void;

type GhostHookHandler = (
  event: GhostHookEvent,
  context: GhostHookContext,
) => Promise<GhostHookResult | undefined | void> | GhostHookResult | undefined | void;

export interface GhostHookRegistrationOptions {
  name?: string;
  description?: string;
  /** Used only by conversation_idle. Defaults to 60 seconds. */
  idleSeconds?: number;
  /** In-process handler deadline. Defaults to 30 seconds. */
  timeoutSeconds?: number;
}

export interface GhostHookAPI {
  on(
    event: "before_prompt",
    handler: GhostBeforePromptHandler,
    options?: GhostHookRegistrationOptions,
  ): void;
  on(
    event: "session_stop",
    handler: GhostSessionStopHandler,
    options?: GhostHookRegistrationOptions,
  ): void;
  on(
    event: "conversation_idle",
    handler: GhostConversationIdleHandler,
    options?: GhostHookRegistrationOptions,
  ): void;
}

export type GhostHookFactory = (hooks: GhostHookAPI) => void | Promise<void>;

interface CommandHook {
  type: "command";
  eventName: GhostHookEvent["type"];
  command: string;
  name: string;
  description: string;
  idleMs?: number;
  timeoutMs: number;
  source: string;
}

interface GhostHookRunnerOptions {
  logger?: Logger;
  handlerTimeoutMs?: number;
  conversationIdleDelayMs?: number;
}

interface RegisteredHook {
  handler: GhostHookHandler;
  name: string;
  description: string;
  idleMs?: number;
  timeoutMs: number;
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

function defaultHookName(event: GhostHookEvent["type"], kind: "command" | "extension"): string {
  const trigger = event === "before_prompt"
    ? "Before-prompt"
    : event === "session_stop" ? "Session-stop" : "Conversation-idle";
  return `${trigger} ${kind} hook`;
}

function defaultHookDescription(event: GhostHookEvent["type"]): string {
  return event === "before_prompt"
    ? "Adds context before the owner prompt is sent."
    : event === "session_stop"
      ? "Reviews the current assistant pass and may continue it."
      : "Runs in the background after one minute without conversation activity.";
}

function displayText(
  value: unknown,
  fallback: string,
  label: string,
  maximum: number,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function idleDelayMs(value: unknown, fallbackMs: number, label: string): number {
  if (value === undefined) return fallbackMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 86_400) {
    throw new Error(`${label} must be a number in (0, 86400].`);
  }
  return Math.floor(value * 1_000);
}

function handlerTimeoutMs(value: unknown, fallbackMs: number, label: string): number {
  if (value === undefined) return fallbackMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 600) {
    throw new Error(`${label} must be a number in (0, 600].`);
  }
  return Math.floor(value * 1_000);
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
  const supported = new Set<GhostHookEvent["type"]>([
    "before_prompt",
    "session_stop",
    "conversation_idle",
  ]);
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
          name: displayText(raw.name, defaultHookName(eventName, "command"), `${path}: ${label}.name`, 80),
          description: displayText(
            raw.description,
            defaultHookDescription(eventName),
            `${path}: ${label}.description`,
            240,
          ),
          ...(eventName === "conversation_idle"
            ? { idleMs: idleDelayMs(raw.idleSeconds, GHOST_CONVERSATION_IDLE_DELAY_MS, `${path}: ${label}.idleSeconds`) }
            : {}),
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
    if (hook.eventName !== "session_stop") {
      logger.warn(`${hook.eventName} hook attempted to block and was ignored`, { source: hook.source });
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
  if (hook.eventName === "conversation_idle") {
    if (output !== "{}") {
      logger.warn("conversation_idle hook output was ignored", { source: hook.source });
    }
    return undefined;
  }
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
  private readonly conversationIdleDelayMs: number;
  private readonly handlers: Record<GhostHookEvent["type"], RegisteredHook[]> = {
    before_prompt: [],
    session_stop: [],
    conversation_idle: [],
  };
  private readonly commands: CommandHook[];
  private readonly conversationIdle = new Map<string, {
    timers: Set<NodeJS.Timeout>;
    controller: AbortController;
    ghostName: string;
    remaining: number;
  }>();

  constructor(options: GhostHookRunnerOptions & { commands?: CommandHook[] } = {}) {
    this.logger = options.logger ?? silentLogger;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? GHOST_HOOK_HANDLER_TIMEOUT_MS;
    this.conversationIdleDelayMs = options.conversationIdleDelayMs
      ?? GHOST_CONVERSATION_IDLE_DELAY_MS;
    if (!Number.isFinite(this.conversationIdleDelayMs) || this.conversationIdleDelayMs < 0) {
      throw new RangeError("conversationIdleDelayMs must be a finite non-negative number");
    }
    this.commands = options.commands ?? [];
  }

  static fromConfig(path: string, options: GhostHookRunnerOptions = {}): GhostHookRunner {
    return new GhostHookRunner({ ...options, commands: existsSync(path) ? parseCommandHooks(path) : [] });
  }

  async register(factory: GhostHookFactory): Promise<void> {
    await factory({
      on: (
        event: GhostHookEvent["type"],
        handler: GhostHookHandler,
        options: GhostHookRegistrationOptions = {},
      ) => {
        const name = displayText(
          options.name,
          defaultHookName(event, "extension"),
          `${event} hook name`,
          80,
        );
        const description = displayText(
          options.description,
          defaultHookDescription(event),
          `${event} hook description`,
          240,
        );
        this.handlers[event].push({
          handler,
          name,
          description,
          ...(event === "conversation_idle"
            ? { idleMs: idleDelayMs(options.idleSeconds, this.conversationIdleDelayMs, `${event} idleSeconds`) }
            : {}),
          timeoutMs: handlerTimeoutMs(
            options.timeoutSeconds,
            this.handlerTimeoutMs,
            `${event} timeoutSeconds`,
          ),
        });
      },
    } as GhostHookAPI);
  }

  hasHandlers(event: GhostHookEvent["type"]): boolean {
    return this.handlers[event].length > 0 || this.commands.some((hook) => hook.eventName === event);
  }

  status(): GhostHookStatus {
    const events = (["before_prompt", "session_stop", "conversation_idle"] as const)
      .map((event) => ({
        event,
        count: this.handlers[event].length
          + this.commands.filter((hook) => hook.eventName === event).length,
      }))
      .filter(({ count }) => count > 0);
    const total = events.reduce((sum, event) => sum + event.count, 0);
    const hooks: GhostHookStatusItem[] = [];
    for (const event of ["before_prompt", "session_stop", "conversation_idle"] as const) {
      for (const handler of this.handlers[event]) {
        hooks.push({
          event,
          name: handler.name,
          description: handler.description,
          ...(handler.idleMs === undefined ? {} : { idle_seconds: handler.idleMs / 1_000 }),
        });
      }
      for (const command of this.commands.filter((hook) => hook.eventName === event)) {
        hooks.push({
          event,
          name: command.name,
          description: command.description,
          ...(command.idleMs === undefined ? {} : { idle_seconds: command.idleMs / 1_000 }),
        });
      }
    }
    return {
      active: total > 0,
      total,
      events,
      hooks,
      session_stop_continuation_cap: GHOST_SESSION_STOP_CONTINUATION_CAP,
    };
  }

  private async runHandler(
    handler: GhostHookHandler,
    event: GhostHookEvent,
    timeoutMs = this.handlerTimeoutMs,
  ): Promise<GhostHookResult | undefined> {
    if (event.signal.aborted) return undefined;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(event.signal.reason);
    event.signal.addEventListener("abort", onParentAbort, { once: true });
    const handlerEvent = { ...event, signal: controller.signal } as GhostHookEvent;
    const context: GhostHookContext = {
      ghostName: event.ghost_name,
      cwd: event.cwd,
      runtime: event.runtime,
      signal: controller.signal,
    };
    let timer: NodeJS.Timeout | undefined;
    let resolveAbort: (() => void) | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      timer.unref();
    });
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      resolveAbort = () => resolve({ kind: "aborted" });
      event.signal.addEventListener("abort", resolveAbort, { once: true });
    });
    const handled = Promise.resolve()
      .then(() => handler(handlerEvent, context))
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
    event.signal.removeEventListener("abort", onParentAbort);
    if (settled.kind === "timeout") {
      controller.abort(new Error(`${event.type} hook timed out`));
      this.logger.warn(`${event.type} hook timed out`, {
        ghost: event.ghost_name,
        timeoutMs,
      });
      return undefined;
    }
    if (settled.kind === "aborted") return undefined;
    return settled.result;
  }

  async emitBeforePrompt(event: GhostBeforePromptEvent): Promise<GhostBeforePromptResult | undefined> {
    if (event.signal.aborted) return undefined;
    const contexts: string[] = [];
    const acknowledgements: Array<() => Promise<void> | void> = [];
    for (const hook of this.handlers.before_prompt) {
      const result = await this.runHandler(
        hook.handler,
        event,
        hook.timeoutMs,
      ) as GhostBeforePromptResult | undefined;
      if (event.signal.aborted) return undefined;
      if (typeof result?.additionalContext === "string" && result.additionalContext.length > 0) {
        contexts.push(result.additionalContext);
        if (typeof result.acknowledge === "function") acknowledgements.push(result.acknowledge);
      }
    }
    for (const command of this.commands.filter((hook) => hook.eventName === "before_prompt")) {
      const result = parseCommandResult(command, await runCommandHook(command, event), this.logger);
      if (event.signal.aborted) return undefined;
      if (typeof result?.additionalContext === "string" && result.additionalContext.length > 0) {
        contexts.push(result.additionalContext);
      }
    }
    if (contexts.length === 0) return undefined;
    return {
      additionalContext: contexts.join("\n\n"),
      ...(acknowledgements.length === 0
        ? {}
        : { acknowledge: async () => {
          for (const acknowledge of acknowledgements) await acknowledge();
        } }),
    };
  }

  async emitSessionStop(event: GhostSessionStopEvent): Promise<GhostSessionStopResult | undefined> {
    if (event.signal.aborted) return undefined;
    for (const hook of this.handlers.session_stop) {
      const result = await this.runHandler(
        hook.handler,
        event,
        hook.timeoutMs,
      ) as GhostSessionStopResult | undefined;
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

  async emitConversationIdle(event: GhostConversationIdleEvent): Promise<void> {
    if (event.signal.aborted) return;
    for (const hook of this.handlers.conversation_idle) {
      await this.runHandler(hook.handler, event, hook.timeoutMs);
      if (event.signal.aborted) return;
    }
    for (const command of this.commands.filter((hook) => hook.eventName === "conversation_idle")) {
      parseCommandResult(command, await runCommandHook(command, event), this.logger);
      if (event.signal.aborted) return;
    }
  }

  scheduleConversationIdle(
    key: string,
    event: Omit<GhostConversationIdleEvent, "idle_for_ms" | "signal" | "type">,
  ): void {
    this.cancelConversationIdle(key);
    if (!this.hasHandlers("conversation_idle")) return;
    const controller = new AbortController();
    const started = Date.now();
    const jobs: Array<{
      delayMs: number;
      run(event: GhostConversationIdleEvent): Promise<unknown>;
    }> = [
      ...this.handlers.conversation_idle.map((hook) => ({
        delayMs: hook.idleMs ?? this.conversationIdleDelayMs,
        run: (idleEvent: GhostConversationIdleEvent) => this.runHandler(
          hook.handler,
          idleEvent,
          hook.timeoutMs,
        ),
      })),
      ...this.commands
        .filter((hook) => hook.eventName === "conversation_idle")
        .map((hook) => ({
          delayMs: hook.idleMs ?? this.conversationIdleDelayMs,
          run: async (idleEvent: GhostConversationIdleEvent) => parseCommandResult(
            hook,
            await runCommandHook(hook, idleEvent),
            this.logger,
          ),
        })),
    ];
    const pending = {
      timers: new Set<NodeJS.Timeout>(),
      controller,
      ghostName: event.ghost_name,
      remaining: jobs.length,
    };
    this.conversationIdle.set(key, pending);
    const settled = () => {
      pending.remaining -= 1;
      if (pending.remaining === 0 && this.conversationIdle.get(key) === pending) {
        this.conversationIdle.delete(key);
      }
    };
    for (const job of jobs) {
      const timer = setTimeout(() => {
        pending.timers.delete(timer);
        if (this.conversationIdle.get(key) !== pending || controller.signal.aborted) {
          settled();
          return;
        }
        const idleEvent: GhostConversationIdleEvent = {
          ...event,
          type: "conversation_idle",
          idle_for_ms: Math.max(job.delayMs, Date.now() - started),
          signal: controller.signal,
        };
        void job.run(idleEvent).finally(settled);
      }, job.delayMs);
      timer.unref();
      pending.timers.add(timer);
    }
  }

  cancelConversationIdle(key: string): void {
    const pending = this.conversationIdle.get(key);
    if (!pending) return;
    this.conversationIdle.delete(key);
    for (const timer of pending.timers) clearTimeout(timer);
    pending.controller.abort();
  }

  cancelConversationIdleForGhost(ghostName: string): void {
    for (const [key, pending] of this.conversationIdle) {
      if (pending.ghostName !== ghostName) continue;
      this.conversationIdle.delete(key);
      for (const timer of pending.timers) clearTimeout(timer);
      pending.controller.abort();
    }
  }

  cancelAllConversationIdle(): void {
    for (const key of [...this.conversationIdle.keys()]) this.cancelConversationIdle(key);
  }
}
