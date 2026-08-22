/**
 * The pi-messages wire protocol, daemon side.
 *
 * The normative spec is the pinned client in `@earendil-works/pi-ai@0.84.2`
 * (`dist/api/pi-messages.js`), which the summon-ghost web UI already speaks.
 * Its contract, restated so the code below can be checked against it:
 *
 * - Request: `POST <baseUrl>/messages` with a JSON body
 *   `{ model, context: { systemPrompt?, messages, tools? }, options }`,
 *   `accept: text/event-stream`, `authorization: Bearer <key>`.
 * - Response: SSE. Frames are separated by a blank line and parsed by taking
 *   the FIRST line that starts with `data:`; a frame with no such line (an
 *   SSE comment like `: keepalive`) is skipped, and a `data: [DONE]` payload
 *   is ignored. So keepalive comments are free and `event:` names are
 *   invisible to the client — the type lives in the JSON.
 * - The client's converter rebuilds one assistant message from the stream:
 *   exactly one `start`, content blocks addressed by `contentIndex`, and
 *   exactly one terminal `done` or `error`. A stream that ends without a
 *   terminal event is an error on the client side.
 * - `contentIndex` indexes into a single array, so indices must be dense and
 *   monotonic across the WHOLE response, not per provider step.
 *
 * Everything here is pure: no HTTP, no pi session. `server.ts` wires it up.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { PiMessagesEvent } from "@earendil-works/pi-ai/api/pi-messages";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type { PiMessagesEvent };

/** SSE framing, byte-identical to the hosted relay's. */
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

function addUsage(total: Usage, delta: Usage | undefined): void {
  if (!delta) return;
  total.input += delta.input ?? 0;
  total.output += delta.output ?? 0;
  total.cacheRead += delta.cacheRead ?? 0;
  total.cacheWrite += delta.cacheWrite ?? 0;
  total.totalTokens += delta.totalTokens ?? 0;
  if (!delta.cost) return;
  total.cost.input += delta.cost.input ?? 0;
  total.cost.output += delta.cost.output ?? 0;
  total.cost.cacheRead += delta.cost.cacheRead ?? 0;
  total.cost.cacheWrite += delta.cost.cacheWrite ?? 0;
  total.cost.total += delta.cost.total ?? 0;
}

function copyUsage(usage: Usage): Usage {
  return { ...usage, cost: { ...usage.cost } };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** The parsed, trusted subset of a pi-messages request. */
export interface PiMessagesRequest {
  /** Client-requested model id. Advisory: the ghost's own config wins. */
  model: string | null;
  /** `options.sessionId` — the conversation id. */
  sessionId: string | null;
  /** The visitor's newest user message, flattened to text. */
  prompt: string;
}

export class PiMessagesRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PiMessagesRequestError";
    this.code = code;
  }
}

/** Flatten pi content parts (or a bare string) to text. */
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
 * Parse a pi-messages request body.
 *
 * Deliberately narrow: a client-supplied `systemPrompt` or `tools` array is
 * untrusted and IGNORED — the ghost assembles its own persona and tool set
 * from its home. History is ignored too: the daemon's pi session is the
 * authority on the conversation (see the deltas note in README.md), so only
 * the newest user message is taken from `context.messages`.
 */
export function parsePiMessagesRequest(body: unknown): PiMessagesRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new PiMessagesRequestError("invalid_request", "Request body must be a JSON object.");
  }
  const request = body as { model?: unknown; context?: unknown; options?: unknown };
  const context = request.context;
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new PiMessagesRequestError("invalid_request", "\"context\" must be an object.");
  }
  const messages = (context as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new PiMessagesRequestError(
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
    throw new PiMessagesRequestError(
      "invalid_request",
      "\"context.messages\" must end with a user message carrying text.",
    );
  }
  const options = request.options;
  const sessionId = options && typeof options === "object"
    ? (options as { sessionId?: unknown }).sessionId
    : undefined;
  return {
    model: typeof request.model === "string" && request.model ? request.model : null,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId.slice(0, 200) : null,
    prompt,
  };
}

// ---------------------------------------------------------------------------
// AgentSessionEvent → PiMessagesEvent
// ---------------------------------------------------------------------------

export interface PiMessagesAdapterOptions {
  /**
   * Forward `thinking_*` blocks. Off by default: reasoning quotes the ghost's
   * private memory and notes verbatim, and the hosted UI never showed it to
   * visitors either. Suppressed blocks consume no wire index.
   */
  includeThinking?: boolean;
}

export interface PiMessagesAdapter {
  /** Feed one pi `AgentSessionEvent`. Safe to call after termination. */
  handle(event: AgentSessionEvent): void;
  /** Emit the single terminal `done`. No-op once terminal. */
  finishDone(reason?: "stop" | "length" | "toolUse"): void;
  /** Emit the single terminal `error`. No-op once terminal. */
  finishError(error: unknown, aborted?: boolean): void;
  /** True once a terminal event has been emitted. */
  isTerminal(): boolean;
  /** Aggregate usage across every provider step of the turn. */
  totalUsage(): Usage;
}

type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: string; [key: string]: unknown };

/**
 * Translate one agent run into the flattened pi-messages event sequence.
 *
 * The seam is `message_update.assistantMessageEvent`: pi's agent loop
 * forwards the provider's `AssistantMessageEvent` stream there verbatim,
 * which is the same event type the hosted runtime tapped. Step boundaries
 * (`message_start` / `message_end`) are invisible on the wire, but each step
 * restarts `contentIndex` at 0, so indices are re-numbered through a single
 * monotonic counter for the whole turn.
 */
