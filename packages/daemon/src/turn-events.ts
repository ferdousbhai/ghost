/**
 * The turn wire: the SSE events one `POST /messages` turn streams, the same
 * for every harness. Clients ignore event types they do not know.
 */
import { requireConversationId } from "./conversation-log.js";

/** Token and cost accounting for one provider step, as pi reports it. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

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
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
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
      usage: Usage;
    }
  | LimitReachedEvent
  | {
      type: "error";
      reason: string;
      usage: Usage;
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

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

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

export function textFromParts(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      texts.push(candidate.text);
    }
  }
  return texts.join("\n");
}

/**
 * Parse a turn request body.
 *
 * Deliberately narrow: a client-supplied `systemPrompt`, `tools`, or `model`
 * is IGNORED — the ghost assembles its own persona and tools, and the harness
 * owns its model. History is ignored too: the conversation log is the
 * authority, so only the newest user message is taken from `context.messages`.
 */
export function parseTurnRequest(body: unknown): TurnRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TurnRequestError("invalid_request", "Request body must be a JSON object.");
  }
  const request = body as { context?: unknown; options?: unknown };
  const context = request.context;
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new TurnRequestError("invalid_request", "\"context\" must be an object.");
  }
  const messages = (context as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TurnRequestError(
      "invalid_request",
      "\"context.messages\" must be a non-empty array.",
    );
  }
  let prompt = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    prompt = textFromParts((message as { content?: unknown }).content).trim();
    if (prompt) break;
  }
  if (!prompt) {
    throw new TurnRequestError(
      "invalid_request",
      "\"context.messages\" must end with a user message carrying text.",
    );
  }
  const options = request.options;
  const sessionId = options && typeof options === "object"
    ? (options as { sessionId?: unknown }).sessionId
    : undefined;
  return {
    sessionId: typeof sessionId === "string" && sessionId ? requireConversationId(sessionId) : null,
    prompt,
  };
}
