import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";

export const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;
export const GHOST_SESSION_STOP_CONTINUATION_CAP = 10;
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
  ghost_home: string;
  cwd: string;
  runtime: "omp" | "claude-code";
  conversation_id: string;
  conversation_runtime: "pi" | "claude-code";
}

export interface GhostBeforePromptEvent extends GhostHookEventBase {
  type: "before_prompt";
  prompt: string;
  turn_id: number;
}

export interface GhostBeforePromptResult {
  additionalContext?: string;
  acknowledge?: () => Promise<void> | void;
}

export interface GhostSessionStopEvent extends GhostHookEventBase {
  type: "session_stop";
  owner_prompt: string;
  messages: unknown[];
  turn_id: number;
  last_assistant_message?: unknown;
  stop_hook_active: boolean;
  /**
   * The runtime's native transcript when one exists on disk: the Pi session file
   * for OMP conversations, the Claude Code SDK session file for Claude Code
   * conversations. `messages` still carries only the current pass.
   */
  transcript_path?: string;
}

export interface GhostConversationIdleEvent extends GhostHookEventBase {
  type: "conversation_idle";
  conversation_incarnation: string;
  sequence: number;
  source_revision: string;
  idle_for_ms: number;
  last_turn_outcome: "completed" | "failed";
}

export interface GhostSessionStopResult {
  continue?: boolean;
  additionalContext?: string;
  decision?: "block";
  reason?: string;
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
  idleSeconds?: number;
}

export interface GhostHookStatus {
  active: boolean;
  total: number;
  events: GhostHookEventStatus[];
  hooks: GhostHookStatusItem[];
  sessionStopContinuationCap: number;
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

/** Opaque identity for dispatching one exact in-process idle registration. */
export interface GhostConversationIdleRegistration {
  readonly id: string;
  readonly idleMs: number;
}

type GhostHookHandler = (
  event: GhostHookEvent,
  context: GhostHookContext,
) => Promise<GhostHookResult | undefined | void> | GhostHookResult | undefined | void;

export interface GhostHookRegistrationOptions {
  name?: string;
  description?: string;
  idleSeconds?: number;
  timeoutSeconds?: number;
  registrationId?: string;
}

export interface GhostHookAPI {
  on(event: "before_prompt", handler: GhostBeforePromptHandler, options?: GhostHookRegistrationOptions): void;
  on(event: "session_stop", handler: GhostSessionStopHandler, options?: GhostHookRegistrationOptions): void;
  on(
    event: "conversation_idle",
    handler: GhostConversationIdleHandler,
    options?: GhostHookRegistrationOptions,
  ): GhostConversationIdleRegistration;
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
  idleRegistration?: GhostConversationIdleRegistration;
}

interface GhostHookRunnerOptions {
  logger?: Logger;
  handlerTimeoutMs?: number;
  conversationIdleDelayMs?: number;
  /** Test seam for a rejected command execution boundary. */
  commandRunner?: (hook: CommandHook, event: GhostHookEvent) => Promise<CommandResult>;
}

interface RegisteredHook {
  handler: GhostHookHandler;
  name: string;
  description: string;
  idleMs?: number;
  timeoutMs: number;
  idleRegistration?: GhostConversationIdleRegistration;
}

type IdleTarget =
  | { registration: GhostConversationIdleRegistration; handler: RegisteredHook }
  | { registration: GhostConversationIdleRegistration; command: CommandHook };

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
      : "Runs in the background after the configured idle interval.";
}

function displayText(value: unknown, fallback: string, label: string, maximum: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function idleDelayMs(value: unknown, fallbackMs: number, label: string): number {
  if (value === undefined) return fallbackMs;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86_400) {
    throw new Error(`${label} must be an integer in [1, 86400].`);
  }
  return (value as number) * 1_000;
}

