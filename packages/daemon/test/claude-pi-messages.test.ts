import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createClaudePiMessagesAdapter } from "../src/claude-pi-messages.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";

function message(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function success(overrides: Record<string, unknown> = {}): SDKMessage {
  return message({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.012,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
    modelUsage: {},
    permission_denials: [],
    result: "hello",
    uuid: "result-1",
    session_id: "session-1",
    ...overrides,
  });
}

let uuid = 0;

function streamEvent(event: unknown): SDKMessage {
  return message({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: `stream-${++uuid}`,
    session_id: "session-1",
    event,
  });
}

/** One complete tool block: the model opens it, streams its arguments, closes it. */
function callTool(
  adapter: ReturnType<typeof createClaudePiMessagesAdapter>,
  call: { index: number; block: Record<string, unknown>; partialJson?: string },
): void {
  adapter.handle(streamEvent({
    type: "content_block_start",
    index: call.index,
    content_block: call.block,
  }));
  if (call.partialJson !== undefined) {
    adapter.handle(streamEvent({
      type: "content_block_delta",
      index: call.index,
      delta: { type: "input_json_delta", partial_json: call.partialJson },
    }));
  }
  adapter.handle(streamEvent({ type: "content_block_stop", index: call.index }));
}

function toolResults(content: unknown[]): SDKMessage {
  return message({
    type: "user",
    parent_tool_use_id: null,
    uuid: `user-${++uuid}`,
    session_id: "session-1",
    message: { role: "user", content },
  });
}

describe("Claude Agent SDK -> pi-messages", () => {
  it("streams text with dense indices and maps terminal usage", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.handle(message({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "a",
      session_id: "session-1",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    }));
    adapter.handle(message({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "b",
      session_id: "session-1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
    }));
    adapter.handle(message({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "c",
      session_id: "session-1",
      event: { type: "content_block_stop", index: 0 },
    }));
    adapter.handle(success());

    expect(events).toEqual([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hello" },
      { type: "text_end", contentIndex: 0, content: "hello" },
      {
        type: "done",
        reason: "stop",
        responseId: "session-1",
        usage: {
          input: 10,
          output: 4,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 19,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
        },
      },
    ]);
  });

  it("normalizes the chosen in-process MCP tool prefix for the existing shell", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.setInternalMcpServerName("ghost-1");
    callTool(adapter, {
      index: 0,
      block: {
        type: "mcp_tool_use",
        id: "tool-1",
        name: "mcp__ghost-1__ghost_browser",
        server_name: "ghost-1",
        input: {},
      },
      partialJson: "{\"action\":\"tabs\"}",
    });

    expect(events).toContainEqual({
      type: "toolcall_start",
      contentIndex: 0,
      id: "tool-1",
      toolName: "ghost_browser",
    });
    expect(events).toContainEqual({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "tool-1",
        name: "ghost_browser",
        arguments: { action: "tabs" },
      },
    });
  });

  it("normalizes Claude's native owner question to the shared ask wire name", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    callTool(adapter, {
      index: 0,
      block: {
        type: "tool_use",
        id: "ask-1",
        name: "AskUserQuestion",
        input: {},
      },
      partialJson: JSON.stringify({ questions: [] }),
    });

    expect(events).toContainEqual({
      type: "tool_execution_start",
      id: "ask-1",
      toolName: "ask",
      arguments: { questions: [] },
      cwd: process.cwd(),
    });
  });

  it("brackets every tool call with an execution window the HUD can narrate", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event), {
      getCwd: () => "/home/owner/project",
    });
    callTool(adapter, {
      index: 0,
      block: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      partialJson: "{\"file_path\":\"docs/design.md\"}",
    });

    expect(events).toContainEqual({
      type: "tool_execution_start",
      id: "tool-1",
      toolName: "Read",
      arguments: { file_path: "docs/design.md" },
      cwd: "/home/owner/project",
    });

    adapter.handle(toolResults([
      { type: "tool_result", tool_use_id: "tool-1", content: "# design" },
    ]));

    expect(events).toContainEqual({
      type: "tool_execution_end",
      id: "tool-1",
      toolName: "Read",
      isError: false,
      summary: "# design",
    });
  });

  it("closes a ghost tool under its visible name and keeps a failure's text", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.setInternalMcpServerName("ghost-1");
    callTool(adapter, {
      index: 0,
      block: {
        type: "mcp_tool_use",
        id: "tool-1",
        name: "mcp__ghost-1__ghost_browser",
        server_name: "ghost-1",
        input: { action: "read" },
      },
    });
    callTool(adapter, {
      index: 1,
      block: {
        type: "mcp_tool_use",
        id: "tool-2",
        name: "mcp__ghost-1__ghost_screen",
        server_name: "ghost-1",
        input: {},
      },
    });
    adapter.handle(toolResults([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "Read the departures board" }],
      },
      {
        type: "tool_result",
        tool_use_id: "tool-2",
        is_error: true,
        content: [{ type: "text", text: "No display is attached" }],
      },
    ]));

    expect(events).toContainEqual({
      type: "tool_execution_end",
      id: "tool-1",
      toolName: "ghost_browser",
      isError: false,
      summary: "Read the departures board",
    });
    expect(events).toContainEqual({
      type: "tool_execution_end",
      id: "tool-2",
      toolName: "ghost_screen",
      isError: true,
      summary: "No display is attached",
    });
  });

  it("ignores tool results for calls it never announced", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.handle(toolResults([
      { type: "tool_result", tool_use_id: "replayed", content: "stale" },
    ]));

    expect(events).toEqual([]);
  });

  it("does not leak subagent narration into the parent transcript", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.handle(message({
      type: "stream_event",
      parent_tool_use_id: "parent-tool",
      uuid: "a",
      session_id: "session-1",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "private sidechain" },
      },
    }));
    adapter.handle(success({ result: "parent answer" }));

    expect(events).toEqual([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "parent answer" },
      { type: "text_end", contentIndex: 0, content: "parent answer" },
      expect.objectContaining({ type: "done" }),
    ]);
  });
});

