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
export type GhostHookEvent = GhostSessionStopEvent | GhostTurnEndEvent;

/** The admitted `hooks.json` document and where it lives. */
export interface GhostHookCommandConfig {
  path: string;
  document: Record<string, unknown>;
}

export interface CommandHook {
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
  const additional = result.additionalContext || undefined;
  const reason = result.reason || undefined;
  if (result.continue === true) return additional ?? reason;
  if (result.decision === "block") return reason ?? additional;
  return undefined;
}


/** Every hook event, in the order hooks are loaded, with a handler's default name and description. */
const HOOK_EVENTS: Record<GhostHookEvent["type"], { name: string; description: string }> = {
  session_stop: { name: "Session-stop command hook", description: "Runs after the assistant pass and may continue it." },
  turn_end: { name: "Turn-end command hook", description: "Observes final turn success or failure without continuing it." },
};

/**
 * Events earlier versions ran. At startup a `hooks.json` naming one is
 * admitted without it, so an upgrade never stops the daemon; a write through
 * `PUT /api/hooks/config` still refuses it.
 */
const RETIRED_HOOK_EVENTS: ReadonlySet<string> = new Set(["before_prompt"]);

function displayText(value: unknown, fallback: string, label: string, maximum: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

/**
 * A document `parseHooksDocument` admitted at startup, as `PUT
 * /api/hooks/config` would accept it: only `hooks`, without retired events.
 * The daemon serves this, so the next edit writes the file clean.
 */
export function admittedHooksDocument(document: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(document.hooks)) return {};
  return { hooks: Object.fromEntries(Object.entries(document.hooks).filter(([eventName]) => !RETIRED_HOOK_EVENTS.has(eventName))) };
}

/**
 * Admit one `hooks.json` document. Every error names the offending field the
 * same way whether the document came from disk or from `PUT /api/hooks/config`.
 */
export function parseHooksDocument(
  parsed: unknown,
  path: string,
  /** Given at startup: told of each retired event skipped instead of refused. */
  onRetired?: (eventName: string) => void,
): CommandHook[] {
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
  const hooks = parsed.hooks;
  if (hooks === undefined) return [];
  if (!isRecord(hooks)) throw new Error(`${path}: "hooks" must be an object.`);
  for (const eventName of Object.keys(hooks)) {
    if (Object.hasOwn(HOOK_EVENTS, eventName)) continue;
    if (!RETIRED_HOOK_EVENTS.has(eventName)) {
      throw new Error(`${path}: unsupported hook event ${JSON.stringify(eventName)}.`);
    }
    if (!onRetired) throw new Error(`${path}: hook event ${JSON.stringify(eventName)} was retired; remove it.`);
    onRetired(eventName);
  }

  const result: CommandHook[] = [];
  for (const eventName of Object.keys(HOOK_EVENTS) as GhostHookEvent["type"][]) {
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
        const name = displayText(raw.name, HOOK_EVENTS[eventName].name, `${path}: ${label}.name`, 80);
        const description = displayText(
          raw.description,
          HOOK_EVENTS[eventName].description,
          `${path}: ${label}.description`,
          240,
        );
        result.push({
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

export interface HookCommandResult {
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
  result: HookCommandResult,
  warn: (message: string, details: Record<string, unknown>) => void,
): GhostSessionStopResult | undefined {
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

export async function runSessionStopHooks(
  commands: readonly CommandHook[], event: GhostSessionStopEvent,
  invoke: (hook: CommandHook, event: GhostSessionStopEvent) => Promise<GhostSessionStopResult | undefined>,
): Promise<GhostSessionStopResult | undefined> {
  if (event.signal.aborted) return undefined;
  for (const command of commands.filter((hook) => hook.eventName === "session_stop")) {
    const result = await invoke(command, event);
    if (ghostSessionStopContinuation(result)) return result;
  }
  return undefined;
}
