import { mkdirSync } from "node:fs";
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import { GhostHookRunner } from "../src/hooks.js";
import { setChatModelRole } from "../src/models.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function fakeQuery(
  messages: SDKMessage[],
  lifecycle: { interrupted: number; closed: number },
): Query {
  const stream = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(stream, {
    interrupt: async () => {
      lifecycle.interrupted += 1;
    },
    close: () => {
      lifecycle.closed += 1;
    },
  }) as unknown as Query;
}

function responseMessages(sessionId: string, text: string): SDKMessage[] {
  return [
    sdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "start",
      session_id: sessionId,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    }),
    sdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "delta",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    }),
    sdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "stop",
      session_id: sessionId,
      event: { type: "content_block_stop", index: 0 },
    }),
    sdkMessage({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      result: text,
      uuid: "result",
      session_id: sessionId,
    }),
  ];
}

function setupClaudeHost(options: {
  visitorId?: string;
  authStatus?: { loggedIn: boolean; authMethod?: string; subscriptionType?: string };
  hooks?: GhostHookRunner;
} = {}) {
  temp = makeTempGhosts();
  const dir = seedGhost(temp.root, {
    name: "casper",
    character: "---\npublic: true\ntitle: casper\n---\n\nYou are Casper, a letterpress printer.\n",
  });
  const paths = ghostPaths(dir);
  mkdirSync(paths.agentDir, { recursive: true });
  setChatModelRole(paths.agentDir, "claude-code", "default");

  const seenOptions: ClaudeQueryOptions[] = [];
  const lifecycle = { queries: 0, interrupted: 0, closed: 0 };
  host = new SessionHost({
    registry: temp.registry,
    offline: true,
    ...(options.visitorId ? { extensionOptions: { visitorId: options.visitorId } } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    claudeCode: {
      binaryPath: process.execPath,
      readAuthStatus: async () => options.authStatus ?? ({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
      }),
      createQuery: (input) => {
        lifecycle.queries += 1;
        seenOptions.push(input.options);
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(responseMessages(sessionId, "Hello from the plan."), lifecycle);
      },
    },
  });
  return { paths, seenOptions, lifecycle };
}

describe("Claude Code subscription runtime", () => {
  it("routes an explicit claude-code role through the isolated SDK harness and resumes it", async () => {
    const { seenOptions, lifecycle } = setupClaudeHost();
    const first: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "Who are you?",
      emit: (event) => first.push(event),
    });

    expect(first.at(-1)?.type).toBe("done");
    expect(first.some((event) => event.type === "text_delta"
      && event.delta.includes("plan"))).toBe(true);
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]).toMatchObject({
      cwd: expect.stringContaining("casper"),
      tools: [],
      settingSources: [],
      skills: [],
      plugins: [],
      permissionMode: "dontAsk",
      strictMcpConfig: true,
      persistSession: true,
    });
    expect(seenOptions[0]?.systemPrompt).toContain("letterpress printer");
    expect(seenOptions[0]?.systemPrompt).not.toContain("coding agent");
    expect(seenOptions[0]?.allowedTools).toContain("mcp__ghost__ghost_memory_read");
    expect(seenOptions[0]?.allowedTools).not.toContain("Bash");
    expect(lifecycle.closed).toBe(1);
    const sessionId = seenOptions[0]?.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "And now?",
      emit: () => {},
    });
    expect(seenOptions[1]?.resume).toBe(sessionId);
    expect(seenOptions[1]?.sessionId).toBeUndefined();
    expect(lifecycle.closed).toBe(2);

    const sessions = await host!.listSessions("casper");
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        title: "Claude Code",
        messageCount: 4,
      }),
    ]);
  });

  it("applies session_stop continuations before the Claude turn settles", async () => {
    const hooks = new GhostHookRunner();
    const active: boolean[] = [];
    await hooks.register((api) => {
      api.on("session_stop", (event) => {
        active.push(event.stop_hook_active);
        if (!event.stop_hook_active) return { continue: true, additionalContext: "Revise it once." };
      });
    });
    const { seenOptions, lifecycle } = setupClaudeHost({ hooks });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(2);
    expect(active).toEqual([false, true]);
    expect(seenOptions[1]?.resume).toBe(seenOptions[0]?.sessionId);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { totalTokens: 4 } });
  });

  it("never makes an owner subscription available to a visitor scope", async () => {
    setupClaudeHost({ visitorId: "visitor-1" });
    await expect(host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "hello",
      emit: () => {},
    })).rejects.toMatchObject({
      code: "claude_code_owner_only",
      status: 403,
    });
  });

  it("fails closed without Claude.ai plan auth and never starts a query", async () => {
    const { lifecycle } = setupClaudeHost({
      authStatus: { loggedIn: true, authMethod: "api_key" },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("claude auth login"),
    });
    expect(await host!.listSessions("casper")).toEqual([]);
  });

  it("interrupts and closes an already-aborted turn", async () => {
    const { lifecycle } = setupClaudeHost();
    const controller = new AbortController();
    const events: PiMessagesEvent[] = [];
    controller.abort();

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "hello",
      signal: controller.signal,
      emit: (event) => events.push(event),
    });

    expect(lifecycle.interrupted).toBe(1);
    expect(lifecycle.closed).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });
});
