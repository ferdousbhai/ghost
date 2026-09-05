/**
 * Claude Agent SDK -> pi-messages wire adapter.
 *
 * The lifecycle and partial-message mapping are adapted from T3 Code's
 * `ClaudeAdapter.ts` (MIT, https://github.com/pingdotgg/t3code). Ghost has a
 * deliberately smaller wire contract, so this keeps only the parts needed by
 * the existing shell: text/thinking deltas, tool calls, terminal state, and
 * usage. In particular, it preserves T3's parent/subagent separation so a
 * future Claude capability cannot interleave a sidechain's narration into the
 * main chat.
 */
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  addUsage,
  copyUsage,
  toolResultSummary,
  zeroUsage,
  type PiMessagesEvent,
  type Usage,
} from "./pi-messages.js";

export interface ClaudePiMessagesAdapter {
  setInternalMcpServerName(name: string): void;
  handle(message: SDKMessage): void;
  recordUsage(result: SDKResultMessage): void;
  finishError(error: unknown, aborted?: boolean): void;
  isTerminal(): boolean;
}

type StreamBlock =
  | { kind: "text"; wireIndex: number; content: string }
  | { kind: "thinking"; wireIndex: number; content: string }
  | {
      kind: "tool";
      wireIndex: number;
      id: string;
      name: string;
      inputJson: string;
      initialInput: unknown;
    };

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromResult(result: SDKResultMessage): Usage {
  const raw = result.usage as unknown as Record<string, unknown>;
  const input = numberField(raw.input_tokens);
  const output = numberField(raw.output_tokens);
  const cacheRead = numberField(raw.cache_read_input_tokens);
  const cacheWrite = numberField(raw.cache_creation_input_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: numberField(result.total_cost_usd),
    },
  };
}

