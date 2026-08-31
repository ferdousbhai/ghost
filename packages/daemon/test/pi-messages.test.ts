import { describe, expect, it } from "vitest";
import {
  createPiMessagesAdapter,
  encodeSseEvent,
  parsePiMessagesRequest,
  PiMessagesRequestError,
  textFromParts,
  type PiMessagesEvent,
  type RuntimeSessionEvent as AgentSessionEvent,
} from "../src/pi-messages.js";
import { parseSseStream } from "./helpers/fixtures.js";

function assistantMessage(fields: Record<string, unknown> = {}): never {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "ghost-local",
    model: "mock-ghost-1",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...fields,
  } as never;
}

function ownerMessage(text: string): AgentSessionEvent {
  return {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  } as AgentSessionEvent;
}

function ownerCustomMessage(text: string): AgentSessionEvent {
  return {
    type: "message_start",
    message: {
      role: "custom",
      customType: "skill-prompt",
      content: text,
      display: true,
      attribution: "user",
      timestamp: 0,
    },
  } as unknown as AgentSessionEvent;
}

function collect(): { events: PiMessagesEvent[]; emit: (e: PiMessagesEvent) => void } {
  const events: PiMessagesEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

function textStep(text: string, stepIndex = 0): AgentSessionEvent[] {
  const partial = { content: [] as Array<{ type: string; text?: string }> };
  partial.content[stepIndex] = { type: "text", text };
  return [
    { type: "message_start", message: assistantMessage() },
    {
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "text_start", contentIndex: stepIndex, partial },
    },
    {
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: stepIndex,
        delta: text,
        partial,
      },
    },
    {
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: stepIndex,
        content: text,
        partial,
      },
    },
    { type: "message_end", message: assistantMessage() },
  ] as unknown as AgentSessionEvent[];
}

function toolStep(id: string, name: string, args: string): AgentSessionEvent[] {
  const partial = {
    content: [{ type: "toolCall", id, name, arguments: JSON.parse(args) }],
  };
  return [
    { type: "message_start", message: assistantMessage() },
    {
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
    },
    {
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: args,
        partial,
      },
    },
    {
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial },
    },
    { type: "message_end", message: assistantMessage({ stopReason: "toolUse" }) },
  ] as unknown as AgentSessionEvent[];
}

