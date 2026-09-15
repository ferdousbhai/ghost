import {
  isValidConversationId,
  MAX_CONVERSATION_ID_SCALARS,
} from "./conversation-identity.js";

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

/** The message fields the wire projection reads, whichever runtime produced them. */
export interface RuntimeMessage {
  role: string;
  content?: unknown;
  attribution?: string;
  display?: boolean;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * The session events the wire projection understands. Both agent runtimes
 * emit this structural shape; everything else they emit is ignored.
 */
export type RuntimeSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "message_start"; message: RuntimeMessage }
  | { type: "message_update"; message: RuntimeMessage; assistantMessageEvent: unknown }
  | { type: "message_end"; message: RuntimeMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "retry_fallback_applied"; from: string; to: string; role: string }
  | { type: "retry_fallback_succeeded"; model: string; role: string };

/** Narrow a runtime's own event union at the subscription seam. */
export function asRuntimeSessionEvent(event: { type: string }): RuntimeSessionEvent {
  return event as RuntimeSessionEvent;
}

export type PiMessagesEvent =
  | { type: "start" }
  | {
      type: "owner_message";
      text: string;
    }
  | {
      type: "command_output";
      command: string;
      output: string;
      isError?: boolean;
      code?: "unsupported_command" | "command_failed";
    }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: { type?: "toolCall"; id: string; name: string; arguments: unknown };
    }
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
      type: "model_fallback";
      phase: "applied";
      from: string;
      to: string;
      role: string;
    }
  | {
      type: "branch_changed";
      transcript: TranscriptWireView;
    }
  | {
      type: "model_fallback";
      phase: "succeeded";
      model: string;
      role: string;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      usage: Usage;
      responseId?: string;
    }
  | LimitReachedEvent
  | {
      type: "error";
      reason: string;
      usage: Usage;
      errorMessage?: string;
      responseId?: string;
    };

/**
 * A harness or provider refused on quota. Sent before the terminal `error`
 * (or on its own when the runtime reports a limit without ending the turn),
 * so the HUD and hooks can say "limit, resets at …" instead of a generic
 * failure. `resetsAt` is ISO time when the runtime knows it.
 */