describe("exchange parts", () => {
  it("collects prose and tool calls in order, marks failures, and resets per exchange", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.handle(streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "Checking " },
    }));
    adapter.handle(streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "the file." },
    }));
    adapter.handle(streamEvent({ type: "content_block_stop", index: 0 }));
    callTool(adapter, {
      index: 1,
      block: { type: "tool_use", id: "call-1", name: "Read", input: {} },
      partialJson: '{"file_path":"/etc/hostname"}',
    });
    adapter.handle(toolResults([{ type: "tool_result", tool_use_id: "call-1", content: "nope", is_error: true }]));
    adapter.handle(streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "It failed." },
    }));
    adapter.handle(streamEvent({ type: "content_block_stop", index: 0 }));
    expect(adapter.exchangeParts()).toEqual([
      { type: "text", text: "Checking the file." },
      { type: "toolCall", id: "call-1", name: "Read", arguments: { file_path: "/etc/hostname" }, failed: true },
      { type: "text", text: "It failed." },
    ]);
    expect(adapter.exchangeText()).toBe("Checking the file.It failed.");

    adapter.beginExchange("and now?");
    expect(adapter.exchangeParts()).toEqual([]);
    expect(adapter.exchangeText()).toBe("");
    expect(events).toContainEqual({ type: "owner_message", text: "and now?" });
  });
});

describe("limits", () => {
  it("reports a rejected claude.ai window as limit_reached with its reset time", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.handle(message({
      type: "rate_limit_event",
      uuid: "rl-1",
      session_id: "session-1",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 },
    }));
    expect(events).toEqual([]);
    adapter.handle(message({
      type: "rate_limit_event",
      uuid: "rl-2",
      session_id: "session-1",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_789_600_000 },
    }));
    expect(events).toEqual([{
      type: "limit_reached",
      harness: "claude-code",
      kind: "usage_limit",
      window: "seven_day",
      resetsAt: new Date(1_789_600_000 * 1000).toISOString(),
      message: "Claude Code seven_day limit reached.",
    }]);
  });

  it("classifies a quota error result and still ends the turn with error", () => {
    const events: PiMessagesEvent[] = [];
    const adapter = createClaudePiMessagesAdapter((event) => events.push(event));
    adapter.handle(message({
      ...JSON.parse(JSON.stringify(success())),
      subtype: "error_during_execution",
      is_error: true,
      errors: ["You've hit your usage limit."],
    }));
    expect(events.map((event) => event.type)).toEqual(["start", "limit_reached", "error"]);
    expect(events[1]).toMatchObject({ harness: "claude-code", kind: "usage_limit" });
  });
});