describe("createPiMessagesAdapter", () => {
  it("surfaces later owner-attributed passes but not the prompt the shell already rendered", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit, { skipOwnerMessages: 1 });

    adapter.handle(ownerMessage("Start the turn."));
    for (const event of toolStep("call_1", "read", '{"path":"notes.md"}')) {
      adapter.handle(event);
    }
    adapter.handle(ownerMessage("Use the shorter version."));
    for (const event of textStep("Short answer.")) adapter.handle(event);
    adapter.finishDone();

    expect(events.filter((event) => event.type === "owner_message")).toEqual([
      { type: "owner_message", text: "Use the shorter version." },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "owner_message",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  it("counts a forced skill prompt as the already-rendered owner message", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit, { skipOwnerMessages: 1 });

    adapter.handle(ownerCustomMessage("Forced skill instructions"));
    adapter.handle(ownerMessage("Steer after the skill starts."));
    adapter.finishDone();

    expect(events).toEqual([
      { type: "start" },
      { type: "owner_message", text: "Steer after the skill starts." },
      expect.objectContaining({ type: "done" }),
    ]);
  });

  it("emits exactly one start and one terminal done", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    for (const event of textStep("hello")) adapter.handle(event);
    adapter.handle({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);

    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events[0]?.type).toBe("start");
    const terminal = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "done", reason: "stop" });
    expect(adapter.isTerminal()).toBe(true);
  });

  it("renumbers contentIndex densely across provider steps", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    // Step 1: a tool call at the step's own contentIndex 0.
    for (const event of toolStep("call_1", "ghost_character", '{"action":"read"}')) {
      adapter.handle(event);
    }
    // Step 2: text, again at the step's own contentIndex 0.
    for (const event of textStep("the answer")) adapter.handle(event);
    adapter.handle({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);

    const indices = events
      .filter((event) => "contentIndex" in event)
      .map((event) => (event as { contentIndex: number }).contentIndex);
    // Tool block is wire index 0; the second step's text is wire index 1,
    // not 0 again — the client indexes one flat content array.
    expect(indices).toEqual([0, 0, 0, 1, 1, 1]);
    const toolStart = events.find((event) => event.type === "toolcall_start");
    expect(toolStart).toMatchObject({
      contentIndex: 0,
      id: "call_1",
      toolName: "ghost_character",
    });
    const textStart = events.find((event) => event.type === "text_start");
    expect(textStart).toMatchObject({ contentIndex: 1 });
  });

  it("forwards OMP tool execution state with bounded text summaries", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "ghost_character",
      args: { action: "read" },
      intent: "Recall the restoration details",
    } as AgentSessionEvent);
    adapter.handle({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "ghost_character",
      args: { action: "read" },
      partialResult: { content: [{ type: "text", text: "Reading the doc now." }] },
    } as AgentSessionEvent);
    adapter.handle({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "ghost_character",
      result: { content: [{ type: "text", text: "x".repeat(400) }] },
      isError: false,
    } as AgentSessionEvent);

    expect(events).toEqual([
      { type: "start" },
      expect.objectContaining({
        type: "tool_execution_start",
        id: "call_1",
        arguments: { action: "read" },
      }),
      expect.objectContaining({ type: "tool_execution_update", summary: "Reading the doc now." }),
      expect.objectContaining({ type: "tool_execution_end", isError: false }),
    ]);
    const end = events.at(-1) as Extract<PiMessagesEvent, { type: "tool_execution_end" }>;
    expect(end.summary?.length).toBeLessThanOrEqual(240);
    expect(end.summary?.endsWith("…")).toBe(true);
  });

  it("surfaces OMP model fallback application and recovery", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({
      type: "retry_fallback_applied",
      from: "openai-codex/gpt-5.6-sol",
      to: "anthropic/claude-sonnet-4-6",
      role: "default",
    } as AgentSessionEvent);
    adapter.handle({
      type: "retry_fallback_succeeded",
      model: "anthropic/claude-sonnet-4-6",
      role: "default",
    } as AgentSessionEvent);
    expect(events).toEqual([
      { type: "start" },
      {
        type: "model_fallback",
        phase: "applied",
        from: "openai-codex/gpt-5.6-sol",
        to: "anthropic/claude-sonnet-4-6",
        role: "default",
      },
      {
        type: "model_fallback",
        phase: "succeeded",
        model: "anthropic/claude-sonnet-4-6",
        role: "default",
      },
    ]);
  });

  it("suppresses thinking by default and consumes no wire index for it", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    const partial = { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "public" }] };
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    adapter.handle({ type: "message_start", message: assistantMessage() } as AgentSessionEvent);
    for (const inner of [
      { type: "thinking_start", contentIndex: 0, partial },
      { type: "thinking_delta", contentIndex: 0, delta: "private", partial },
      { type: "thinking_end", contentIndex: 0, content: "private", partial },
      { type: "text_start", contentIndex: 1, partial },
      { type: "text_delta", contentIndex: 1, delta: "public", partial },
    ]) {
      adapter.handle({
        type: "message_update",
        message: assistantMessage(),
        assistantMessageEvent: inner,
      } as unknown as AgentSessionEvent);
    }
    adapter.finishDone();

    expect(events.some((event) => event.type.startsWith("thinking"))).toBe(false);
    // The text block takes wire index 0, not 1: suppressed blocks are free.
    expect(events.find((event) => event.type === "text_start"))
      .toMatchObject({ contentIndex: 0 });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("forwards thinking when asked", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit, { includeThinking: true });
    const partial = { content: [{ type: "thinking", thinking: "shown" }] };
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    adapter.handle({ type: "message_start", message: assistantMessage() } as AgentSessionEvent);
    adapter.handle({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial },
    } as unknown as AgentSessionEvent);
    adapter.finishDone();
    expect(events.some((event) => event.type === "thinking_start")).toBe(true);
  });

  it("aggregates usage across every step", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    for (const event of toolStep("call_1", "ghost_character", '{"action":"read"}')) {
      adapter.handle(event);
    }
    for (const event of textStep("done")) adapter.handle(event);
    adapter.handle({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);

    const done = events.at(-1) as Extract<PiMessagesEvent, { type: "done" }>;
    expect(done.usage.input).toBe(20);
    expect(done.usage.output).toBe(10);
    expect(done.usage.totalTokens).toBe(30);
  });

  it("does not terminate while pi is going to retry", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    adapter.handle({ type: "agent_end", messages: [], willRetry: true } as AgentSessionEvent);
    expect(adapter.isTerminal()).toBe(false);
    for (const event of textStep("second attempt")) adapter.handle(event);
    adapter.handle({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("holds a failed provider step open for OMP recovery, then terminates if it stays failed", () => {
    const { events, emit } = collect();
    const adapter = createPiMessagesAdapter(emit);
    adapter.handle({ type: "agent_start" } as AgentSessionEvent);
    adapter.handle({
      type: "message_end",
      message: assistantMessage({ stopReason: "error", errorMessage: "provider exploded" }),
    } as AgentSessionEvent);
    expect(adapter.isTerminal()).toBe(false);
    adapter.finishDone();
    const terminal = events.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
    expect(terminal).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: "provider exploded",
    });
    // Nothing after the settled terminal event reaches the wire.
    adapter.finishDone();
    expect(events.filter((event) => event.type === "done")).toHaveLength(0);
  });

  it("always produces a terminal event, even with no agent events at all", () => {
    const { events, emit } = collect();
    createPiMessagesAdapter(emit).finishError(new Error("no model configured"));
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
  });
});