export interface LimitReachedEvent {
  type: "limit_reached";
  harness: "pi";
  kind: "rate_limit" | "usage_limit" | "overloaded" | "billing";
  window?: string;
  resetsAt?: string;
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

export interface TranscriptWireView {
  id: string;
  title: string | null;
  messages: unknown[];
  total: number;
  truncated: boolean;
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

export function addUsage(total: Usage, delta: Usage | undefined): void {
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

export function copyUsage(usage: Usage): Usage {
  return { ...usage, cost: { ...usage.cost } };
}


export interface PiMessagesRequest {
  model: string | null;
  sessionId: string | null;
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
  if (typeof sessionId === "string" && !isValidConversationId(sessionId)) {
    throw new PiMessagesRequestError(
      "invalid_conversation_id",
      `Conversation ids must contain 1-${MAX_CONVERSATION_ID_SCALARS} Unicode scalar values.`,
    );
  }
  return {
    model: typeof request.model === "string" && request.model ? request.model : null,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : null,
    prompt,
  };
}


export interface PiMessagesAdapterOptions {
  /**
   * Forward `thinking_*` blocks. Off by default: reasoning quotes the ghost's
   * private memory and owner-shared notes verbatim, and the hosted UI never showed it to
   * users either. Suppressed blocks consume no wire index.
   */
  includeThinking?: boolean;
  /**
   * Owner messages already rendered before this adapter subscribed. A normal
   * prompt skips one; later dequeued steering/follow-ups still cross the wire.
   */
  skipOwnerMessages?: number;
  deferAgentEnd?: boolean;
  getCwd?: () => string;
}

export interface PiMessagesAdapter {
  handle(event: RuntimeSessionEvent): void;
  finishDone(reason?: "stop" | "length" | "toolUse"): void;
  finishError(error: unknown, aborted?: boolean): void;
  isTerminal(): boolean;
  totalUsage(): Usage;
}

type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: string; [key: string]: unknown };

const TOOL_SUMMARY_LIMIT = 240;

/**
 * One bounded line of what a tool actually returned, from either a pi tool
 * result or a provider `tool_result` block. Both runtimes put this on the wire
 * as the live `summary`, so the HUD reads one shape whatever ran the tool.
 */
export function toolResultSummary(result: unknown): string | undefined {
  let text: string | undefined;
  if (typeof result === "string") text = result;
  else if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      text = content
        .filter((part): part is { type: "text"; text: string } =>
          Boolean(part)
          && typeof part === "object"
          && (part as { type?: unknown }).type === "text"
          && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text)
        .join(" ");
    }
  }
  const compact = text?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > TOOL_SUMMARY_LIMIT
    ? `${compact.slice(0, TOOL_SUMMARY_LIMIT - 1)}…`
    : compact;
}

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
  const deferAgentEnd = options.deferAgentEnd === true;
  let ownerMessagesToSkip = Math.max(0, options.skipOwnerMessages ?? 0);
  const usage = zeroUsage();
  let started = false;
  let terminal = false;
  let nextWireIndex = 0;
  let wireIndexByStepIndex = new Map<number, number>();
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;

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
        if (block?.type !== "toolCall") return;
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
        if (block?.type !== "toolCall") return;
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
        case "message_start": {
          const message = event.message;
          // Forced /skill prompts are persisted as displayable custom messages
          // attributed to the owner. Count that as the POST's already-rendered
          // input too, or the first later steer would consume the skip instead.
          const ownerAuthored = message.role === "user"
            || (message.role === "custom"
              && message.attribution === "user"
              && message.display !== false);
          if (ownerAuthored) {
            const text = textFromParts(message.content).trim();
            if (!text) return;
            if (ownerMessagesToSkip > 0) {
              ownerMessagesToSkip -= 1;
              return;
            }
            ensureStarted();
            send({ type: "owner_message", text });
            return;
          }
          if (event.message.role !== "assistant") return;
          // A new provider step: its contentIndex numbering restarts at 0.
          wireIndexByStepIndex = new Map();
          ensureStarted();
          return;
        }
        case "message_update": {
          if (event.message.role !== "assistant") return;
          handleAssistantMessageEvent(
            event.assistantMessageEvent as Parameters<typeof handleAssistantMessageEvent>[0],
          );
          return;
        }
        case "message_end": {
          const message = event.message;
          if (message.role !== "assistant") return;
          addUsage(usage, message.usage);
          lastStopReason = message.stopReason;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            ensureStarted();
            // The runtime owns retry/fallback recovery after a failed provider step.
            // Do not terminate the Ghost stream here: a later model may still
            // answer this same turn. `finishDone` turns the *last* failed step
            // into an error only after AgentSession.prompt() has settled.
            lastErrorMessage = message.errorMessage;
          } else {
            lastErrorMessage = undefined;
          }
          return;
        }
        case "tool_execution_start":
          ensureStarted();
          send({
            type: "tool_execution_start",
            id: event.toolCallId,
            toolName: event.toolName,
            arguments: event.args,
            cwd: options.getCwd?.() ?? process.cwd(),
            ...(event.intent ? { intent: event.intent } : {}),
          });
          return;
        case "tool_execution_update": {
          ensureStarted();
          const summary = toolResultSummary(event.partialResult);
          send({
            type: "tool_execution_update",
            id: event.toolCallId,
            toolName: event.toolName,
            ...(summary ? { summary } : {}),
          });
          return;
        }
        case "tool_execution_end": {
          ensureStarted();
          const summary = toolResultSummary(event.result);
          send({
            type: "tool_execution_end",
            id: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError === true,
            ...(summary ? { summary } : {}),
          });
          return;
        }
        case "retry_fallback_applied":
          ensureStarted();
          send({
            type: "model_fallback",
            phase: "applied",
            from: event.from,
            to: event.to,
            role: event.role,
          });
          return;
        case "retry_fallback_succeeded":
          ensureStarted();
          send({
            type: "model_fallback",
            phase: "succeeded",
            model: event.model,
            role: event.role,
          });
          return;
        case "agent_end":
          // A retrying run ends its failed attempt with `willRetry`; the turn
          // is not over until an attempt ends without it.
          if (event.willRetry || deferAgentEnd) return;
          this.finishDone();
          return;
        default:
          return;
      }
    },
    finishDone(reason) {
      ensureStarted();
      if (lastStopReason === "error" || lastStopReason === "aborted") {
        const kind = lastStopReason === "error" && lastErrorMessage
          ? classifyLimitMessage(lastErrorMessage)
          : null;
        if (kind) send({ type: "limit_reached", harness: "pi", kind, message: lastErrorMessage ?? "" });
        send({
          type: "error",
          reason: lastStopReason,
          usage: copyUsage(usage),
          ...(lastErrorMessage ? { errorMessage: lastErrorMessage } : {}),
        });
        return;
      }
      const resolved = reason
        ?? (lastStopReason === "length" || lastStopReason === "toolUse"
          ? lastStopReason
          : "stop");
      send({ type: "done", reason: resolved, usage: copyUsage(usage) });
    },
    finishError(error, aborted = false) {
      ensureStarted();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const kind = aborted ? null : classifyLimitMessage(errorMessage);
      if (kind) send({ type: "limit_reached", harness: "pi", kind, message: errorMessage });
      send({
        type: "error",
        reason: aborted ? "aborted" : "error",
        usage: copyUsage(usage),
        errorMessage,
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
