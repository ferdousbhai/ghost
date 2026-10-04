/**
 * The turn wire: the SSE events one `POST /messages` turn streams, the same
 * for every harness. Clients ignore event types they do not know.
 */
import { requireConversationId } from "./conversation-log.js";

export type TurnEvent =
  | { type: "start" }
  | {
      type: "owner_message";
      text: string;
    }
  | {
      type: "session_stop_continued";
      reason: string;
    }
  | { type: "hook_start"; name: string }
  | { type: "hook_end"; name: string }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | {
      type: "tool_execution_start";
      id: string;
      toolName: string;
      arguments: unknown;
      cwd: string;
      intent?: string;
    }
  | {
      type: "tool_execution_update";
      id: string;
      toolName: string;
      summary?: string;
    }
  | {
      type: "tool_execution_end";
      id: string;
      toolName: string;
      isError: boolean;
      summary?: string;
    }
  | {
      type: "done";
      reason: "stop";
    }
  | LimitReachedEvent
  | {
      type: "error";
      reason: string;
      errorMessage?: string;
    };

/**
 * A harness refused on quota. Sent before the terminal `error`, so the HUD
 * and hooks can name the limit instead of a generic failure.
 */
export interface LimitReachedEvent {
  type: "limit_reached";
  harness: string;
  kind: "rate_limit" | "usage_limit" | "overloaded" | "billing";
  message: string;
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

export class TurnRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TurnRequestError";
    this.code = code;
  }
}

/** Parse a turn request body, `{ prompt, sessionId? }`. */
export function parseTurnRequest(body: unknown): TurnRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TurnRequestError("invalid_request", "Request body must be a JSON object.");
  }
  const { prompt, sessionId } = body as { prompt?: unknown; sessionId?: unknown };
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new TurnRequestError("invalid_request", "\"prompt\" must be non-empty text.");
  }
  return {
    sessionId: typeof sessionId === "string" && sessionId ? requireConversationId(sessionId) : null,
    prompt: prompt.trim(),
  };
}