function visibleToolName(name: string, internalMcpServerName: string): string {
  if (name === "AskUserQuestion") return "ask";
  const prefix = `mcp__${internalMcpServerName}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function parseToolInput(block: Extract<StreamBlock, { kind: "tool" }>): Record<string, unknown> {
  if (block.inputJson.trim()) {
    try {
      const parsed = JSON.parse(block.inputJson) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // The provider's final snapshot below is authoritative when the streamed
      // JSON was incomplete. If neither is usable, emit an empty object rather
      // than inventing arguments.
    }
  }
  if (block.initialInput !== null
    && typeof block.initialInput === "object"
    && !Array.isArray(block.initialInput)) {
    return block.initialInput as Record<string, unknown>;
  }
  return {};
}

/** The SDK's own text for a failed result; empty for a successful one. */
export function resultErrorMessage(result: SDKResultMessage): string {
  if (result.subtype === "success") return "";
  return result.errors.filter(Boolean).join("\n") || `Claude Code ended with ${result.subtype}.`;
}

/**
 * Flatten one Claude turn into the protocol already consumed by Ghost's shell.
 * Raw provider block indices are never put on the wire: Claude starts them
 * over for every assistant sampling step, while pi-messages requires one dense
 * sequence for the entire response.
 */
export function createClaudePiMessagesAdapter(
  emit: (event: PiMessagesEvent) => void,
  options: { includeThinking?: boolean; getCwd?: () => string } = {},
): ClaudePiMessagesAdapter {
  const includeThinking = options.includeThinking === true;
  const blocks = new Map<number, StreamBlock>();
  /** Tools whose execution has been announced and not yet closed by a result. */
  const executing = new Map<string, string>();
  let nextWireIndex = 0;
  let started = false;
  let terminal = false;
  let emittedText = false;
  let internalMcpServerName = "ghost";
  const totalUsage = zeroUsage();

  const addResultUsage = (result: SDKResultMessage): void => {
    addUsage(totalUsage, usageFromResult(result));
  };

  const usageSnapshot = (): Usage => copyUsage(totalUsage);

  const getCwd = (): string => options.getCwd?.() ?? process.cwd();

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

  const openText = (rawIndex: number, initial: string): void => {
    ensureStarted();
    const block: StreamBlock = { kind: "text", wireIndex: nextWireIndex++, content: "" };
    blocks.set(rawIndex, block);
    send({ type: "text_start", contentIndex: block.wireIndex });
    if (initial) {
      block.content += initial;
      emittedText = true;
      send({ type: "text_delta", contentIndex: block.wireIndex, delta: initial });
    }
  };

  const openThinking = (rawIndex: number, initial: string): void => {
    if (!includeThinking) return;
    ensureStarted();
    const block: StreamBlock = { kind: "thinking", wireIndex: nextWireIndex++, content: "" };
    blocks.set(rawIndex, block);
    send({ type: "thinking_start", contentIndex: block.wireIndex });
    if (initial) {
      block.content += initial;
      send({ type: "thinking_delta", contentIndex: block.wireIndex, delta: initial });
    }
  };

  const openTool = (
    rawIndex: number,
    content: { id: string; name: string; input?: unknown },
  ): void => {
    ensureStarted();
    const block: StreamBlock = {
      kind: "tool",
      wireIndex: nextWireIndex++,
      id: content.id,
      name: visibleToolName(content.name, internalMcpServerName),
      inputJson: "",
      initialInput: content.input,
    };
    blocks.set(rawIndex, block);
    send({
      type: "toolcall_start",
      contentIndex: block.wireIndex,
      id: block.id,
      toolName: block.name,
    });
  };

  const closeBlock = (rawIndex: number): void => {
    const block = blocks.get(rawIndex);
    if (!block) return;
    blocks.delete(rawIndex);
    if (block.kind === "text") {
      send({ type: "text_end", contentIndex: block.wireIndex, content: block.content });
      return;
    }
    if (block.kind === "thinking") {
      send({ type: "thinking_end", contentIndex: block.wireIndex, content: block.content });
      return;
    }
    const args = parseToolInput(block);
    send({
      type: "toolcall_end",
      contentIndex: block.wireIndex,
      toolCall: {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: args,
      },
    });
    // Claude runs a requested tool as soon as its block closes, and the SDK
    // offers no separate pre-execution frame. Announcing execution here is what
    // gives the HUD a live "what is it doing" state for the whole run of the
    // call; without it a Claude turn looks identical whether it is reading a
    // file or idling. `tool_progress` carries no arguments and arrives only
    // for slow calls, so it cannot open this window.
    executing.set(block.id, block.name);
    send({
      type: "tool_execution_start",
      id: block.id,
      toolName: block.name,
      arguments: args,
      cwd: getCwd(),
    });
  };

  /**
   * Close the execution window a `tool_result` answers.
   *
   * Membership in `executing` is the whole test: a subagent's tool calls are
   * announced like any other (only its narration is private), so matching on
   * the id closes exactly the calls this adapter opened and ignores replayed or
   * synthetic user content.
   */
  const handleToolResults = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const result = part as {
        type?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };
      if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
      const toolName = executing.get(result.tool_use_id);
      if (toolName === undefined) continue;
      executing.delete(result.tool_use_id);
      // `toolResultSummary` reads pi's `{ content: [...] }` shape; a provider
      // block may carry its text directly instead. Which of a tool's results
      // are worth showing is the HUD's call, made once for both runtimes.
      const summary = toolResultSummary(
        typeof result.content === "string" ? result.content : result,
      );
      send({
        type: "tool_execution_end",
        id: result.tool_use_id,
        toolName,
        isError: result.is_error === true,
        ...(summary ? { summary } : {}),
      });
    }
  };

  const handleStreamEvent = (message: Extract<SDKMessage, { type: "stream_event" }>): void => {
    const event = message.event;
    const sidechain = message.parent_tool_use_id !== null
      && message.parent_tool_use_id !== undefined;

    // T3 learned this guard the hard way: includePartialMessages also carries
    // subagent narration. Ghost does not expose Agent today, but filtering at
    // the provider boundary prevents a future tool-policy change from leaking
    // those private deltas into the parent transcript.
    if (sidechain) {
      const sidechainNarrationStart = event.type === "content_block_start"
        && event.content_block.type !== "tool_use"
        && event.content_block.type !== "mcp_tool_use";
      const sidechainNarrationDelta = event.type === "content_block_delta"
        && (event.delta.type === "text_delta" || event.delta.type === "thinking_delta");
      if (sidechainNarrationStart || sidechainNarrationDelta || event.type === "message_delta") {
        return;
      }
    }

    if (event.type === "message_start") {
      // Raw content indices restart for a new provider step.
      blocks.clear();
      return;
    }

    if (event.type === "content_block_start") {
      const content = event.content_block;
      if (content.type === "text") openText(event.index, content.text);
      else if (content.type === "thinking") openThinking(event.index, content.thinking);
      else if (content.type === "tool_use" || content.type === "mcp_tool_use") {
        openTool(event.index, content);
      }
      return;
    }

    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (!block) return;
      if (event.delta.type === "text_delta" && block.kind === "text") {
        block.content += event.delta.text;
        emittedText = true;
        send({ type: "text_delta", contentIndex: block.wireIndex, delta: event.delta.text });
      } else if (event.delta.type === "thinking_delta" && block.kind === "thinking") {
        block.content += event.delta.thinking;
        send({ type: "thinking_delta", contentIndex: block.wireIndex, delta: event.delta.thinking });
      } else if (event.delta.type === "input_json_delta" && block.kind === "tool") {
        block.inputJson += event.delta.partial_json;
        send({ type: "toolcall_delta", contentIndex: block.wireIndex, delta: event.delta.partial_json });
      }
      return;
    }

    if (event.type === "content_block_stop") closeBlock(event.index);
  };

  return {
    setInternalMcpServerName(name) {
      internalMcpServerName = name;
    },
    handle(message) {
      if (terminal) return;
      if (message.type === "stream_event") {
        handleStreamEvent(message);
        return;
      }
      if (message.type === "user") {
        handleToolResults((message.message as { content?: unknown } | undefined)?.content);
        return;
      }
      if (message.type !== "result") return;

      // Older Claude Code builds can omit partial events. Preserve the answer
      // from the success result instead of returning a mysteriously empty turn.
      if (message.subtype === "success" && !emittedText && message.result) {
        openText(Number.MAX_SAFE_INTEGER, message.result);
        closeBlock(Number.MAX_SAFE_INTEGER);
      }

      ensureStarted();
      addResultUsage(message);
      const usage = usageSnapshot();
      if (message.subtype === "success") {
        const reason = message.stop_reason === "max_tokens" ? "length" : "stop";
        send({ type: "done", reason, usage, responseId: message.session_id });
      } else {
        send({
          type: "error",
          reason: "error",
          usage,
          responseId: message.session_id,
          errorMessage: resultErrorMessage(message),
        });
      }
    },
    recordUsage(result) {
      if (!terminal) addResultUsage(result);
    },
    finishError(error, aborted = false) {
      ensureStarted();
      send({
        type: "error",
        reason: aborted ? "aborted" : "error",
        usage: usageSnapshot(),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    },
    isTerminal() {
      return terminal;
    },
  };
}