function explicitIdleRegistrationId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9][A-Za-z0-9._:-]* and be at most 128 characters.`);
  }
  return value;
}

function derivedIdleRegistrationId(
  kind: "command" | "extension",
  fields: readonly unknown[],
  duplicates: Map<string, number>,
): string {
  const fingerprint = createHash("sha256").update(JSON.stringify([kind, ...fields])).digest("hex");
  const ordinal = duplicates.get(fingerprint) ?? 0;
  duplicates.set(fingerprint, ordinal + 1);
  return `${kind}:${fingerprint}:${ordinal}`;
}

function timeoutMs(value: unknown, fallbackMs: number, label: string): number {
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
  const supported = new Set<GhostHookEvent["type"]>(["before_prompt", "session_stop", "conversation_idle"]);
  for (const eventName of Object.keys(hooks)) {
    if (!supported.has(eventName as GhostHookEvent["type"])) {
      throw new Error(`${path}: unsupported hook event ${JSON.stringify(eventName)}.`);
    }
  }

  const result: CommandHook[] = [];
  const idleDuplicates = new Map<string, number>();
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
        if (!isObject(raw) || raw.type !== "command" || typeof raw.command !== "string"
          || !raw.command.trim() || raw.command.includes("\0")) {
          throw new Error(`${path}: ${label} must be a command hook with a non-empty NUL-free command.`);
        }
        if (eventName !== "conversation_idle" && raw.registrationId !== undefined) {
          throw new Error(`${path}: ${label}.registrationId is supported only for conversation_idle hooks.`);
        }
        const timeoutSeconds = raw.timeout === undefined ? GHOST_HOOK_HANDLER_TIMEOUT_MS / 1_000 : raw.timeout;
        if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
          throw new Error(`${path}: ${label}.timeout must be a number in (0, 600].`);
        }
        const name = displayText(raw.name, defaultHookName(eventName, "command"), `${path}: ${label}.name`, 80);
        const description = displayText(
          raw.description,
          defaultHookDescription(eventName),
          `${path}: ${label}.description`,
          240,
        );
        const admittedIdleMs = eventName === "conversation_idle"
          ? idleDelayMs(raw.idleSeconds, GHOST_CONVERSATION_IDLE_DELAY_MS, `${path}: ${label}.idleSeconds`)
          : undefined;
        const admittedTimeoutMs = Math.floor(timeoutSeconds * 1_000);
        const idleRegistration = admittedIdleMs === undefined ? undefined : Object.freeze({
          id: explicitIdleRegistrationId(raw.registrationId, `${path}: ${label}.registrationId`)
            ?? derivedIdleRegistrationId(
              "command",
              [raw.command, name, description, admittedIdleMs, admittedTimeoutMs],
              idleDuplicates,
            ),
          idleMs: admittedIdleMs,
        });
        result.push({
          type: "command",
          eventName,
          command: raw.command,
          name,
          description,
          ...(admittedIdleMs === undefined ? {} : { idleMs: admittedIdleMs, idleRegistration }),
          timeoutMs: admittedTimeoutMs,
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
  executionFailed: boolean;
}

function runCommandHook(
  hook: CommandHook,
  event: GhostHookEvent,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (event.signal.aborted) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        aborted: true,
        timedOut: false,
        executionFailed: false,
      });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(hook.command, {
        cwd: event.cwd,
        env: process.env,
        shell: process.platform === "win32" ? true : "/bin/bash",
        // A separate POSIX process group lets cancellation own the shell and
        // every descendant which inherited its stdout/stderr pipes.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        aborted: false,
        timedOut: false,
        executionFailed: true,
      });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let executionFailed = false;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;

    const append = (chunks: Buffer[], chunk: Buffer, used: number): number => {
      const remaining = Math.max(0, MAX_HOOK_OUTPUT_BYTES - used);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return used + chunk.length;
    };
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {
            // The close/error event remains the authoritative drain boundary.
          }
        }
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      event.signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        aborted,
        timedOut,
        executionFailed,
      });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) signalTree("SIGKILL");
      }, 2_000);
      killTimer.unref();
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdoutChunks, chunk, stdoutBytes);
      if (stdoutBytes > MAX_HOOK_OUTPUT_BYTES) {
        timedOut = true;
        stderrChunks.length = 0;
        stderrChunks.push(Buffer.from("Hook stdout exceeded 1 MB."));
        stderrBytes = stderrChunks[0]?.length ?? 0;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderrChunks, chunk, stderrBytes);
      if (stderrBytes > MAX_HOOK_OUTPUT_BYTES) {
        timedOut = true;
        stop();
      }
    });
    child.on("error", () => {
      executionFailed = true;
      stderrChunks.length = 0;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // A hook may exit without reading stdin; its process exit still decides
      // whether this is a block or a non-blocking failure.
    });
    try {
      child.stdin.end(JSON.stringify({ ...event, signal: undefined }));
    } catch {
      executionFailed = true;
      stop();
    }
  });
}

function parseCommandResult(
  hook: CommandHook,
  result: CommandResult,
  logger: Logger,
): GhostHookResult | undefined {
  if (result.aborted) return undefined;
  if (result.executionFailed) {
    logger.warn(`${hook.eventName} hook failed open`, {
      source: hook.source,
      error: "command execution failed",
    });
    return undefined;
  }
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
    });
    return undefined;
  }
  const output = result.stdout.trim();
  if (!output) return undefined;
  if (hook.eventName === "conversation_idle") {
    if (output !== "{}") logger.warn("conversation_idle hook output was ignored", { source: hook.source });
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
  } catch {
    logger.warn(`${hook.eventName} hook returned invalid JSON`, {
      source: hook.source,
      error: "invalid hook output",
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
  private readonly commandRunner: NonNullable<GhostHookRunnerOptions["commandRunner"]>;
  private readonly idleTargets = new Map<string, IdleTarget>();
  private readonly idleDuplicates = new Map<string, number>();

  constructor(options: GhostHookRunnerOptions & { commands?: CommandHook[] } = {}) {
    this.logger = options.logger ?? silentLogger;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? GHOST_HOOK_HANDLER_TIMEOUT_MS;
    this.conversationIdleDelayMs = options.conversationIdleDelayMs ?? GHOST_CONVERSATION_IDLE_DELAY_MS;
    if (!Number.isSafeInteger(this.conversationIdleDelayMs)
      || this.conversationIdleDelayMs < 1_000
      || this.conversationIdleDelayMs > 86_400_000
      || this.conversationIdleDelayMs % 1_000 !== 0) {
      throw new RangeError(
        "conversationIdleDelayMs must be a whole-second integer in [1000, 86400000]",
      );
    }
    this.commands = options.commands ?? [];
    this.commandRunner = options.commandRunner ?? runCommandHook;
    for (const command of this.commands) {
      if (!command.idleRegistration) continue;
      if (this.idleTargets.has(command.idleRegistration.id)) {
        throw new Error(`Duplicate conversation_idle registration ${JSON.stringify(command.idleRegistration.id)}.`);
      }
      this.idleTargets.set(command.idleRegistration.id, {
        registration: command.idleRegistration,
        command,
      });
    }
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
        const registered: RegisteredHook = {
          handler,
          name: displayText(options.name, defaultHookName(event, "extension"), `${event} hook name`, 80),
          description: displayText(
            options.description,
            defaultHookDescription(event),
            `${event} hook description`,
            240,
          ),
          ...(event === "conversation_idle"
            ? { idleMs: idleDelayMs(options.idleSeconds, this.conversationIdleDelayMs, `${event} idleSeconds`) }
            : {}),
          timeoutMs: timeoutMs(options.timeoutSeconds, this.handlerTimeoutMs, `${event} timeoutSeconds`),
        };
        if (event !== "conversation_idle" && options.registrationId !== undefined) {
          throw new Error("registrationId is supported only for conversation_idle hooks.");
        }
        if (event === "conversation_idle") {
          const idleMs = registered.idleMs as number;
          const id = explicitIdleRegistrationId(
            options.registrationId,
            `${event} registrationId`,
          ) ?? derivedIdleRegistrationId(
            "extension",
            [registered.name, registered.description, idleMs, registered.timeoutMs],
            this.idleDuplicates,
          );
          if (this.idleTargets.has(id)) {
            throw new Error(`Duplicate conversation_idle registration ${JSON.stringify(id)}.`);
          }
          registered.idleRegistration = Object.freeze({ id, idleMs });
        }
        this.handlers[event].push(registered);
        if (event !== "conversation_idle") return undefined;
        const registration = registered.idleRegistration as GhostConversationIdleRegistration;
        this.idleTargets.set(registration.id, { registration, handler: registered });
        return registration;
      },
    } as GhostHookAPI);
  }

  private async runCommandFailOpen(
    hook: CommandHook,
    event: GhostHookEvent,
  ): Promise<GhostHookResult | undefined> {
    try {
      return parseCommandResult(hook, await this.commandRunner(hook, event), this.logger);
    } catch {
      this.logger.warn(`${hook.eventName} hook failed open`, {
        source: hook.source,
        error: "command execution failed",
      });
      return undefined;
    }
  }

  hasHandlers(event: GhostHookEvent["type"]): boolean {
    return this.handlers[event].length > 0 || this.commands.some((hook) => hook.eventName === event);
  }

  conversationIdleDelaysMs(): readonly number[] {
    return [...new Set(this.conversationIdleRegistrations().map(({ idleMs }) => idleMs))]
      .sort((left, right) => left - right);
  }

  conversationIdleRegistrations(): readonly GhostConversationIdleRegistration[] {
    return [
      ...this.handlers.conversation_idle
        .map(({ idleRegistration }) => idleRegistration)
        .filter((value): value is GhostConversationIdleRegistration => value !== undefined),
      ...this.commands
        .map(({ idleRegistration }) => idleRegistration)
        .filter((value): value is GhostConversationIdleRegistration => value !== undefined),
    ];
  }

  status(): GhostHookStatus {
    const eventOrder = ["before_prompt", "session_stop", "conversation_idle"] as const;
    const events = eventOrder.map((event) => ({
      event,
      count: this.handlers[event].length
        + this.commands.filter((command) => command.eventName === event).length,
    })).filter(({ count }) => count > 0);
    const hooks: GhostHookStatusItem[] = [];
    for (const event of eventOrder) {
      for (const hook of this.handlers[event]) {
        hooks.push({
          event,
          name: hook.name,
          description: hook.description,
          ...(hook.idleMs === undefined ? {} : { idleSeconds: hook.idleMs / 1_000 }),
        });
      }
      for (const hook of this.commands.filter((command) => command.eventName === event)) {
        hooks.push({
          event,
          name: hook.name,
          description: hook.description,
          ...(hook.idleMs === undefined ? {} : { idleSeconds: hook.idleMs / 1_000 }),
        });
      }
    }
    const total = events.reduce((sum, event) => sum + event.count, 0);
    return {
      active: total > 0,
      total,
      events,
      hooks,
      sessionStopContinuationCap: GHOST_SESSION_STOP_CONTINUATION_CAP,
    };
  }

  private async runHandler(
    handler: GhostHookHandler,
    event: GhostHookEvent,
    handlerTimeout = this.handlerTimeoutMs,
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
      timer = setTimeout(() => resolve({ kind: "timeout" }), handlerTimeout);
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
        timeoutMs: handlerTimeout,
      });
      // Cancellation is a lifecycle boundary, not detach. A hook which owns a
      // home lease or model/tool operation must settle before its caller may
      // rename, delete, replace, or shut down that resource.
      await handled;
      return undefined;
    }
    if (settled.kind === "aborted") {
      controller.abort(event.signal.reason);
      await handled;
      return undefined;
    }
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
      const result = await this.runCommandFailOpen(command, event);
      if (event.signal.aborted) return undefined;
      if (typeof result?.additionalContext === "string" && result.additionalContext.length > 0) {
        contexts.push(result.additionalContext);
      }
    }
    if (contexts.length === 0) return undefined;
    return {
      additionalContext: contexts.join("\n\n"),
      ...(acknowledgements.length === 0 ? {} : {
        acknowledge: async () => {
          for (const acknowledge of acknowledgements) await acknowledge();
        },
      }),
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
      const result = await this.runCommandFailOpen(command, event) as GhostSessionStopResult | undefined;
      if (ghostSessionStopContinuation(result)) return result;
    }
    return undefined;
  }

  async emitConversationIdle(
    event: GhostConversationIdleEvent,
    dueIdleMs: readonly number[] = this.conversationIdleDelaysMs(),
  ): Promise<void> {
    if (event.signal.aborted) return;
    const due = new Set(dueIdleMs);
    for (const hook of this.handlers.conversation_idle.filter(({ idleMs }) =>
      idleMs !== undefined && due.has(idleMs)
    )) {
      await this.runHandler(hook.handler, event, hook.timeoutMs);
      if (event.signal.aborted) return;
    }
    for (const command of this.commands.filter((hook) =>
      hook.eventName === "conversation_idle" && hook.idleMs !== undefined && due.has(hook.idleMs)
    )) {
      await this.runCommandFailOpen(command, event);
      if (event.signal.aborted) return;
    }
  }

  async emitConversationIdleRegistration(
    event: GhostConversationIdleEvent,
    registration: GhostConversationIdleRegistration,
  ): Promise<void> {
    if (event.signal.aborted) return;
    const target = this.idleTargets.get(registration.id);
    if (!target || target.registration.idleMs !== registration.idleMs) {
      throw new Error("Unknown conversation_idle registration.");
    }
    if ("handler" in target) {
      await this.runHandler(target.handler.handler, event, target.handler.timeoutMs);
    } else {
      await this.runCommandFailOpen(target.command, event);
    }
  }
}
