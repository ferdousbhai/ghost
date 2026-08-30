import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  claudeSdkTranscriptPath,
  claudeSessionMetadataPath,
  CLAUDE_SESSION_METADATA_MAX_BYTES,
  CLAUDE_CODE_TOOL_CAPABILITIES,
  ClaudeCodeProbe,
  readClaudeSessionMetadataFile,
  type ClaudeCodeQueryInput,
} from "../src/claude-code.js";
import type {
  MaintenanceIdentity,
  SettledMaintenanceTurn,
} from "../src/conversation-maintenance.js";
import { ghostPaths } from "../src/ghosts.js";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
} from "../src/hooks.js";
import type { Logger } from "../src/log.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { setChatModelRole } from "../src/models.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import {
  loadProjectDeclarativeSnapshot,
  PROJECT_SCAN_MAX_ENTRIES,
} from "../src/project-resources.js";
import {
  declarativePromptSnapshot,
  mergeProjectDeclarativeSnapshots,
} from "../src/declarative-snapshot.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
import { makeFakeCatalogRuntime } from "./helpers/fake-catalog-runtime.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { recordingLogger } from "./helpers/recording-logger.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
const FAKE_QUERY_EXIT = Symbol("fake-query-exit");

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
  vi.unstubAllEnvs();
});

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function filesystemTreeContains(root: string, needle: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (filesystemTreeContains(path, needle)) return true;
    } else if (entry.isFile() && readFileSync(path).includes(Buffer.from(needle))) {
      return true;
    }
  }
  return false;
}

/**
 * A warm query the way the real SDK behaves: one `result` per owner prompt,
 * with the stream left open for the next one. Pass `prompts` to drive it turn
 * by turn — draining that channel eagerly would deadlock, because a warm
 * query's input stays open for the life of the process. Omit it for a query
 * that only ever serves one turn.
 */
function fakeQuery(
  messages: SDKMessage[] | ((turn: number) => SDKMessage[]),
  lifecycle: { interrupted: number; closed: number },
  prompts?: AsyncIterable<SDKUserMessage>,
  onPrompt?: (message: SDKUserMessage) => void,
  processExit = deferred(),
  resolveExitOnClose = true,
): Query {
  let transportClosed = false;
  const forTurn = (turn: number): SDKMessage[] =>
    typeof messages === "function" ? messages(turn) : messages;
  const stream = (async function* () {
    if (!prompts) {
      for (const message of forTurn(1)) yield message;
      return;
    }
    let turn = 0;
    for await (const prompt of prompts) {
      onPrompt?.(prompt);
      // Synthetic context carries no turn of its own, exactly as the SDK treats
      // a `shouldQuery: false` message.
      if ((prompt as { shouldQuery?: boolean }).shouldQuery === false) continue;
      turn += 1;
      for (const message of forTurn(turn)) yield message;
    }
  })();
  return Object.assign(stream, {
    interrupt: async () => {
      if (transportClosed) throw new Error("SDK control transport is closed");
      lifecycle.interrupted += 1;
    },
    close: () => {
      if (transportClosed) return;
      transportClosed = true;
      lifecycle.closed += 1;
      if (resolveExitOnClose) processExit.resolve();
    },
    [FAKE_QUERY_EXIT]: processExit.promise,
  }) as unknown as Query;
}

