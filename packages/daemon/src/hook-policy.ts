const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;

export interface GhostHookEventBase {
  session_id: string;
  session_file?: string;
  signal: AbortSignal;
  ghost_name: string;
  ghost_home?: string;
  storage?: { kind: "backend"; ghost_id: string; session_id: string };
  cwd: string;
  conversation_id: string;
  /** The harness the conversation's latest stretch ran on, when one has run. */
  harness?: string;
}

export interface GhostBeforePromptEvent extends GhostHookEventBase {
  type: "before_prompt";
  prompt: string;
  turn_id: string;
}

export interface GhostBeforePromptResult {
  additionalContext?: string;
}

export interface GhostSessionStopEvent extends GhostHookEventBase {
  type: "session_stop";
  owner_prompt: string;
  messages: unknown[];
  turn_id: string;
  last_assistant_message?: unknown;
  stop_hook_active: boolean;
  /** The conversation log on disk; `messages` carries only the current pass. */
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

export interface GhostHookStatusItem {
  event: GhostHookEvent["type"];
  name: string;
  description: string;
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

export interface CommandHook {
  type: "command";
  eventName: GhostHookEvent["type"];
  command: string;
  name: string;
  description: string;
  timeoutMs: number;
  source: string;
}

const SETTINGS_KEY = /^[a-z][a-z0-9_]*$/u;
const BUILTIN_SETTINGS_KEYS = new Set<string>();

/**
 * The `builtin` section of a `hooks.json` document once named hooks Ghost
 * registered in code. There is no such registration, so every key is refused;
 * the section is still read so an older `hooks.json` parses when it is empty
 * and says so plainly when it is not.
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

function defaultHookName(event: GhostHookEvent["type"]): string {
  return `${event === "before_prompt" ? "Before-prompt" : "Session-stop"} command hook`;
}

function defaultHookDescription(event: GhostHookEvent["type"]): string {
  return event === "before_prompt"
    ? "Adds context before the owner prompt is sent."
    : "Runs after the assistant pass and may continue it.";
}

function displayText(value: unknown, fallback: string, label: string, maximum: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

/**
 * Admit one `hooks.json` document. Every error names the offending field the
 * same way whether the document came from disk or from `PUT /api/hooks/config`.
 */
export function parseHooksDocument(parsed: unknown, path: string): CommandHook[] {
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
        const name = displayText(raw.name, defaultHookName(eventName), `${path}: ${label}.name`, 80);
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

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  executionFailed: boolean;
}

export function parseCommandResult(
  hook: CommandHook,
  result: CommandResult,
  warn: (message: string, details: Record<string, unknown>) => void,
): GhostHookResult | undefined {
  if (result.aborted) return undefined;
  if (result.executionFailed) {
    warn(`${hook.eventName} hook failed open`, {
      source: hook.source,
      error: "command execution failed",
    });
    return undefined;
  }
  if (result.timedOut) {
    warn(`${hook.eventName} hook timed out`, { source: hook.source, timeoutMs: hook.timeoutMs });
    return undefined;
  }
  if (result.exitCode === 2) {
    if (hook.eventName !== "session_stop") {
      warn(`${hook.eventName} hook attempted to block and was ignored`, { source: hook.source });
      return undefined;
    }
    return { decision: "block", reason: result.stderr.trim() || "A Ghost hook blocked the stop." };
  }
  if (result.exitCode !== 0) {
    warn(`${hook.eventName} hook failed open`, {
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
    warn(`${hook.eventName} hook returned invalid JSON`, {
      source: hook.source,
      error: "invalid hook output",
    });
    return undefined;
  }
}

export function hookStatus(commands: readonly CommandHook[]): GhostHookStatus {
  const eventOrder = ["before_prompt", "session_stop"] as const;
  const events = eventOrder.map((event) => ({
    event,
    count: commands.filter((command) => command.eventName === event).length,
  })).filter(({ count }) => count > 0);
  const hooks: GhostHookStatusItem[] = [];
  for (const event of eventOrder) {
    for (const hook of commands.filter((command) => command.eventName === event)) {
      hooks.push({ event, name: hook.name, description: hook.description });
    }
  }
  const total = events.reduce((sum, event) => sum + event.count, 0);
  return { active: total > 0, total, events, hooks };
}

export async function runBeforePromptHooks(
  commands: readonly CommandHook[], event: GhostBeforePromptEvent,
  invoke: (hook: CommandHook, event: GhostBeforePromptEvent) => Promise<GhostHookResult | undefined>,
): Promise<GhostBeforePromptResult | undefined> {
  if (event.signal.aborted) return undefined;
  const contexts: string[] = [];
  for (const command of commands.filter((hook) => hook.eventName === "before_prompt")) {
    const result = await invoke(command, event);
    if (event.signal.aborted) return undefined;
    if (typeof result?.additionalContext === "string" && result.additionalContext.length > 0) {
      contexts.push(result.additionalContext);
    }
  }
  return contexts.length ? { additionalContext: contexts.join("\n\n") } : undefined;
}

export async function runSessionStopHooks(
  commands: readonly CommandHook[], event: GhostSessionStopEvent,
  invoke: (hook: CommandHook, event: GhostSessionStopEvent) => Promise<GhostHookResult | undefined>,
): Promise<GhostSessionStopResult | undefined> {
  if (event.signal.aborted) return undefined;
  for (const command of commands.filter((hook) => hook.eventName === "session_stop")) {
    const result = await invoke(command, event) as GhostSessionStopResult | undefined;
    if (ghostSessionStopContinuation(result)) return result;
  }
  return undefined;
}
