import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import { writePrivateJsonAtomic } from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";

const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

interface GhostHookEventBase {
  session_id: string;
  session_file?: string;
  signal: AbortSignal;
  ghost_name: string;
  ghost_home: string;
  cwd: string;
  runtime: "pi" | "claude-code";
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
   * for pi conversations, the Claude Code SDK session file for Claude Code
   * conversations. `messages` still carries only the current pass.
   */
  transcript_path?: string;
}

export interface GhostSessionStopResult {
  continue?: boolean;
  additionalContext?: string;
  decision?: "block";
  reason?: string;
}

export type GhostHookEvent = GhostBeforePromptEvent | GhostSessionStopEvent;
export type GhostHookResult = GhostBeforePromptResult | GhostSessionStopResult;

export interface GhostHookEventStatus {
  event: GhostHookEvent["type"];
  count: number;
}

/** `builtin` is an in-process registration; `config` comes from `hooks.json`. */
export type GhostHookSource = "builtin" | "config";

export interface GhostHookStatusItem {
  event: GhostHookEvent["type"];
  source: GhostHookSource;
  name: string;
  description: string;
  /** The `builtin.<key>` entry of `hooks.json` that tunes this built-in hook. */
  settingsKey?: string;
}

/** The admitted `hooks.json` document and where it lives. */
export interface GhostHookCommandConfig {
  path: string;
  document: Record<string, unknown>;
}

export interface GhostHookStatus {
  active: boolean;
  total: number;
  events: GhostHookEventStatus[];
  hooks: GhostHookStatusItem[];
}

export interface GhostHookContext {
  ghostName: string;
  cwd: string;
  runtime: "pi" | "claude-code";
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

export interface GhostHookRegistrationOptions {
  name?: string;
  description?: string;
  timeoutSeconds?: number;
  /** Names the `builtin.<key>` entry of `hooks.json` that tunes this hook. */
  settingsKey?: string;
}

export interface GhostHookAPI {
  on(event: "before_prompt", handler: GhostBeforePromptHandler, options?: GhostHookRegistrationOptions): void;
  on(event: "session_stop", handler: GhostSessionStopHandler, options?: GhostHookRegistrationOptions): void;
}

export type GhostHookFactory = (hooks: GhostHookAPI) => void | Promise<void>;

interface CommandHook {
  type: "command";
  eventName: GhostHookEvent["type"];
  command: string;
  name: string;
  description: string;
  timeoutMs: number;
  source: string;
}

interface GhostHookRunnerOptions {
  logger?: Logger;
  handlerTimeoutMs?: number;
  /** Test seam for a rejected command execution boundary. */
  commandRunner?: (hook: CommandHook, event: GhostHookEvent) => Promise<CommandResult>;
}

interface RegisteredHook {
  handler: GhostHookHandler;
  name: string;
  description: string;
  timeoutMs: number;
  settingsKey?: string;
}

const SETTINGS_KEY = /^[a-z][a-z0-9_]*$/u;
const BUILTIN_SETTINGS_KEYS = new Set(["review"]);

/**
 * The `builtin` section of a `hooks.json` document names the hooks Ghost
 * registers in code. No built-in takes a `hooks.json` field today, so the
 * section only admits a known key with an empty object.
 */
function validateBuiltinHookSettings(parsed: Record<string, unknown>, path: string): void {
  const builtin = parsed.builtin;
  if (builtin === undefined) return;
  if (!isObject(builtin)) throw new Error(`${path}: "builtin" must be an object.`);
  for (const [key, raw] of Object.entries(builtin)) {
    if (!SETTINGS_KEY.test(key)) {
      throw new Error(`${path}: builtin key ${JSON.stringify(key)} must match [a-z][a-z0-9_]*.`);
    }
    if (!BUILTIN_SETTINGS_KEYS.has(key)) {
      throw new Error(`${path}: unsupported builtin key ${JSON.stringify(key)}.`);
    }
    if (!isObject(raw)) throw new Error(`${path}: builtin.${key} must be an object.`);
    const [field] = Object.keys(raw);
    if (field !== undefined) {
      throw new Error(`${path}: builtin.${key}.${field} is not a setting.`);
    }
  }
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
  const trigger = event === "before_prompt" ? "Before-prompt" : "Session-stop";
  return `${trigger} ${kind} hook`;
}

function defaultHookDescription(event: GhostHookEvent["type"]): string {
  return event === "before_prompt"
    ? "Adds context before the owner prompt is sent."
    : "Reviews the current assistant pass and may continue it.";
}

function displayText(value: unknown, fallback: string, label: string, maximum: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function timeoutMs(value: unknown, fallbackMs: number, label: string): number {
  if (value === undefined) return fallbackMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 600) {
    throw new Error(`${label} must be a number in (0, 600].`);
  }
  return Math.floor(value * 1_000);
}

function readCommandHooksDocument(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load Ghost hooks from ${path}: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed;
}

/**
 * Admit one `hooks.json` document. Every error names the offending field the
 * same way whether the document came from disk or from `PUT /api/hooks/config`.
 */
function parseHooksDocument(parsed: unknown, path: string): CommandHook[] {
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
  validateBuiltinHookSettings(parsed, path);
  return parseCommandHooks(parsed, path);
}

function parseCommandHooks(parsed: Record<string, unknown>, path: string): CommandHook[] {
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
        if (!isObject(raw) || raw.type !== "command" || typeof raw.command !== "string"
          || !raw.command.trim() || raw.command.includes("\0")) {
          throw new Error(`${path}: ${label} must be a command hook with a non-empty NUL-free command.`);
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
        result.push({
          type: "command",
          eventName,
          command: raw.command,
          name,
          description,
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
  private readonly handlers: Record<GhostHookEvent["type"], RegisteredHook[]> = {
    before_prompt: [],
    session_stop: [],
  };
  private commands: CommandHook[];
  private readonly commandRunner: NonNullable<GhostHookRunnerOptions["commandRunner"]>;
  private commandConfig?: GhostHookCommandConfig;
  private readonly configWrites = new Map<string, Promise<unknown>>();

  constructor(
    options: GhostHookRunnerOptions & {
      commands?: CommandHook[];
      commandConfig?: GhostHookCommandConfig;
    } = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? GHOST_HOOK_HANDLER_TIMEOUT_MS;
    this.commands = options.commands ?? [];
    this.commandConfig = options.commandConfig;
    this.commandRunner = options.commandRunner ?? runCommandHook;
  }

  static fromConfig(path: string, options: GhostHookRunnerOptions = {}): GhostHookRunner {
    const document = readCommandHooksDocument(path);
    return new GhostHookRunner({
      ...options,
      commands: parseHooksDocument(document, path),
      commandConfig: { path, document },
    });
  }

  /** The admitted `hooks.json`, or undefined for a runner built without one. */
  config(): GhostHookCommandConfig | undefined {
    return this.commandConfig;
  }

  /**
   * Admit `document` as the new `hooks.json`, write it through a temporary
   * file and one rename, then swap the live command hooks. Handlers registered
   * in-process are untouched, and the new commands apply at the next boundary.
   * Replacements are serialized so two writers cannot interleave the file and
   * the live set.
   */
  async replaceConfig(document: unknown): Promise<GhostHookCommandConfig> {
    const config = this.commandConfig;
    if (!config) throw new Error("This hook runner has no configuration file.");
    const commands = parseHooksDocument(document, config.path);
    const admitted = document as Record<string, unknown>;
    return serializeByKey(this.configWrites, config.path, async () => {
      await mkdir(dirname(config.path), { recursive: true });
      await writePrivateJsonAtomic(config.path, admitted);
      this.commands = commands;
      this.commandConfig = { path: config.path, document: admitted };
      return this.commandConfig;
    });
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
          timeoutMs: timeoutMs(options.timeoutSeconds, this.handlerTimeoutMs, `${event} timeoutSeconds`),
        };
        if (options.settingsKey !== undefined) {
          if (!SETTINGS_KEY.test(options.settingsKey)) {
            throw new Error("settingsKey must match [a-z][a-z0-9_]*.");
          }
          registered.settingsKey = options.settingsKey;
        }
        this.handlers[event].push(registered);
      },
    } as GhostHookAPI);
  }

