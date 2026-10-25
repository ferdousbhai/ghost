import { isRecord } from "./record.js";
const GHOST_HOOK_HANDLER_TIMEOUT_MS = 30_000;

export interface GhostHookEventBase {
  session_id: string;
  session_file: string;
  signal: AbortSignal;
  ghost_name: string;
  ghost_home: string;
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
  last_assistant_message: unknown;
  stop_hook_active: boolean;
  /** The conversation log on disk; `messages` carries only the current pass. */
  transcript_path: string;
}

export interface GhostSessionStopResult {
  continue?: boolean;
  additionalContext?: string;
  decision?: "block";
  reason?: string;
}

export interface GhostTurnEndEvent extends GhostHookEventBase {
  type: "turn_end";
  turn_id: string;
  outcome: "done" | "error";
  title: string;
  excerpt: string;
  url: string | null;
}
export type GhostHookEvent = GhostBeforePromptEvent | GhostSessionStopEvent | GhostTurnEndEvent;
export type GhostHookResult = GhostBeforePromptResult | GhostSessionStopResult;

/** The admitted `hooks.json` document and where it lives. */
export interface GhostHookCommandConfig {
  path: string;
  document: Record<string, unknown>;
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


function defaultHookName(event: GhostHookEvent["type"]): string {
  return `${event === "before_prompt" ? "Before-prompt" : event === "turn_end" ? "Turn-end" : "Session-stop"} command hook`;
}

function defaultHookDescription(event: GhostHookEvent["type"]): string {
  return event === "turn_end" ? "Observes final turn success or failure without continuing it." : event === "before_prompt"
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
export function parseHooksDocument(parsed: unknown, path: string): { commands: CommandHook[] } {
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return { commands: parseCommandHooks(parsed, path) };
}

function parseCommandHooks(parsed: Record<string, unknown>, path: string): CommandHook[] {
  const hooks = parsed.hooks;
  if (hooks === undefined) return [];
  if (!isRecord(hooks)) throw new Error(`${path}: "hooks" must be an object.`);
  const supported = new Set<GhostHookEvent["type"]>(["before_prompt", "session_stop", "turn_end"]);
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
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        throw new Error(`${path}: hooks.${eventName}[${groupIndex}].hooks must be an array.`);
      }
      for (const [handlerIndex, raw] of group.hooks.entries()) {
        const label = `hooks.${eventName}[${groupIndex}].hooks[${handlerIndex}]`;
        if (!isRecord(raw) || raw.type !== "command" || typeof raw.command !== "string"
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
  /** Stopped for writing more than 1 MB to stdout. */
  overflowed: boolean;
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
  if (result.overflowed) {
    warn(`${hook.eventName} hook wrote more than 1 MB`, { source: hook.source });
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
  if (hook.eventName === "turn_end") return undefined;
  const output = result.stdout.trim();
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output);
    if (!isRecord(parsed)) throw new Error("hook output must be a JSON object");
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