describe("SSE framing", () => {
  it("round-trips through the pinned client's parser", () => {
    const events: PiMessagesEvent[] = [
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hi\n\nthere" },
      {
        type: "done",
        reason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ];
    // Keepalive comments and a trailing [DONE] must be invisible.
    const body = `: keepalive\n\n${events.map(encodeSseEvent).join("")}data: [DONE]\n\n`;
    expect(parseSseStream(body)).toEqual(events);
  });
});

describe("parsePiMessagesRequest", () => {
  it("takes the newest user text and the session id", () => {
    const parsed = parsePiMessagesRequest({
      model: "ghost/casper",
      context: {
        systemPrompt: "IGNORE ME",
        messages: [
          { role: "user", content: [{ type: "text", text: "older" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
          { role: "user", content: [{ type: "text", text: "newest" }] },
        ],
      },
      options: { sessionId: "conv-1" },
    });
    expect(parsed).toEqual({ model: "ghost/casper", sessionId: "conv-1", prompt: "newest" });
  });

  it("preserves a 200-scalar id and rejects overflow or lone surrogates", () => {
    const request = (sessionId: string) => ({
      context: { messages: [{ role: "user", content: "hello" }] },
      options: { sessionId },
    });
    const atLimit = `${"a".repeat(199)}\u{1f47b}`;
    expect(parsePiMessagesRequest(request(atLimit)).sessionId).toBe(atLimit);
    for (const invalid of ["", "a".repeat(201), "\ud800", "\udc00"]) {
      expect(() => parsePiMessagesRequest(request(invalid))).toThrow(expect.objectContaining({
        code: "invalid_conversation_id",
      }));
    }
  });

  it("accepts a bare string content", () => {
    expect(parsePiMessagesRequest({
      context: { messages: [{ role: "user", content: "hello" }] },
    }).prompt).toBe("hello");
  });

  it("rejects a body with no user text", () => {
    expect(() => parsePiMessagesRequest({ context: { messages: [{ role: "assistant" }] } }))
      .toThrowError(PiMessagesRequestError);
    expect(() => parsePiMessagesRequest({ context: { messages: [] } }))
      .toThrowError(/non-empty array/);
    expect(() => parsePiMessagesRequest("nope")).toThrowError(/JSON object/);
  });

  it("flattens content parts and drops non-text", () => {
    expect(textFromParts([
      { type: "text", text: "a" },
      { type: "image", data: "..." },
      { type: "text", text: "b" },
    ])).toBe("a\nb");
  });
});