function observeFakeQueryExit(query: Query): Promise<void> {
  return (query as Query & { [FAKE_QUERY_EXIT]?: Promise<void> })[FAKE_QUERY_EXIT]
    ?? Promise.resolve();
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
  logger?: Logger;
  maintenance?: SessionHostOptions["maintenance"];
  machineSkill?: { name: string; description: string; body: string };
  warmIdleTtlMs?: number;
  exitWaitTimeoutMs?: number;
  useSdkSpawnExitBoundary?: boolean;
} = {}) {
  temp = makeTempGhosts();
  const dir = seedGhost(temp.root, {
    name: "casper",
    character: "# Casper\n\nYou are Casper, a letterpress printer.\n",
  });
  const paths = ghostPaths(dir);
  mkdirSync(paths.agentDir, { recursive: true });
  setChatModelRole(paths.home, "claude-code", "default");
  const machineSkills = join(temp.ownerHome, ".agents", "skills");
  if (options.machineSkill) {
    const skillDir = join(machineSkills, options.machineSkill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${options.machineSkill.name}\ndescription: ${options.machineSkill.description}\n---\n\n${options.machineSkill.body}\n`,
    );
  }

  const seenOptions: ClaudeQueryOptions[] = [];
  const seenPrompts: SDKUserMessage[] = [];
  const lifecycle = { queries: 0, interrupted: 0, closed: 0 };
  const scheduleUnitDir = join(temp.ownerHome, ".xdg-config", "systemd", "user");
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    scheduleUnitDir,
    machineSkillPaths: options.machineSkill ? [machineSkills] : [],
    offline: true,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.maintenance ? { maintenance: options.maintenance } : {}),
    claudeCode: {
      ...(options.warmIdleTtlMs === undefined
        ? {}
        : { warmIdleTtlMs: options.warmIdleTtlMs }),
      ...(options.exitWaitTimeoutMs === undefined
        ? {}
        : { exitWaitTimeoutMs: options.exitWaitTimeoutMs }),
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
        return fakeQuery(
          responseMessages(sessionId, "Hello from the plan."),
          lifecycle,
          input.prompt,
          (message) => seenPrompts.push(message),
        );
      },
      ...(options.useSdkSpawnExitBoundary ? {} : { observeQueryExit: observeFakeQueryExit }),
    },
  });
  return { paths, scheduleUnitDir, seenOptions, seenPrompts, lifecycle };
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

function storedClaudeV3(input: {
  conversationId: string;
  root: string;
  cwd?: string;
  mcpServers: Record<string, unknown>;
  instruction?: string;
  declarative?: Record<string, unknown>;
}): string {
  const identity = statSync(input.root, { bigint: true });
  return `${JSON.stringify({
    version: 3,
    runtime: "claude-code",
    conversationId: input.conversationId,
    sessionId: `sdk-${input.conversationId}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ownerTurnCount: 1,
    cwd: input.cwd ?? input.root,
    projectSnapshot: {
      root: input.root,
      identity: { dev: String(identity.dev), ino: String(identity.ino) },
      declarative: input.declarative ?? {
        instructions: [{
          path: join(input.root, "AGENTS.md"),
          content: input.instruction ?? "PINNED-PROJECT-SNAPSHOT",
        }],
        skills: [],
        rules: [],
        prompts: [],
        commands: [],
      },
      mcpServers: input.mcpServers,
      resourceWarnings: [],
      mcpWarnings: [],
    },
  })}\n`;
}

function storedClaudeV1(conversationId: string): string {
  return `${JSON.stringify({
    version: 1,
    runtime: "claude-code",
    conversationId,
    sessionId: `sdk-${conversationId}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ownerTurnCount: 1,
  })}\n`;
}

function storedUnboundClaudeV3(conversationId: string): Record<string, unknown> {
  return {
    version: 3,
    runtime: "claude-code",
    conversationId,
    sessionId: `sdk-${conversationId}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ownerTurnCount: 1,
    cwd: temp!.ownerHome,
    projectSnapshot: {
      root: null,
      declarative: {
        instructions: [],
        skills: [],
        rules: [],
        prompts: [],
        commands: [],
      },
      mcpServers: {},
      resourceWarnings: [],
      mcpWarnings: [],
    },
  };
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

describe("Claude session sidecar confinement", () => {
  it("accepts the exact byte boundary and rejects oversized, linked, and special files", async () => {
    temp = makeTempGhosts();
    const fixtureDir = join(temp.root, "claude-sidecar-reader");
    mkdirSync(fixtureDir);

    const exact = join(fixtureDir, "exact.json");
    writeFileSync(exact, Buffer.alloc(CLAUDE_SESSION_METADATA_MAX_BYTES, 0x78), {
      mode: 0o600,
    });
    await expect(readClaudeSessionMetadataFile(exact)).resolves.toHaveLength(
      CLAUDE_SESSION_METADATA_MAX_BYTES,
    );

    const oversized = join(fixtureDir, "oversized.json");
    writeFileSync(oversized, Buffer.alloc(CLAUDE_SESSION_METADATA_MAX_BYTES + 1, 0x78), {
      mode: 0o600,
    });
    await expect(readClaudeSessionMetadataFile(oversized))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const wrongMode = join(fixtureDir, "wrong-mode.json");
    writeFileSync(wrongMode, "{}", { mode: 0o600 });
    chmodSync(wrongMode, 0o640);
    await expect(readClaudeSessionMetadataFile(wrongMode))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const invalidUtf8 = join(fixtureDir, "invalid-utf8.json");
    writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(readClaudeSessionMetadataFile(invalidUtf8))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const symlink = join(fixtureDir, "symlink.json");
    symlinkSync(exact, symlink);
    await expect(readClaudeSessionMetadataFile(symlink))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const hardLinkSource = join(fixtureDir, "hard-link-source.json");
    const hardLink = join(fixtureDir, "hard-link.json");
    writeFileSync(hardLinkSource, "{}", { mode: 0o600 });
    linkSync(hardLinkSource, hardLink);
    await expect(readClaudeSessionMetadataFile(hardLink))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const fifo = join(fixtureDir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    await expect(readClaudeSessionMetadataFile(fifo))
      .rejects.toMatchObject({ code: "claude_session_invalid" });
  });

  it("rejects descriptor-time mutation and pathname replacement", async () => {
    temp = makeTempGhosts();
    const fixtureDir = join(temp.root, "claude-sidecar-races");
    mkdirSync(fixtureDir);

    const mutated = join(fixtureDir, "mutated.json");
    writeFileSync(mutated, "pinned", { mode: 0o600 });
    await expect(readClaudeSessionMetadataFile(mutated, (path) => {
      writeFileSync(path, "changed-size", { mode: 0o600 });
    })).rejects.toMatchObject({ code: "claude_session_invalid" });

    const swapped = join(fixtureDir, "swapped.json");
    const displaced = join(fixtureDir, "displaced.json");
    writeFileSync(swapped, "pinned", { mode: 0o600 });
    await expect(readClaudeSessionMetadataFile(swapped, (path) => {
      renameSync(path, displaced);
      writeFileSync(path, "pinned", { mode: 0o600 });
    })).rejects.toMatchObject({ code: "claude_session_invalid" });
  });
});

describe("Claude Code subscription runtime", () => {
  it("removes the pinned SDK credential surface from query env without mutating parent env", async () => {
    const { seenOptions } = setupClaudeHost();
    const hostileNames = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CONFIG_DIR",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_IDENTITY_TOKEN",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_SCOPE",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "ANTHROPIC_UNIX_SOCKET",
      "ANTHROPIC_WORKSPACE_ID",
      "CLAUDE_CODE_CLIENT_CERT",
      "CLAUDE_CODE_CLIENT_KEY",
      "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
      "CLAUDE_CODE_CUSTOM_OAUTH_URL",
      "CLAUDE_CODE_OAUTH_CLIENT_ID",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_ORGANIZATION_UUID",
      "CLAUDE_CODE_REMOTE",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
      "CLAUDE_LOCAL_OAUTH_API_BASE",
      "CLAUDE_LOCAL_OAUTH_APPS_BASE",
      "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
      "GITLAB_TOKEN",
      "HF_TOKEN",
      "HUGGINGFACE_HUB_TOKEN",
    ] as const;
    const hostile = Object.fromEntries(
      hostileNames.map((name) => [name, `hostile-${name}`]),
    ) as Record<(typeof hostileNames)[number], string>;
    const inherited = {
      ...hostile,
      CLAUDE_CONFIG_DIR: "/home/owner/.claude-owner-plan",
    };
    const previous = new Map(
      Object.keys(inherited).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, inherited);

    try {
      await host!.runTurn("casper", {
        sessionId: "credential-free-query",
        prompt: "Use only the owner's Claude plan.",
        emit: () => {},
      });

      const queryEnv = seenOptions[0]?.env;
      expect(queryEnv).toBeDefined();
      for (const [name, value] of Object.entries(hostile)) {
        expect(queryEnv?.[name]).toBeUndefined();
        expect(process.env[name]).toBe(value);
      }
      expect(queryEnv?.CLAUDE_CONFIG_DIR).toBe(inherited.CLAUDE_CONFIG_DIR);
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(inherited.CLAUDE_CONFIG_DIR);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("returns image blocks from screen and browser screenshots across the tool bridge", async () => {
    const { paths } = setupClaudeHost();
    vi.stubEnv("OMARCHY_SCREENSHOT_DIR", join(temp!.root, "screenshots"));
    let browserPage: { url: string; title: string } | undefined;
    const resolver = vi.fn(async (hostname: string) => {
      expect(hostname).toBe("example.com");
      return [{ address: "1.1.1.1", family: 4 }] as const;
    });
    const browser = {
      name: "claude-bridge-test",
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
    const screenExtension = createScreenExtension({
      home: paths.home,
      helper,
      capabilities: CLAUDE_CODE_TOOL_CAPABILITIES,
    });
    const browserExtension = createBrowserExtension({
      home: paths.home,
      backend: () => browser,
      browser: { idleTimeoutMs: 0, resolver },
      capabilities: CLAUDE_CODE_TOOL_CAPABILITIES,
    });
    const tools = await bridgeClaudeCodeTools({
      ghost: async (api) => {
        await screenExtension(api);
        await browserExtension(api);
      },
      toolNames: [GHOST_SCREEN, GHOST_BROWSER],
    }, paths.home);
    const call = async (name: string, args: Record<string, unknown>) => {
      const definition = tools.find((candidate) => candidate.name === name);
      if (!definition) throw new Error(`Missing bridged tool ${name}`);
      return definition.handler(args as never, {});
    };

    const screen = await call(GHOST_SCREEN, { prompt: "What is visible?" });
    const opened = await call(GHOST_BROWSER, { action: "open", url: "https://example.com" });
    // The session verifies both before and after navigation to close DNS
    // rebinding; both checks stay on this injected, offline resolver.
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(opened.content).toContainEqual({
      type: "text",
      text: "Opened https://example.com/\nBridge fixture",
    });
    expect(browserPage).toEqual({ url: "https://example.com/", title: "Bridge fixture" });
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

  it("expires an idle Claude session and rebuilds its persona on cold resume", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost({ warmIdleTtlMs: 20 });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "conversation-idle",
      prompt,
      emit: () => {},
    });

    await turn("first");
    expect(lifecycle.queries).toBe(1);
    expect(lifecycle.closed).toBe(0);

    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    writeFileSync(
      join(paths.home, "memory", "idle-session-memory.md"),
      "The owner expects idle sessions to refresh.\n",
      "utf8",
    );
    mkdirSync(temp!.documentsDir, { recursive: true });
    writeFileSync(join(temp!.documentsDir, "idle-session-document.txt"), "owner bytes", "utf8");

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lifecycle.closed).toBe(1);

    // Cold again: a second query that resumes the id the sidecar kept.
    await turn("after the idle timeout");
    expect(lifecycle.queries).toBe(2);
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-idle");
    expect(seenOptions[1]?.resume).toBe(
      (JSON.parse(readFileSync(sidecar, "utf8")) as { sessionId: string }).sessionId,
    );
    const resumedPrompt = JSON.stringify(seenOptions[1]?.systemPrompt);
    expect(resumedPrompt).toContain("bookbinder");
    expect(resumedPrompt).toContain("idle-session-memory");
    expect(resumedPrompt).toContain("idle-session-document.txt");
  });

  it("claims a warm query before async setup can cross its idle deadline", async () => {
    const hooks = new GhostHookRunner();
    const secondHookStarted = deferred();
    const releaseSecondHook = deferred();
    let hookCalls = 0;
    await hooks.register((api) => {
      api.on("before_prompt", async () => {
        hookCalls += 1;
        if (hookCalls !== 2) return;
        secondHookStarted.resolve();
        await releaseSecondHook.promise;
      });
    });
    const { lifecycle } = setupClaudeHost({ hooks, warmIdleTtlMs: 40 });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "conversation-idle-boundary",
      prompt,
      emit: () => {},
    });

    await turn("first");
    const second = turn("claim the warm query");
    await secondHookStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lifecycle).toMatchObject({ queries: 1, closed: 0 });

    releaseSecondHook.resolve();
    await second;
    expect(lifecycle).toMatchObject({ queries: 1, closed: 0 });
  });

  it("expires a persona snapshot after a terminal non-success retires its query", async () => {
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      warmIdleTtlMs: 20,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          state.queries === 1
            ? [errorResultMessage(sessionId, "error_max_turns", 1)]
            : responseMessages(sessionId, "recovered"),
          state,
          input.prompt,
        );
      },
    });
    await host!.runTurn("casper", {
      sessionId: "persona-after-terminal-error",
      prompt: "fail once",
      emit: () => {},
    });
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await host!.runTurn("casper", {
      sessionId: "persona-after-terminal-error",
      prompt: "retry after idle",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("expires a persona snapshot after query startup fails", async () => {
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      warmIdleTtlMs: 20,
      createQuery: (input, state) => {
        if (state.queries === 1) throw new Error("simulated startup failure");
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(responseMessages(sessionId, "recovered"), state, input.prompt);
      },
    });
    await host!.runTurn("casper", {
      sessionId: "persona-after-startup-failure",
      prompt: "fail to start",
      emit: () => {},
    });
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await host!.runTurn("casper", {
      sessionId: "persona-after-startup-failure",
      prompt: "retry after idle",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("expires a persona snapshot after cancellation retires its query", async () => {
    const firstPrompt = deferred();
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      warmIdleTtlMs: 20,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return state.queries === 1
          ? fakeQuery([], state, input.prompt, () => firstPrompt.resolve())
          : fakeQuery(responseMessages(sessionId, "recovered"), state, input.prompt);
      },
    });
    const controller = new AbortController();
    const first = host!.runTurn("casper", {
      sessionId: "persona-after-cancellation",
      prompt: "wait for cancellation",
      signal: controller.signal,
      emit: () => {},
    });
    await firstPrompt.promise;
    controller.abort();
    await first;
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await host!.runTurn("casper", {
      sessionId: "persona-after-cancellation",
      prompt: "retry after idle",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("retires a warm query whose persona changed rather than answering under a stale one", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost();
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "conversation-restart",
      prompt,
      emit: () => {},
    });

    await turn("first");
    expect(lifecycle.queries).toBe(1);

    // The character file is part of the prompt the query was built from, and
    // the SDK cannot be told about the change, so the process must go.
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await host!.close("casper", "conversation-restart");

    await turn("second");
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("derives the persona once per conversation, and again for a new one", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const runTurn = (sessionId: string) => host!.runTurn("casper", {
      sessionId,
      prompt: "Who are you?",
      emit: () => {},
    });
    const append = (position: number): string =>
      JSON.stringify(seenOptions[position]?.systemPrompt);

    await runTurn("conversation-1");
    expect(append(0)).not.toContain("written-between-turns");
    writeFileSync(
      join(paths.home, "memory", "written-between-turns.md"),
      "A fact the ghost learned mid-conversation.\n",
      "utf8",
    );

    // The memory index is session-start state. It is on disk, where the native
    // file tools read it; it does not rewrite a prompt prefix already read.
    await runTurn("conversation-1");
    // The turn rode the warm query, so it was answered under the very prompt
    // the session started with — there is no second set of startup options.
    expect(seenOptions).toHaveLength(1);

    // A conversation that starts after the write derives it fresh.
    await runTurn("conversation-2");
    expect(append(1)).toContain("written-between-turns");
  });

  it("routes an explicit claude-code role through the isolated SDK harness and resumes it", async () => {
    const { paths, scheduleUnitDir, seenOptions, lifecycle } = setupClaudeHost();
    mkdirSync(temp!.documentsDir, { recursive: true });
    writeFileSync(join(temp!.documentsDir, "owner-plan.pdf"), "owner bytes");
    mkdirSync(join(paths.home, "docs"), { recursive: true });
    writeFileSync(join(paths.home, "docs", "legacy.md"), "# Legacy home doc\n");
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
      cwd: temp!.ownerHome,
      tools: { type: "preset", preset: "claude_code" },
      skills: [],
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
    });
    // Scheduling, plan mode, and asking the owner are Ghost-owned; Claude's own
    // versions would keep state or reach the owner outside Ghost's surfaces.
    for (const tool of [
      "AskUserQuestion",
      "CronCreate",
      "CronDelete",
      "CronList",
      "EnterPlanMode",
      "ExitPlanMode",
      "PushNotification",
      "RemoteTrigger",
      "ScheduleWakeup",
    ]) expect(seenOptions[0]?.disallowedTools, tool).toContain(tool);
    // Claude's own way of working is untouched.
    for (const tool of ["Agent", "Task", "Bash", "Read", "Write", "TodoWrite", "WebSearch"]) {
      expect(seenOptions[0]?.disallowedTools, tool).not.toContain(tool);
    }
    expect(seenOptions[0]).not.toHaveProperty("plugins");
    expect(seenOptions[0]).not.toHaveProperty("strictMcpConfig");
    const systemPrompt = seenOptions[0]?.systemPrompt;
    expect(systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: expect.stringContaining("letterpress printer"),
    });
    if (
      typeof systemPrompt !== "object"
      || systemPrompt === null
      || !("append" in systemPrompt)
      || typeof systemPrompt.append !== "string"
    ) throw new Error("Claude Code did not receive Ghost's appended persona.");
    const appended = systemPrompt.append;
    expect(appended).toContain(temp!.documentsDir);
    expect(appended).toContain("owner-plan.pdf");
    expect(appended).toContain(scheduleUnitDir);
    expect(appended).toContain("ghost-timer-v1-6-casper-<slug>");
    expect(appended).not.toContain("~/.config/systemd/user");
    expect(appended).not.toContain("legacy.md");
    expect(seenOptions[0]?.allowedTools).toContain("mcp__ghost__ghost_browser");
    // The query stays warm between turns, so nothing is closed yet.
    expect(lifecycle.closed).toBe(0);
    const sessionId = seenOptions[0]?.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-1");
    const firstStored = JSON.parse(readFileSync(sidecar, "utf8")) as {
      created: string;
      modified: string;
    };
    expect(new Date(firstStored.created).toISOString()).toBe(firstStored.created);
    expect(new Date(firstStored.modified).toISOString()).toBe(firstStored.modified);

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "And now?",
      emit: () => {},
    });
    // Turn two rides the same live process: no second query, no resume, and
    // Claude's transcript and MCP servers were never torn down.
    expect(seenOptions).toHaveLength(1);
    expect(lifecycle.queries).toBe(1);
    expect(lifecycle.closed).toBe(0);

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
    const stored = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(stored.created).toBe(firstStored.created);
    expect(new Date(stored.created).toISOString()).toBe(stored.created);
    expect(new Date(stored.modified).toISOString()).toBe(stored.modified);
    expect(stored).toMatchObject({
      version: 3,
      cwd: temp!.ownerHome,
      projectSnapshot: {
        root: null,
        declarative: {
          instructions: [],
          skills: [],
          rules: [],
          prompts: [],
          commands: [],
        },
        mcpServers: {},
        resourceWarnings: [],
        mcpWarnings: [],
      },
    });
  });

  it("injects only always-active Ghost instructions while unbound", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    mkdirSync(join(paths.home, "skills", "unbound"), { recursive: true });
    mkdirSync(join(paths.home, "rules"), { recursive: true });
    mkdirSync(join(paths.home, "prompts"), { recursive: true });
    mkdirSync(join(paths.home, "commands"), { recursive: true });
    mkdirSync(join(paths.home, "agents"), { recursive: true });
    mkdirSync(join(paths.home, ".omp", "skills", "hidden"), { recursive: true });
    writeFileSync(join(paths.home, "AGENTS.md"), "UNBOUND-GHOST-INSTRUCTION");
    writeFileSync(
      join(paths.home, "skills", "unbound", "SKILL.md"),
      "---\nname: unbound\ndescription: visible unbound skill\n---\n\nUNBOUND-GHOST-SKILL\n",
    );
    writeFileSync(join(paths.home, "rules", "unbound.md"), "UNBOUND-GHOST-RULE");
    writeFileSync(join(paths.home, "prompts", "unbound.md"), "UNBOUND-GHOST-PROMPT");
    writeFileSync(join(paths.home, "commands", "unbound.md"), "UNBOUND-GHOST-COMMAND");
    writeFileSync(join(paths.home, "agents", "inactive.md"), "UNBOUND-INACTIVE-AGENT");
    writeFileSync(
      join(paths.home, ".omp", "skills", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: hidden provider\n---\n\nUNBOUND-HIDDEN-SKILL\n",
    );

    await host!.runTurn("casper", {
      sessionId: "unbound-declarative",
      prompt: "use the Ghost resources",
      emit: () => {},
    });

    const append = JSON.stringify(seenOptions[0]?.systemPrompt);
    expect(append).toContain("UNBOUND-GHOST-INSTRUCTION");
    expect(append).toContain("unbound: visible unbound skill");
    expect(append).toContain(join(paths.home, "skills", "unbound", "SKILL.md"));
    expect(append).not.toContain("UNBOUND-GHOST-SKILL");
    expect(append).not.toContain("UNBOUND-GHOST-RULE");
    expect(append).not.toContain("UNBOUND-GHOST-PROMPT");
    expect(append).not.toContain("UNBOUND-GHOST-COMMAND");
    expect(append).not.toContain("UNBOUND-INACTIVE-AGENT");
    expect(append).not.toContain("UNBOUND-HIDDEN-SKILL");
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "unbound-declarative"),
      "utf8",
    ))).toMatchObject({
      projectSnapshot: {
        root: null,
        declarative: {
          instructions: [],
          skills: [],
          rules: [],
          prompts: [],
          commands: [],
        },
      },
    });
  });

  it("indexes ambient machine skills and applies Omarchy CLI-first policy without SDK discovery", async () => {
    const { seenOptions } = setupClaudeHost({
      machineSkill: {
        name: "omarchy",
        description: "Control an Omarchy desktop through its CLI.",
        body: "MACHINE-SKILL-BODY",
      },
    });

    await host!.runTurn("casper", {
      sessionId: "machine-skill-index",
      prompt: "change a desktop setting",
      emit: () => {},
    });

    const append = JSON.stringify(seenOptions[0]?.systemPrompt);
    expect(append).toContain("omarchy: Control an Omarchy desktop through its CLI.");
    expect(append).toContain("omarchy commands --json");
    expect(append).toContain("ghost_desktop");
    expect(append).not.toContain("MACHINE-SKILL-BODY");
    expect(seenOptions[0]?.skills).toEqual([]);
    expect(seenOptions[0]?.settingSources).toEqual([]);
  });

  it("pins a trusted project before the first turn and injects only its declarative resources", async () => {
    const { seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-bound");
    const projectCwd = join(project, "work");
    const approvedSkill = join(project, ".omp", "skills", "approved");
    mkdirSync(approvedSkill, { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(projectCwd);
    writeFileSync(join(project, "AGENTS.md"), "Always say PROJECT-SNAPSHOT.");
    writeFileSync(
      join(approvedSkill, "SKILL.md"),
      "---\nname: approved\ndescription: approved\n---\n\nALWAYS-ACTIVE-SKILL-SNAPSHOT\n",
    );
    writeFileSync(
      join(project, ".omp", "rules", "typed-rule.md"),
      "---\nalwaysApply: true\n---\n\nTYPED-RULE-SNAPSHOT\n",
    );
    const hostile = join(temp!.root, "hostile-claude-resources");
    mkdirSync(hostile);
    writeFileSync(join(hostile, "SKILL.md"), "HOSTILE-SYMLINK-SKILL");
    symlinkSync(hostile, join(project, ".omp", "skills", "escaped"));
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        project_fixture: { type: "stdio", command: process.execPath, args: ["--version"] },
        explicit_cwd: {
          type: "stdio",
          command: process.execPath,
          args: ["--version"],
          cwd: "work",
        },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "bound-project",
      "claude-code",
      project,
    );
    expect(preview.resources.rules).toBe(1);
    await host!.bindProject("casper", "bound-project", "claude-code", {
      root: project,
      cwd: projectCwd,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "bound-project",
      prompt: "use the project",
      emit: () => {},
    });
    expect(seenOptions[0]).toMatchObject({
      cwd: projectCwd,
      skills: [],
      settingSources: [],
      mcpServers: {
        project_fixture: { type: "stdio", command: process.execPath },
        ghost: expect.any(Object),
      },
      systemPrompt: { append: expect.stringContaining("PROJECT-SNAPSHOT") },
    });
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("explicit_cwd");
    expect(seenOptions[0]?.mcpServers?.project_fixture).not.toHaveProperty("cwd");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).not.toContain("ALWAYS-ACTIVE-SKILL-SNAPSHOT");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("approved: approved");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("TYPED-RULE-SNAPSHOT");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).not.toContain("HOSTILE-SYMLINK-SKILL");
    writeFileSync(join(project, "AGENTS.md"), "MUTATED-AFTER-FIRST-TURN");
    writeFileSync(join(project, ".omp", "rules", "typed-rule.md"), "MUTATED-LIVE-RULE");
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { replacement: { type: "stdio", command: "never-run" } },
    }));
    // The point of this turn is that a cold start rebuilds from the stored
    // project bytes rather than reopening the project, so retire the warm
    // query first; a warm turn would never look at the mutated files at all.
    await host!.close("casper", "bound-project");
    await host!.runTurn("casper", {
      sessionId: "bound-project",
      prompt: "resume without rereading",
      emit: () => {},
    });
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("PROJECT-SNAPSHOT");
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("TYPED-RULE-SNAPSHOT");
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).not.toContain("MUTATED-AFTER-FIRST-TURN");
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).not.toContain("MUTATED-LIVE-RULE");
    expect(seenOptions[1]?.mcpServers).toMatchObject({
      project_fixture: { type: "stdio", command: process.execPath },
      ghost: expect.any(Object),
    });
    expect(seenOptions[1]?.mcpServers).not.toHaveProperty("replacement");
    const persisted = JSON.parse(readFileSync(
      claudeSessionMetadataPath(ghostPaths(temp!.registry.get("casper").dir).sessionDir, "bound-project"),
      "utf8",
    ));
    expect(persisted).toMatchObject({
      version: 3,
      projectSnapshot: {
        root: project,
        declarative: {
          instructions: [expect.objectContaining({ content: "Always say PROJECT-SNAPSHOT." })],
          skills: [expect.objectContaining({ content: expect.stringContaining("ALWAYS-ACTIVE") })],
          rules: [expect.objectContaining({ content: "TYPED-RULE-SNAPSHOT" })],
        },
        mcpServers: { project_fixture: { command: process.execPath } },
        mcpWarnings: expect.arrayContaining([
          "explicit_cwd: row rejected because Claude project MCP does not support an explicit cwd.",
        ]),
      },
    });
    await host!.disposeAll();
    const restartedOptions: ClaudeQueryOptions[] = [];
    const restartedLifecycle = { queries: 0, interrupted: 0, closed: 0 };
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      machineSkillPaths: [],
      offline: true,
      claudeCode: {
        binaryPath: process.execPath,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        observeQueryExit: observeFakeQueryExit,
        createQuery: (input) => {
          restartedOptions.push(input.options);
          const sessionId = input.options.resume;
          if (!sessionId) throw new Error("restart must resume the persisted Claude id");
          return fakeQuery(responseMessages(sessionId, "restarted"), restartedLifecycle);
        },
      },
    });
    await host.runTurn("casper", {
      sessionId: "bound-project",
      prompt: "resume after daemon restart",
      emit: () => {},
    });
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).toContain("PROJECT-SNAPSHOT");
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).toContain("TYPED-RULE-SNAPSHOT");
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).not.toContain("MUTATED-AFTER-FIRST-TURN");
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).not.toContain("MUTATED-LIVE-RULE");
    expect(restartedOptions[0]?.mcpServers).toHaveProperty("project_fixture");
    expect(restartedOptions[0]?.mcpServers).not.toHaveProperty("replacement");
    expect(await host!.getProject("casper", "bound-project", "claude-code"))
      .toMatchObject({ root: project, cwd: projectCwd, canRebind: false });
    await expect(host!.reloadProject("casper", "bound-project", "claude-code", 1))
      .rejects.toMatchObject({ code: "project_rebind_requires_new_conversation" });
  });

  it("preserves inherited-object MCP names through Claude launch, persistence, and resume", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-hostile-mcp-names");
    mkdirSync(join(project, ".omp"), { recursive: true });
    const hostileServers = Object.fromEntries([
      ["__proto__", {
        type: "stdio",
        command: process.execPath,
        args: ["--version"],
        timeout: 1_000,
      }],
      ["constructor", {
        type: "http",
        url: "https://constructor.example.test/mcp",
        timeout: 1_100,
      }],
      ["toString", {
        type: "sse",
        url: "https://tostring.example.test/mcp",
        timeout: 1_200,
      }],
    ]);
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: hostileServers,
    }));
    const preview = await host!.previewProject(
      "casper",
      "hostile-mcp-names",
      "claude-code",
      project,
    );
    expect(preview.resources.mcpServers).toBe(3);
    await host!.bindProject("casper", "hostile-mcp-names", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "hostile-mcp-names",
      prompt: "use every admitted MCP server",
      emit: () => {},
    });

    const launched = seenOptions[0]?.mcpServers as Record<string, unknown>;
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(launched, name)).toBe(true);
    }
    const launchedByName = new Map(Object.entries(launched));
    expect(launchedByName.get("__proto__")).toMatchObject({
      type: "stdio",
      command: process.execPath,
      timeout: 1_000,
    });
    expect(launchedByName.get("constructor")).toMatchObject({
      type: "http",
      url: "https://constructor.example.test/mcp",
      timeout: 1_100,
    });
    expect(launchedByName.get("toString")).toMatchObject({
      type: "sse",
      url: "https://tostring.example.test/mcp",
      timeout: 1_200,
    });
    expect(Object.hasOwn(launched, "ghost")).toBe(true);
    expect(await host!.getProject("casper", "hostile-mcp-names", "claude-code"))
      .toMatchObject({ status: "ready", mcpStatus: "ready" });

    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "hostile-mcp-names");
    const persisted = JSON.parse(readFileSync(sidecar, "utf8")) as {
      projectSnapshot: { mcpServers: Record<string, unknown> };
    };
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(persisted.projectSnapshot.mcpServers, name)).toBe(true);
    }

    await host!.disposeAll();
    const resumedOptions: ClaudeQueryOptions[] = [];
    const resumedLifecycle = { interrupted: 0, closed: 0 };
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      machineSkillPaths: [],
      offline: true,
      claudeCode: {
        binaryPath: process.execPath,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        observeQueryExit: observeFakeQueryExit,
        createQuery: (input) => {
          resumedOptions.push(input.options);
          const sessionId = input.options.resume;
          if (!sessionId) throw new Error("hostile-name fixture must resume its Claude id");
          return fakeQuery(responseMessages(sessionId, "resumed"), resumedLifecycle);
        },
      },
    });
    await host.runTurn("casper", {
      sessionId: "hostile-mcp-names",
      prompt: "resume every admitted MCP server",
      emit: () => {},
    });
    const resumed = resumedOptions[0]?.mcpServers as Record<string, unknown>;
    const resumedByName = new Map(Object.entries(resumed));
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(resumed, name)).toBe(true);
      expect(resumedByName.get(name)).toEqual(launchedByName.get(name));
    }
  });

  it("keeps Claude MCP counts, health, launch, and persistence on admitted rows only", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const disabledProject = join(temp!.root, "claude-disabled-only-mcp");
    mkdirSync(join(disabledProject, ".omp"), { recursive: true });
    writeFileSync(join(disabledProject, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        disabled_only: {
          enabled: false,
          type: "stdio",
          command: process.execPath,
        },
      },
    }));
    const disabledPreview = await host!.previewProject(
      "casper",
      "disabled-only-mcp",
      "claude-code",
      disabledProject,
    );
    expect(disabledPreview.resources.mcpServers).toBe(0);
    expect(disabledPreview.warnings).toEqual([]);
    const disabledBound = await host!.bindProject(
      "casper",
      "disabled-only-mcp",
      "claude-code",
      {
        root: disabledProject,
        trustToken: disabledPreview.trustToken,
        expectedGeneration: 0,
      },
    );
    expect(disabledBound).toMatchObject({
      resources: { mcpServers: 0 },
      status: "ready",
      mcpStatus: "off",
    });
    await host!.runTurn("casper", {
      sessionId: "disabled-only-mcp",
      prompt: "run without disabled MCP",
      emit: () => {},
    });
    expect(Object.hasOwn(seenOptions[0]?.mcpServers ?? {}, "disabled_only")).toBe(false);
    expect(await host!.getProject("casper", "disabled-only-mcp", "claude-code"))
      .toMatchObject({ status: "ready", mcpStatus: "off" });
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "disabled-only-mcp"),
      "utf8",
    ))).toMatchObject({
      projectSnapshot: { mcpServers: {}, mcpWarnings: [] },
    });

    const mixedProject = join(temp!.root, "claude-mixed-mcp");
    mkdirSync(join(mixedProject, ".omp"), { recursive: true });
    writeFileSync(join(mixedProject, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        valid_row: {
          type: "stdio",
          command: process.execPath,
          args: ["--version"],
        },
        malformed_row: { type: "stdio", command: 42 },
      },
    }));
    const mixedPreview = await host!.previewProject(
      "casper",
      "mixed-mcp",
      "claude-code",
      mixedProject,
    );
    expect(mixedPreview.resources.mcpServers).toBe(1);
    expect(mixedPreview.warnings).toContainEqual(expect.stringContaining("malformed_row"));
    const mixedBound = await host!.bindProject("casper", "mixed-mcp", "claude-code", {
      root: mixedProject,
      trustToken: mixedPreview.trustToken,
      expectedGeneration: 0,
    });
    expect(mixedBound).toMatchObject({
      resources: { mcpServers: 1 },
      status: "degraded",
      mcpStatus: "degraded",
    });
    await host!.runTurn("casper", {
      sessionId: "mixed-mcp",
      prompt: "run only admitted MCP",
      emit: () => {},
    });
    expect(Object.hasOwn(seenOptions[1]?.mcpServers ?? {}, "valid_row")).toBe(true);
    expect(Object.hasOwn(seenOptions[1]?.mcpServers ?? {}, "malformed_row")).toBe(false);
    const mixedStored = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "mixed-mcp"),
      "utf8",
    )) as {
      projectSnapshot: { mcpServers: Record<string, unknown>; mcpWarnings: string[] };
    };
    expect(Object.hasOwn(mixedStored.projectSnapshot.mcpServers, "valid_row")).toBe(true);
    expect(Object.hasOwn(mixedStored.projectSnapshot.mcpServers, "malformed_row")).toBe(false);
    expect(mixedStored.projectSnapshot.mcpWarnings)
      .toContainEqual(expect.stringContaining("malformed_row"));
    expect(await host!.getProject("casper", "mixed-mcp", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("uses Pi's instruction merge while keeping invoked resources out of Claude's prompt", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const ghostSkill = join(paths.home, "skills", "shared");
    const retainedSkill = join(paths.home, "skills", "retained");
    mkdirSync(ghostSkill, { recursive: true });
    mkdirSync(retainedSkill, { recursive: true });
    mkdirSync(join(paths.home, "rules"), { recursive: true });
    mkdirSync(join(paths.home, "prompts"), { recursive: true });
    mkdirSync(join(paths.home, "commands"), { recursive: true });
    mkdirSync(join(paths.home, "agents"), { recursive: true });
    writeFileSync(join(paths.home, "AGENTS.md"), "GHOST-VISIBLE-INSTRUCTION");
    writeFileSync(
      join(ghostSkill, "SKILL.md"),
      "---\nname: shared\ndescription: ghost shared\n---\n\nGHOST-SHARED-SKILL\n",
    );
    writeFileSync(
      join(retainedSkill, "SKILL.md"),
      "---\nname: retained\ndescription: retained\n---\n\nGHOST-RETAINED-SKILL\n",
    );
    writeFileSync(join(paths.home, "rules", "shared.md"), "GHOST-SHARED-RULE");
    writeFileSync(join(paths.home, "prompts", "shared.md"), "GHOST-SHARED-PROMPT");
    writeFileSync(join(paths.home, "commands", "shared.md"), "GHOST-SHARED-COMMAND");
    writeFileSync(join(paths.home, "agents", "inactive.md"), "GHOST-INACTIVE-AGENT");

    mkdirSync(join(paths.home, ".claude", "skills", "ambient"), { recursive: true });
    writeFileSync(join(paths.home, ".claude", "CLAUDE.md"), "AMBIENT-GHOST-CLAUDE");
    writeFileSync(
      join(paths.home, ".claude", "skills", "ambient", "SKILL.md"),
      "---\nname: ambient\ndescription: ambient\n---\n\nAMBIENT-GHOST-SKILL\n",
    );

    const project = join(temp!.root, "claude-declarative-parity");
    const projectSkill = join(project, ".omp", "skills", "shared");
    const malformedSkill = join(project, ".omp", "skills", "retained");
    const namelessCollision = join(project, ".claude", "skills", "retained");
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(malformedSkill, { recursive: true });
    mkdirSync(namelessCollision, { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(join(project, ".omp", "prompts"), { recursive: true });
    mkdirSync(join(project, ".omp", "commands"), { recursive: true });
    mkdirSync(join(project, ".omp", "agents"), { recursive: true });
    mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(project, ".omp", "AGENTS.md"), "PROJECT-PREFERRED-INSTRUCTION");
    writeFileSync(join(project, "AGENTS.md"), "PROJECT-SHADOWED-INSTRUCTION");
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: shared\ndescription: project shared\n---\n\nPROJECT-SHARED-SKILL\n",
    );
    writeFileSync(
      join(malformedSkill, "SKILL.md"),
      "---\nname: [unterminated\n---\n\nPROJECT-MALFORMED-SKILL\n",
    );
    writeFileSync(
      join(namelessCollision, "SKILL.md"),
      "---\ndescription: directory names are not skill names\n---\n\nPROJECT-NAMELESS-COLLISION\n",
    );
    writeFileSync(join(project, ".omp", "rules", "shared.md"), "PROJECT-SHARED-RULE");
    writeFileSync(join(project, ".omp", "prompts", "shared.md"), "PROJECT-SHARED-PROMPT");
    writeFileSync(join(project, ".omp", "commands", "shared.md"), "PROJECT-SHARED-COMMAND");
    writeFileSync(join(project, ".omp", "agents", "inactive.md"), "PROJECT-INACTIVE-AGENT");
    writeFileSync(join(project, ".omp", "extensions", "inactive.ts"), "PROJECT-EXECUTABLE");

    const ghostSnapshot = await loadProjectDeclarativeSnapshot(paths.home, { level: "user" });
    const projectSnapshot = await loadProjectDeclarativeSnapshot(project, { level: "project" });
    const piEffective = declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([
      ghostSnapshot,
      projectSnapshot,
    ]));
    expect(piEffective.instructions.map((entry) => entry.content)).toEqual([
      "GHOST-VISIBLE-INSTRUCTION",
      "PROJECT-PREFERRED-INSTRUCTION",
    ]);
    expect(piEffective.skills.map((entry) => [entry.name, entry.content])).toEqual([
      ["retained", expect.stringContaining("GHOST-RETAINED-SKILL")],
      ["shared", expect.stringContaining("PROJECT-SHARED-SKILL")],
    ]);
    expect(piEffective.rules).toEqual([
      expect.objectContaining({ name: "shared", content: "PROJECT-SHARED-RULE" }),
    ]);
    expect(piEffective.prompts).toEqual([
      expect.objectContaining({ name: "shared", content: "PROJECT-SHARED-PROMPT" }),
    ]);
    expect(piEffective.commands).toEqual([
      expect.objectContaining({ name: "shared", content: "PROJECT-SHARED-COMMAND" }),
    ]);
    expect(projectSnapshot.warnings).toContainEqual(
      expect.stringContaining("skill metadata is invalid"),
    );
    expect(projectSnapshot.warnings).toContainEqual(
      expect.stringContaining("skill name or description is missing"),
    );

    const preview = await host!.previewProject(
      "casper",
      "declarative-parity",
      "claude-code",
      project,
    );
    expect(preview.resources).toMatchObject({
      skills: 1,
      rules: 1,
      prompts: 1,
      commands: 1,
      agents: 1,
      ignoredExecutable: 1,
    });
    await host!.bindProject("casper", "declarative-parity", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    await host!.runTurn("casper", {
      sessionId: "declarative-parity",
      prompt: "use the admitted resources",
      emit: () => {},
    });

    const systemPrompt = seenOptions[0]?.systemPrompt;
    if (typeof systemPrompt !== "object"
      || systemPrompt === null
      || !("append" in systemPrompt)
      || typeof systemPrompt.append !== "string") {
      throw new Error("Claude Code did not receive its declarative prompt append.");
    }
    const append = systemPrompt.append;
    for (const entry of piEffective.instructions) expect(append).toContain(entry.content);
    for (const entry of [
      ...piEffective.skills,
      ...piEffective.rules,
      ...piEffective.prompts,
      ...piEffective.commands,
    ]) expect(append).not.toContain(entry.content);
    expect(append).not.toContain("GHOST-SHARED-SKILL");
    expect(append).not.toContain("GHOST-SHARED-RULE");
    expect(append).not.toContain("GHOST-SHARED-PROMPT");
    expect(append).not.toContain("GHOST-SHARED-COMMAND");
    expect(append).not.toContain("PROJECT-SHADOWED-INSTRUCTION");
    expect(append).not.toContain("PROJECT-MALFORMED-SKILL");
    expect(append).not.toContain("PROJECT-NAMELESS-COLLISION");
    expect(append).not.toContain("AMBIENT-GHOST-CLAUDE");
    expect(append).not.toContain("AMBIENT-GHOST-SKILL");
    expect(append).not.toContain("GHOST-INACTIVE-AGENT");
    expect(append).not.toContain("PROJECT-INACTIVE-AGENT");
    expect(append).not.toContain("PROJECT-EXECUTABLE");
  });

  it("keeps invalid UTF-8 project instructions, skills, and MCP out of Claude", async () => {
    const { seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-invalid-project-utf8");
    const invalidSkill = join(project, ".omp", "skills", "invalid");
    const validSkill = join(project, ".omp", "skills", "valid");
    mkdirSync(invalidSkill, { recursive: true });
    mkdirSync(validSkill, { recursive: true });
    writeFileSync(
      join(project, ".omp", "AGENTS.md"),
      Buffer.concat([Buffer.from("INVALID-CLAUDE-INSTRUCTION-"), Buffer.from([0x80])]),
    );
    writeFileSync(join(project, "AGENTS.md"), "VALID-CLAUDE-FALLBACK-INSTRUCTION");
    writeFileSync(
      join(invalidSkill, "SKILL.md"),
      Buffer.concat([
        Buffer.from("---\nname: invalid\ndescription: invalid\n---\n\nINVALID-CLAUDE-SKILL-"),
        Buffer.from([0x80]),
      ]),
    );
    writeFileSync(
      join(validSkill, "SKILL.md"),
      "---\nname: valid\ndescription: valid\n---\n\nVALID-CLAUDE-SKILL",
    );
    writeFileSync(
      join(project, ".omp", "mcp.json"),
      Buffer.concat([
        Buffer.from('{"mcpServers":{"invalid":{"type":"stdio","command":"INVALID-CLAUDE-MCP-'),
        Buffer.from([0x80]),
        Buffer.from('"}}}'),
      ]),
    );
    const preview = await host!.previewProject(
      "casper",
      "claude-invalid-utf8",
      "claude-code",
      project,
    );
    expect(preview.resources).toMatchObject({ instructions: 1, skills: 1, mcpServers: 0 });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(".omp/AGENTS.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/skills/invalid/SKILL.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/mcp.json was ignored because it is not valid UTF-8"),
    ]));
    await host!.bindProject("casper", "claude-invalid-utf8", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "claude-invalid-utf8",
      prompt: "use only valid project resources",
      emit: () => {},
    });

    const prompt = JSON.stringify(seenOptions[0]?.systemPrompt);
    expect(prompt).toContain("VALID-CLAUDE-FALLBACK-INSTRUCTION");
    expect(prompt).not.toContain("VALID-CLAUDE-SKILL");
    expect(prompt).not.toContain("\uFFFD");
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("invalid");
    expect(await host!.getProject("casper", "claude-invalid-utf8", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("degrades and omits project MCP timeouts below the Claude SDK floor", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-low-mcp-timeout");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        zero: { type: "stdio", command: process.execPath, timeout: 0 },
        below: { type: "stdio", command: process.execPath, timeout: 999 },
        floor: { type: "stdio", command: process.execPath, timeout: 1_000 },
        exact: { type: "stdio", command: process.execPath, timeout: 1_234 },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "low-mcp-timeout",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "low-mcp-timeout", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "low-mcp-timeout",
      prompt: "use representable MCP timeouts",
      emit: () => {},
    });

    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("zero");
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("below");
    expect(seenOptions[0]?.mcpServers).toMatchObject({
      floor: { timeout: 1_000 },
      exact: { timeout: 1_234 },
    });
    expect(await host!.getProject("casper", "low-mcp-timeout", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
    const stored = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "low-mcp-timeout"),
      "utf8",
    ));
    expect(stored.projectSnapshot.mcpServers).toEqual(expect.objectContaining({
      floor: expect.objectContaining({ timeout: 1_000 }),
      exact: expect.objectContaining({ timeout: 1_234 }),
    }));
    expect(stored.projectSnapshot.mcpServers).not.toHaveProperty("zero");
    expect(stored.projectSnapshot.mcpServers).not.toHaveProperty("below");
    expect(stored.projectSnapshot.mcpWarnings).toEqual(expect.arrayContaining([
      "zero: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
      "below: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
    ]));
  });

  it("revalidates stored MCP timeout semantics before a Claude resume", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost();
    const project = join(temp!.root, "claude-stored-low-mcp-timeout");
    mkdirSync(project);
    const preview = await host!.previewProject(
      "casper",
      "stored-low-timeout",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "stored-low-timeout", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "stored-low-timeout");
    writeFileSync(sidecar, storedClaudeV3({
      conversationId: "stored-low-timeout",
      root: project,
      mcpServers: Object.fromEntries([
        ["__proto__", {
          type: "http",
          url: "https://mcp.example.test/below",
          timeout: 999,
          alwaysLoad: true,
        }],
        ["constructor", {
          type: "http",
          url: "https://mcp.example.test/floor",
          timeout: 1_000,
          alwaysLoad: true,
        }],
        ["toString", {
          type: "http",
          url: "https://mcp.example.test/exact",
          timeout: 1_234,
          alwaysLoad: true,
        }],
      ]),
    }), { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: "stored-low-timeout",
      prompt: "resume with exact timeout semantics",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(seenOptions[0]?.resume).toBe("sdk-stored-low-timeout");
    const resumed = seenOptions[0]?.mcpServers as Record<string, unknown>;
    expect(Object.hasOwn(resumed, "__proto__")).toBe(false);
    expect(Object.hasOwn(resumed, "constructor")).toBe(true);
    expect(Object.hasOwn(resumed, "toString")).toBe(true);
    expect(resumed.constructor).toMatchObject({ timeout: 1_000 });
    expect(resumed.toString).toMatchObject({ timeout: 1_234 });
    const repaired = JSON.parse(readFileSync(sidecar, "utf8")) as {
      projectSnapshot: {
        mcpServers: Record<string, { timeout?: number }>;
        mcpWarnings: string[];
      };
    };
    expect(Object.hasOwn(repaired.projectSnapshot.mcpServers, "__proto__")).toBe(false);
    const repairedByName = new Map(Object.entries(repaired.projectSnapshot.mcpServers));
    expect(repairedByName.get("constructor")?.timeout).toBe(1_000);
    expect(repairedByName.get("toString")?.timeout).toBe(1_234);
    expect(repaired.projectSnapshot.mcpWarnings).toContain(
      "__proto__: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
    );
    expect(await host!.getProject("casper", "stored-low-timeout", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("round-trips the complete credential-free serializable SDK MCP union", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost();
    const project = join(temp!.root, "claude-sdk-mcp-roundtrip");
    mkdirSync(project);
    const preview = await host!.previewProject(
      "casper",
      "sdk-mcp-roundtrip",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "sdk-mcp-roundtrip", "claude-code", {
      root: project,
      cwd: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const mcpServers = {
      local: {
        type: "stdio",
        command: process.execPath,
        args: ["--version"],
        env: {},
        timeout: 1_000,
        alwaysLoad: true,
      },
      remote_http: {
        type: "http",
        url: "https://mcp.example.test/http",
        headers: {},
        tools: [{ name: "read", permission_policy: "always_allow" }],
        timeout: 2_000,
        alwaysLoad: false,
      },
      remote_sse: {
        type: "sse",
        url: "http://127.0.0.1:9010/events",
        tools: [{ name: "write", permission_policy: "always_ask" }],
        timeout: 3_000,
        alwaysLoad: true,
      },
    };
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "sdk-mcp-roundtrip");
    writeFileSync(sidecar, storedClaudeV3({
      conversationId: "sdk-mcp-roundtrip",
      root: project,
      mcpServers,
    }), { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: "sdk-mcp-roundtrip",
      prompt: "resume the pinned transports",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(seenOptions[0]?.resume).toBe("sdk-sdk-mcp-roundtrip");
    expect(seenOptions[0]?.mcpServers).toMatchObject(mcpServers);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      projectSnapshot: { mcpServers },
    });
    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({ conversationId: "sdk-mcp-roundtrip", runtime: "claude-code" }),
    ]);
  });

  it("rejects malformed or secret-bearing stored MCP rows before SDK launch or logging", async () => {
    const logger = recordingLogger();
    const { paths, lifecycle } = setupClaudeHost({ logger });
    const project = join(temp!.root, "claude-malformed-stored-mcp");
    mkdirSync(project);
    const sentinel = "R4-SIDECAR-SECRET-MUST-NOT-LOG";
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bad-command", { bad: { type: "stdio", command: 42 } }],
      ["bad-transport", { bad: { type: "websocket", url: "https://example.test" } }],
      ["extra-secret", { bad: { type: "stdio", command: "safe", token: sentinel } }],
      ["env-secret", { bad: { type: "stdio", command: "safe", env: { TOKEN: sentinel } } }],
      ["header-secret", {
        bad: { type: "http", url: "https://example.test", headers: { authorization: sentinel } },
      }],
    ];

    for (const [conversationId, mcpServers] of cases) {
      const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
      mkdirSync(paths.sessionDir, { recursive: true });
      writeFileSync(sidecar, storedClaudeV3({ conversationId, root: project, mcpServers }), {
        mode: 0o600,
      });
      const events: PiMessagesEvent[] = [];
      await expect(host!.runTurn("casper", {
        sessionId: conversationId,
        prompt: "must fail before launch",
        emit: (event) => events.push(event),
      })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });
      expect(events).toEqual([]);
    }

    expect(lifecycle.queries).toBe(0);
    expect(await host!.listSessions("casper")).toEqual([]);
    expect(JSON.stringify(logger.records)).not.toContain(sentinel);
  });

  it("keeps non-MCP project scan warnings out of Claude MCP health", async () => {
    setupClaudeHost();
    const project = join(temp!.root, "claude-resource-warning-only");
    const outside = join(temp!.root, "outside-skill");
    mkdirSync(join(project, "skills"), { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        bounded_fixture: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    for (let index = 0; index < PROJECT_SCAN_MAX_ENTRIES + 10; index += 1) {
      writeFileSync(join(project, ".omp", "rules", `wide-${index}.md`), `rule ${index}`);
    }
    mkdirSync(outside);
    symlinkSync(outside, join(project, "skills", "escaped"));
    const preview = await host!.previewProject(
      "casper",
      "resource-warning-only",
      "claude-code",
      project,
    );
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("symbolic links"),
      expect.stringContaining("entry limit"),
    ]));
    await host!.bindProject("casper", "resource-warning-only", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "resource-warning-only",
      prompt: "use the safe project snapshot",
      emit: () => {},
    });

    expect(await host!.getProject("casper", "resource-warning-only", "claude-code"))
      .toMatchObject({ status: "ready", error: null, mcpStatus: "ready" });
    const stored = JSON.parse(readFileSync(
      claudeSessionMetadataPath(
        ghostPaths(temp!.registry.get("casper").dir).sessionDir,
        "resource-warning-only",
      ),
      "utf8",
    ));
    expect(stored.projectSnapshot.resourceWarnings)
      .toContainEqual(expect.stringContaining("symbolic links"));
    expect(stored.projectSnapshot.mcpWarnings).toEqual([]);
  });

  it("freezes one immutable project scan between admission and Claude execution", async () => {
    const { seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-single-project-scan");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "PINNED-BEFORE-QUERY");
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        pinned: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    const preview = await host!.previewProject("casper", "single-scan", "claude-code", project);
    await host!.bindProject("casper", "single-scan", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const claudeRuntime = (host as unknown as {
      claudeCode: { admitProjectSnapshot(...args: unknown[]): Promise<unknown> };
    }).claudeCode;
    const scan = vi.spyOn(claudeRuntime, "admitProjectSnapshot");
    const admission = await host!.admitTurn("casper", {
      sessionId: "single-scan",
      prompt: "use the admitted snapshot",
    });
    expect(scan).toHaveBeenCalledTimes(1);
    writeFileSync(join(project, "AGENTS.md"), "MUTATED-BEFORE-QUERY");
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { replacement: { type: "stdio", command: "changed" } },
    }));
    await admission.run({ emit: () => {} });
    expect(scan).toHaveBeenCalledTimes(1);

    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("PINNED-BEFORE-QUERY");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).not.toContain("MUTATED-BEFORE-QUERY");
    expect(seenOptions[0]?.mcpServers).toHaveProperty("pinned");
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("replacement");
  });

  it("rejects secret-bearing project MCP before query or resume metadata publication", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-secret-mcp");
    const sentinel = "GHOST_CLAUDE_PROJECT_SECRET_SENTINEL";
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        secret_stdio: {
          type: "stdio",
          command: process.execPath,
          args: ["--version", `$${"{CLAUDE_PROJECT_TOKEN}"}`],
          env: { CLAUDE_PROJECT_TOKEN: sentinel },
        },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "secret-project-mcp",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "secret-project-mcp", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const events: PiMessagesEvent[] = [];
    const before = await host!.getProject("casper", "secret-project-mcp", "claude-code");
    await expect(host!.runTurn("casper", {
      sessionId: "secret-project-mcp",
      prompt: "must fail before Claude starts",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({
      code: "claude_project_mcp_secrets_unsupported",
      status: 409,
    });
    expect(events).toEqual([]);
    expect(seenOptions).toHaveLength(0);
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "secret-project-mcp",
    ))).toBe(false);
    expect(await host!.getProject("casper", "secret-project-mcp", "claude-code"))
      .toMatchObject({
        generation: before.generation,
        status: before.status,
        error: before.error,
        mcpStatus: before.mcpStatus,
        lastRefreshAt: before.lastRefreshAt,
      });
    // Project files stay outside the portable ghost home, and no expanded or
    // literal credential may be copied into that home.
    expect(filesystemTreeContains(paths.home, sentinel)).toBe(false);

    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        safe_stdio: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    await host!.runTurn("casper", {
      sessionId: "secret-project-mcp",
      prompt: "retry the validated project",
      emit: () => {},
    });
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.mcpServers).toHaveProperty("safe_stdio");
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "secret-project-mcp",
    ))).toBe(true);
    expect(filesystemTreeContains(paths.home, sentinel)).toBe(false);
  });

  it("uses SDK num_turns across resume while preserving an existing sidecar count", async () => {
    const { paths, seenOptions } = setupClaudeHost({
      createQuery: (input, lifecycle) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          (turn) => responseMessages(sessionId, `response ${turn}`, turn === 1 ? 3 : 2),
          lifecycle,
          input.prompt,
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
    expect(seenOptions[0]?.cwd).toBe(paths.home);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      cwd: paths.home,
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
          input.prompt,
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

    // Retiring the warm query is what makes the next turn a real resume.
    await host!.close("casper", "conversation-zero-turn");
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
    await expect(host!.runTurn("casper", {
      sessionId: "conversation-odd-legacy",
      prompt: "must not guess",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });
    expect(lifecycle.queries).toBe(0);
    expect(events).toEqual([]);
  });

  it.each([
    ["created", "2026-01-01T00:00:00Z"],
    ["created", "not-a-timestamp"],
    ["modified", "2026-01-01T00:00:00.000+00:00"],
    ["modified", "2026-02-30T00:00:00.000Z"],
  ] as const)(
    "rejects a noncanonical or invalid v3 %s timestamp before maintenance or Claude work",
    async (field, timestamp) => {
      let authReads = 0;
      let maintenanceAdmissions = 0;
      let maintenanceFinishes = 0;
      let maintenanceReleases = 0;
      const reservation = () => ({ drained: Promise.resolve(), release: () => {} });
      const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
        admitOwnerAction: () => {
          maintenanceAdmissions += 1;
          return {
            ready: Promise.resolve(),
            finish: async () => {
              maintenanceFinishes += 1;
            },
            release: () => {
              maintenanceReleases += 1;
            },
          };
        },
        recordOwnerActivity: async () => {},
        reserveConversationDelete: reservation,
        completeConversationDelete: () => {},
        reserveGhostMove: reservation,
        completeGhostRename: async () => {},
        completeGhostDelete: () => {},
        beginShutdown: async () => {},
        disposeAll: async () => {},
      };
      const { paths, lifecycle } = setupClaudeHost({
        maintenance,
        readAuthStatus: async () => {
          authReads += 1;
          return { loggedIn: true, authMethod: "claude.ai" };
        },
      });
      const conversationId = `invalid-${field}-${timestamp.length}`;
      const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
      mkdirSync(paths.sessionDir, { recursive: true });
      const metadata = storedUnboundClaudeV3(conversationId);
      metadata[field] = timestamp;
      const original = `${JSON.stringify(metadata)}\n`;
      writeFileSync(sidecar, original, { mode: 0o600 });
      const events: PiMessagesEvent[] = [];

      await expect(host!.runTurn("casper", {
        sessionId: conversationId,
        prompt: "must fail without paid Claude work",
        emit: (event) => events.push(event),
      })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });

      expect(authReads).toBe(0);
      expect(lifecycle.queries).toBe(0);
      expect({ maintenanceAdmissions, maintenanceFinishes, maintenanceReleases }).toEqual({
        maintenanceAdmissions: 0,
        maintenanceFinishes: 0,
        maintenanceReleases: 0,
      });
      expect(events).toEqual([]);
      expect(readFileSync(sidecar, "utf8")).toBe(original);
    },
  );

  it("revalidates resume timestamps after admission and before the Claude auth probe", async () => {
    let authReads = 0;
    const { paths, lifecycle } = setupClaudeHost({
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });
    const conversationId = "timestamp-swapped-after-admission";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify(storedUnboundClaudeV3(conversationId))}\n`, {
      mode: 0o600,
    });
    const admission = await host!.admitTurn("casper", {
      sessionId: conversationId,
      prompt: "do not pay for corrupt resume state",
    });
    const changed = storedUnboundClaudeV3(conversationId);
    changed.modified = "2026-01-01T00:00:00Z";
    const invalid = `${JSON.stringify(changed)}\n`;
    writeFileSync(sidecar, invalid, { mode: 0o600 });
    const events: PiMessagesEvent[] = [];

    await admission.run({ emit: (event) => events.push(event) });

    expect(authReads).toBe(0);
    expect(lifecycle.queries).toBe(0);
    expect(events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({
        type: "error",
        errorMessage: expect.stringContaining("metadata contract"),
      })]);
    expect(readFileSync(sidecar, "utf8")).toBe(invalid);
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
    const { paths } = setupClaudeHost();
    await host!.runTurn("casper", {
      sessionId: "conversation-delete",
      prompt: "Remember this",
      emit: () => {},
    });
    expect(await host!.listSessions("casper")).toHaveLength(1);
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-delete");
    writeFileSync(`${sidecar}.started`, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-delete",
    })}\n`, { mode: 0o600 });

    await host!.deleteSession("casper", "conversation-delete", "claude-code");
    expect(await host!.listSessions("casper")).toEqual([]);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(`${sidecar}.started`)).toBe(false);
  });

  it("skips and logs malformed Claude Code sidecars without hiding valid sessions", async () => {
    const logger = recordingLogger("warn");
    const { paths } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "conversation-valid",
      prompt: "Remember this",
      emit: () => {},
    });
    const malformedPath = join(paths.sessionDir, "claude-malformed.json");
    writeFileSync(malformedPath, "{ definitely not json\n", { encoding: "utf8", mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-valid",
        conversationId: "conversation-valid",
        runtime: "claude-code",
      }),
    ]);
    expect(logger.records).toContainEqual(expect.objectContaining({
      message: "skipping invalid Claude Code session metadata",
      fields: expect.objectContaining({
        path: malformedPath,
        error: expect.stringContaining("not valid Claude session metadata"),
      }),
    }));
  });

  it("listSessions skips insecure sidecar entries without hiding a valid sibling", async () => {
    const logger = recordingLogger("warn");
    const { paths } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "secure-listing",
      prompt: "persist one valid row",
      emit: () => {},
    });

    const wrongMode = claudeSessionMetadataPath(paths.sessionDir, "wrong-mode-listing");
    writeFileSync(wrongMode, storedClaudeV1("wrong-mode-listing"), { mode: 0o600 });
    chmodSync(wrongMode, 0o640);

    const symlink = claudeSessionMetadataPath(paths.sessionDir, "symlink-listing");
    symlinkSync(claudeSessionMetadataPath(paths.sessionDir, "secure-listing"), symlink);

    const oversized = claudeSessionMetadataPath(paths.sessionDir, "oversized-listing");
    writeFileSync(oversized, Buffer.alloc(CLAUDE_SESSION_METADATA_MAX_BYTES + 1, 0x78), {
      mode: 0o600,
    });

    const fifo = claudeSessionMetadataPath(paths.sessionDir, "fifo-listing");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({ conversationId: "secure-listing", runtime: "claude-code" }),
    ]);
    expect(logger.records.map((entry) => entry.fields?.path)).toEqual(expect.arrayContaining([
      wrongMode,
      symlink,
      oversized,
      fifo,
    ]));
  });

  it("never lists or resumes a Claude sidecar transplanted onto another id's hash", async () => {
    const logger = recordingLogger("warn");
    const { paths, lifecycle } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "conversation-a",
      prompt: "remember A",
      emit: () => {},
    });
    const source = claudeSessionMetadataPath(paths.sessionDir, "conversation-a");
    const transplanted = claudeSessionMetadataPath(paths.sessionDir, "conversation-b");
    writeFileSync(transplanted, readFileSync(source), { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-a",
        conversationId: "conversation-a",
      }),
    ]);
    expect(logger.records).toContainEqual(expect.objectContaining({
      message: "skipping invalid Claude Code session metadata",
      fields: expect.objectContaining({
        path: transplanted,
        error: expect.stringContaining("sidecar filename"),
      }),
    }));

    const events: PiMessagesEvent[] = [];
    await expect(host!.runTurn("casper", {
      sessionId: "conversation-b",
      prompt: "do not resume A",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ code: "session_identity_mismatch", status: 409 });
    expect(lifecycle.queries).toBe(1);
    expect(events).toEqual([]);
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
    })}\n`, { mode: 0o600 });
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
    })}\n`, { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([]);
    const events: PiMessagesEvent[] = [];
    await expect(host!.runTurn("casper", {
      sessionId: boundedConversation,
      prompt: "must not resume malformed metadata",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });
    expect(lifecycle.queries).toBe(0);
    expect(events).toEqual([]);
  });

  it("applies session_stop continuations before the Claude turn settles", async () => {
    const hooks = new GhostHookRunner();
    const active: boolean[] = [];
    const beforeTurnIds: number[] = [];
    const turnIds: number[] = [];
    const ownerPrompts: string[] = [];
    const hookHomes: string[] = [];
    const hookCwds: string[] = [];
    const hookIdentities: string[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        beforeTurnIds.push(event.turn_id);
      });
      api.on("session_stop", (event) => {
        const priorPasses = turnIds.filter((turnId) => turnId === event.turn_id).length;
        active.push(event.stop_hook_active);
        turnIds.push(event.turn_id);
        ownerPrompts.push(event.owner_prompt);
        hookHomes.push(event.ghost_home);
        hookCwds.push(event.cwd);
        hookIdentities.push(`${event.runtime}:${event.conversation_runtime}:${event.conversation_id}`);
        if (priorPasses < GHOST_SESSION_STOP_CONTINUATION_CAP) {
          return { continue: true, additionalContext: "Revise it again." };
        }
      });
    });
    const providerTurns = [4, 2, 3, 1];
    const { seenOptions, lifecycle, paths } = setupClaudeHost({
      hooks,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        // Each continuation is another pass through the one warm query, so the
        // scripted turn counts are indexed by pass rather than by query.
        return fakeQuery(
          (pass) => responseMessages(sessionId, `pass ${pass}`, providerTurns[pass - 1] ?? 1),
          state,
          input.prompt,
        );
      },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    // The hook always continues, so the cap ends each owner turn: one initial
    // pass plus GHOST_SESSION_STOP_CONTINUATION_CAP continuations. Every pass
    // is another prompt into the one warm query, not another query.
    const passCount = GHOST_SESSION_STOP_CONTINUATION_CAP + 1;
    const activePerTurn = [false, ...Array(passCount - 1).fill(true)];
    expect(lifecycle.queries).toBe(1);
    expect(seenOptions).toHaveLength(1);
    expect(active).toEqual(activePerTurn);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    // The fake query reports two tokens per query.
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { totalTokens: passCount * 2 } });

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "one more owner turn",
      emit: () => {},
    });
    // A second owner turn on the same warm process: still one query.
    expect(lifecycle.queries).toBe(1);
    expect(active).toEqual([...activePerTurn, ...activePerTurn]);
    expect(beforeTurnIds).toEqual([1, 2]);
    expect(turnIds).toEqual([...Array(passCount).fill(1), ...Array(passCount).fill(2)]);
    expect(ownerPrompts).toEqual([
      ...Array(passCount).fill("hello"),
      ...Array(passCount).fill("one more owner turn"),
    ]);
    expect(hookHomes).toEqual(Array(passCount * 2).fill(paths.home));
    expect(hookCwds).toEqual(Array(passCount * 2).fill(temp!.ownerHome));
    expect(hookIdentities).toEqual(Array(passCount * 2).fill(
      "claude-code:claude-code:conversation-hooks",
    ));
    // Each query runs `providerTurns[query] ?? 1` provider turns, two messages each.
    const totalProviderTurns = Array.from(
      { length: passCount * 2 },
      (_, query) => providerTurns[query] ?? 1,
    ).reduce((sum, turns) => sum + turns, 0);
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-hooks"),
      "utf8",
    ))).toMatchObject({
      messageCount: totalProviderTurns * 2,
      ownerTurnCount: 2,
    });
  });

  it("records Claude v3 resume identity before releasing runtime ownership", async () => {
    const finishEntered = deferred();
    const allowFinish = deferred();
    let identity: MaintenanceIdentity | undefined;
    let settled: SettledMaintenanceTurn | undefined;
    let releases = 0;
    const reservation = () => ({ drained: Promise.resolve(), release: () => {} });
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      admitOwnerAction: (value) => {
        identity = value;
        return {
          ready: Promise.resolve(),
          finish: async (turn) => {
            settled = turn;
            finishEntered.resolve();
            await allowFinish.promise;
          },
          release: () => {
            releases += 1;
          },
        };
      },
      recordOwnerActivity: async () => {},
      reserveConversationDelete: reservation,
      completeConversationDelete: () => {},
      reserveGhostMove: reservation,
      completeGhostRename: async () => {},
      completeGhostDelete: () => {},
      beginShutdown: async () => {},
      disposeAll: async () => {},
    };
    const { paths } = setupClaudeHost({ maintenance });
    const events: PiMessagesEvent[] = [];
    const running = host!.runTurn("casper", {
      sessionId: "conversation-maintenance-source",
      prompt: "Keep the source exact.",
      emit: (event) => events.push(event),
    });

    await finishEntered.promise;
    expect(identity).toEqual({
      ghostName: "casper",
      runtime: "claude-code",
      conversationId: "conversation-maintenance-source",
    });
    const metadata = JSON.parse(readFileSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-maintenance-source",
    ), "utf8")) as { created: string; sessionId: string };
    expect(settled).toMatchObject({
      source: {
        runtime: "claude-code",
        createdAt: metadata.created,
        resumeId: metadata.sessionId,
      },
      sourceRevision: { kind: "claude-owner-turn", value: 1 },
      cwd: temp!.ownerHome,
      ownerPrompt: "Keep the source exact.",
      assistantText: "Hello from the plan.",
      outcome: "completed",
    });
    expect(releases).toBe(0);
    expect(events.at(-1)?.type).not.toBe("done");
    await expect(host!.runTurn("casper", {
      sessionId: "conversation-maintenance-source",
      prompt: "Must wait.",
      emit: () => {},
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });

    allowFinish.resolve();
    await running;
    expect(releases).toBe(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("emits one generic error when a durable Claude maintenance record rejects", async () => {
    const finished: Array<SettledMaintenanceTurn | undefined> = [];
    const logger = recordingLogger("warn");
    let releases = 0;
    let rejectNext = true;
    const reservation = () => ({ drained: Promise.resolve(), release: () => {} });
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      admitOwnerAction: () => ({
        ready: Promise.resolve(),
        finish: async (turn) => {
          finished.push(turn);
          if (turn && rejectNext) {
            rejectNext = false;
            throw new Error("sensitive Claude sidecar failure");
          }
        },
        release: () => {
          releases += 1;
        },
      }),
      recordOwnerActivity: async () => {},
      reserveConversationDelete: reservation,
      completeConversationDelete: () => {},
      reserveGhostMove: reservation,
      completeGhostRename: async () => {},
      completeGhostDelete: () => {},
      beginShutdown: async () => {},
      disposeAll: async () => {},
    };
    const { paths, lifecycle, seenOptions } = setupClaudeHost({ maintenance, logger });
    const failedEvents: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "strict-claude-maintenance",
      prompt: "Persist this Claude owner turn.",
      emit: (event) => failedEvents.push(event),
    });

    expect(failedEvents.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({
        type: "error",
        errorMessage: "Could not durably settle this owner turn.",
      })]);
    expect(JSON.stringify(failedEvents)).not.toContain("sensitive Claude sidecar failure");
    expect(finished).toEqual([expect.objectContaining({
      source: {
        runtime: "claude-code",
        createdAt: expect.any(String),
        resumeId: expect.any(String),
      },
      sourceRevision: { kind: "claude-owner-turn", value: 1 },
      assistantText: "Hello from the plan.",
    })]);
    expect(releases).toBe(1);
    expect(logger.records).toContainEqual({
      level: "warn",
      message: "conversation maintenance turn record failed",
      fields: {
        ghost: "casper",
        conversation: "strict-claude-maintenance",
        runtime: "claude-code",
      },
    });
    expect(JSON.stringify(logger.records)).not.toContain("sensitive Claude sidecar failure");
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "strict-claude-maintenance"),
      "utf8",
    ))).toMatchObject({ ownerTurnCount: 1, messageCount: 2 });
    expect(lifecycle.closed).toBe(1);

    const retryEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "strict-claude-maintenance",
      prompt: "Retry after persistence failure.",
      emit: (event) => retryEvents.push(event),
    });
    expect(retryEvents.at(-1)?.type).toBe("done");
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBe(
      (JSON.parse(readFileSync(
        claudeSessionMetadataPath(paths.sessionDir, "strict-claude-maintenance"),
        "utf8",
      )) as { sessionId: string }).sessionId,
    );
    expect(releases).toBe(2);
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "strict-claude-maintenance"),
      "utf8",
    ))).toMatchObject({ ownerTurnCount: 2, messageCount: 4 });
  });

  it("injects before_prompt guidance into one Claude query", async () => {
    const hooks = new GhostHookRunner();
    let sidecar = "";
    let acknowledgedMetadata: unknown;
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Avoid the prior warning.",
        acknowledge: () => {
          acknowledgedMetadata = JSON.parse(readFileSync(sidecar, "utf8"));
        },
      }));
    });
    const { seenOptions, seenPrompts, lifecycle, paths } = setupClaudeHost({ hooks });
    sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-before-prompt");

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
    expect(acknowledgedMetadata).toMatchObject({
      version: 3,
      conversationId: "conversation-before-prompt",
      ownerTurnCount: 1,
    });
  });

  it("fails open when a persisted Claude notice acknowledgement fails", async () => {
    const hooks = new GhostHookRunner();
    const logger = recordingLogger("warn");
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "A durable maintenance notice.",
        acknowledge: () => {
          throw new Error("sensitive notice id");
        },
      }));
    });
    const { paths, lifecycle, seenOptions } = setupClaudeHost({ hooks, logger });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-ack-failure",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-ack-failure",
    ))).toBe(true);
    expect(logger.records).toContainEqual({
      level: "warn",
      message: "before_prompt hook acknowledgement failed",
      fields: {
        ghost: "casper",
        conversation: "conversation-ack-failure",
        runtime: "claude-code",
      },
    });
    expect(JSON.stringify(logger.records)).not.toContain("sensitive notice id");

    await host!.runTurn("casper", {
      sessionId: "conversation-ack-failure",
      prompt: "continue after the acknowledgement failure",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(lifecycle.closed).toBe(2);
    expect(seenOptions[1]?.resume).toBe(
      (JSON.parse(readFileSync(
        claudeSessionMetadataPath(paths.sessionDir, "conversation-ack-failure"),
        "utf8",
      )) as { sessionId: string }).sessionId,
    );
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
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          state.queries === 1
            ? [errorResultMessage(sessionId, "error_max_turns", 3)]
            : responseMessages(sessionId, "Recovered after the terminal error."),
          state,
          input.prompt,
        );
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
    expect(lifecycle.closed).toBe(1);

    const retryEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-max-turns",
      prompt: "retry cold",
      emit: (event) => retryEvents.push(event),
    });
    expect(retryEvents.at(-1)?.type).toBe("done");
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBe(metadata.sessionId);
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-max-turns"),
      "utf8",
    ))).toMatchObject({ ownerTurnCount: 2, messageCount: 8 });
  });

  it("does not publish an invalid session id from a terminal SDK result", async () => {
    const invalidSessionId = "x".repeat(513);
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          state.queries === 1
            ? [errorResultMessage(invalidSessionId, "error_during_execution", 1)]
            : responseMessages(sessionId, "Recovered after invalid metadata."),
          state,
          input.prompt,
        );
      },
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
    expect(lifecycle.closed).toBe(1);

    await host!.runTurn("casper", {
      sessionId: "conversation-invalid-result-session",
      prompt: "start cleanly",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBeUndefined();
    expect(seenOptions[1]?.sessionId).toEqual(expect.any(String));
  });

  it("does not submit a prompt when its durable resume fence cannot be written", async () => {
    const { paths, lifecycle, seenOptions, seenPrompts } = setupClaudeHost();
    mkdirSync(paths.sessionDir, { recursive: true });
    chmodSync(paths.sessionDir, 0o500);
    const failedEvents: PiMessagesEvent[] = [];
    try {
      await host!.runTurn("casper", {
        sessionId: "conversation-metadata-write-failure",
        prompt: "this result cannot settle",
        emit: (event) => failedEvents.push(event),
      });
    } finally {
      chmodSync(paths.sessionDir, 0o700);
    }

    expect(failedEvents.at(-1)).toMatchObject({ type: "error" });
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });
    expect(seenPrompts).toEqual([]);
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-metadata-write-failure",
    ))).toBe(false);

    const retryEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-metadata-write-failure",
      prompt: "retry from durable state",
      emit: (event) => retryEvents.push(event),
    });
    expect(retryEvents.at(-1)?.type).toBe("done");
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBeUndefined();
  });

  it("preserves history but cold-restarts after an existing sidecar cannot advance", async () => {
    let prompted = 0;
    let sessionDir = "";
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, "durable turn"),
          state,
          input.prompt,
          () => {
            prompted += 1;
            if (prompted === 2) chmodSync(sessionDir, 0o500);
          },
        );
      },
    });
    sessionDir = paths.sessionDir;
    const sidecar = claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-existing-write-failure",
    );

    await host!.runTurn("casper", {
      sessionId: "conversation-existing-write-failure",
      prompt: "first durable turn",
      emit: () => {},
    });
    const first = JSON.parse(readFileSync(sidecar, "utf8")) as {
      sessionId: string;
    };

    const failedEvents: PiMessagesEvent[] = [];
    try {
      await host!.runTurn("casper", {
        sessionId: "conversation-existing-write-failure",
        prompt: "advance while the final write fails",
        emit: (event) => failedEvents.push(event),
      });
    } finally {
      chmodSync(paths.sessionDir, 0o700);
    }

    expect(failedEvents.at(-1)).toMatchObject({ type: "error" });
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      sessionId: first.sessionId,
      ownerTurnCount: 1,
      messageCount: 2,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(true);
    expect((await host!.listSessions("casper")).find((row) =>
      row.id === "claude-code:conversation-existing-write-failure"))
      .toMatchObject({ messageCount: 2 });

    await host!.runTurn("casper", {
      sessionId: "conversation-existing-write-failure",
      prompt: "restart cold without losing durable history",
      emit: () => {},
    });
    expect(seenOptions[1]?.resume).toBeUndefined();
    expect(seenOptions[1]?.sessionId).not.toBe(first.sessionId);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      sessionId: seenOptions[1]?.sessionId,
      ownerTurnCount: 2,
      messageCount: 4,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(false);
  });

  it("recovers an exact settling candidate before resuming another turn", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const conversationId = "conversation-settling-recovery";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    await host!.runTurn("casper", {
      sessionId: conversationId,
      prompt: "publish the first result",
      emit: () => {},
    });
    await host!.close("casper", conversationId);
    const first = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    const settling = {
      ...first,
      sessionId: "recovered-sdk-session",
      modified: "2026-08-30T12:00:00.000Z",
      messageCount: 4,
      ownerTurnCount: 2,
    };
    writeFileSync(`${sidecar}.started`, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId,
    })}\n`, { mode: 0o600 });
    writeFileSync(`${sidecar}.settling`, `${JSON.stringify(settling)}\n`, { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: conversationId,
      prompt: "continue after recovery",
      emit: () => {},
    });

    expect(seenOptions[1]?.resume).toBe("recovered-sdk-session");
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      sessionId: "recovered-sdk-session",
      messageCount: 6,
      ownerTurnCount: 3,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(false);
    expect(existsSync(`${sidecar}.settling`)).toBe(false);
  });

  it("rejects the exact terminal emit failure and resumes cold afterward", async () => {
    const failure = new Error("terminal stream consumer failed");
    const { paths, lifecycle, seenOptions } = setupClaudeHost();
    const first = host!.runTurn("casper", {
      sessionId: "conversation-terminal-emit-failure",
      prompt: "settle before terminal delivery",
      emit: (event) => {
        if (event.type === "done") throw failure;
      },
    });

    await expect(first).rejects.toBe(failure);
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });
    const metadata = JSON.parse(readFileSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-terminal-emit-failure",
    ), "utf8")) as { sessionId: string };

    await host!.runTurn("casper", {
      sessionId: "conversation-terminal-emit-failure",
      prompt: "resume from the durable result",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBe(metadata.sessionId);
  });

  it("fences resume while preserving persisted counts when the SDK fails before a result", async () => {
    const { paths, lifecycle } = setupClaudeHost({
      createQuery: (_input, state) => fakeQuery([], state, (async function* fail() {
        throw new Error("simulated process failure");
        // biome-ignore lint/correctness/noUnreachable: shapes the generator type.
        yield undefined as unknown as SDKUserMessage;
      })()),
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
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 1,
      sessionId: "existing-sdk-session",
      messageCount: 8,
      ownerTurnCount: 3,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(true);
  });

  it("does not start a query for an already-aborted turn", async () => {
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

    expect(lifecycle).toMatchObject({ queries: 0, interrupted: 0, closed: 0 });
    expect(seenOptions).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("uses authoritative SDK abort and close during cancellation", async () => {
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
            throw new Error("cancellation must not send a control request");
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
    expect(lifecycle.interrupted).toBe(0);
    expect(lifecycle.closed).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-wedged"),
    )).toBe(false);
  });

  it("force-closes an active query without requesting over its closed transport", async () => {
    const started = deferred();
    const order: string[] = [];
    let transportClosed = false;
    const { lifecycle } = setupClaudeHost({
      createQuery: (input, state) => {
        const stream = (async function* () {
          started.resolve();
          await new Promise<void>((resolve) => {
            input.options.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
        return Object.assign(stream, {
          interrupt: async () => {
            if (transportClosed) throw new Error("SDK control transport is closed");
            state.interrupted += 1;
            order.push("interrupt");
          },
          close: () => {
            if (transportClosed) return;
            transportClosed = true;
            state.closed += 1;
            order.push("close");
          },
        }) as unknown as Query;
      },
    });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-active-close",
      prompt: "keep running",
      emit: (event) => events.push(event),
    });
    await started.promise;

    await Promise.all([host!.close("casper", "conversation-active-close"), turn]);

    expect(order).toEqual(["close"]);
    expect(lifecycle).toMatchObject({ interrupted: 0, closed: 1 });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("does not move a ghost home until the retired SDK subprocess confirms exit", async () => {
    const processExit = deferred();
    const { lifecycle } = setupClaudeHost({
      useSdkSpawnExitBoundary: true,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        const spawnProcess = input.options.spawnClaudeCodeProcess;
        if (!spawnProcess) throw new Error("SDK spawn exit boundary was not installed");
        const child = spawnProcess({
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume(); process.stdin.once('end', () => "
              + "setTimeout(() => process.exit(0), 80));",
          ],
          cwd: temp!.ownerHome,
          env: { ...process.env },
          signal: new AbortController().signal,
        });
        child.once("exit", () => processExit.resolve());
        const stream = (async function* () {
          for (const message of responseMessages(sessionId, "ready to close")) yield message;
        })();
        let closed = false;
        return Object.assign(stream, {
          interrupt: async () => {},
          close: () => {
            if (closed) return;
            closed = true;
            state.closed += 1;
            child.stdin.end();
          },
        }) as unknown as Query;
      },
    });
    await host!.runTurn("casper", {
      sessionId: "conversation-delayed-process-exit",
      prompt: "start the subprocess",
      emit: () => {},
    });

    let renamed = false;
    const renaming = host!.renameGhost("casper", "wisp").then(() => {
      renamed = true;
    });
    await vi.waitFor(() => expect(lifecycle.closed).toBe(1));
    expect(renamed).toBe(false);
    expect(temp!.registry.list().map((ghost) => ghost.name)).toContain("casper");
    await processExit.promise;
    await renaming;
    expect(temp!.registry.list().map((ghost) => ghost.name)).toContain("wisp");
  });

  it("fails a home move with a retryable type when SDK exit remains unconfirmed", async () => {
    const processExit = deferred();
    setupClaudeHost({
      exitWaitTimeoutMs: 20,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, "ready to close"),
          state,
          input.prompt,
          undefined,
          processExit,
          false,
        );
      },
    });
    await host!.runTurn("casper", {
      sessionId: "conversation-exit-timeout",
      prompt: "start the subprocess",
      emit: () => {},
    });

    await expect(host!.renameGhost("casper", "wisp")).rejects.toMatchObject({
      code: "claude_code_exit_unconfirmed",
      status: 503,
    });
    expect(temp!.registry.list().map((ghost) => ghost.name)).toContain("casper");

    processExit.resolve();
    await expect(host!.renameGhost("casper", "wisp"))
      .resolves.toMatchObject({ name: "wisp" });
  });

  it("aborts and drains a pre-query turn before close can return", async () => {
    const probeStarted = deferred();
    const releaseProbe = deferred();
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      resolveExecutable: async () => {
        probeStarted.resolve();
        await releaseProbe.promise;
        return process.execPath;
      },
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
    });
    const { lifecycle, paths, seenOptions } = setupClaudeHost({ probe });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-close-during-probe",
      prompt: "do not resurrect this turn",
      emit: (event) => events.push(event),
    });
    await probeStarted.promise;
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );

    let closeSettled = false;
    const closing = host!.close("casper", "conversation-close-during-probe").then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseProbe.resolve();
    await Promise.all([closing, turn]);

    expect(closeSettled).toBe(true);
    expect(lifecycle).toMatchObject({ queries: 0, closed: 0 });
    expect(seenOptions).toEqual([]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-close-during-probe",
    ))).toBe(false);
    const settledEvents = [...events];
    await Promise.resolve();
    expect(events).toEqual(settledEvents);

    await host!.runTurn("casper", {
      sessionId: "conversation-close-during-probe",
      prompt: "start after the closed turn",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(1);
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("bookbinder");
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
    expect(lifecycle.interrupted).toBe(0);
    expect(lifecycle.closed).toBeGreaterThanOrEqual(1);
  });
});

describe("claudeSdkTranscriptPath", () => {
  it("locates the SDK session transcript by id under the config projects tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-claude-config-"));
    try {
      const projectDir = join(root, "projects", "-home-me-project");
      mkdirSync(projectDir, { recursive: true });
      const transcript = join(projectDir, "0123abcd-session.jsonl");
      writeFileSync(transcript, "");
      const env = { CLAUDE_CONFIG_DIR: root };
      expect(claudeSdkTranscriptPath("0123abcd-session", env)).toBe(transcript);
      expect(claudeSdkTranscriptPath("missing-session", env)).toBeUndefined();
      expect(claudeSdkTranscriptPath("../escape", env)).toBeUndefined();
      expect(claudeSdkTranscriptPath("0123abcd-session", {
        CLAUDE_CONFIG_DIR: join(root, "nope"),
      })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
