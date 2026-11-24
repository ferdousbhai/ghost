/**
 * The turn wire: the SSE events one `POST /messages` turn streams, the same
 * for every harness, plus the `resume` frame that ends a response cut for
 * size. Clients ignore event types they do not know.
 */
import { requireConversationId } from "./conversation-log.js";
import { GhostError } from "./errors.js";

export type TurnEvent =
  | { type: "start" }
  /** A pass starting on this harness: the first, or the next after one failed. */
  | { type: "harness"; harness: string }
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
  | { type: "hook_start"; name: string; event: "session_stop" }
  | { type: "hook_end"; name: string; event: "session_stop" }
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

interface TurnRequest {
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
