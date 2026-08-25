import { mkdirSync, writeFileSync } from "node:fs";
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createBrowserExtension,
  createScreenExtension,
  GHOST_BROWSER,
  GHOST_SCREEN,
} from "@ghost/extensions";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeClaudeCodeTools,
  CLAUDE_CODE_TOOL_CAPABILITIES,
} from "../src/claude-code.js";
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
  before?: () => Promise<void>,
): Query {
  const stream = (async function* () {
    await before?.();
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

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function setupClaudeHost(options: {
  authStatus?: { loggedIn: boolean; authMethod?: string; subscriptionType?: string };
  hooks?: GhostHookRunner;
} = {}) {
  temp = makeTempGhosts();
  const dir = seedGhost(temp.root, {
    name: "casper",
    character: "---\ntitle: casper\n---\n\nYou are Casper, a letterpress printer.\n",
  });
  const paths = ghostPaths(dir);
  mkdirSync(paths.agentDir, { recursive: true });
  setChatModelRole(paths.agentDir, "claude-code", "default");

  const seenOptions: ClaudeQueryOptions[] = [];
  const seenPrompts: SDKUserMessage[] = [];
  const lifecycle = { queries: 0, interrupted: 0, closed: 0 };
  host = new SessionHost({
    registry: temp.registry,
    offline: true,
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
        return fakeQuery(responseMessages(sessionId, "Hello from the plan."), lifecycle, async () => {
          for await (const message of input.prompt) seenPrompts.push(message);
        });
      },
    },
  });
  return { paths, seenOptions, seenPrompts, lifecycle };
}

describe("Claude Code subscription runtime", () => {
  it("returns image blocks from screen and browser screenshots across the tool bridge", async () => {
    const { paths } = setupClaudeHost();
    let browserPage: { url: string; title: string } | undefined;
    const browser = {
      name: "claude-bridge-test",
      setHeadless: () => ({ applied: true }),
      current: async () => browserPage,
      open: async (url: string) => {
        browserPage = { url, title: "Bridge fixture" };
        return browserPage;
      },
      screenshot: async (options: { path: string }) => {
        writeFileSync(options.path, Buffer.from(TINY_PNG_BASE64, "base64"));
        return browserPage ?? { url: "about:blank", title: "" };
      },
      close: async () => {
        browserPage = undefined;
        return true;
      },
    } as never;
    const helper = {
      hello: async () => ({}),
      capabilities: async () => ({}),
      request: async () => ({
        png_base64: TINY_PNG_BASE64,
        width: 1,
        height: 1,
        backend: "bridge-fixture",
        background_safe: true,
      }),
      dispose: async () => {},
    } as never;
    const tools = await bridgeClaudeCodeTools({
      factories: [
        createScreenExtension({
          home: paths.home,
          helper,
          capabilities: CLAUDE_CODE_TOOL_CAPABILITIES,
        }),
        createBrowserExtension({
          home: paths.home,
          backend: () => browser,
          browser: { idleTimeoutMs: 0 },
          capabilities: CLAUDE_CODE_TOOL_CAPABILITIES,
        }),
      ],
      toolNames: [GHOST_SCREEN, GHOST_BROWSER],
    }, paths.home, "Ghost bridge test");
    const call = async (name: string, args: Record<string, unknown>) => {
      const definition = tools.find((candidate) => candidate.name === name);
      if (!definition) throw new Error(`Missing bridged tool ${name}`);
      return definition.handler(args as never, {});
    };

    const screen = await call(GHOST_SCREEN, { prompt: "What is visible?" });
    await call(GHOST_BROWSER, { action: "open", url: "https://example.com" });
    const browserShot = await call(GHOST_BROWSER, { action: "screenshot" });
    await call(GHOST_BROWSER, { action: "close" });

    expect(screen.content).toContainEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
    expect(browserShot.content).toContainEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
  });

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
      tools: { type: "preset", preset: "claude_code" },
      skills: "all",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
    });
    expect(seenOptions[0]).not.toHaveProperty("settingSources");
    expect(seenOptions[0]).not.toHaveProperty("plugins");
    expect(seenOptions[0]).not.toHaveProperty("strictMcpConfig");
    expect(seenOptions[0]?.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: expect.stringContaining("letterpress printer"),
    });
    expect(seenOptions[0]?.allowedTools).toContain("mcp__ghost__ghost_memory_write");
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

  it("deletes a Claude Code resume sidecar", async () => {
    setupClaudeHost();
    await host!.runTurn("casper", {
      sessionId: "conversation-delete",
      prompt: "Remember this",
      emit: () => {},
    });
    expect(await host!.listSessions("casper")).toHaveLength(1);

    await host!.deleteSession("casper", "conversation-delete");
    expect(await host!.listSessions("casper")).toEqual([]);
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

  it("injects before_prompt guidance into one Claude query", async () => {
    const hooks = new GhostHookRunner();
    await hooks.register((api) => {
      api.on("before_prompt", () => ({ additionalContext: "Avoid the prior warning." }));
    });
    const { seenOptions, seenPrompts, lifecycle } = setupClaudeHost({ hooks });

    await host!.runTurn("casper", {
      sessionId: "conversation-before-prompt",
      prompt: "hello",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(seenOptions[0]?.systemPrompt).not.toContain("Avoid the prior warning.");
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[0]).toMatchObject({ isSynthetic: true, shouldQuery: false });
    expect(JSON.stringify(seenPrompts[0]?.message.content)).toContain("Avoid the prior warning.");
    expect(JSON.stringify(seenPrompts[1]?.message.content)).toContain("hello");
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
