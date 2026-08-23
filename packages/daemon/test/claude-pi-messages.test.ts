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

  it("normalizes in-process MCP tool names for the existing shell", () => {
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
        content_block: {
          type: "mcp_tool_use",
          id: "tool-1",
          name: "mcp__ghost__ghost_notes_read",
          server_name: "ghost",
          input: {},
        },
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
        delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.md\"}" },
      },
    }));
    adapter.handle(message({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "c",
      session_id: "session-1",
      event: { type: "content_block_stop", index: 0 },
    }));

    expect(events).toContainEqual({
      type: "toolcall_start",
      contentIndex: 0,
      id: "tool-1",
      toolName: "ghost_notes_read",
    });
    expect(events).toContainEqual({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "tool-1",
        name: "ghost_notes_read",
        arguments: { path: "a.md" },
      },
    });
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