export function createPiMessagesAdapter(
  emit: (event: PiMessagesEvent) => void,
  options: PiMessagesAdapterOptions = {},
): PiMessagesAdapter {
  const includeThinking = options.includeThinking === true;
  const usage = zeroUsage();
  let started = false;
  let terminal = false;
  let nextWireIndex = 0;
  /** Per-step map: the step's own contentIndex → this turn's wire index. */
  let wireIndexByStepIndex = new Map<number, number>();
  let lastStopReason: string | undefined;

  const send = (event: PiMessagesEvent): void => {
    if (terminal) return;
    if (event.type === "done" || event.type === "error") terminal = true;
    emit(event);
  };

  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    send({ type: "start" });
  };

  const assignWireIndex = (stepIndex: number): number => {
    const assigned = nextWireIndex;
    nextWireIndex += 1;
    wireIndexByStepIndex.set(stepIndex, assigned);
    return assigned;
  };

  const handleAssistantMessageEvent = (event: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    partial?: { content?: AssistantContentBlock[] };
  }): void => {
    const stepIndex = event.contentIndex;
    const mapped = stepIndex === undefined
      ? undefined
      : wireIndexByStepIndex.get(stepIndex);
    switch (event.type) {
      case "text_start":
        if (stepIndex === undefined) return;
        ensureStarted();
        send({ type: "text_start", contentIndex: assignWireIndex(stepIndex) });
        return;
      case "text_delta":
        if (mapped === undefined || typeof event.delta !== "string") return;
        send({ type: "text_delta", contentIndex: mapped, delta: event.delta });
        return;
      case "text_end":
        if (mapped === undefined) return;
        send({ type: "text_end", contentIndex: mapped, content: event.content ?? "" });
        return;
      case "thinking_start":
        if (!includeThinking || stepIndex === undefined) return;
        ensureStarted();
        send({ type: "thinking_start", contentIndex: assignWireIndex(stepIndex) });
        return;
      case "thinking_delta":
        if (!includeThinking || mapped === undefined || typeof event.delta !== "string") return;
        send({ type: "thinking_delta", contentIndex: mapped, delta: event.delta });
        return;
      case "thinking_end":
        if (!includeThinking || mapped === undefined) return;
        send({ type: "thinking_end", contentIndex: mapped, content: event.content ?? "" });
        return;
      case "toolcall_start": {
        if (stepIndex === undefined) return;
        // pi's toolcall_start carries no id/name of its own; they are already
        // set on the partial message's content block.
        const block = event.partial?.content?.[stepIndex];
        if (!block || block.type !== "toolCall") return;
        ensureStarted();
        send({
          type: "toolcall_start",
          contentIndex: assignWireIndex(stepIndex),
          id: String((block as { id: string }).id),
          toolName: String((block as { name: string }).name),
        });
        return;
      }
      case "toolcall_delta":
        if (mapped === undefined || typeof event.delta !== "string") return;
        send({ type: "toolcall_delta", contentIndex: mapped, delta: event.delta });
        return;
      case "toolcall_end": {
        if (mapped === undefined || stepIndex === undefined) return;
        const block = event.partial?.content?.[stepIndex];
        if (!block || block.type !== "toolCall") return;
        send({
          type: "toolcall_end",
          contentIndex: mapped,
          toolCall: block as unknown as Extract<
            PiMessagesEvent,
            { type: "toolcall_end" }
          >["toolCall"],
        });
        return;
      }
      default:
        return;
    }
  };

  return {
    handle(event) {
      if (terminal) return;
      switch (event.type) {
        case "agent_start":
          ensureStarted();
          return;
        case "message_start":
          if (event.message.role !== "assistant") return;
          // A new provider step: its contentIndex numbering restarts at 0.
          wireIndexByStepIndex = new Map();
          ensureStarted();
          return;
        case "message_update": {
          if (event.message.role !== "assistant") return;
          handleAssistantMessageEvent(
            event.assistantMessageEvent as unknown as Parameters<
              typeof handleAssistantMessageEvent
            >[0],
          );
          return;
        }
        case "message_end": {
          const message = event.message as {
            role: string;
            usage?: Usage;
            stopReason?: string;
            errorMessage?: string;
          };
          if (message.role !== "assistant") return;
          addUsage(usage, message.usage);
          lastStopReason = message.stopReason;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            ensureStarted();
            send({
              type: "error",
              reason: message.stopReason,
              usage: copyUsage(usage),
              ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
            });
          }
          return;
        }
        case "agent_end":
          // An auto-retry keeps the turn alive; only a settled run terminates.
          if (event.willRetry) return;
          this.finishDone();
          return;
        default:
          return;
      }
    },
    finishDone(reason) {
      ensureStarted();
      const resolved = reason
        ?? (lastStopReason === "length" || lastStopReason === "toolUse"
          ? lastStopReason
          : "stop");
      send({ type: "done", reason: resolved, usage: copyUsage(usage) });
    },
    finishError(error, aborted = false) {
      ensureStarted();
      send({
        type: "error",
        reason: aborted ? "aborted" : "error",
        usage: copyUsage(usage),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    },
    isTerminal() {
      return terminal;
    },
    totalUsage() {
      return copyUsage(usage);
    },
  };
}
