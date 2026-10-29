/**
 * The turn wire: the SSE events one `POST /messages` turn streams, the same
 * for every harness, plus the `resume` frame that ends a response cut for
 * size. Clients ignore event types they do not know.
 */
import { requireConversationId } from "./conversation-log.js";
import { GhostError } from "./errors.js";
import type { RunResourceSnapshot } from "./run-resources.js";

export type TurnEvent =
  | { type: "start" }
  /** A pass starting on this harness: the first, or the next after one failed. */
  | { type: "harness"; harness: string }
  | ({ type: "resources" } & RunResourceSnapshot)
  /** The follow-ups still waiting, sent whenever one is queued or starts. */
  | { type: "queue"; followUp: string[] }
  | {
      type: "owner_message";
      text: string;
    }
  | {
      type: "session_stop_continued";
      reason: string;
    }
  /** An owner command hook running; a `session_stop` one runs after the reply is complete. */
  | { type: "hook_start"; name: string; event: "before_prompt" | "session_stop" }
  | { type: "hook_end"; name: string; event: "before_prompt" | "session_stop" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  /** The harness's reasoning, as far as it shows it; a new block starts on a new line. */
  | { type: "thinking"; delta: string }
  | {
      type: "tool_execution_start";
      id: string;
      toolName: string;
      arguments: unknown;
      cwd: string;
    }
  | {
      type: "tool_execution_update";
      id: string;
      summary?: string;
    }
  | {
      type: "tool_execution_end";
      id: string;
      toolName: string;
      isError: boolean;
      summary?: string;
    }
  | { type: "done" }
  | LimitReachedEvent
  | {
      type: "error";
      reason: string;
      errorMessage?: string;
    };

/**
 * The last frame of a turn response cut for size, never a terminal: the turn
 * runs on, and `GET …/sessions/:id/stream?turn=<turn>&from=<from>` continues it.
 */
export interface TurnResumeEvent {
  type: "resume";
  turn: string;
  from: number;
}

/**
 * A harness refused on quota. Sent before the terminal `error`, whose
 * message it classifies, so the HUD and CLI can name the limit.
 */
export interface LimitReachedEvent {
  type: "limit_reached";
  harness: string;
  kind: "rate_limit" | "usage_limit" | "overloaded" | "billing";
}

const LIMIT_PATTERNS: ReadonlyArray<[RegExp, LimitReachedEvent["kind"]]> = [
  [/\b429\b|rate.?limit|too many requests/iu, "rate_limit"],
  [/usage limit|hit your limit|limit reached|quota|exceeded your|out of credits|insufficient(_| )credits/iu, "usage_limit"],
  [/overloaded|capacity|503\b|529\b/iu, "overloaded"],
  [/billing|payment|credit balance/iu, "billing"],
];

/** The kind of limit a runtime's error text describes, or null for an ordinary failure. */
export function classifyLimitMessage(text: string): LimitReachedEvent["kind"] | null {
  for (const [pattern, kind] of LIMIT_PATTERNS) if (pattern.test(text)) return kind;
  return null;
}

/** A date, with an optional time, after words that announce a return: "regain access on 2026-11-01 at 00:00 UTC". */
const STATED_DATE = /(?:regain access|access (?:returns|resumes)|resets?|available again|try again|retry)\D{0,24}?(\d{4}-\d{2}-\d{2})(?:(?:\s+at\s+|T)(\d{1,2}):(\d{2}))?/iu;
/** A span: "try again in 30 minutes", "retry after 120 seconds", "resets in 2 hours". */
const STATED_SPAN = /(?:try again|retry|resets?)\s+(?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/iu;
const SPAN_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** No refusal is believed past a month; a wrong parse costs at most that. */
const MAX_STATED_WAIT_MS = 31 * 86_400_000;

/**
 * When a refusal says access returns, as epoch milliseconds: a stated date
 * (read as UTC, the zone providers state) or a stated span from `now`. Null
 * when it states none, or nothing in the future within a month.
 */
export function statedReturn(text: string, now: number): number | null {
  let at: number | null = null;
  const date = STATED_DATE.exec(text);
  if (date) {
    const [year, month, day] = (date[1] as string).split("-").map(Number) as [number, number, number];
    at = Date.UTC(year, month - 1, day, Number(date[2] ?? 0), Number(date[3] ?? 0));
  } else {
    const span = STATED_SPAN.exec(text);
    if (span) at = now + Number(span[1]) * (SPAN_MS[(span[2] as string)[0]?.toLowerCase() ?? ""] ?? 0);
  }
  if (at === null || !Number.isFinite(at) || at <= now || at - now > MAX_STATED_WAIT_MS) return null;
  return at;
}

export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export const SSE_KEEPALIVE_COMMENT = ": keepalive\n\n";
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  // Local only, but a proxy in front of the daemon must not buffer the turn.
  "x-accel-buffering": "no",
};

export interface TurnRequest {
  sessionId: string | null;
  prompt: string;
}

/** Parse a turn request body, `{ prompt, sessionId? }`. */
export function parseTurnRequest(body: Record<string, unknown>): TurnRequest {
  const { prompt, sessionId } = body;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new GhostError("invalid_request", "\"prompt\" must be non-empty text.", 400);
  }
  return {
    sessionId: typeof sessionId === "string" && sessionId ? requireConversationId(sessionId) : null,
    prompt: prompt.trim(),
  };
}