  private async runCommandFailOpen(
    hook: CommandHook,
    event: GhostHookEvent,
  ): Promise<GhostHookResult | undefined> {
    const logger = this.logger.child({
      ghost: event.ghost_name,
      conversation: event.conversation_id,
    });
    try {
      return parseCommandResult(hook, await this.commandRunner(hook, event), logger);
    } catch {
      logger.warn(`${hook.eventName} hook failed open`, {
        source: hook.source,
        error: "command execution failed",
      });
      return undefined;
    }
  }

  hasHandlers(event: GhostHookEvent["type"]): boolean {
    return this.handlers[event].length > 0 || this.commands.some((hook) => hook.eventName === event);
  }

  status(): GhostHookStatus {
    const eventOrder = ["before_prompt", "session_stop"] as const;
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
          source: "builtin",
          name: hook.name,
          description: hook.description,
          ...(hook.settingsKey === undefined ? {} : { settingsKey: hook.settingsKey }),
        });
      }
      for (const hook of this.commands.filter((command) => command.eventName === event)) {
        hooks.push({
          event,
          source: "config",
          name: hook.name,
          description: hook.description,
        });
      }
    }
    const total = events.reduce((sum, event) => sum + event.count, 0);
    return {
      active: total > 0,
      total,
      events,
      hooks,
    };
  }

  private async runHandler(
    handler: GhostHookHandler,
    event: GhostHookEvent,
    handlerTimeout = this.handlerTimeoutMs,
  ): Promise<GhostHookResult | undefined> {
    if (event.signal.aborted) return undefined;
    const logger = this.logger.child({
      ghost: event.ghost_name,
      conversation: event.conversation_id,
    });
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
        logger.warn(`${event.type} hook failed open`, {
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
      logger.warn(`${event.type} hook timed out`, {
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

}
