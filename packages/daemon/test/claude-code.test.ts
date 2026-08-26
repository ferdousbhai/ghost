import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeClaudeCodeTools,
  claudeSessionMetadataPath,
  CLAUDE_CODE_TOOL_CAPABILITIES,
  ClaudeCodeProbe,
  type ClaudeCodeQueryInput,
} from "../src/claude-code.js";
import { ghostPaths } from "../src/ghosts.js";
import { GhostHookRunner } from "../src/hooks.js";
import type { Logger } from "../src/log.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { setChatModelRole } from "../src/models.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { SessionHost } from "../src/session-host.js";
import { makeFakeCatalogRuntime } from "./helpers/fake-catalog-runtime.js";
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

function responseMessages(sessionId: string, text: string, numTurns = 1): SDKMessage[] {
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
      num_turns: numTurns,
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

function errorResultMessage(
  sessionId: string,
  subtype: "error_during_execution" | "error_max_turns",
  numTurns: number,
): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: numTurns,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: [`simulated ${subtype}`],
    uuid: `result-${subtype}`,
    session_id: sessionId,
  });
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function setupClaudeHost(options: {
  authStatus?: { loggedIn: boolean; authMethod?: string; subscriptionType?: string };
  readAuthStatus?: (binaryPath: string) => Promise<{
    loggedIn: boolean;
    authMethod?: string;
    subscriptionType?: string;
  }>;
  probe?: ClaudeCodeProbe;
  createQuery?: (
    input: ClaudeCodeQueryInput,
    lifecycle: { queries: number; interrupted: number; closed: number },
  ) => Query;
  hooks?: GhostHookRunner;
  conversationMaintenance?: ConstructorParameters<typeof SessionHost>[0]["conversationMaintenance"];
  logger?: Logger;
} = {}) {
  temp = makeTempGhosts();
  const dir = seedGhost(temp.root, {
    name: "casper",
    character: "---\ntitle: casper\n---\n\nYou are Casper, a letterpress printer.\n",
  });
  const paths = ghostPaths(dir);
  mkdirSync(paths.agentDir, { recursive: true });
  setChatModelRole(paths.home, "claude-code", "default");

  const seenOptions: ClaudeQueryOptions[] = [];
  const seenPrompts: SDKUserMessage[] = [];
  const lifecycle = { queries: 0, interrupted: 0, closed: 0 };
  host = new SessionHost({
    registry: temp.registry,
    offline: true,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.conversationMaintenance
      ? { conversationMaintenance: options.conversationMaintenance }
      : {}),
    claudeCode: {
      ...(options.probe
        ? { probe: options.probe }
        : {
          binaryPath: process.execPath,
          readAuthStatus: options.readAuthStatus ?? (async () => options.authStatus ?? ({
            loggedIn: true,
            authMethod: "claude.ai",
            subscriptionType: "max",
          })),
        }),
      createQuery: (input) => {
        lifecycle.queries += 1;
        seenOptions.push(input.options);
        if (options.createQuery) return options.createQuery(input, lifecycle);
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Claude Code executable/auth probe", () => {
  it("single-flights concurrent work and retains one successful snapshot until TTL expiry", async () => {
    let now = 100;
    let resolutions = 0;
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      ttlMs: 5_000,
      now: () => now,
      resolveExecutable: async (configured) => {
        resolutions += 1;
        expect(configured).toBe("configured-claude");
        return "/resolved/claude";
      },
      readAuthStatus: async (binary) => {
        authReads += 1;
        expect(binary).toBe("/resolved/claude");
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });

    const [first, concurrent] = await Promise.all([probe.read(), probe.read()]);
    expect(first).toEqual(concurrent);
    expect({ resolutions, authReads }).toEqual({ resolutions: 1, authReads: 1 });

    now = 5_099;
    await probe.read();
    expect({ resolutions, authReads }).toEqual({ resolutions: 1, authReads: 1 });

    now = 5_100;
    await probe.read();
    expect({ resolutions, authReads }).toEqual({ resolutions: 2, authReads: 2 });
  });

  it("single-flights and briefly caches failure without poisoning a later retry", async () => {
    const gate = deferred();
    let now = 100;
    let authReads = 0;
    let fail = true;
    const probe = new ClaudeCodeProbe({
      binaryPath: "claude",
      ttlMs: 1_000,
      now: () => now,
      resolveExecutable: async () => "/resolved/claude",
      readAuthStatus: async () => {
        authReads += 1;
        await gate.promise;
        if (fail) throw new Error("transient auth probe failure");
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });

    const first = probe.read();
    const concurrent = probe.read();
    gate.resolve();
    await expect(first).rejects.toThrow("transient auth probe failure");
    await expect(concurrent).rejects.toThrow("transient auth probe failure");
    expect(authReads).toBe(1);

    fail = false;
    await expect(probe.read()).rejects.toThrow("transient auth probe failure");
    expect(authReads).toBe(1);

    now = 1_100;
    await expect(probe.read()).resolves.toMatchObject({
      binaryPath: "/resolved/claude",
      authStatus: { loggedIn: true, authMethod: "claude.ai" },
    });
    expect(authReads).toBe(2);
  });

  it("never returns or retains a successful probe from before invalidation", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "claude",
      resolveExecutable: async () => "/resolved/claude",
      readAuthStatus: async () => {
        authReads += 1;
        if (authReads === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { loggedIn: true, authMethod: "claude.ai" };
        }
        return { loggedIn: false };
      },
    });

    const stale = probe.read();
    await firstStarted.promise;
    probe.invalidate();
    const current = await probe.read();
    expect(current.authStatus.loggedIn).toBe(false);

    releaseFirst.resolve();
    expect((await stale).authStatus.loggedIn).toBe(false);
    expect((await probe.read()).authStatus.loggedIn).toBe(false);
    expect(authReads).toBe(2);
  });

  it("rejects a cache lifetime outside the short bounded range", () => {
    expect(() => new ClaudeCodeProbe({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new ClaudeCodeProbe({ ttlMs: 30_001 })).toThrow(RangeError);
  });
});

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
      screenshot: async () => ({
        ...(browserPage ?? { url: "about:blank", title: "" }),
        bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      }),
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
        id: "claude-code:conversation-1",
        conversationId: "conversation-1",
        runtime: "claude-code",
        title: "Claude Code",
        messageCount: 4,
      }),
    ]);
  });

  it("uses SDK num_turns across resume while preserving an existing sidecar count", async () => {
    let queryNumber = 0;
    const { paths } = setupClaudeHost({
      createQuery: (input, lifecycle) => {
        queryNumber += 1;
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, `response ${queryNumber}`, queryNumber === 1 ? 3 : 2),
          lifecycle,
        );
      },
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-counted");
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-counted",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 8,
    })}\n`, { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: "conversation-counted",
      prompt: "first resumed turn",
      emit: () => {},
    });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      sessionId: "existing-sdk-session",
      messageCount: 14,
      ownerTurnCount: 5,
    });

    await host!.runTurn("casper", {
      sessionId: "conversation-counted",
      prompt: "second resumed turn",
      emit: () => {},
    });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      sessionId: "existing-sdk-session",
      messageCount: 18,
      ownerTurnCount: 6,
    });
    expect((await host!.listSessions("casper"))[0]).toMatchObject({
      messageCount: 18,
    });
  });

  it("persists a terminal zero-turn resume id without fabricating messages", async () => {
    let queryNumber = 0;
    const { paths, seenOptions } = setupClaudeHost({
      createQuery: (input, lifecycle) => {
        queryNumber += 1;
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, `response ${queryNumber}`, queryNumber === 1 ? 0 : 1),
          lifecycle,
        );
      },
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-zero-turn");

    await host!.runTurn("casper", {
      sessionId: "conversation-zero-turn",
      prompt: "first",
      emit: () => {},
    });
    const first = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(first).toMatchObject({
      sessionId: seenOptions[0]?.sessionId,
      messageCount: 0,
      ownerTurnCount: 1,
    });

    await host!.runTurn("casper", {
      sessionId: "conversation-zero-turn",
      prompt: "resume",
      emit: () => {},
    });
    expect(seenOptions[1]?.resume).toBe(first.sessionId);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      messageCount: 2,
      ownerTurnCount: 2,
    });
  });

  it("rejects an exhausted owner-turn counter before hooks or a query", async () => {
    const hooks = new GhostHookRunner();
    const hookTurns: number[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        hookTurns.push(event.turn_id);
      });
    });
    const { paths, lifecycle } = setupClaudeHost({ hooks });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-owner-overflow");
    mkdirSync(paths.sessionDir, { recursive: true });
    const original = `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-owner-overflow",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
      ownerTurnCount: Number.MAX_SAFE_INTEGER,
    })}\n`;
    writeFileSync(sidecar, original, { mode: 0o600 });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-owner-overflow",
      prompt: "must not wrap",
      emit: (event) => events.push(event),
    });

    expect(hookTurns).toEqual([]);
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("owner turn count overflowed"),
    });
    expect(readFileSync(sidecar, "utf8")).toBe(original);
  });

  it("treats an odd legacy message count as corrupt instead of flooring a hook id", async () => {
    const { paths, lifecycle } = setupClaudeHost();
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-odd-legacy");
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-odd-legacy",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 3,
    })}\n`, { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-odd-legacy",
      prompt: "must not guess",
      emit: (event) => events.push(event),
    });
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("metadata contract"),
    });
  });

  it("invalidates the cached external auth snapshot during auth refresh", async () => {
    let authReads = 0;
    setupClaudeHost({
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });

    for (const sessionId of ["conversation-cache-a", "conversation-cache-b"]) {
      await host!.runTurn("casper", { sessionId, prompt: "hello", emit: () => {} });
    }
    expect(authReads).toBe(1);

    await host!.refreshAuth("casper");
    await host!.runTurn("casper", {
      sessionId: "conversation-cache-c",
      prompt: "hello again",
      emit: () => {},
    });
    expect(authReads).toBe(2);
  });

  it("shares one executable/auth probe between catalogue listing and a turn", async () => {
    let resolutions = 0;
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      resolveExecutable: async () => {
        resolutions += 1;
        return process.execPath;
      },
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });
    setupClaudeHost({ probe });
    const catalog = new ModelCatalog({
      registry: temp!.registry,
      offline: true,
      claudeCodeProbe: probe,
      createRuntime: async () => makeFakeCatalogRuntime({ models: [] }),
    });

    const listing = await catalog.listModels("casper", {
      scope: "catalog",
      provider: "claude-code",
    });
    expect(listing.models).toEqual([expect.objectContaining({
      provider: "claude-code",
      usable: true,
    })]);
    await host!.runTurn("casper", {
      sessionId: "conversation-shared-probe",
      prompt: "hello",
      emit: () => {},
    });

    expect({ resolutions, authReads }).toEqual({ resolutions: 1, authReads: 1 });
  });

  it("deletes a Claude Code resume sidecar", async () => {
    setupClaudeHost();
    await host!.runTurn("casper", {
      sessionId: "conversation-delete",
      prompt: "Remember this",
      emit: () => {},
    });
    expect(await host!.listSessions("casper")).toHaveLength(1);

    await host!.deleteSession("casper", "conversation-delete", "claude-code");
    expect(await host!.listSessions("casper")).toEqual([]);
  });

  it("skips and logs malformed Claude Code sidecars without hiding valid sessions", async () => {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, fields) => warnings.push({ message, fields }),
      error: () => {},
    };
    const { paths } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "conversation-valid",
      prompt: "Remember this",
      emit: () => {},
    });
    const malformedPath = join(paths.sessionDir, "claude-malformed.json");
    writeFileSync(malformedPath, "{ definitely not json\n", "utf8");

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-valid",
        conversationId: "conversation-valid",
        runtime: "claude-code",
      }),
    ]);
    expect(warnings).toContainEqual({
      message: "skipping invalid Claude Code session metadata",
      fields: expect.objectContaining({
        path: malformedPath,
        error: expect.stringContaining("not valid Claude session metadata"),
      }),
    });
  });

  it("never lists or resumes a Claude sidecar transplanted onto another id's hash", async () => {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, fields) => warnings.push({ message, fields }),
      error: () => {},
    };
    const { paths, lifecycle } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "conversation-a",
      prompt: "remember A",
      emit: () => {},
    });
    const source = claudeSessionMetadataPath(paths.sessionDir, "conversation-a");
    const transplanted = claudeSessionMetadataPath(paths.sessionDir, "conversation-b");
    writeFileSync(transplanted, readFileSync(source));

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-a",
        conversationId: "conversation-a",
      }),
    ]);
    expect(warnings).toContainEqual({
      message: "skipping invalid Claude Code session metadata",
      fields: expect.objectContaining({
        path: transplanted,
        error: expect.stringContaining("sidecar filename"),
      }),
    });

    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-b",
      prompt: "do not resume A",
      emit: (event) => events.push(event),
    });
    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("does not match the requested resume id"),
    });
    expect(JSON.parse(readFileSync(transplanted, "utf8"))).toMatchObject({
      conversationId: "conversation-a",
    });
  });

  it("rejects empty, overlong, and malformed stored Claude identities", async () => {
    const { paths, lifecycle } = setupClaudeHost();
    for (const conversationId of ["", "x".repeat(201)]) {
      try {
        claudeSessionMetadataPath(paths.sessionDir, conversationId);
        throw new Error("expected invalid conversation id");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_conversation_id", status: 400 });
      }
    }

    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(join(paths.sessionDir, `claude-${"0".repeat(64)}.json`), `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "",
      sessionId: "stored-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      ownerTurnCount: 0,
    })}\n`);
    const boundedConversation = "conversation-invalid-session";
    const invalidSessionPath = claudeSessionMetadataPath(paths.sessionDir, boundedConversation);
    writeFileSync(invalidSessionPath, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: boundedConversation,
      sessionId: "x".repeat(513),
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      ownerTurnCount: 0,
    })}\n`);

    expect(await host!.listSessions("casper")).toEqual([]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: boundedConversation,
      prompt: "must not resume malformed metadata",
      emit: (event) => events.push(event),
    });
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("metadata contract"),
    });
  });

  it("applies session_stop continuations before the Claude turn settles", async () => {
    const hooks = new GhostHookRunner({ conversationIdleDelayMs: 0 });
    const active: boolean[] = [];
    const beforeTurnIds: number[] = [];
    const turnIds: number[] = [];
    const ownerPrompts: string[] = [];
    const idleEvents: Array<{ conversation: string; outcome: string; runtime: string }> = [];
    let firstIdleResolve!: () => void;
    const firstIdle = new Promise<void>((resolve) => { firstIdleResolve = resolve; });
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        beforeTurnIds.push(event.turn_id);
      });
      api.on("session_stop", (event) => {
        active.push(event.stop_hook_active);
        turnIds.push(event.turn_id);
        ownerPrompts.push(event.owner_prompt);
        if (!event.stop_hook_active) return { continue: true, additionalContext: "Revise it once." };
      });
      api.on("conversation_idle", (event) => {
        idleEvents.push({
          conversation: event.conversation_id,
          outcome: event.last_turn_outcome,
          runtime: event.runtime,
        });
        firstIdleResolve();
      });
    });
    let queryNumber = 0;
    const providerTurns = [4, 2, 3, 1];
    const { seenOptions, lifecycle, paths } = setupClaudeHost({
      hooks,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        const numTurns = providerTurns[queryNumber++] ?? 1;
        return fakeQuery(responseMessages(sessionId, `pass ${queryNumber}`, numTurns), state);
      },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(2);
    expect(active).toEqual([false, true]);
    expect(ownerPrompts).toEqual(["hello", "hello"]);
    expect(seenOptions[1]?.resume).toBe(seenOptions[0]?.sessionId);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { totalTokens: 4 } });
    await firstIdle;
    expect(idleEvents[0]).toEqual({
      conversation: "conversation-hooks",
      outcome: "completed",
      runtime: "claude-code",
    });

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "one more owner turn",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(4);
    expect(active).toEqual([false, true, false, true]);
    expect(ownerPrompts).toEqual(["hello", "hello", "one more owner turn", "one more owner turn"]);
    expect(beforeTurnIds).toEqual([1, 2]);
    expect(turnIds).toEqual([1, 1, 2, 2]);
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-hooks"),
      "utf8",
    ))).toMatchObject({
      messageCount: 20,
      ownerTurnCount: 2,
    });
  });

  it("injects before_prompt guidance into one Claude query", async () => {
    const hooks = new GhostHookRunner();
    const acknowledge = vi.fn();
    const recordTurn = vi.fn(async () => {});
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Avoid the prior warning.",
        acknowledge,
      }));
    });
    const { seenOptions, seenPrompts, lifecycle } = setupClaudeHost({
      hooks,
      conversationMaintenance: {
        recordTurn,
        forgetConversation: vi.fn(async () => {}),
      },
    });

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
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "claude-code",
      conversationId: "conversation-before-prompt",
      ownerPrompt: "hello",
      assistantText: "Hello from the plan.",
      outcome: "completed",
    }));
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

  it("persists SDK turns and resume identity from a terminal max-turn error", async () => {
    const { paths, lifecycle } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery([errorResultMessage(sessionId, "error_max_turns", 3)], state);
      },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-max-turns",
      prompt: "keep going",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("error_max_turns"),
    });
    const metadata = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-max-turns"),
      "utf8",
    ));
    expect(metadata).toMatchObject({
      conversationId: "conversation-max-turns",
      sessionId: expect.any(String),
      messageCount: 6,
      ownerTurnCount: 1,
    });
  });

  it("does not publish an invalid session id from a terminal SDK result", async () => {
    const invalidSessionId = "x".repeat(513);
    const { paths, lifecycle } = setupClaudeHost({
      createQuery: (_input, state) => fakeQuery([
        errorResultMessage(invalidSessionId, "error_during_execution", 1),
      ], state),
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-invalid-result-session",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("invalid session id"),
    });
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-invalid-result-session",
    ))).toBe(false);
  });

  it("does not change persisted counts when the SDK process fails before a result", async () => {
    const { paths, lifecycle } = setupClaudeHost({
      createQuery: (_input, state) => fakeQuery([], state, async () => {
        throw new Error("simulated process failure");
      }),
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-process-failure");
    mkdirSync(paths.sessionDir, { recursive: true });
    const original = `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-process-failure",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 8,
      ownerTurnCount: 3,
    }, null, 2)}\n`;
    writeFileSync(sidecar, original, { mode: 0o600 });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-process-failure",
      prompt: "retry",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("message stream failed"),
    });
    expect(readFileSync(sidecar, "utf8")).toBe(original);
  });

  it("interrupts and closes an already-aborted turn", async () => {
    const { lifecycle, seenOptions } = setupClaudeHost();
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
    expect(seenOptions[0]?.abortController?.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("uses the SDK abort controller when interrupt rejects during cancellation", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { lifecycle, paths, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const stream = (async function* () {
          markStarted();
          await new Promise<void>((resolve) => {
            input.options.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
        return Object.assign(stream, {
          interrupt: async () => {
            state.interrupted += 1;
            throw new Error("simulated stuck interrupt");
          },
          close: () => {
            state.closed += 1;
          },
        }) as unknown as Query;
      },
    });
    const controller = new AbortController();
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-wedged",
      prompt: "hello",
      signal: controller.signal,
      emit: (event) => events.push(event),
    });
    await started;

    controller.abort();
    await turn;

    expect(seenOptions[0]?.abortController?.signal.aborted).toBe(true);
    expect(lifecycle.interrupted).toBe(1);
    expect(lifecycle.closed).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-wedged"),
    )).toBe(false);
  });

  it("does not admit a query whose auth probe settles after daemon disposal", async () => {
    const probeStarted = deferred();
    const releaseProbe = deferred();
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      resolveExecutable: async () => {
        probeStarted.resolve();
        await releaseProbe.promise;
        return process.execPath;
      },
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });
    const { lifecycle, paths } = setupClaudeHost({ probe });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-held-probe",
      prompt: "hello",
      emit: (event) => events.push(event),
    });
    await probeStarted.promise;

    let disposed = false;
    const disposal = host!.disposeAll().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseProbe.resolve();
    await Promise.all([disposal, turn]);
    expect(disposed).toBe(true);

    expect(authReads).toBe(1);
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
      errorMessage: "The daemon is shutting down.",
    });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-held-probe"),
    )).toBe(false);
  });

  it("aborts and drains a turn held in pre-query hook preparation", async () => {
    const hooks = new GhostHookRunner();
    const hookStarted = deferred();
    let hookAborted = false;
    await hooks.register((api) => {
      api.on("before_prompt", async (event) => {
        hookStarted.resolve();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            hookAborted = true;
            resolve();
          };
          if (event.signal.aborted) onAbort();
          else event.signal.addEventListener("abort", onAbort, { once: true });
        });
      });
    });
    const { lifecycle, paths } = setupClaudeHost({ hooks });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-held-hook",
      prompt: "hello",
      emit: (event) => events.push(event),
    });
    await hookStarted.promise;

    await Promise.all([host!.disposeAll(), turn]);

    expect(hookAborted).toBe(true);
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
      errorMessage: "The daemon is shutting down.",
    });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-held-hook"),
    )).toBe(false);
  });

  it("aborts the SDK controller while shutting down an active query", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const stream = (async function* () {
          markStarted();
          await new Promise<void>((resolve) => {
            input.options.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
        return Object.assign(stream, {
          interrupt: async () => {
            state.interrupted += 1;
          },
          close: () => {
            state.closed += 1;
          },
        }) as unknown as Query;
      },
    });
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-shutdown",
      prompt: "hello",
      emit: () => {},
    });
    await started;

    await host!.disposeAll();
    await turn;

    expect(seenOptions[0]?.abortController?.signal.aborted).toBe(true);
    expect(lifecycle.interrupted).toBe(1);
    expect(lifecycle.closed).toBeGreaterThanOrEqual(1);
  });
});
