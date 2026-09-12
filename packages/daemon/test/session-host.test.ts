/**
 * Session host against a mock provider. No real model is ever called.
 *
 * The properties under test are the ones the spike found are easy to lose:
 * sessions inside the ghost home, native Pi tools, Ghost-owned discovery and
 * provider prompt, and two ghosts staying separate
 * while answering at the same time in one process.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join, sep } from "node:path";
import {
  browserSessionFor,
  closeAllBrowserSessions,
  relayBackend,
  type RelayTransport,
} from "@ghost/extensions";
import { GhostMcpManager } from "../src/mcp-manager.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { createMCPToolName } from "../src/mcp-tool-names.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSessionMetadataPath } from "../src/claude-code.js";
import { ghostPaths } from "../src/ghosts.js";
import {
  clearGhostModelRole,
  openAiCompatiblePreset,
  setGhostModelRole,
  writeGhostModels,
  type GhostModelDefinition,
  type GhostModelsFile,
} from "../src/models.js";
import { GhostHookRunner, MAX_SESSION_STOP_CONTINUATIONS } from "../src/hooks.js";
import {
  PI_NATIVE_TOOL_NAMES,
  SessionHost,
  forkConversationTitle,
  parseUserBashCommand,
  sessionFileNameFor,
  sessionKeyOf,
  type SessionHostOptions,
  type TrashedConversation,
} from "../src/session-host.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { readPinState, writePins } from "../src/pins.js";
import { readReadState, writeReads } from "../src/reads.js";
import { conversationCwdPath, writeConversationCwd } from "../src/conversation-cwd.js";
import {
  readToolCwds,
  TOOL_CWDS_MAX_BYTES,
  toolCwdsPath,
  writeToolCwds,
} from "../src/tool-cwds.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "../src/home-operations.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import {
  createMockProviderBarrier,
  startMockProvider,
  type MockProvider,
} from "./helpers/mock-provider.js";
import { recordingLogger } from "./helpers/recording-logger.js";
let temp: TempGhosts | null = null;
let provider: MockProvider | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await closeAllBrowserSessions();
  await host?.disposeAll();
  host = null;
  await provider?.close();
  provider = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  temp?.cleanup();
  temp = null;
});

const TEST_DOC = `# Restoring the Vandercook

Pull the roller bearings before you soak anything.
`;

function directoryBytesSnapshot(root: string): string[] {
  const snapshot: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        snapshot.push(`directory:${relativePath}`);
        visit(path, relativePath);
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        snapshot.push(`file:${relativePath}:sha256:${digest}`);
      } else {
        snapshot.push(`other:${relativePath}`);
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function writeMcpFixture(
  dir: string,
  options: { enabled?: boolean; empty?: boolean; cwd?: string; project?: boolean } = {},
): void {
  const configPath = options.project ? join(dir, ".omp", "mcp.json") : join(dir, "mcp.json");
  mkdirSync(join(configPath, ".."), { recursive: true });
  const serverPath = join(dir, "reload-mcp.mjs");
  if (!existsSync(serverPath)) {
    writeFileSync(
      serverPath,
      `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(join(dir, "mcp-cwd.txt"))}, process.cwd());
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send(request.id, {
    protocolVersion: "2025-11-25", capabilities: { tools: {} },
    serverInfo: { name: "reload-fixture", version: "1.0.0" }
  });
  else if (request.method === "tools/list") send(request.id, { tools: [{
    name: "reload_echo", description: "Reload fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }] });
  else send(request.id, {});
});
`,
      "utf8",
    );
  }
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: options.empty ? {} : {
        reload_fixture: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath],
          ...(options.enabled === false ? { enabled: false } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
      },
    }),
    "utf8",
  );
}

async function setup(
  script: Parameters<typeof startMockProvider>[0]["script"] = [{ kind: "text", text: "hello" }],
  options: Pick<
    SessionHostOptions,
    | "hooks"
    | "browserSessionClose"
    | "homeOperations"
    | "askTimeoutSeconds"
    | "claudeCode"
    | "compaction"
    | "title"
    | "retention"
    | "sessionStartupProbe"
    | "toolCwdWriter"
    | "pinWriter"
    | "readWriter"
    | "conversationFileProbe"
    | "transactionProbe"
    | "transactionWriter"
    | "transactionMarkerLstat"
    | "ghostHomeLstat"
    | "logger"
    | "scheduleCommandRunner"
  > = {},
  providerOptions: Omit<Parameters<typeof startMockProvider>[0], "script"> = {},
) {
  temp = makeTempGhosts();
  provider = await startMockProvider({ script, ...providerOptions });
  const dir = seedGhost(temp.root, {
    name: "casper",
    docs: { "press.md": TEST_DOC },
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    machineSkillPaths: [],
    offline: true,
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    ...options,
  });
  return { dir, host, provider, temp };
}

async function _modelSystemPrompt(
  sessionId: string,
  prompt = "Show that this conversation is ready.",
): Promise<string> {
  const before = provider?.requests.length ?? 0;
  await host!.runTurn("casper", { sessionId, prompt, emit: () => {} });
  const request = provider?.requests[before];
  if (!request) throw new Error("Expected the turn to reach the mock provider.");
  return request.system;
}

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for state");
}

async function listenOnLoopback(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("test HTTP server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
      } else {
        reject(error);
      }
    };
    try {
      server.close(settle);
      server.closeAllConnections();
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function readHttpJson(request: IncomingMessage): Promise<{
  id?: string | number;
  method?: string;
}> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return JSON.parse(body) as { id?: string | number; method?: string };
}

function captureHostedMcpLogs(): {
  daemon: unknown[];
  omp: unknown[];
  logger: SessionHostOptions["logger"];
  dispose(): void;
} {
  const logger = recordingLogger();
  const omp: unknown[] = [];
  const dispose = () => {};
  return {
    daemon: logger.records,
    omp,
    logger,
    dispose,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function failedRelayOpen(
  homeDir: string,
  failure: "cancelled" | "timeout",
  onClose: () => void | Promise<void> = () => {},
): Promise<{
  readonly sent: string[];
  readonly closeRequested: Promise<void>;
  settleCreate(): void;
}> {
  const openStarted = deferred();
  const createSettled = deferred();
  const closeRequested = deferred();
  const sent: string[] = [];
  const transport: RelayTransport = {
    connected: true,
    peer: "test relay",
    request: async (op) => {
      sent.push(op);
      if (op === "open") {
        openStarted.resolve();
        if (failure === "timeout") {
          return { ok: false, failure: "timeout", message: "relay deadline elapsed" };
        }
        await createSettled.promise;
        return {
          ok: true,
          result: {
            id: "test-tab",
            page: { url: "https://example.com/", title: "Example" },
          },
        };
      }
      if (op === "close") {
        closeRequested.resolve();
        await createSettled.promise;
        await onClose();
        return { ok: true, result: { closed: true } };
      }
      return { ok: false, failure: "invalid_input", message: "unexpected test op" };
    },
  };
  const browser = browserSessionFor(homeDir, {
    backend: relayBackend({ transport }),
    idleTimeoutMs: 0,
  });
  const controller = new AbortController();
  const opening = browser.backend.open("https://example.com/", {
    timeoutMs: 1_000,
    ...(failure === "cancelled" ? { signal: controller.signal } : {}),
  });
  const observed = opening.then(
    () => undefined,
    (error: unknown) => error,
  );
  await openStarted.promise;
  if (failure === "cancelled") controller.abort();
  expect(await observed).toMatchObject({
    details: failure === "cancelled" ? { reason: "aborted" } : { failure: "timeout" },
  });
  expect(browser.backend.running).toBe(true);
  return {
    sent,
    closeRequested: closeRequested.promise,
    settleCreate: createSettled.resolve,
  };
}

function authRuntimeForTest(handle: Awaited<ReturnType<SessionHost["open"]>>): {
  close(): void;
} {
  return (handle as typeof handle & { modelRuntime: { close(): void } }).modelRuntime;
}

describe("sessionKeyOf", () => {
  it("encodes (ghost, session) unambiguously — no delimiter collision", () => {
    // A plain delimiter would map ("ghost a", "b") and ("ghost", "a b") onto
    // one key; the JSON encoding keeps them distinct.
    expect(sessionKeyOf("ghost a", "b")).not.toBe(sessionKeyOf("ghost", "a b"));
    expect(sessionKeyOf("a", "b")).not.toBe(sessionKeyOf("a\0b", undefined));
    // Same inputs still collide (it is a stable map key).
    expect(sessionKeyOf("casper", "conv-1")).toBe(sessionKeyOf("casper", "conv-1"));
  });

  it("collapses an empty or missing session id to the default", () => {
    expect(sessionKeyOf("casper", null)).toBe(sessionKeyOf("casper", undefined));
    expect(() => sessionKeyOf("casper", "")).toThrow(expect.objectContaining({
      code: "invalid_conversation_id",
      status: 400,
    }));
    expect(sessionKeyOf("casper", "default")).toBe(sessionKeyOf("casper", undefined));
  });
});

describe("parseUserBashCommand", () => {
  it("recognizes Ghost's contextual and context-free Bash sigils", () => {
    expect(parseUserBashCommand("!pwd")).toEqual({
      command: "pwd",
      excludeFromContext: false,
    });
    expect(parseUserBashCommand("  !! printenv TOKEN ")).toEqual({
      command: "printenv TOKEN",
      excludeFromContext: true,
    });
    expect(parseUserBashCommand("ordinary message!")).toBeNull();
  });
});

describe("Ghost slash commands", () => {
  it("discovers the live Ghost catalog and annotates its execution policy", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const commands = await host!.availableCommands("casper", "conv-commands");

    expect(commands).toContainEqual(expect.objectContaining({
      name: "tools",
      source: "builtin",
      availability: "available",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      name: "memory",
      source: "builtin",
      availability: "unsupported",
    }));
    // Ghost combines its headless builtins with the unified registry so
    // familiar Pi TUI-only commands remain discoverable but honest.
    expect(commands).toContainEqual(expect.objectContaining({
      name: "help",
      source: "builtin",
      availability: "unsupported",
      unavailableReason: expect.stringContaining("interactive terminal UI"),
    }));
  });

  it("reports that an active Claude Code runtime has no Ghost command catalog", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    setGhostModelRole(ghostPaths(dir).home, "chat_model", "claude-code", "default");

    await expect(host!.availableCommands("casper", "conv-claude"))
      .rejects.toMatchObject({ code: "not_supported", status: 409 });
  });

  it("runs admitted builtins without a model and rejects unsafe or TUI-only ones", async () => {
    await setup([{ kind: "text", text: "must not be requested" }]);

    const run = async (sessionId: string, prompt: string) => {
      const events: PiMessagesEvent[] = [];
      await host!.runTurn("casper", { sessionId, prompt, emit: (event) => events.push(event) });
      return events;
    };

    const tools = await run("conv-tools", "/tools");
    expect(tools[0]).toEqual({ type: "start" });
    expect(tools).toContainEqual(expect.objectContaining({
      type: "command_output",
      command: "/tools",
      output: expect.stringContaining("read"),
    }));
    expect(tools.at(-1)).toMatchObject({ type: "done", usage: { totalTokens: 0 } });

    for (const [sessionId, prompt, command] of [
      ["conv-memory", "/memory stats", "/memory"],
      ["conv-help", "/help", "/help"],
      ["conv-delete", "/session delete", "/session"],
    ] as const) {
      const events = await run(sessionId, prompt);
      expect(events).toContainEqual(expect.objectContaining({
        type: "command_output",
        command,
        isError: true,
        code: "unsupported_command",
      }));
      expect(events.at(-1)).toMatchObject({ type: "done", usage: { totalTokens: 0 } });
    }

    expect(provider!.requests).toHaveLength(0);
  });
});

describe("SessionHost.open", () => {
  it("resumes a legacy Pi transcript at its historical cwd", async () => {
    const { dir } = await setup();
    const paths = ghostPaths(dir);
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(
      join(paths.sessionDir, sessionFileNameFor("legacy-cwd")),
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "legacy-cwd",
        timestamp: "2026-08-26T00:00:00.000Z",
        cwd: dir,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const handle = await host!.open("casper", "legacy-cwd");
    expect(handle.session.sessionManager.getCwd()).toBe(dir);
    expect(await host!.conversationCwd("casper", "legacy-cwd")).toBe(dir);
  });

  it("accepts only a line-one native Pi cwd header and rejects unsafe transcript shapes", async () => {
    const { dir } = await setup();
    const paths = ghostPaths(dir);
    mkdirSync(paths.sessionDir, { recursive: true });
    const writeTranscript = (
      conversationId: string,
      lines: readonly Record<string, unknown>[],
    ) => {
      const path = join(paths.sessionDir, sessionFileNameFor(conversationId));
      writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return path;
    };
    const header = (id: string) => ({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp: "2026-08-26T00:00:00.000Z",
      cwd: dir,
    });

    // Keep ahead of the padded transcripts below: the snapshot bracketing this
    // read base64s every file in the session directory, and 384 MiB fixtures
    // would cost three quarters of a gigabyte twice to prove nothing extra.
    const nulPrefix = join(temp!.root, "must-not-become-a-cwd");
    writeTranscript("nul-cwd-legacy", [{
      ...header("nul-cwd-legacy"),
      cwd: `${nulPrefix}\0escape`,
    }]);
    const beforeNulRead = directoryBytesSnapshot(paths.sessionDir);
    await expect(host!.conversationCwd("casper", "nul-cwd-legacy"))
      .resolves.toBe(temp!.ownerHome);
    expect(directoryBytesSnapshot(paths.sessionDir)).toEqual(beforeNulRead);
    expect(existsSync(nulPrefix)).toBe(false);

    const sparse = writeTranscript("sparse-legacy", [header("sparse-legacy")]);
    truncateSync(sparse, 384 * 1024 * 1024);
    await expect(host!.conversationCwd("casper", "sparse-legacy"))
      .resolves.toBe(dir);

    const titleFirst = writeTranscript("title-first-legacy", [
      { type: "title", title: "Legacy title", source: "auto" },
      header("title-first-legacy"),
    ]);
    const titleFirstBytes = readFileSync(titleFirst);
    await expect(host!.conversationCwd("casper", "title-first-legacy"))
      .resolves.toBe(temp!.ownerHome);
    await expect(host!.open("casper", "title-first-legacy"))
      .rejects.toThrow("not a valid pi session");
    expect(readFileSync(titleFirst)).toEqual(titleFirstBytes);

    const longLine = join(paths.sessionDir, sessionFileNameFor("long-header"));
    writeFileSync(longLine, `${"x".repeat(64 * 1024 + 1)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    truncateSync(longLine, 384 * 1024 * 1024);
    await expect(host!.conversationCwd("casper", "long-header"))
      .resolves.toBe(temp!.ownerHome);

    const fifo = join(paths.sessionDir, sessionFileNameFor("fifo-header"));
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    await expect(host!.conversationCwd("casper", "fifo-header"))
      .resolves.toBe(temp!.ownerHome);

    const outside = join(temp!.root, "outside-session.jsonl");
    writeFileSync(outside, `${JSON.stringify(header("linked-header"))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const linked = join(paths.sessionDir, sessionFileNameFor("linked-header"));
    symlinkSync(outside, linked);
    await expect(host!.conversationCwd("casper", "linked-header"))
      .resolves.toBe(temp!.ownerHome);
    expect(readFileSync(outside, "utf8")).toContain('"cwd"');
  });

  it("starts a new conversation in the settings.yml cwd when one is named", async () => {
    const { dir } = await setup();
    const workspace = join(temp!.ownerHome, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(ghostPaths(dir).settingsFile, `cwd: ${workspace}\n`);

    const handle = await host!.open("casper", "conv-settings-cwd");
    expect(handle.session.sessionManager.getCwd()).toBe(workspace);
  });

  it("ignores a settings.yml cwd outside the owner home", async () => {
    const { dir } = await setup();
    writeFileSync(ghostPaths(dir).settingsFile, "cwd: /srv/elsewhere\n");

    const handle = await host!.open("casper", "conv-bad-cwd");
    expect(handle.session.sessionManager.getCwd()).toBe(temp!.ownerHome);
  });

  it("closes the borrowed model runtime when a later startup stage fails", async () => {
    let closeRuntime: ReturnType<typeof vi.spyOn> | undefined;
    await setup([{ kind: "text", text: "unused" }], {
      sessionStartupProbe: (stage, runtime) => {
        closeRuntime ??= vi.spyOn(runtime, "close");
        if (stage === "session-manager") throw new Error("injected post-runtime startup failure");
      },
    });

    await expect(host!.open("casper", "startup-failure"))
      .rejects.toThrow("injected post-runtime startup failure");
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(host!.cachedSessionCount).toBe(0);
  });

  it("keeps sessions, settings, and models inside the ghost home", async () => {
    const { dir } = await setup();
    const handle = await host!.open("casper", "conv-1");

    const paths = ghostPaths(dir);
    expect(handle.sessionFile).toBeDefined();
    expect(handle.sessionFile!.startsWith(paths.sessionDir + sep)).toBe(true);
    expect(handle.sessionFile).toBe(join(paths.sessionDir, sessionFileNameFor("conv-1")));
    expect(handle.model).toEqual({ provider: "ghost-local", id: provider!.modelId });
  });

  it("binds the configured model before open() resolves", async () => {
    // createAgentSession owns and awaits initial selection, so open() returns
    // with the configured model already visible to the first prompt.
    await setup();
    const handle = await host!.open("casper", "conv-1");
    expect(handle.session.model?.id).toBe(provider!.modelId);
    expect(handle.session.model?.provider).toBe("ghost-local");
  });

  it("inherits Pi's native tools and adds Ghost's own capabilities", async () => {
    await setup();
    const handle = await host!.open("casper", "conv-1");
    const names = handle.session.getActiveToolNames();

    expect(PI_NATIVE_TOOL_NAMES).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    expect(names).toEqual(expect.arrayContaining([...PI_NATIVE_TOOL_NAMES, "ask"]));
    expect(names).toContain("inspect_image");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("task");
    expect(handle.session.getToolDefinition("task")).toBeUndefined();
    for (const name of ["ghost_browser", "ghost_desktop", "ghost_screen"]) {
      expect(handle.session.getToolDefinition(name), `${name} must be available`).toBeDefined();
    }
  });

  it("does not offer inspect_image to a chat model with native vision", async () => {
    const { dir } = await setup();
    const paths = ghostPaths(dir);
    const models = openAiCompatiblePreset({
      providerId: "ghost-local",
      baseUrl: provider!.url,
      modelId: provider!.modelId,
      apiKey: "not-needed",
    });
    models.providers["ghost-local"]!.models![0]!.input = ["text", "image"];
    writeGhostModels(paths.home, models);

    const handle = await host!.open("casper", "vision-tools");
    expect(handle.session.getActiveToolNames()).not.toContain("inspect_image");
    expect(handle.session.getToolDefinition("inspect_image")).toBeDefined();
  });

  it("reuses one session per conversation id and separates different ids", async () => {
    await setup();
    const first = await host!.open("casper", "conv-1");
    const again = await host!.open("casper", "conv-1");
    const other = await host!.open("casper", "conv-2");

    expect(again.session).toBe(first.session);
    expect(other.session).not.toBe(first.session);
    expect(other.sessionFile).not.toBe(first.sessionFile);
  });

  it("loads only visible ghost MCP while unbound, never ambient coding-agent MCP", async () => {
    const logger = recordingLogger();
    const { dir } = await setup(undefined, {
      logger,
    });
    const serverPath = join(dir, "ghost-mcp.mjs");
    writeFileSync(
      serverPath,
      `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "ghost-visible-fixture", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    send(request.id, { tools: [{
      name: "ghost_echo",
      description: "Echo from visible ghost MCP.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] });
  } else if (request.method === "resources/list") {
    send(request.id, { resources: [] });
  } else if (request.method === "resources/templates/list") {
    send(request.id, { resourceTemplates: [] });
  } else if (request.method === "prompts/list") {
    send(request.id, { prompts: [] });
  } else {
    send(request.id, {});
  }
});
`,
      "utf8",
    );
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          ghost_visible: {
            command: process.execPath,
            args: [serverPath],
          },
          malformed: {
            type: "stdio",
            command: { secret: "MCP_LOG_AND_LAUNCH_SENTINEL" },
          },
        },
      }),
      "utf8",
    );

    const handle = await host!.open("casper", "conv-mcp");
    const toolNames = handle.session.getAllTools().map((tool) => tool.name);
    expect(toolNames).toContain("mcp__ghost_visible_ghost_echo");
    expect(toolNames.some((name) => name.includes("malformed"))).toBe(false);
    expect(JSON.stringify(logger.records)).not.toContain("MCP_LOG_AND_LAUNCH_SENTINEL");
    // This machine deliberately has `node_repl` in ~/.codex/config.toml. Its
    // absence here is the live sovereignty regression, not a mocked condition.
    expect(toolNames.some((name) => name.startsWith("mcp__node_repl_"))).toBe(false);
  });

  it("preserves inherited-object MCP names across Pi config, source, tools, and status", async () => {
    const { dir } = await setup();
    writeMcpFixture(dir);
    const serverPath = join(dir, "reload-mcp.mjs");
    const names = ["__proto__", "constructor", "toString"];
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: Object.fromEntries(names.map((name) => [name, {
        type: "stdio",
        command: process.execPath,
        args: [serverPath],
      }])),
    }));

    const handle = await host!.open("casper", "hostile-mcp-names");
    const mcp = (host as unknown as {
      sessions: Map<string, {
        mcp?: {
          manager: { getServerConfig(name: string): unknown };
          sources: Map<string, unknown>;
        };
      }>;
    }).sessions.get(sessionKeyOf("casper", "hostile-mcp-names"))?.mcp;

    for (const name of names) {
      expect(handle.session.getToolDefinition(createMCPToolName(name, "reload_echo"))).toBeDefined();
      expect(host!.mcpConnectionStatus("casper", name)).toBe("connected");
      expect(mcp?.sources.get(name)).toEqual({ path: join(dir, "mcp.json") });
      expect(mcp?.manager.getServerConfig(name)).toMatchObject({
        command: process.execPath,
        args: [serverPath],
        cwd: dir,
      });
    }
  });

  it("redacts an immediate hosted MCP HTTP connection failure from daemon and Pi logs", async () => {
    const responseSecret = "MCP_IMMEDIATE_RESPONSE_BODY_SECRET";
    const urlSecret = "MCP_IMMEDIATE_CONFIGURED_URL_SECRET";
    const captured = captureHostedMcpLogs();
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end(responseSecret);
    });
    const baseUrl = await listenOnLoopback(server);

    try {
      const { dir } = await setup(undefined, {
        logger: captured.logger,
      });
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            immediate_failure: {
              type: "http",
              url: `${baseUrl}/mcp?credential=${urlSecret}`,
              timeout: 1_000,
            },
          },
        }),
        "utf8",
      );

      await host!.open("casper", "mcp-immediate-redaction");
      await host!.disposeAll();
      host = null;

      const allLogs = JSON.stringify([captured.daemon, captured.omp]);
      expect(allLogs).toContain("mcp_connection_failed");
      expect(allLogs).not.toContain(responseSecret);
      expect(allLogs).not.toContain(urlSecret);
      expect(allLogs).not.toContain(`${baseUrl}/mcp`);
    } finally {
      await host?.disposeAll();
      host = null;
      captured.dispose();
      await closeHttpServer(server);
    }
  });

  it("redacts a delayed hosted MCP tool-list timeout and server event from every log", async () => {
    const eventSecret = "MCP_DELAYED_SERVER_EVENT_SECRET";
    const urlSecret = "MCP_DELAYED_CONFIGURED_URL_SECRET";
    const captured = captureHostedMcpLogs();
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        request.resume();
        response.writeHead(405);
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        request.resume();
        response.writeHead(202);
        response.end();
        return;
      }
      void readHttpJson(request).then((message) => {
        if (message.method === "initialize") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "delayed-redaction-fixture", version: "1.0.0" },
            },
          }));
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        if (message.method === "tools/list") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          response.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              method: `notifications/${eventSecret}`,
              params: { secret: eventSecret },
            })}\n\n`,
          );
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
    });
    const baseUrl = await listenOnLoopback(server);

    try {
      const { dir } = await setup(undefined, {
        logger: captured.logger,
      });
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            delayed_timeout: {
              type: "http",
              url: `${baseUrl}/mcp?credential=${urlSecret}`,
              timeout: 600,
            },
          },
        }),
        "utf8",
      );

      await host!.open("casper", "mcp-delayed-redaction");
      await waitFor(() => JSON.stringify(captured.daemon).includes("mcp_tool_load_failed") ? true : null, 3_000);
      await host!.disposeAll();
      host = null;

      const allLogs = JSON.stringify([captured.daemon, captured.omp]);
      expect(allLogs).toContain("mcp_tool_load_failed");
      expect(allLogs).not.toContain(eventSecret);
      expect(allLogs).not.toContain(urlSecret);
      expect(allLogs).not.toContain(`${baseUrl}/mcp`);
      expect(allLogs).not.toContain("SSE response timeout");
    } finally {
      await host?.disposeAll();
      host = null;
      captured.dispose();
      await closeHttpServer(server);
    }
  });

  it("discovers visible skills and commands without enabling ghost agents", async () => {
    const { dir } = await setup();
    mkdirSync(join(dir, "skills", "inking"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "inking", "SKILL.md"),
      "---\nname: inking\ndescription: Ink a forme evenly.\n---\n\nInk it.\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "agents", "pressman.md"),
      "---\nname: pressman\ndescription: Runs the press.\n---\n\nRun it.\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "commands", "proofsheet.md"),
      "---\ndescription: Proof a sheet.\n---\n\nProof it.\n",
      "utf8",
    );

    const handle = await host!.open("casper", "conv-visible-artifacts");

    expect(handle.skills.map((skill) => skill.name)).toContain("inking");
    expect(handle.commands.map((command) => command.name))
      .toContain("proofsheet");
    // Custom definitions can still appear in artifact previews, but neither
    // they nor an ambient project definition can activate Pi subagents in phase 1.
    expect(handle.session.getToolDefinition("task")).toBeUndefined();
    // This harness disables machine roots unless a test opts into them.
    expect(handle.skills.map((skill) => skill.name)).toEqual(["inking"]);
  });

  it("admits ambient machine skills without a hardcoded name allowlist", async () => {
    await setup();
    const skills = join(temp!.ownerHome, ".agents", "skills");
    mkdirSync(join(skills, "firecrawl"), { recursive: true });
    mkdirSync(join(skills, "hey"), { recursive: true });
    mkdirSync(join(skills, "ambient"), { recursive: true });
    writeFileSync(
      join(skills, "firecrawl", "SKILL.md"),
      "---\nname: firecrawl\ndescription: Official Firecrawl CLI skill.\n---\n\nUse firecrawl.\n",
      "utf8",
    );
    writeFileSync(
      join(skills, "hey", "SKILL.md"),
      "---\nname: hey\ndescription: Official HEY CLI skill.\n---\n\nUse hey.\n",
      "utf8",
    );
    writeFileSync(
      join(skills, "ambient", "SKILL.md"),
      "---\nname: ambient\ndescription: Owner-installed ambient skill.\n---\n\nUse ambient.\n",
      "utf8",
    );

    await host!.disposeAll();
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      machineSkillPaths: [skills],
      offline: true,
    });

    const handle = await host!.open("casper", "conv-firecrawl-skill");

    expect(handle.skills.map((skill) => skill.name).sort()).toEqual(["ambient", "firecrawl", "hey"]);
    expect(handle.session.systemPrompt).toContain("firecrawl: Official Firecrawl CLI skill.");
    expect(handle.session.systemPrompt).toContain("hey: Official HEY CLI skill.");
    expect(handle.session.systemPrompt).toContain("ambient: Owner-installed ambient skill.");
    expect(handle.session.systemPrompt).toContain(
      join(skills, "firecrawl", "SKILL.md"),
    );
    expect(handle.session.systemPrompt).toContain("omarchy commands --json");
  });

  it("keeps owner-home coding-agent instructions out of an unbound prompt", async () => {
    await setup();
    mkdirSync(join(temp!.ownerHome, ".claude"), { recursive: true });
    mkdirSync(join(temp!.ownerHome, ".agents"), { recursive: true });
    writeFileSync(join(temp!.ownerHome, ".claude", "CLAUDE.md"), "HOSTILE-CLAUDE-IDENTITY");
    writeFileSync(join(temp!.ownerHome, ".agents", "AGENTS.md"), "HOSTILE-AGENTS-IDENTITY");

    const handle = await host!.open("casper", "conv-owner-context");
    const prompt = handle.session.systemPrompt;
    expect(prompt).not.toContain("HOSTILE-CLAUDE-IDENTITY");
    expect(prompt).not.toContain("HOSTILE-AGENTS-IDENTITY");
  });

  it("discovers visible Ghost context and supports /skill:name invocation", async () => {
    const { dir } = await setup([{ kind: "text", text: "skill applied" }]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Workshop rule\nAlways identify the composing stick.\n",
      "utf8",
    );
    const skillDir = join(dir, "skills", "press-review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: press-review",
        "description: Review a printing press repair plan.",
        "---",
        "",
        "Check the tympan and packing before suggesting a repair.",
        "",
      ].join("\n"),
      "utf8",
    );

    const handle = await host!.open("casper", "conv-skill");
    expect(handle.skills.map((skill) => skill.name)).toContain("press-review");
    await host!.runTurn("casper", {
      sessionId: "conv-skill",
      prompt: "/skill:press-review focus on the rollers",
      emit: () => {},
    });
    expect(provider!.requests[0]?.system).toContain("Always identify the composing stick");
    expect(provider!.requests[0]?.system).toContain(
      "press-review: Review a printing press repair plan.",
    );
    expect(provider!.requests[0]?.system).not.toContain("Check the tympan and packing");
    expect(JSON.stringify(provider!.requests[0]?.messages)).toContain(
      "Check the tympan and packing",
    );
    expect(JSON.stringify(provider!.requests[0]?.messages)).toContain("focus on the rollers");
  });
});

describe("SessionHost retention", () => {
  it("unrefs its sweep timer, expires idle sessions, and disposes the timer", async () => {
    let now = 1_000;
    let sweep = () => {};
    let unrefs = 0;
    let disposals = 0;
    await setup([{ kind: "text", text: "unused" }], {
      retention: {
        idleTtlMs: 100,
        maxSessions: 10,
        sweepIntervalMs: 25,
        now: () => now,
        schedule: (callback, intervalMs) => {
          expect(intervalMs).toBe(25);
          sweep = callback;
          return {
            unref: () => { unrefs += 1; },
            dispose: () => { disposals += 1; },
          };
        },
      },
    });
    const opened = await host!.open("casper", "conv-expire");
    expect(unrefs).toBe(1);

    now += 101;
    sweep();
    await waitFor(() => host!.cachedSessionCount === 0 ? true : null);
    await waitFor(() => (opened as { sessionDisposed?: boolean }).sessionDisposed === true ? true : null);

    await host!.disposeAll();
    expect(disposals).toBe(1);
  });

  it("retries transient retention teardown before reopening the same conversation", async () => {
    let now = 1_000;
    let sweep = () => {};
    let startups = 0;
    await setup([{ kind: "text", text: "unused" }], {
      retention: {
        idleTtlMs: 100,
        maxSessions: 10,
        now: () => now,
        schedule: (callback) => {
          sweep = callback;
          return { dispose: () => {} };
        },
      },
      sessionStartupProbe: (stage) => {
        if (stage === "model-runtime") startups += 1;
      },
    });
    const conversationId = "conv-retention-retry";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    const originalDispose = opened.session.dispose.bind(opened.session);
    const dispose = vi.spyOn(opened.session, "dispose")
      .mockRejectedValueOnce(new Error("transient retained-session disposal"))
      .mockImplementation(() => originalDispose());
    const internals = host as unknown as {
      cleanupRetries: Map<string, typeof opened>;
      closing: Map<string, unknown>;
    };

    now += 101;
    sweep();
    await waitFor(() =>
      internals.cleanupRetries.has(key) && !internals.closing.has(key) ? true : null
    );
    expect(host!.cachedSessionCount).toBe(0);
    expect(startups).toBe(1);

    const replacement = await host!.open("casper", conversationId);
    expect(replacement.session).not.toBe(opened.session);
    expect(startups).toBe(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(internals.cleanupRetries.has(key)).toBe(false);
  });

  it("keeps permanent retention teardown pending without creating a replacement", async () => {
    let now = 1_000;
    let sweep = () => {};
    let startups = 0;
    await setup([{ kind: "text", text: "unused" }], {
      retention: {
        idleTtlMs: 100,
        maxSessions: 10,
        now: () => now,
        schedule: (callback) => {
          sweep = callback;
          return { dispose: () => {} };
        },
      },
      sessionStartupProbe: (stage) => {
        if (stage === "model-runtime") startups += 1;
      },
    });
    const conversationId = "conv-retention-pending";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    const originalDispose = opened.session.dispose.bind(opened.session);
    let fail = true;
    const dispose = vi.spyOn(opened.session, "dispose").mockImplementation(() => {
      if (fail) return Promise.reject(new Error("permanent retained-session disposal"));
      return originalDispose();
    });
    const internals = host as unknown as {
      cleanupRetries: Map<string, typeof opened>;
      closing: Map<string, unknown>;
    };

    now += 101;
    sweep();
    await waitFor(() =>
      internals.cleanupRetries.has(key) && !internals.closing.has(key) ? true : null
    );
    await expect(host!.open("casper", conversationId)).rejects.toMatchObject({
      code: "session_cleanup_pending",
      status: 503,
    });
    expect(startups).toBe(1);
    expect(host!.cachedSessionCount).toBe(0);
    expect(internals.cleanupRetries.get(key)?.session).toBe(opened.session);

    fail = false;
    const replacement = await host!.open("casper", conversationId);
    expect(replacement.session).not.toBe(opened.session);
    expect(startups).toBe(2);
    expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(internals.cleanupRetries.has(key)).toBe(false);
  });

  it("evicts the least-recently-used idle session at the soft maximum", async () => {
    let now = 1_000;
    await setup([{ kind: "text", text: "unused" }], {
      retention: {
        idleTtlMs: 0,
        maxSessions: 2,
        now: () => now,
      },
    });
    const first = await host!.open("casper", "conv-oldest");
    now += 1;
    const second = await host!.open("casper", "conv-recent");
    now += 1;
    await host!.open("casper", "conv-oldest");
    now += 1;
    await host!.open("casper", "conv-new");

    expect(host!.cachedSessionCount).toBe(2);
    await waitFor(() => (second as { sessionDisposed?: boolean }).sessionDisposed === true ? true : null);
    expect(((first as { sessionDisposed?: boolean }).sessionDisposed === true)).toBe(false);
  });

  it("does not evict an expired session while a turn owns it", async () => {
    const barrier = createMockProviderBarrier();
    let now = 1_000;
    let sweep = () => {};
    await setup([{ kind: "text", text: "held", barrier }], {
      retention: {
        idleTtlMs: 10,
        maxSessions: 10,
        now: () => now,
        schedule: (callback) => {
          sweep = callback;
          return { dispose: () => {} };
        },
      },
    });
    const opened = await host!.open("casper", "conv-owned");
    const turn = host!.runTurn("casper", {
      sessionId: "conv-owned",
      prompt: "hold",
      emit: () => {},
    });
    await barrier.waitForArrivals();

    now += 100;
    sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host!.cachedSessionCount).toBe(1);
    expect(((opened as { sessionDisposed?: boolean }).sessionDisposed === true)).toBe(false);

    barrier.release();
    await turn;
    expect(host!.cachedSessionCount).toBe(1);
  });

  it("times out hung title providers so they cannot protect an unbounded cache", async () => {
    const titleSignals: AbortSignal[] = [];
    const deadlines: Array<{ run: () => void; disposed: boolean }> = [];
    await setup([{ kind: "text", text: "done" }], {
      retention: { idleTtlMs: 0, maxSessions: 1 },
      title: {
        timeoutMs: 50_000,
        scheduleTimeout: (run, timeoutMs) => {
          expect(timeoutMs).toBe(50_000);
          const deadline = { run, disposed: false };
          deadlines.push(deadline);
          return {
            dispose: () => {
              deadline.disposed = true;
            },
          };
        },
        generate: async ({ signal }) => {
          titleSignals.push(signal);
          return new Promise(() => {});
        },
      },
    });

    await Promise.all([
      host!.runTurn("casper", { sessionId: "conv-title-a", prompt: "a", emit: () => {} }),
      host!.runTurn("casper", { sessionId: "conv-title-b", prompt: "b", emit: () => {} }),
    ]);
    expect(host!.cachedSessionCount).toBe(2);
    expect(titleSignals).toHaveLength(2);
    expect(titleSignals.some((signal) => signal.aborted)).toBe(false);
    expect(deadlines).toHaveLength(2);
    const internal = host as unknown as {
      sessions: Map<string, { title?: Promise<void> }>;
    };
    const titleTasks = [...internal.sessions.values()]
      .map(({ title }) => title)
      .filter((title): title is Promise<void> => title !== undefined);

    for (const deadline of deadlines) deadline.run();
    expect(titleSignals.every((signal) => signal.aborted)).toBe(true);
    await Promise.all(titleTasks);

    expect(host!.cachedSessionCount).toBe(1);
    expect(deadlines.every(({ disposed }) => disposed)).toBe(true);
  });
});

describe("SessionHost shutdown", () => {
  it("stops admission synchronously and aborts an active provider turn", async () => {
    const barrier = createMockProviderBarrier();
    await setup([{ kind: "text", text: "held", barrier }]);
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conv-shutdown",
      prompt: "hold",
      emit: (event) => events.push(event),
    });
    await barrier.waitForArrivals();

    host!.beginShutdown();
    await expect(host!.open("casper", "new-after-signal"))
      .rejects.toMatchObject({ code: "shutting_down", status: 503 });
    await expect(Promise.race([
      turn.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])).resolves.toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });

    barrier.release();
    await host!.disposeAll();
  });

  it("cancels a hung background title during shutdown", async () => {
    const titleStarted = deferred();
    let titleSignal: AbortSignal | undefined;
    await setup([{ kind: "text", text: "done" }], {
      title: {
        timeoutMs: 5_000,
        generate: async ({ signal }) => {
          titleSignal = signal;
          titleStarted.resolve();
          return new Promise(() => {});
        },
      },
    });
    await host!.runTurn("casper", {
      sessionId: "conv-title-shutdown",
      prompt: "title me",
      emit: () => {},
    });
    await titleStarted.promise;

    await host!.disposeAll();
    expect(titleSignal?.aborted).toBe(true);
  });

  it("reports and retries incomplete per-session shutdown cleanup", async () => {
    const logger = recordingLogger();
    await setup([{ kind: "text", text: "unused" }], {
      logger,
    });
    const conversationId = "conv-shutdown-cleanup-retry";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    const originalDispose = opened.session.dispose.bind(opened.session);
    let fail = true;
    const dispose = vi.spyOn(opened.session, "dispose").mockImplementation(() => {
      if (fail) return Promise.reject(new Error("transient shutdown session disposal"));
      return originalDispose();
    });
    const internals = host as unknown as {
      cleanupRetries: Map<string, typeof opened>;
    };

    await host!.disposeAll();
    expect(internals.cleanupRetries.get(key)?.session).toBe(opened.session);
    expect(logger.records).toContainEqual(expect.objectContaining({
      message: "session cleanup failed",
      fields: expect.objectContaining({
        session: key,
        stage: "daemon shutdown session",
      }),
    }));
    await expect(host!.open("casper", conversationId)).rejects.toMatchObject({
      code: "shutting_down",
      status: 503,
    });

    fail = false;
    await host!.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(internals.cleanupRetries.has(key)).toBe(false);
  });

  it("keeps a ghost home immovable until a blocked session close settles", async () => {
    const disposeEntered = deferred();
    const releaseDispose = deferred();
    await setup([{ kind: "text", text: "unused" }]);
    const opened = await host!.open("casper", "conv-closing-home");
    const originalDispose = opened.session.dispose.bind(opened.session);
    vi.spyOn(opened.session, "dispose").mockImplementation(async () => {
      disposeEntered.resolve();
      await releaseDispose.promise;
      await originalDispose();
    });

    const closing = host!.close("casper", "conv-closing-home");
    await disposeEntered.promise;
    await expect(host!.renameGhost("casper", "renamed"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    await expect(host!.deleteGhost("casper"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });

    releaseDispose.resolve();
    await closing;
  });

  it("retries every transient close stage before admitting a replacement session", async () => {
    let startups = 0;
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      sessionStartupProbe: (stage) => {
        if (stage === "model-runtime") startups += 1;
      },
    });
    writeMcpFixture(dir);
    const conversationId = "conv-retry-all-cleanup";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    const internals = host as unknown as {
      cleanupRetries: Map<string, typeof opened>;
    };
    const hostedMcp = opened as typeof opened & {
      mcp: { manager: { disconnectAll(): Promise<void> } };
    };
    const oldRuntime = authRuntimeForTest(opened);
    const closeRuntime = vi.spyOn(oldRuntime, "close");
    const originalAbort = opened.session.abort.bind(opened.session);
    const abort = vi.spyOn(opened.session, "abort")
      .mockRejectedValueOnce(new Error("transient session abort"))
      .mockImplementation(() => originalAbort());
    const originalDisconnect = hostedMcp.mcp.manager.disconnectAll.bind(hostedMcp.mcp.manager);
    const disconnect = vi.spyOn(hostedMcp.mcp.manager, "disconnectAll")
      .mockRejectedValueOnce(new Error("transient MCP disconnect"))
      .mockImplementation(() => originalDisconnect());
    const originalDispose = opened.session.dispose.bind(opened.session);
    const dispose = vi.spyOn(opened.session, "dispose")
      .mockRejectedValueOnce(new Error("transient session dispose"))
      .mockImplementation(() => originalDispose());

    await expect(host!.close("casper", conversationId)).rejects.toBeInstanceOf(AggregateError);
    expect(host!.cachedSessionCount).toBe(0);
    expect(internals.cleanupRetries.get(key)?.session).toBe(opened.session);
    expect(startups).toBe(1);

    const replacement = await host!.open("casper", conversationId);
    expect(replacement.session).not.toBe(opened.session);
    expect(internals.cleanupRetries.has(key)).toBe(false);
    expect(startups).toBe(2);
    expect(abort.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(replacement.session.getToolDefinition("mcp__reload_fixture_reload_echo")).toBeDefined();
  });

  it("keeps permanently failing cleanup as a typed replacement-open gate", async () => {
    let startups = 0;
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      sessionStartupProbe: (stage) => {
        if (stage === "model-runtime") startups += 1;
      },
    });
    writeMcpFixture(dir);
    const conversationId = "conv-permanent-cleanup";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    const internals = host as unknown as {
      cleanupRetries: Map<string, typeof opened>;
      sessions: Map<string, typeof opened>;
    };
    const hostedMcp = opened as typeof opened & {
      mcp: { manager: { disconnectAll(): Promise<void> } };
    };
    const oldRuntime = authRuntimeForTest(opened);
    const closeRuntime = vi.spyOn(oldRuntime, "close");
    let fail = true;
    const originalAbort = opened.session.abort.bind(opened.session);
    vi.spyOn(opened.session, "abort").mockImplementation(() => {
      if (fail) return Promise.reject(new Error("permanent session abort"));
      return originalAbort();
    });
    const originalDisconnect = hostedMcp.mcp.manager.disconnectAll.bind(hostedMcp.mcp.manager);
    vi.spyOn(hostedMcp.mcp.manager, "disconnectAll").mockImplementation(() => {
      if (fail) return Promise.reject(new Error("permanent MCP disconnect"));
      return originalDisconnect();
    });
    const originalDispose = opened.session.dispose.bind(opened.session);
    vi.spyOn(opened.session, "dispose").mockImplementation(() => {
      if (fail) return Promise.reject(new Error("permanent session dispose"));
      return originalDispose();
    });

    await expect(host!.close("casper", conversationId)).rejects.toBeInstanceOf(AggregateError);
    await expect(host!.open("casper", conversationId)).rejects.toMatchObject({
      code: "session_cleanup_pending",
      status: 503,
    });
    expect(startups).toBe(1);
    expect(host!.cachedSessionCount).toBe(0);
    expect(internals.sessions.has(key)).toBe(false);
    expect(internals.cleanupRetries.get(key)?.session).toBe(opened.session);
    expect(closeRuntime).toHaveBeenCalledOnce();

    fail = false;
    await expect(host!.close("casper", conversationId)).resolves.toBeUndefined();
    expect(internals.cleanupRetries.has(key)).toBe(false);
    expect(closeRuntime).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent teardown attempts for the same hosted session", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const conversationId = "conv-coalesced-cleanup";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalDispose = opened.session.dispose.bind(opened.session);
    const dispose = vi.spyOn(opened.session, "dispose").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await originalDispose();
    });
    const internals = host as unknown as {
      closeHostedSession(key: string): Promise<void>;
      cleanupRetries: Map<string, typeof opened>;
    };

    const first = internals.closeHostedSession(key);
    await entered.promise;
    const second = internals.closeHostedSession(key);
    expect(second).toBe(first);
    expect(internals.cleanupRetries.get(key)?.session).toBe(opened.session);
    release.resolve();
    await Promise.all([first, second]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.cleanupRetries.has(key)).toBe(false);
  });

});

describe("SessionHost.reloadMcp", () => {
  it("preserves policy-protected MCP maps across open, reload, and reconnect", async () => {
    const requests: Array<{ authorization: string | undefined; method: string; url: string }> = [];
    const remote = createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        method: request.method ?? "",
        url: request.url ?? "",
      });
      request.resume();
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("unavailable");
    });
    const baseUrl = await listenOnLoopback(remote);
    try {
      const { dir } = await setup([{ kind: "text", text: "unused" }]);
      const ordinary = "$" + "{GHOST_MCP_SESSION_ORDINARY}";
      const protectedValue = "$" + "{GHOST_MCP_SESSION_PROTECTED}";
      const launchLog = join(dir, "policy-mcp-launches.jsonl");
      const serverPath = join(dir, "policy-mcp.mjs");
      writeFileSync(
        serverPath,
        `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({
  name: process.argv[2], ordinary: process.argv[3], token: process.env.TOKEN
}) + "\\n");
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send(request.id, {
    protocolVersion: "2025-11-25", capabilities: { tools: {} },
    serverInfo: { name: "policy-probe", version: "1.0.0" }
  });
  else if (request.method === "tools/list") send(request.id, { tools: [] });
  else send(request.id, {});
});
`,
        "utf8",
      );
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({
        mcpServers: {
          literal_stdio: {
            type: "stdio",
            command: process.execPath,
            args: [serverPath, "literal", ordinary],
            env: { TOKEN: protectedValue },
            envPolicy: "literal",
          },
          inherited_stdio: {
            type: "stdio",
            command: process.execPath,
            args: [serverPath, "inherited", ordinary],
            env: { TOKEN: protectedValue },
          },
          literal_http: {
            type: "http",
            url: `${baseUrl}/literal-http-${ordinary}`,
            headers: { Authorization: protectedValue },
            headerPolicy: "origin-locked",
            timeout: 50,
          },
          literal_sse: {
            type: "sse",
            url: `${baseUrl}/literal-sse-${ordinary}`,
            headers: { Authorization: protectedValue },
            headerPolicy: "origin-locked",
            timeout: 50,
          },
          inherited_http: {
            type: "http",
            url: `${baseUrl}/inherited-http-${ordinary}`,
            headers: { Authorization: protectedValue },
            timeout: 50,
          },
        },
      }), "utf8");
      const launchRows = () => existsSync(launchLog)
        ? readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean).map((line) =>
            JSON.parse(line) as { name: string; ordinary: string; token: string })
        : [];
      const expectPhase = async (
        ordinaryValue: string,
        inheritedSecret: string,
        minimumLaunches: number,
      ) => {
        const launches = await waitFor(() => {
          const rows = launchRows();
          return rows.length >= minimumLaunches ? rows : null;
        }, 5_000);
        expect(launches).toEqual(expect.arrayContaining([
          { name: "literal", ordinary: ordinaryValue, token: protectedValue },
          { name: "inherited", ordinary: ordinaryValue, token: inheritedSecret },
        ]));
        expect(requests).toEqual(expect.arrayContaining([
          expect.objectContaining({
            authorization: protectedValue,
            url: `/literal-http-${ordinaryValue}`,
          }),
          expect.objectContaining({
            authorization: protectedValue,
            url: `/literal-sse-${ordinaryValue}`,
          }),
          expect.objectContaining({
            authorization: inheritedSecret,
            url: `/inherited-http-${ordinaryValue}`,
          }),
        ]));
      };

      vi.stubEnv("GHOST_MCP_SESSION_ORDINARY", "open-expanded");
      vi.stubEnv("GHOST_MCP_SESSION_PROTECTED", "open-ambient-secret");
      const opened = await host!.open("casper", "mcp-policy-expansion");
      await expectPhase("open-expanded", "open-ambient-secret", 2);
      const firstManager = (opened as unknown as {
        mcp: { manager: { getServerConfig(name: string): unknown } };
      }).mcp.manager;
      expect(firstManager.getServerConfig("literal_stdio")).toMatchObject({
        env: { TOKEN: protectedValue },
      });

      requests.length = 0;
      vi.stubEnv("GHOST_MCP_SESSION_ORDINARY", "reload-expanded");
      vi.stubEnv("GHOST_MCP_SESSION_PROTECTED", "reload-ambient-secret");
      await host!.reloadMcp("casper");
      await expectPhase("reload-expanded", "reload-ambient-secret", 4);
      const reloadedManager = (opened as unknown as {
        mcp: { manager: { getServerConfig(name: string): unknown } };
      }).mcp.manager;
      expect(reloadedManager).not.toBe(firstManager);

      requests.length = 0;
      vi.stubEnv("GHOST_MCP_SESSION_ORDINARY", "reconnect-must-not-expand");
      vi.stubEnv("GHOST_MCP_SESSION_PROTECTED", "reconnect-must-not-enter-map");
      for (const name of [
        "literal_stdio",
        "inherited_stdio",
        "literal_http",
        "literal_sse",
        "inherited_http",
      ]) {
        await host!.reconnectMcp("casper", name);
      }
      await expectPhase("reload-expanded", "reload-ambient-secret", 6);
      const reconnectedManager = (opened as unknown as {
        mcp: { manager: { getServerConfig(name: string): unknown } };
      }).mcp.manager;
      expect(reconnectedManager).not.toBe(reloadedManager);
      expect(JSON.stringify(reconnectedManager.getServerConfig("literal_stdio")))
        .not.toContain("reconnect-must-not-enter-map");
      expect(JSON.stringify(reconnectedManager.getServerConfig("literal_http")))
        .not.toContain("reconnect-must-not-enter-map");
    } finally {
      await host?.disposeAll();
      host = null;
      await closeHttpServer(remote);
    }
  });

  it("makes pre-stream turn admission and ghost-wide MCP transitions mutually exclusive", async () => {
    const { dir } = await setup([{ kind: "text", text: "admitted turn completed" }]);
    writeMcpFixture(dir);
    const sessionDir = ghostPaths(dir).sessionDir;
    const conversationId = "mcp-turn-lease";
    const opened = await host!.open("casper", conversationId);
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();
    const initialMcp = (opened as unknown as {
      mcp: { manager: { reconnectServer: (name: string, options: { manual: boolean }) => Promise<boolean> } };
    }).mcp.manager;
    const initialReconnect = vi.spyOn(initialMcp, "reconnectServer");

    const admitted = await host!.admitTurn("casper", {
      sessionId: conversationId,
      prompt: "complete after the rejected transitions",
    });
    let mutationCalls = 0;
    await expect(host!.withMcpReload("casper", async () => {
      mutationCalls += 1;
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.reconnectMcp("casper", "reload_fixture"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(mutationCalls).toBe(0);
    expect(initialReconnect).not.toHaveBeenCalled();
    expect((opened as unknown as { mcp: { manager: unknown } }).mcp.manager).toBe(initialMcp);
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();

    const admittedEvents: PiMessagesEvent[] = [];
    await admitted.run({ emit: (event) => admittedEvents.push(event) });
    expect(admittedEvents.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "done" })]);
    expect(provider!.requests.length).toBeGreaterThanOrEqual(1);

    const mutationEntered = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const transition = host!.withMcpReload("casper", async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;
    await expect(host!.admitTurn("casper", {
      sessionId: "blocked-by-mcp-mutation",
      prompt: "must not be admitted",
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(existsSync(join(sessionDir, sessionFileNameFor("blocked-by-mcp-mutation"))))
      .toBe(false);
    releaseMutation.resolve();
    await transition;
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();

    const currentMcp = (opened as unknown as { mcp: { manager: GhostMcpManager } }).mcp.manager;
    const reconnectEntered = Promise.withResolvers<void>();
    const releaseReconnect = Promise.withResolvers<void>();
    const originalConnect = GhostMcpManager.prototype.connectServers;
    const connectSpy = vi.spyOn(GhostMcpManager.prototype, "connectServers").mockImplementationOnce(async function (
      this: GhostMcpManager,
      configs,
    ) {
      reconnectEntered.resolve();
      await releaseReconnect.promise;
      return originalConnect.call(this, configs);
    });
    const reconnecting = host!.reconnectMcp("casper", "reload_fixture");
    await reconnectEntered.promise;
    await expect(host!.admitTurn("casper", {
      sessionId: "blocked-by-mcp-reconnect",
      prompt: "must not be admitted",
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(existsSync(join(sessionDir, sessionFileNameFor("blocked-by-mcp-reconnect"))))
      .toBe(false);
    releaseReconnect.resolve();
    await reconnecting;
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect((opened as unknown as { mcp: { manager: unknown } }).mcp.manager).not.toBe(currentMcp);
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();
    connectSpy.mockRestore();
  });

  it("never falls back to the former hidden MCP path on open or reload", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    writeMcpFixture(dir, { enabled: false });
    const serverPath = join(dir, "reload-mcp.mjs");
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(
      join(dir, ".omp", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          reload_fixture: {
            type: "stdio",
            command: process.execPath,
            args: [serverPath],
          },
        },
      }),
      "utf8",
    );

    const handle = await host!.open("casper", "conv-mcp-shadow");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();

    writeMcpFixture(dir, { empty: true });
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeDefined();
    const ghostMcp = (host as unknown as {
      sessions: Map<string, { mcp?: { sources: Map<string, unknown> } }>;
    }).sessions.get(sessionKeyOf("casper", "conv-mcp-shadow"))?.mcp;
    expect(ghostMcp?.sources.get("reload_fixture")).toEqual({ path: join(dir, "mcp.json") });
  });

  it("mounts the first server across open conversations and unmounts disabled or removed tools", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    const first = await host!.open("casper", "conv-mcp-first");
    const second = await host!.open("casper", "conv-mcp-second");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(first.session.getToolDefinition(toolName)).toBeUndefined();
    expect(second.session.getToolDefinition(toolName)).toBeUndefined();

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(first.session.getToolDefinition(toolName)).toBeDefined();
    expect(second.session.getToolDefinition(toolName)).toBeDefined();
    expect(host!.mcpConnectionStatus("casper", "reload_fixture")).toBe("connected");

    writeMcpFixture(dir, { enabled: false });
    await host!.reloadMcp("casper");
    expect(first.session.getToolDefinition(toolName)).toBeUndefined();
    expect(second.session.getToolDefinition(toolName)).toBeUndefined();

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(first.session.getToolDefinition(toolName)).toBeDefined();
    writeMcpFixture(dir, { empty: true });
    await host!.reloadMcp("casper");
    expect(first.session.getToolDefinition(toolName)).toBeUndefined();
    expect(second.session.getToolDefinition(toolName)).toBeUndefined();
  });

  it("rejects normal-turn reload/reconnect leases until the admitted turn settles", async () => {
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Ready",
            question: "Ready?",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Wait" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Done." },
    ]);
    const handle = await host!.open("casper", "conv-mcp-busy");
    const toolName = "mcp__reload_fixture_reload_echo";
    const turn = host!.runTurn("casper", {
      sessionId: "conv-mcp-busy",
      prompt: "Ask me first.",
      emit: () => {},
    });
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-mcp-busy"));

    writeMcpFixture(dir);
    await expect(host!.reloadMcp("casper"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.reconnectMcp("casper", "reload_fixture"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    host!.answerAsk("casper", "conv-mcp-busy", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Yes"] }],
    });
    await turn;

    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeDefined();
  });

  it("defers reload and reconnect across a raw external turn", async () => {
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Ready",
            question: "Ready?",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Wait" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Remote turn done." },
    ]);
    const handle = await host!.open("casper", "conv-mcp-remote");
    const toolName = "mcp__reload_fixture_reload_echo";

    // A raw AgentSession turn bypasses SessionHost.runTurn() and therefore
    // never sets HostedSession.busy.
    const remoteTurn = handle.session.prompt("Ask outside runTurn.");
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-mcp-remote"));
    expect(handle.session.isStreaming).toBe(true);

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("deferred");

    host!.answerAsk("casper", "conv-mcp-remote", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Yes"] }],
    });
    await remoteTurn;
    await waitFor(() => handle.session.getToolDefinition(toolName) ? true : null);
    expect(host!.mcpConnectionStatus("casper", "reload_fixture")).toBe("connected");
  });

});

describe("SessionHost.runTurn", () => {
  it("holds a terminal frame until the tool-cwd sidecar is durable", async () => {
    const writerEntered = deferred();
    const releaseWriter = deferred();
    await setup(
      [
        { kind: "tool", name: "read", args: { path: join(process.cwd(), "package.json") } },
        { kind: "text", text: "Saved." },
      ],
      {
        toolCwdWriter: async (...args) => {
          writerEntered.resolve();
          await releaseWriter.promise;
          return writeToolCwds(...args);
        },
      },
    );
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conv-tool-cwd-barrier",
      prompt: "Read the character.",
      emit: (event) => events.push(event),
    });
    await writerEntered.promise;
    await waitFor(() => events.some((event) => event.type === "tool_execution_end") ? true : null);
    expect(events.some((event) => event.type === "done" || event.type === "error")).toBe(false);

    releaseWriter.resolve();
    await turn;
    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(toolCwdsPath(
      ghostPaths(temp!.registry.get("casper").dir).sessionDir,
      "conv-tool-cwd-barrier",
    ))).toBe(true);
  });

  it("retries transient tool-cwd publication before sending done", async () => {
    let writes = 0;
    await setup(
      [
        { kind: "tool", name: "read", args: { path: join(process.cwd(), "package.json") } },
        { kind: "text", text: "Saved." },
      ],
      {
        toolCwdWriter: async (...args) => {
          writes += 1;
          if (writes < 3) throw new Error(`transient-${writes}`);
          return writeToolCwds(...args);
        },
      },
    );
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-tool-cwd-retry",
      prompt: "Read the character.",
      emit: (event) => events.push(event),
    });
    expect(writes).toBe(3);
    expect(events.at(-1)?.type).toBe("done");
    const calls = (await host!.readTranscript("casper", "conv-tool-cwd-retry")).messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => (part as { type?: unknown }).type === "toolCall") as Array<{
        cwd?: string | null;
      }>;
    expect(calls.map((call) => call.cwd)).toEqual([temp!.ownerHome]);
  });

  it("reports a durable tool-cwd failure, keeps it dirty, and recovers on close/restart", async () => {
    let writes = 0;
    await setup(
      [
        { kind: "tool", name: "read", args: { path: join(process.cwd(), "package.json") } },
        { kind: "text", text: "Saved." },
      ],
      {
        toolCwdWriter: async (...args) => {
          writes += 1;
          if (writes <= 4) throw new Error("sidecar unavailable");
          return writeToolCwds(...args);
        },
      },
    );
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-tool-cwd-restart",
      prompt: "Read the character.",
      emit: (event) => events.push(event),
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("sidecar unavailable"),
    });
    expect(writes).toBe(4);

    await host!.close("casper", "conv-tool-cwd-restart");
    expect(writes).toBe(5);
    await host!.disposeAll();
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      offline: true,
    });
    const calls = (await host.readTranscript("casper", "conv-tool-cwd-restart")).messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => (part as { type?: unknown }).type === "toolCall") as Array<{
        cwd?: string | null;
      }>;
    expect(calls.map((call) => call.cwd)).toEqual([temp!.ownerHome]);
  });

  it("restores an evicted old tool cwd as null after compaction and restart", async () => {
    await setup(
      [
        { kind: "tool", name: "read", args: { path: join(process.cwd(), "package.json") } },
        { kind: "tool", name: "read", args: { path: join(process.cwd(), "package.json") } },
        { kind: "text", text: "Read twice." },
      ],
      { title: { enabled: false } },
    );
    const conversationId = "conv-tool-cwd-compaction";
    await host!.runTurn("casper", {
      sessionId: conversationId,
      prompt: "Read the character twice.",
      emit: () => {},
    });
    const before = await host!.readTranscript("casper", conversationId);
    const ids = before.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => (part as { type?: unknown }).type === "toolCall")
      .map((part) => (part as { id: string }).id);
    expect(ids).toHaveLength(2);

    await host!.disposeAll();
    const sessionDir = ghostPaths(temp!.registry.get("casper").dir).sessionDir;
    const minimal = `{"version":2,"cwds":[${JSON.stringify([ids[0], "/"])}]}\n`;
    const oversizedOldCwd = `/${"x".repeat(
      TOOL_CWDS_MAX_BYTES - Buffer.byteLength(minimal),
    )}`;
    await writeToolCwds(sessionDir, conversationId, new Map([
      [ids[0]!, oversizedOldCwd],
      [ids[1]!, temp!.ownerHome],
    ]));
    await expect(readToolCwds(sessionDir, conversationId))
      .resolves.toEqual(new Map([[ids[1]!, temp!.ownerHome]]));

    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      offline: true,
    });
    const after = await host.readTranscript("casper", conversationId);
    const calls = after.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => (part as { type?: unknown }).type === "toolCall") as Array<{
        cwd?: string | null;
      }>;
    expect(calls.map((call) => call.cwd)).toEqual([null, temp!.ownerHome]);
  });

  it("pauses Ghost's ask until the shell supplies a validated answer", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Finish",
            question: "Which finish should I use?",
            options: [
              { label: "Matte", description: "Quiet and low-glare" },
              { label: "Gloss", description: "Brighter and reflective" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Matte it is." },
    ]);
    await host!.open("casper", "conv-ask");
    // Ghost owns the desktop interaction. The upstream notifier hard-codes its
    // product identity, so it must stay off even though the HTTP broker can
    // still present and resolve the ask.
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conv-ask",
      prompt: "Choose a finish with me.",
      emit: (event) => events.push(event),
    });

    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-ask"));
    expect(pending.questions).toEqual([
      expect.objectContaining({ id: "question-1", question: "Which finish should I use?" }),
    ]);
    host!.answerAsk("casper", "conv-ask", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Matte"] }],
    });
    await turn;

    expect(host!.pendingAsk("casper", "conv-ask")).toBeNull();
    expect(events.at(-1)?.type).toBe("done");
    expect(provider!.requests.filter((request) => request.system.includes("letterpress printer")))
      .toHaveLength(2);
    expect(JSON.stringify(provider!.requests[1]?.messages)).toContain("Matte");
  });

  it("re-opens a historical ask, commits a sibling answer, and resumes that branch", async () => {
    const writerEntered = deferred();
    const releaseWriter = deferred();
    let blockWriter = false;
    const hooks = new GhostHookRunner();
    const beforeOwners: string[] = [];
    const stoppedOwners: string[] = [];
    let reanswerBlocked = false;
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        beforeOwners.push(event.prompt);
      });
      api.on("session_stop", (event) => {
        stoppedOwners.push(event.owner_prompt);
        if (stoppedOwners.length === 2 && !reanswerBlocked) {
          reanswerBlocked = true;
          return { decision: "block", reason: "Make the revised choice explicit." };
        }
      });
    });
    await setup(
      [
        {
          kind: "tool",
          name: "ask",
          args: {
            questions: [{
              header: "Finish",
              question: "Which finish should I use?",
              options: [
                { label: "Matte", description: "Quiet and low-glare" },
                { label: "Gloss", description: "Brighter and reflective" },
              ],
              multiSelect: false,
            }],
          },
        },
        { kind: "text", text: "I will use that finish." },
        { kind: "text", text: "I will explicitly use gloss stock." },
        { kind: "text", text: "The final choice is gloss stock." },
      ],
      {
        hooks,
        title: { enabled: false },
        toolCwdWriter: async (...args) => {
          if (blockWriter) {
            writerEntered.resolve();
            await releaseWriter.promise;
          }
          return writeToolCwds(...args);
        },
      },
      { sequential: true },
    );
    const firstTurn = host!.runTurn("casper", {
      sessionId: "conv-reanswer",
      prompt: "Help choose the finish.",
      emit: () => {},
    });
    const firstAsk = await waitFor(() => host!.pendingAsk("casper", "conv-reanswer"));
    host!.answerAsk("casper", "conv-reanswer", firstAsk.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Matte"] }],
    });
    await firstTurn;

    const before = await host!.readTranscript("casper", "conv-reanswer");
    const askCall = before.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => (part as { name?: unknown }).name === "ask") as {
        ghostAsk?: { resultEntryId?: string; settled?: string };
      };
    expect(askCall.ghostAsk?.settled).toBe("submitted");
    const resultEntryId = askCall.ghostAsk?.resultEntryId;
    expect(resultEntryId).toBeTruthy();

    blockWriter = true;
    const events: PiMessagesEvent[] = [];
    const reanswer = host!.runAskReanswer("casper", {
      sessionId: "conv-reanswer",
      entryId: resultEntryId!,
      emit: (event) => events.push(event),
    });
    const revisedAsk = await waitFor(() => host!.pendingAsk("casper", "conv-reanswer"));
    host!.answerAsk("casper", "conv-reanswer", revisedAsk.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Gloss"] }],
    });
    await writerEntered.promise;
    await waitFor(() => events.some((event) => event.type === "branch_changed") ? true : null);
    expect(events.some((event) => event.type === "done" || event.type === "error")).toBe(false);
    releaseWriter.resolve();
    await reanswer;

    expect(events.some((event) => event.type === "branch_changed")).toBe(true);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(stoppedOwners).toEqual([
      beforeOwners[0],
      beforeOwners[1],
      beforeOwners[1],
    ]);
    expect(provider!.requests.length).toBeGreaterThanOrEqual(4);
    const reanswerText = events
      .filter((event): event is Extract<PiMessagesEvent, { type: "text_delta" }> =>
        event.type === "text_delta"
      )
      .map((event) => event.delta)
      .join("");
    expect(reanswerText).toContain("I will explicitly use gloss stock.");
    expect(reanswerText).toContain("The final choice is gloss stock.");
    expect(events.at(-1)?.type).toBe("done");
    expect(provider!.requests.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("Gloss");
    const after = await host!.readTranscript("casper", "conv-reanswer");
    const revisedCall = after.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => (part as { name?: unknown }).name === "ask") as {
        ghostAsk?: { resultEntryId?: string; settled?: string };
      };
    // The re-answer committed a sibling and the transcript follows it: the ask
    // the card now points at is the new result, not the one just left behind.
    expect(revisedCall.ghostAsk?.resultEntryId).toBeTruthy();
    expect(revisedCall.ghostAsk?.resultEntryId).not.toBe(resultEntryId);
    expect(revisedCall.ghostAsk?.settled).toBe("submitted");
    expect(beforeOwners).toHaveLength(2);
    expect(beforeOwners[0]).toBe("Help choose the finish.");
    expect(beforeOwners[1]).toContain("Gloss");
  });

  describe("how a historical ask settled", () => {
    const ASK_STEP = {
      kind: "tool" as const,
      name: "ask",
      args: {
        questions: [{
          header: "Finish",
          question: "Which finish should I use?",
          options: [
            { label: "Matte", description: "Quiet and low-glare" },
            { label: "Gloss", description: "Brighter and reflective" },
          ],
          multiSelect: false,
        }],
      },
    };

    async function settledOf(sessionId: string): Promise<string | undefined> {
      const transcript = await host!.readTranscript("casper", sessionId);
      const askCall = transcript.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((part) => (part as { name?: unknown }).name === "ask") as {
          ghostAsk?: { settled?: string };
        } | undefined;
      return askCall?.ghostAsk?.settled;
    }

    it("reports an answered ask as submitted", async () => {
      await setup([ASK_STEP, { kind: "text", text: "Matte it is." }]);
      const turn = host!.runTurn("casper", {
        sessionId: "conv-submitted",
        prompt: "Choose a finish.",
        emit: () => {},
      });
      const pending = await waitFor(() => host!.pendingAsk("casper", "conv-submitted"));
      host!.answerAsk("casper", "conv-submitted", pending.id, {
        kind: "submit",
        results: [{ id: "question-1", selectedOptions: ["Matte"] }],
      });
      await turn;

      expect(await settledOf("conv-submitted")).toBe("submitted");
    });

    it("reports a cancelled ask as cancelled", async () => {
      await setup([ASK_STEP, { kind: "text", text: "No finish chosen." }]);
      const turn = host!.runTurn("casper", {
        sessionId: "conv-cancelled",
        prompt: "Choose a finish.",
        emit: () => {},
      });
      const pending = await waitFor(() => host!.pendingAsk("casper", "conv-cancelled"));
      host!.answerAsk("casper", "conv-cancelled", pending.id, { kind: "cancel" });
      await turn;

      expect(await settledOf("conv-cancelled")).toBe("cancelled");
    });

    it("reports an ask nobody answered in time as timedOut", async () => {
      await setup([ASK_STEP, { kind: "text", text: "Matte it is." }], {
        askTimeoutSeconds: 1,
      });
      const turn = host!.runTurn("casper", {
        sessionId: "conv-timedout",
        prompt: "Choose a finish.",
        emit: () => {},
      });
      await waitFor(() => host!.pendingAsk("casper", "conv-timedout"));
      await turn;

      expect(await settledOf("conv-timedout")).toBe("timedOut");
    }, 15_000);

    it("answers a timed-out question without inventing an owner choice", async () => {
      await setup([
        ASK_STEP,
        { kind: "text", text: "Nobody chose; I will hold." },
      ], { askTimeoutSeconds: 1 });
      const turn = host!.runTurn("casper", {
        sessionId: "conv-timedout-open",
        prompt: "Choose a finish.",
        emit: () => {},
      });
      await waitFor(() => host!.pendingAsk("casper", "conv-timedout-open"));
      await turn;

      // Still a timeout rather than an answer, and the model was told the
      // question expired instead of being handed the first option as a choice.
      expect(await settledOf("conv-timedout-open")).toBe("timedOut");
      const asked = JSON.stringify(provider!.requests.map((request) => request.messages));
      expect(asked).not.toContain("User selected: Matte");
    }, 15_000);
  });

  it("queues Pi steering and follow-up messages while a turn is live", async () => {
    const hooks = new GhostHookRunner();
    const beforePrompts: string[] = [];
    const stoppedOwners: string[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        beforePrompts.push(event.prompt);
      });
      api.on("session_stop", (event) => {
        stoppedOwners.push(event.owner_prompt);
      });
    });
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Ready",
            question: "Ready to continue?",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Wait" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "I adjusted the direction." },
      { kind: "text", text: "And handled the follow-up." },
    ], { hooks });
    const turn = host!.runTurn("casper", {
      sessionId: "conv-queue",
      prompt: "Start.",
      emit: () => {},
    });
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-queue"));

    await host!.queueMessage("casper", "conv-queue", "steer", "Use the quieter direction.");
    await host!.queueMessage("casper", "conv-queue", "followUp", "Then explain the tradeoff.");
    expect(host!.queuedMessages("casper", "conv-queue")).toMatchObject({
      streaming: true,
      steering: ["Use the quieter direction."],
      followUp: ["Then explain the tradeoff."],
    });

    host!.answerAsk("casper", "conv-queue", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Yes"] }],
    });
    await turn;
    const requests = JSON.stringify(provider!.requests.map((request) => request.messages));
    expect(requests).toContain("Use the quieter direction.");
    expect(requests).toContain("Then explain the tradeoff.");
    expect(host!.queuedMessages("casper", "conv-queue").count).toBe(0);
    expect(beforePrompts).toEqual([
      "Start.",
      "Use the quieter direction.",
      "Then explain the tradeoff.",
    ]);
    expect(stoppedOwners).toEqual([
      "Use the quieter direction.",
      "Then explain the tradeoff.",
    ]);
  });

  it("awaits session_stop and sends only the current assistant pass", async () => {
    const hookContinuationPasses = 12;
    const hooks = new GhostHookRunner();
    const active: boolean[] = [];
    const passes: unknown[][] = [];
    const hookCwds: string[] = [];
    const hookOwners: string[] = [];
    const hookHomes: string[] = [];
    const hookIdentities: string[] = [];
    const hookTranscripts: Array<string | undefined> = [];
    await hooks.register((api) => {
      api.on("session_stop", (event) => {
        hookTranscripts.push(event.transcript_path);
        hookCwds.push(event.cwd);
        hookOwners.push(event.owner_prompt);
        hookHomes.push(event.ghost_home);
        hookIdentities.push(`${event.runtime}:${event.conversation_runtime}:${event.conversation_id}`);
        active.push(event.stop_hook_active);
        passes.push(event.messages);
        if (active.length <= hookContinuationPasses) {
          return { decision: "block", reason: "Rewrite the answer without canned phrasing." };
        }
      });
    });
    // The hook keeps asking for twelve; Ghost honors MAX_SESSION_STOP_CONTINUATIONS
    // of them and then accepts the pass, so the hook sees one more pass than
    // that. This test owns the retry via Ghost's session_stop hook and must
    // observe every pass itself.
    const passCount = MAX_SESSION_STOP_CONTINUATIONS + 1;
    const passTexts = [
      "The first answer circles around the point.",
      "Here is the direct answer.",
      ...Array.from(
        { length: passCount - 3 },
        (_, index) => `Here is direct answer ${index + 3}.`,
      ),
      "Here is the final direct answer.",
    ];
    await setup(passTexts.map((text) => ({ kind: "text" as const, text })), { hooks });

    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-hooks",
      prompt: "Answer me.",
      emit: (event) => events.push(event),
    });

    expect(active).toEqual([false, ...Array(passCount - 1).fill(true)]);
    expect(hookCwds).toEqual(Array(passCount).fill(temp!.ownerHome));
    expect(hookOwners).toEqual(Array(passCount).fill("Answer me."));
    expect(hookHomes).toEqual(Array(passCount).fill(join(temp!.root, "casper")));
    expect(hookIdentities).toEqual(Array(passCount).fill("pi:pi:conv-hooks"));
    expect(hookTranscripts).toEqual(
      Array(passCount).fill(join(temp!.root, "casper", "sessions", sessionFileNameFor("conv-hooks"))),
    );
    expect(passes).toHaveLength(passCount);
    expect(passes.every((messages) => messages.length === 1)).toBe(true);
    expect(passes.map((messages) => JSON.stringify(messages))).toEqual(
      passTexts.map((text) => expect.stringContaining(text)),
    );
    expect(JSON.stringify(passes)).not.toContain("Answer me.");
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    const streamedText = events
      .filter((event): event is Extract<PiMessagesEvent, { type: "text_delta" }> =>
        event.type === "text_delta"
      )
      .map((event) => event.delta)
      .join("");
    expect(streamedText).toContain("The first answer circles around the point.");
    expect(streamedText).toContain("Here is the direct answer.");
    expect(streamedText).toContain("Here is the final direct answer.");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("injects before_prompt context into the user turn without an extra model pass", async () => {
    const hooks = new GhostHookRunner();
    let hookCwd = "";
    let transcriptPath = "";
    let acknowledgedAfterPersistence = false;
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        hookCwd = event.cwd;
        return {
          additionalContext: "Avoid the warning from the previous reply.",
          acknowledge: () => {
            acknowledgedAfterPersistence = readFileSync(transcriptPath, "utf8")
              .includes("Avoid the warning from the previous reply.");
          },
        };
      });
    });
    const { dir } = await setup([{ kind: "text", text: "Direct answer." }], { hooks });
    transcriptPath = join(
      ghostPaths(dir).sessionDir,
      sessionFileNameFor("conv-before-prompt"),
    );

    await host!.runTurn("casper", {
      sessionId: "conv-before-prompt",
      prompt: "Continue.",
      emit: () => {},
    });

    expect(provider!.requests).toHaveLength(1);
    expect(hookCwd).toBe(temp!.ownerHome);
    expect(JSON.stringify(provider!.requests[0]?.messages)).toContain(
      "Avoid the warning from the previous reply.",
    );
    expect(acknowledgedAfterPersistence).toBe(true);
  });

  it("fails open without logging notice details when Pi acknowledgement fails", async () => {
    const hooks = new GhostHookRunner();
    const logger = recordingLogger("warn");
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "A retained private maintenance notice.",
        acknowledge: () => {
          throw new Error("sensitive notice id");
        },
      }));
    });
    await setup([{ kind: "text", text: "Direct answer." }], {
      hooks,
      logger,
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conv-ack-failure",
      prompt: "Continue.",
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)?.type).toBe("done");
    expect(logger.records).toContainEqual({
      level: "warn",
      message: "before_prompt hook acknowledgement failed",
      fields: { ghost: "casper", conversation: "conv-ack-failure", runtime: "pi" },
    });
    expect(JSON.stringify(logger.records)).not.toContain("sensitive notice id");
  });

  it("reconstructs Pi owner turn ids from the persisted branch after cache close", async () => {
    const hooks = new GhostHookRunner();
    const turnIds: number[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        turnIds.push(event.turn_id);
      });
    });
    await setup([{ kind: "text", text: "Answer." }], { hooks });

    await host!.runTurn("casper", { sessionId: "durable-turn-id", prompt: "One", emit: () => {} });
    await host!.close("casper", "durable-turn-id");
    await host!.runTurn("casper", { sessionId: "durable-turn-id", prompt: "Two", emit: () => {} });

    expect(turnIds).toEqual([1, 2]);
  });

  it("replaces Pi's prompt with the ghost persona while keeping its tools", async () => {
    await setup([{ kind: "text", text: "hi" }]);
    const handle = await host!.open("casper", "conv-1");
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "Who are you?",
      emit: () => {},
    });

    const request = provider!.requests[0];
    expect(request?.system).toContain("casper");
    expect(request?.system).toContain("letterpress printer");
    expect(request?.toolNames ?? []).toEqual(expect.arrayContaining([
      "read",
      "bash",
      "edit",
    ]));
    expect(handle.session.getToolDefinition("ghost_browser")).toBeDefined();
  });

  it("rejects direct Bash under Claude before creating Pi session or cwd state", async () => {
    let claudeQueries = 0;
    const { dir } = await setup([{ kind: "text", text: "must not run" }], {
      title: { enabled: false },
      claudeCode: {
        binaryPath: process.execPath,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        createQuery: () => {
          claudeQueries += 1;
          throw new Error("Claude query must not start for direct Bash");
        },
      },
    });
    setGhostModelRole(ghostPaths(dir).home, "chat_model", "claude-code", "default");
    const id = "claude-direct-command";
    const sessionDir = ghostPaths(dir).sessionDir;
    const events: PiMessagesEvent[] = [];

    for (const prompt of ["!cd /", "!!cd /"]) {
      await expect(host!.runTurn("casper", {
        sessionId: id,
        prompt,
        emit: (event) => events.push(event),
      })).rejects.toMatchObject({ code: "not_supported", status: 409 });
    }

    expect(events).toEqual([]);
    expect(provider!.requests).toHaveLength(0);
    expect(claudeQueries).toBe(0);
    expect(host!.cachedSessionCount).toBe(0);
    expect(existsSync(join(sessionDir, sessionFileNameFor(id)))).toBe(false);
    expect(existsSync(toolCwdsPath(sessionDir, id))).toBe(false);
    expect(existsSync(conversationCwdPath(sessionDir, id))).toBe(false);
    expect(existsSync(claudeSessionMetadataPath(sessionDir, id))).toBe(false);
  });

  it("runs !command through Pi without asking the model", async () => {
    await setup([{ kind: "text", text: "the model must not run" }]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-bash",
      prompt: "!printf ghost-bash",
      emit: (event) => events.push(event),
    });

    expect(provider!.requests).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "text_delta"
      && event.delta.includes("ghost-bash"))).toBe(true);
    const transcript = await host!.readTranscript("casper", "conv-bash");
    expect(JSON.stringify(transcript.messages)).toContain("ghost-bash");
  });

  it("keeps !!command out of model context", async () => {
    await setup([{ kind: "text", text: "ok" }]);
    await host!.runTurn("casper", {
      sessionId: "conv-secret-bash",
      prompt: "!!printf secret",
      emit: () => {},
    });
    const handle = await host!.open("casper", "conv-secret-bash");
    expect(handle.session.messages.at(-1)).toMatchObject({
      role: "bashExecution",
      excludeFromContext: true,
    });
  });

  it("lets !cd move Pi's cwd without moving or forgetting the ghost home", async () => {
    const { dir } = await setup([{ kind: "text", text: "still Casper" }]);
    const ownerDocs = join(temp!.ownerHome, "docs");
    mkdirSync(ownerDocs, { recursive: true });
    writeFileSync(join(ownerDocs, "AGENTS.md"), "MUST-NOT-REDISCOVER-AFTER-CD");
    await host!.runTurn("casper", {
      sessionId: "conv-cd",
      prompt: "!cd docs",
      emit: () => {},
    });
    const handle = await host!.open("casper", "conv-cd");
    expect(handle.session.sessionManager.getCwd()).toBe(ownerDocs);
    expect(handle.session.systemPrompt).not.toContain("MUST-NOT-REDISCOVER-AFTER-CD");
    expect(handle.sessionFile?.startsWith(ghostPaths(dir).sessionDir + sep)).toBe(true);

    await host!.runTurn("casper", {
      sessionId: "conv-cd",
      prompt: "Do you still know who you are?",
      emit: () => {},
    });
    expect(provider!.requests.at(-1)?.system).toContain("letterpress printer");
  });

  it("persists a memory file the ghost writes", async () => {
    temp = makeTempGhosts();
    const memoryDir = join(temp.root, "casper", "memory");
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "write",
          args: {
            path: join(memoryDir, "explained-the-press.md"),
            content: "I explained the press. They wanted the story, not the spec sheet.",
          },
        },
        { kind: "text", text: "Written down." },
      ],
    });
    const dir = seedGhost(temp.root, {
      name: "casper",
      docs: { "press.md": TEST_DOC },
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      machineSkillPaths: [],
      offline: true,
    });
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "Remember that.",
      emit: () => {},
    });

    expect(memoryDir).toBe(join(dir, "memory"));
    const files = readdirSync(memoryDir).filter((name) => name.endsWith(".md"));
    expect(files).toContain("explained-the-press.md");
    expect(readFileSync(join(memoryDir, files[0]!), "utf8")).toContain("spec sheet");
  });

  it("refuses a second concurrent turn in the same conversation", async () => {
    await setup();
    const first = host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "one",
      emit: () => {},
    });
    await expect(
      host!.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} }),
    ).rejects.toMatchObject({ code: "session_busy", status: 409 });
    await first;
  });

  it("refuses to delete a conversation while it is answering", async () => {
    await setup();
    const turn = host!.runTurn("casper", {
      sessionId: "conv-busy-delete",
      prompt: "one",
      emit: () => {},
    });
    await expect(host!.deleteSession("casper", "conv-busy-delete")).rejects.toMatchObject({
      code: "session_busy",
      status: 409,
    });
    await turn;
    await expect(host!.deleteSession("casper", "conv-busy-delete")).resolves.toMatchObject({
      artifacts: [{ artifact: "omp-transcript", kind: "fallback" }],
    });
  });

  it("refuses conversation and whole-home moves during a raw external turn", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Finish",
            question: "Can the remote turn finish?",
            options: [
              { label: "Yes", description: "Finish the turn" },
              { label: "No", description: "Keep it open" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Finished remotely." },
    ]);
    const handle = await host!.open("casper", "conv-remote-delete");
    const remoteTurn = handle.session.prompt("Raw external prompt.");
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-remote-delete"));
    expect(handle.session.isStreaming).toBe(true);

    await expect(host!.deleteSession("casper", "conv-remote-delete"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.deleteGhost("casper"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    await expect(host!.renameGhost("casper", "wisp"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });

    host!.answerAsk("casper", "conv-remote-delete", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Yes"] }],
    });
    await remoteTurn;
    const deleted = await host!.deleteSession("casper", "conv-remote-delete");
    expect(deleted.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact: "omp-transcript", kind: "fallback" }),
      expect.objectContaining({ artifact: "tool-cwds", kind: "fallback" }),
    ]));
  });

  it("terminates with an error event when the provider fails", async () => {
    // 400, not 500: a server error is retryable and pi would back off for
    // seconds before giving up. A bad request fails once, immediately.
    await setup([
      {
        kind: "error",
        status: 400,
        body: JSON.stringify({ error: { message: "boom", code: "invalid_request" } }),
      },
    ]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "hi",
      emit: (event) => events.push(event),
    });
    expect(events[0]?.type).toBe("start");
    const terminal = events.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
    expect(terminal.type).toBe("error");
    expect(terminal.reason).toBe("error");
  });

  it("writes an unknown ghost as a structured 404, not a stream", async () => {
    await setup();
    await expect(
      host!.runTurn("nobody", { sessionId: "c", prompt: "hi", emit: () => {} }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("forkConversationTitle", () => {
  it("names a copy the way a file manager does, from the first free counter", () => {
    expect(forkConversationTitle("Weekend trip", [])).toBe("Weekend trip (2)");
    expect(forkConversationTitle("Weekend trip", ["Weekend trip", "Weekend trip (2)"]))
      .toBe("Weekend trip (3)");
    // The counter is stripped before it is re-applied, never stacked.
    expect(forkConversationTitle("Weekend trip (2)", ["Weekend trip", "Weekend trip (2)"]))
      .toBe("Weekend trip (3)");
    // Untitled stays untitled; nothing here invents a name.
    expect(forkConversationTitle(null, ["Weekend trip"])).toBeNull();
    expect(forkConversationTitle("   ", [])).toBeNull();
  });
});

describe("conversation branching", () => {
  async function seedBranchable(
    title: string | null = "Weekend trip",
    options: Pick<SessionHostOptions, "conversationFileProbe" | "transactionProbe" | "toolCwdWriter"> = {},
  ) {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "A branch-aware answer." }] });
    const scheduleCommands: string[][] = [];
    seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      scheduleCommandRunner: async (args) => {
        scheduleCommands.push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
      ...options,
      title: title === null
        ? { enabled: false }
        : { generate: async () => title },
    });
    await host.runTurn("casper", {
      sessionId: "conv-tree",
      prompt: "Original question",
      emit: () => {},
    });
    await host.runTurn("casper", {
      sessionId: "conv-tree",
      prompt: "Original follow-up",
      emit: () => {},
    });
    const original = await host.readTranscript("casper", "conv-tree");
    return {
      firstUser: original.messages.find((message) => message.role === "user")!,
      scheduleCommands,
    };
  }

  it("copies the conversation, rewinds the copy, and leaves the source untouched", async () => {
    const { firstUser } = await seedBranchable();
    const before = await host!.readTranscript("casper", "conv-tree");
    const forked = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    expect(forked.sessionId).not.toBe("conv-tree");
    expect(forked.draft).toBe("Original question");
    // The copy is rewound to just before the branched message.
    expect(forked.transcript.messages).toEqual([]);
    expect(forked.transcript.id).toBe(forked.id);
    expect(forked.transcript.conversationId).toBe(forked.conversationId);

    // The source keeps every entry, its leaf, and its title.
    const after = await host!.readTranscript("casper", "conv-tree");
    expect(after.messages).toEqual(before.messages);
    expect(JSON.stringify(after.messages)).toContain("Original follow-up");
    expect(after.title).toBe("Weekend trip");

    // The copy is a first-class conversation: listed, and resumable by its id.
    const listed = await host!.listSessions("casper");
    expect(listed.map((row) => row.id)).toContain(forked.id);
    await host!.runTurn("casper", {
      sessionId: forked.sessionId,
      prompt: "Alternative question",
      emit: () => {},
    });
    const alternative = await host!.readTranscript("casper", forked.sessionId);
    expect(JSON.stringify(alternative.messages)).toContain("Alternative question");
    expect(JSON.stringify(alternative.messages)).not.toContain("Original follow-up");
    // The source is still untouched after the copy has been written to.
    expect(await host!.readTranscript("casper", "conv-tree")).toEqual(after);
  });

  it.each(["rename", "delete"] as const)(
    "publishes a fork into the original home before %s and isolates old-name reuse",
    async (move) => {
      const readEntered = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      const { firstUser, scheduleCommands } = await seedBranchable("Weekend trip", {
        conversationFileProbe: async (operation) => {
          if (operation !== "fork-read") return;
          readEntered.resolve();
          await releaseRead.promise;
        },
      });
      const originalHome = join(temp!.root, "casper");
      const originalInode = statSync(originalHome, { bigint: true }).ino;
      const coordinator = homeOperationsFor(temp!.registry);

      const forking = host!.forkConversation("casper", "conv-tree", firstUser.entryId);
      await readEntered.promise;
      let moveReady = false;
      const reservingMove = coordinator.reserveMove("casper").then((release) => {
        moveReady = true;
        return release;
      });
      await Promise.resolve();
      expect(moveReady).toBe(false);

      releaseRead.resolve();
      const forked = await forking;
      const releaseMove = await reservingMove;
      let movedHome = "";
      try {
        if (move === "rename") {
          await host!.renameGhost("casper", "wisp");
          movedHome = join(temp!.root, "wisp");
        } else {
          movedHome = (await host!.deleteGhost("casper")).trash;
        }
        expect(() => host!.createGhost("casper")).toThrowError(/finish moving/);
      } finally {
        releaseMove();
      }
      expect(statSync(movedHome, { bigint: true }).ino).toBe(originalInode);
      expect(existsSync(join(
        ghostPaths(movedHome).sessionDir,
        sessionFileNameFor(forked.sessionId),
      ))).toBe(true);

      const replacement = host!.createGhost("casper");
      expect(statSync(replacement.dir, { bigint: true }).ino).not.toBe(originalInode);
      expect(existsSync(join(
        ghostPaths(replacement.dir).sessionDir,
        sessionFileNameFor(forked.sessionId),
      ))).toBe(false);
      if (move === "rename") {
        expect((await host!.listSessions("wisp")).map((row) => row.id)).toContain(forked.id);
      }
      expect(scheduleCommands.map((args) => args[1])).toEqual([
        "list-units",
        "list-unit-files",
      ]);
    },
  );

  it("names each copy with the next free counter and never stacks counters", async () => {
    const { firstUser } = await seedBranchable();

    const first = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    expect(first.title).toBe("Weekend trip (2)");
    const second = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    expect(second.title).toBe("Weekend trip (3)");

    // A rewound fork is durably empty. After it gets its own first turn,
    // branching that conversation strips the counter before re-applying it.
    await host!.runTurn("casper", {
      sessionId: first.sessionId,
      prompt: "Alternative question",
      emit: () => {},
    });
    const copied = await host!.readTranscript("casper", first.sessionId);
    const copiedUser = copied.messages.find((message) => message.role === "user")!;
    const third = await host!.forkConversation("casper", first.sessionId, copiedUser.entryId);
    expect(third.title).toBe("Weekend trip (4)");

    const titles = (await host!.listSessions("casper")).map((row) => row.title);
    expect(titles).toEqual(expect.arrayContaining([
      "Weekend trip",
      "Weekend trip (2)",
      "Weekend trip (3)",
      "Weekend trip (4)",
    ]));
  });

  it("leaves a copy of an untitled conversation untitled", async () => {
    const { firstUser } = await seedBranchable(null);
    const forked = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    expect(forked.title).toBeNull();
    const listed = await host!.listSessions("casper");
    expect(listed.find((row) => row.id === forked.id)?.title).toBeNull();
  });

  it("rejects a branch off anything but a persisted user message", async () => {
    const { firstUser } = await seedBranchable();
    const transcript = await host!.readTranscript("casper", "conv-tree");
    const assistant = transcript.messages.find((message) => message.role === "assistant")!;
    await expect(host!.forkConversation("casper", "conv-tree", assistant.entryId))
      .rejects.toMatchObject({ code: "invalid_branch", status: 400 });
    await expect(host!.forkConversation("casper", "conv-tree", "no-such-entry"))
      .rejects.toMatchObject({ code: "invalid_branch", status: 400 });
    // An unknown conversation is a 404, not a new empty one to branch from.
    await expect(host!.forkConversation("casper", "no-such-conversation", firstUser.entryId))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
    // The rejected branches created nothing.
    const listed = await host!.listSessions("casper");
    expect(listed.map((row) => row.id)).toEqual(["pi:conv-tree"]);
  });

  it("refuses to branch a conversation that is still answering", async () => {
    const { firstUser } = await seedBranchable();
    const hosted = await host!.open("casper", "conv-tree") as unknown as { busy: boolean };
    hosted.busy = true;
    try {
      await expect(host!.forkConversation("casper", "conv-tree", firstUser.entryId))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
    } finally {
      hosted.busy = false;
    }
  });

  it("keeps an in-flight fork unpublished and removes every staged artifact on failure", async () => {
    const cloneEntered = Promise.withResolvers<void>();
    const releaseClone = Promise.withResolvers<void>();
    let failNextStaging = false;
    const { firstUser } = await seedBranchable("Weekend trip", {
      // A fork stages its tool-cwd sidecar through the injectable writer; the
      // fourth argument is only present for that staging write.
      toolCwdWriter: async (...args) => {
        if (args[3] === undefined) return writeToolCwds(...args);
        if (failNextStaging) {
          failNextStaging = false;
          throw new Error("injected sidecar failure");
        }
        cloneEntered.resolve();
        await releaseClone.promise;
        return writeToolCwds(...args);
      },
    });

    const fork = host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    await cloneEntered.promise;
    expect((await host!.listSessions("casper")).map((row) => row.id))
      .toEqual(["pi:conv-tree"]);
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    const pendingTranscript = readdirSync(sessionDir).find((name) =>
      name.startsWith(".") && name.includes(".jsonl.") && name.endsWith(".pending"));
    expect(pendingTranscript).toBeDefined();
    const stagedManager = SessionManager.open(
      join(sessionDir, pendingTranscript!),
      sessionDir,
      temp!.ownerHome,
    );
    expect(stagedManager.getBranch().some((entry) =>
      entry.type === "message" && entry.message.role === "user")).toBe(false);
    expect(readdirSync(sessionDir).filter((name) =>
      name.startsWith(".ghost-fork-") && name.endsWith(".pending.json"))).toHaveLength(1);
    releaseClone.resolve();
    const published = await fork;
    expect((await host!.listSessions("casper")).map((row) => row.id))
      .toContain(published.id);
    expect(readdirSync(sessionDir).some((name) => name.includes(".pending"))).toBe(false);

    failNextStaging = true;
    await expect(host!.forkConversation("casper", "conv-tree", firstUser.entryId))
      .rejects.toThrow("injected sidecar failure");
    expect((await host!.listSessions("casper")).map((row) => row.id).sort())
      .toEqual([published.id, "pi:conv-tree"].sort());
    expect(readdirSync(sessionDir).some((name) =>
      name.includes(".pending") || name.startsWith(".ghost-fork-"))).toBe(false);
  });

  it("recovers only an already-rewound hidden fork after a publication crash", async () => {
    const { firstUser } = await seedBranchable();
    const forked = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    const transcript = join(sessionDir, sessionFileNameFor(forked.sessionId));
    const binding = conversationCwdPath(sessionDir, forked.sessionId);
    const toolCwds = toolCwdsPath(sessionDir, forked.sessionId);
    const temporaryTranscript = `${transcript}.crash.pending`;
    const temporaryBinding = `${binding}.crash.pending`;
    const temporaryToolCwds = `${toolCwds}.crash.pending`;
    renameSync(transcript, temporaryTranscript);
    renameSync(binding, temporaryBinding);
    renameSync(toolCwds, temporaryToolCwds);
    const stem = sessionFileNameFor(forked.sessionId).slice(0, -".jsonl".length);
    writeFileSync(join(sessionDir, `.ghost-fork-${stem}.pending.json`), JSON.stringify({
      version: 3,
      kind: "fork",
      conversationId: forked.sessionId,
      tempTranscript: temporaryTranscript,
      tempConversationCwd: temporaryBinding,
      tempToolCwds: temporaryToolCwds,
    }), { mode: 0o600 });

    expect((await host!.listSessions("casper")).map((row) => row.id)).toContain(forked.id);
    expect((await host!.readTranscript("casper", forked.sessionId)).messages).toEqual([]);
    await host!.open("casper", forked.sessionId);
    expect(readdirSync(sessionDir).some((name) => name.includes(".pending"))).toBe(false);
  });

  it("rejects victim, aliased, and duplicate fork paths before any cleanup", async () => {
    const recoveryStages: Array<{ stage: string; path: string }> = [];
    await seedBranchable("Weekend trip", {
      transactionProbe: (stage, path) => {
        recoveryStages.push({ stage, path });
      },
    });

    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    const victimTranscript = join(sessionDir, sessionFileNameFor("conv-tree"));
    await writeConversationCwd(sessionDir, "conv-tree", temp!.ownerHome);
    const victimBinding = conversationCwdPath(sessionDir, "conv-tree");
    await writeToolCwds(
      sessionDir,
      "conv-tree",
      new Map([["victim-call", temp!.ownerHome]]),
    );
    const victimToolCwds = toolCwdsPath(sessionDir, "conv-tree");
    const victimBytes = new Map([
      [victimTranscript, readFileSync(victimTranscript, "utf8")],
      [victimBinding, readFileSync(victimBinding, "utf8")],
      [victimToolCwds, readFileSync(victimToolCwds, "utf8")],
    ]);

    const conversationId = "fork-path-attack";
    const transcript = join(sessionDir, sessionFileNameFor(conversationId));
    const binding = conversationCwdPath(sessionDir, conversationId);
    const toolCwds = toolCwdsPath(sessionDir, conversationId);
    const valid = {
      tempTranscript: `${transcript}.safe.pending`,
      tempConversationCwd: `${binding}.safe.pending`,
      tempToolCwds: `${toolCwds}.safe.pending`,
    };
    const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
    const marker = join(sessionDir, `.ghost-fork-${stem}.pending.json`);
    const cases: Array<[string, Partial<typeof valid>]> = [
      ["victim transcript", { tempTranscript: victimTranscript }],
      ["victim sidecar", { tempConversationCwd: victimBinding }],
      ["aliased child", {
        tempTranscript: `${sessionDir}${sep}nested${sep}..${sep}${basename(valid.tempTranscript)}`,
      }],
      ["duplicate artifact", { tempToolCwds: valid.tempConversationCwd }],
    ];

    for (const [name, override] of cases) {
      recoveryStages.length = 0;
      writeFileSync(marker, `${JSON.stringify({
        version: 3,
        kind: "fork",
        conversationId,
        ...valid,
        ...override,
      })}\n`, { mode: 0o600 });

      expect((await host!.listSessions("casper")).map((row) => row.id))
        .toContain("pi:conv-tree");
      await expect(host!.open("casper", conversationId))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(existsSync(marker), name).toBe(true);
      expect(recoveryStages, name).toEqual([]);
      for (const [path, bytes] of victimBytes) {
        expect(readFileSync(path, "utf8"), `${name}: ${path}`).toBe(bytes);
      }
      rmSync(marker);
    }

  });

  /**
   * The shared back half of every retained-fork-marker case: the failed fork
   * is hidden behind its marker (recovery attempts are blocked, opening 409s),
   * and once `release()` unblocks cleanup the next listing removes the marker
   * and every artifact of the hidden conversation.
   */
  async function expectForkRecovered(release: () => void): Promise<void> {
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    const markerName = readdirSync(sessionDir).find((name) =>
      name.startsWith(".ghost-fork-") && name.endsWith(".pending.json")
    );
    expect(markerName).toBeDefined();
    const marker = join(sessionDir, markerName!);
    const record = JSON.parse(readFileSync(marker, "utf8")) as { conversationId: string };
    await host!.listSessions("casper");
    await expect(host!.open("casper", record.conversationId))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(existsSync(marker)).toBe(true);

    release();
    expect((await host!.listSessions("casper")).map((row) => row.id))
      .not.toContain(`pi:${record.conversationId}`);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(sessionDir).some((name) => name.includes(record.conversationId)))
      .toBe(false);
  }

  it.each([
    "fork-cleanup-verify",
    "fork-cleanup-fsync",
    "fork-marker-unlink",
    "fork-marker-fsync",
    "active-transcript-cleanup",
  ] as const)("retains the fork marker when %s fails", async (blockedStage) => {
    const activePublication = blockedStage === "active-transcript-cleanup";
    let rejectStage = true;
    let sidecarFailed = false;
    const { firstUser } = await seedBranchable(
      "Weekend trip",
      {
        toolCwdWriter: async (...args) => {
          if (activePublication && args[3] !== undefined && !sidecarFailed) {
            sidecarFailed = true;
            throw new Error("injected active sidecar publication failure");
          }
          return writeToolCwds(...args);
        },
        transactionProbe: (stage, path) => {
          if (!rejectStage) return;
          const blocked = activePublication
            ? stage === "fork-cleanup-unlink"
              && path.includes(".jsonl.") && path.endsWith(".pending")
            : stage === blockedStage;
          if (blocked) throw new Error(`injected ${blockedStage} failure`);
        },
      },
    );
    const forking = expect(host!.forkConversation("casper", "conv-tree", firstUser.entryId));
    await (activePublication
      ? forking.rejects.toThrow("transaction remains pending recovery")
      : forking.rejects.toThrow());
    await expectForkRecovered(() => {
      rejectStage = false;
    });
  });

  it.each([
    "transcript",
    "conversation-cwd",
    "tool-cwds",
  ] as const)(
    "retains a failed rollback marker until the partial %s artifact is verified absent",
    async (blockedArtifact) => {
      let blockedPath: string | null = null;
      let rejectCleanup = true;
      const { firstUser } = await seedBranchable("Weekend trip", {
        transactionProbe: (stage, path) => {
          if (rejectCleanup && stage === "fork-cleanup-unlink" && path === blockedPath) {
            throw new Error(`injected ${blockedArtifact} cleanup failure`);
          }
        },
      });
      const project = join(temp!.root, `fork-cleanup-${blockedArtifact}`);
      mkdirSync(project);
      writeFileSync(join(project, "AGENTS.md"), "PINNED-CLEANUP-SNAPSHOT");
      const forked = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
      const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
      const paths = {
        transcript: join(sessionDir, sessionFileNameFor(forked.sessionId)),
        "conversation-cwd": conversationCwdPath(sessionDir, forked.sessionId),
        "tool-cwds": toolCwdsPath(sessionDir, forked.sessionId),
      };
      blockedPath = paths[blockedArtifact];
      const missingPath = blockedArtifact === "conversation-cwd"
        ? paths["tool-cwds"]
        : paths["conversation-cwd"];
      unlinkSync(missingPath);
      const pending = Object.fromEntries(Object.entries(paths).map(([key, path]) =>
        [key, `${path}.rollback.pending`]
      )) as Record<keyof typeof paths, string>;
      const stem = sessionFileNameFor(forked.sessionId).slice(0, -".jsonl".length);
      const marker = join(sessionDir, `.ghost-fork-${stem}.pending.json`);
      writeFileSync(marker, `${JSON.stringify({
        version: 3,
        kind: "fork",
        conversationId: forked.sessionId,
        tempTranscript: pending.transcript,
        tempConversationCwd: pending["conversation-cwd"],
        tempToolCwds: pending["tool-cwds"],
      })}\n`, { mode: 0o600 });

      expect((await host!.listSessions("casper")).map((row) => row.id))
        .not.toContain(forked.id);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(blockedPath)).toBe(true);
      await expect(host!.open("casper", forked.sessionId))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });

      rejectCleanup = false;
      expect((await host!.listSessions("casper")).map((row) => row.id))
        .not.toContain(forked.id);
      expect(existsSync(marker)).toBe(false);
      for (const path of [...Object.values(paths), ...Object.values(pending)]) {
        expect(existsSync(path)).toBe(false);
      }
    },
  );

  it.each([1, 2] as const)(
    "keeps a retained v%s fork marker hidden from listing and open",
    async (version) => {
      await seedBranchable();
      const conversationId = "conv-tree";
      const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
      const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
      const marker = join(sessionDir, `.ghost-fork-${stem}.pending.json`);
      writeFileSync(marker, JSON.stringify({ version, kind: "fork", conversationId }));

      expect((await host!.listSessions("casper")).map((row) => row.id))
        .not.toContain(`pi:${conversationId}`);
      await expect(host!.open("casper", conversationId))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });

      rmSync(marker);
      expect((await host!.listSessions("casper")).map((row) => row.id))
        .toContain(`pi:${conversationId}`);
    },
  );

  it("fails closed on malformed, unreadable, and dangling exact fork markers without leaking bytes", async () => {
    const logger = recordingLogger();
    await setup(undefined, {
      logger,
    });
    await host!.runTurn("casper", {
      sessionId: "fork-marker-target",
      prompt: "persist me",
      emit: () => {},
    });
    const sessionDir = ghostPaths(temp!.registry.get("casper").dir).sessionDir;
    const stem = sessionFileNameFor("fork-marker-target").slice(0, -".jsonl".length);
    const marker = join(sessionDir, `.ghost-fork-${stem}.pending.json`);
    const sentinel = "R5-FORK-MARKER-BYTES-MUST-NOT-LEAK";
    const unrelatedStem = sessionFileNameFor("unrelated-fork-marker")
      .slice(0, -".jsonl".length);
    const unrelated = join(sessionDir, `.ghost-fork-${unrelatedStem}.pending.json`);
    writeFileSync(unrelated, JSON.stringify({
      version: 3,
      kind: "fork",
      conversationId: "fork-marker-target",
      ignored: sentinel,
    }), { mode: 0o600 });
    expect((await host!.listSessions("casper")).map((row) => row.id))
      .toContain("pi:fork-marker-target");
    expect(logger.records).toContainEqual({
      level: "error",
      message: "fork recovery marker is invalid",
      fields: { ghost: "casper", path: unrelated, code: "fork_marker_invalid" },
    });
    expect(JSON.stringify(logger.records)).not.toContain(sentinel);
    rmSync(unrelated);

    writeFileSync(marker, `{ malformed ${sentinel}\n`, { mode: 0o600 });

    expect((await host!.listSessions("casper")).map((row) => row.id))
      .not.toContain("pi:fork-marker-target");
    await expect(host!.open("casper", "fork-marker-target"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.conversationCwd("casper", "fork-marker-target"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(JSON.stringify(logger.records)).not.toContain(sentinel);

    chmodSync(marker, 0o000);
    try {
      expect((await host!.listSessions("casper")).map((row) => row.id))
        .not.toContain("pi:fork-marker-target");
      await expect(host!.open("casper", "fork-marker-target"))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
    } finally {
      chmodSync(marker, 0o600);
      rmSync(marker);
    }

    const missingTarget = join(temp!.root, sentinel);
    symlinkSync(missingTarget, marker);
    try {
      expect((await host!.listSessions("casper")).map((row) => row.id))
        .not.toContain("pi:fork-marker-target");
      await expect(host!.conversationCwd("casper", "fork-marker-target"))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(JSON.stringify(logger.records)).not.toContain(sentinel);
    } finally {
      rmSync(marker);
    }

    execFileSync("mkfifo", [marker]);
    const timeout = Symbol("timeout");
    const fifo = await Promise.race([
      host!.listSessions("casper").then((rows) => rows.map((row) => row.id)),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 500)),
    ]);
    expect(fifo).not.toBe(timeout);
    expect(fifo).not.toContain("pi:fork-marker-target");
    await expect(host!.open("casper", "fork-marker-target"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    rmSync(marker);

    writeFileSync(marker, "x".repeat(1_048_577), { mode: 0o600 });
    expect((await host!.listSessions("casper")).map((row) => row.id))
      .not.toContain("pi:fork-marker-target");
    await expect(host!.conversationCwd("casper", "fork-marker-target"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    rmSync(marker);

    expect((await host!.listSessions("casper")).map((row) => row.id))
      .toContain("pi:fork-marker-target");
  });

  it("retains and hides a v2 fork after recovery I/O failure, then retries atomically", async () => {
    const { firstUser } = await seedBranchable();
    const forked = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    const transcript = join(sessionDir, sessionFileNameFor(forked.sessionId));
    const binding = conversationCwdPath(sessionDir, forked.sessionId);
    const toolCwds = toolCwdsPath(sessionDir, forked.sessionId);
    const temporaryBinding = `${binding}.io-failure.pending`;
    const temporaryToolCwds = `${toolCwds}.io-failure.pending`;
    const temporaryTranscript = `${transcript}.io-failure.pending`;
    const bindingBytes = readFileSync(binding, "utf8");
    const toolCwdBytes = readFileSync(toolCwds, "utf8");
    renameSync(binding, temporaryBinding);
    renameSync(toolCwds, temporaryToolCwds);
    const stem = sessionFileNameFor(forked.sessionId).slice(0, -".jsonl".length);
    const marker = join(sessionDir, `.ghost-fork-${stem}.pending.json`);
    writeFileSync(marker, JSON.stringify({
      version: 3,
      kind: "fork",
      conversationId: forked.sessionId,
      tempTranscript: temporaryTranscript,
      tempConversationCwd: temporaryBinding,
      tempToolCwds: temporaryToolCwds,
    }), { mode: 0o600 });

    chmodSync(sessionDir, 0o500);
    try {
      expect((await host!.listSessions("casper")).map((row) => row.id))
        .not.toContain(forked.id);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(temporaryBinding)).toBe(true);
      expect(existsSync(temporaryToolCwds)).toBe(true);
      await expect(host!.open("casper", forked.sessionId))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(existsSync(marker)).toBe(true);
    } finally {
      chmodSync(sessionDir, 0o700);
    }

    expect((await host!.listSessions("casper")).map((row) => row.id))
      .toContain(forked.id);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(temporaryBinding)).toBe(false);
    expect(existsSync(temporaryToolCwds)).toBe(false);
    expect(readFileSync(binding, "utf8")).toBe(bindingBytes);
    expect(readFileSync(toolCwds, "utf8")).toBe(toolCwdBytes);
    await expect(host!.open("casper", forked.sessionId)).resolves.toMatchObject({
      sessionKey: expect.any(String),
    });
  });
});

describe("multi-ghost", () => {
  it("keeps two ghosts separate while they answer concurrently", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "write",
          args: {
            path: join(temp.root, "casper", "asked-who-i-am.md"),
            content: "Someone asked who casper is.",
          },
        },
        { kind: "text", text: "I am who I am." },
      ],
    });
    const minaProvider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "write",
          args: {
            path: join(temp.root, "mina", "asked-who-i-am.md"),
            content: "Someone asked who mina is.",
          },
        },
        { kind: "text", text: "I am who I am." },
      ],
    });
    try {
      const casper = seedGhost(temp.root, {
        name: "casper",
        character: "# casper\n\nYou set type. Casper keeps this private.\n",
        provider: { baseUrl: provider.url, modelId: provider.modelId },
      });
      const mina = seedGhost(temp.root, {
        name: "mina",
        character: "# mina\n\nYou keep bees. Mina keeps this private.\n",
        provider: { baseUrl: minaProvider.url, modelId: minaProvider.modelId },
      });
      for (const [dir, shellPath] of [[casper, "/bin/bash"], [mina, "/bin/sh"]] as const) {
        writeFileSync(ghostPaths(dir).settingsFile, `shellPath: ${shellPath}\n`);
      }
      const obsidianSkill = join(
        temp.ownerHome,
        ".agents",
        "skills",
        "obsidian-cli",
      );
      mkdirSync(obsidianSkill, { recursive: true });
      writeFileSync(
        join(obsidianSkill, "SKILL.md"),
        "---\nname: obsidian-cli\ndescription: Official Obsidian CLI skill.\n---\n\nUse obsidian.\n",
        "utf8",
      );
      host = new SessionHost({
        registry: temp.registry,
        ownerHome: temp.ownerHome,
        offline: true,
      });

      await Promise.all([
        host.runTurn("casper", { sessionId: "c", prompt: "Who are you?", emit: () => {} }),
        host.runTurn("mina", { sessionId: "c", prompt: "Who are you?", emit: () => {} }),
      ]);

      // Each ghost's native file write and session transcript landed in its own home.
      for (const [dir, expected] of [[casper, "casper"], [mina, "mina"]] as const) {
        const paths = ghostPaths(dir);
        expect(existsSync(paths.sessionDir)).toBe(true);
        expect(readdirSync(paths.sessionDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
        expect(readFileSync(join(dir, "asked-who-i-am.md"), "utf8")).toContain(expected);
      }
      // Personas did not cross: each initial provider request carried one ghost's prompt.
      const systems = [...provider.requests, ...minaProvider.requests]
        .map((request) => request.system)
        .filter((system) => system.includes("set type") || system.includes("keep bees"));
      expect(systems.some((system) => system.includes("set type"))).toBe(true);
      expect(systems.some((system) => system.includes("keep bees"))).toBe(true);
      for (const system of systems) {
        expect(system.includes("set type") && system.includes("keep bees")).toBe(false);
        expect(system).toContain("## Owner context");
        expect(system).toContain("## Self-maintenance");
        expect(system).toContain(
          join(obsidianSkill, "SKILL.md"),
        );
        expect(system.split(join(obsidianSkill, "SKILL.md"))).toHaveLength(2);
      }
      expect(provider.requests[0]?.system).toContain("Casper keeps this private");
      expect(provider.requests[0]?.system).not.toContain("Mina keeps this private");
      expect(minaProvider.requests[0]?.system).toContain("Mina keeps this private");
      expect(minaProvider.requests[0]?.system).not.toContain("casper-private");

      // Bash execution runs in each session's own working directory; nothing
      // process-global leaks one ghost's shell into the other's.
      const [casperSession, minaSession] = await Promise.all([
        host.open("casper", "c"),
        host.open("mina", "c"),
      ]);
      const [casperBash, minaBash] = await Promise.all([
        casperSession.session.executeBash("printf casper"),
        minaSession.session.executeBash("printf mina"),
      ]);
      expect(casperBash.output.trim()).toBe("casper");
      expect(minaBash.output.trim()).toBe("mina");
    } finally {
      await minaProvider.close();
    }
  });
});

describe("session listing", () => {
  it("lists the ghost's own conversations in the sidebar shape", async () => {
    await setup();
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "hi", emit: () => {} });
    const sessions = await host!.listSessions("casper");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
    expect(sessions[0]?.messageCount).toBeGreaterThan(0);
    expect(sessions[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sessions[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // `title` is present (may be null) — no legacy `path` field leaks.
    expect("title" in sessions[0]!).toBe(true);
    expect("path" in (sessions[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("orders conversations newest-updated first", async () => {
    await setup();
    await host!.runTurn("casper", { sessionId: "older", prompt: "one", emit: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host!.runTurn("casper", { sessionId: "newer", prompt: "two", emit: () => {} });
    const sessions = await host!.listSessions("casper");
    expect(sessions.map((session) => session.id)).toEqual(["pi:newer", "pi:older"]);
  });

  it("trashes a stored conversation and lets the id start fresh", async () => {
    const { dir } = await setup();
    await host!.runTurn("casper", { sessionId: "conv-delete", prompt: "one", emit: () => {} });
    const path = join(ghostPaths(dir).sessionDir, sessionFileNameFor("conv-delete"));
    expect(existsSync(path)).toBe(true);

    const trashed = await host!.deleteSession("casper", "conv-delete");
    expect(existsSync(path)).toBe(false);
    expect(trashed.artifacts).toMatchObject([
      { artifact: "omp-transcript", source: path, kind: "fallback" },
    ]);
    expect(existsSync(trashed.artifacts[0]!.trash)).toBe(true);
    expect(await host!.listSessions("casper")).toEqual([]);
    await expect(host!.readTranscript("casper", "conv-delete")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(host!.deleteSession("casper", "conv-delete")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });

    await host!.runTurn("casper", { sessionId: "conv-delete", prompt: "fresh", emit: () => {} });
    expect((await host!.listSessions("casper"))[0]?.messageCount).toBe(2);
  });

  it("rejects delete before an admitted Pi open publishes its opening promise", async () => {
    const { dir } = await setup(undefined, {
      title: { enabled: false },
    });
    const id = "delete-during-open-admission";
    await host!.runTurn("casper", { sessionId: id, prompt: "persist", emit: () => {} });
    const original = await host!.open("casper", id);
    const sessionDir = ghostPaths(dir).sessionDir;
    const transcript = join(sessionDir, sessionFileNameFor(id));
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    const transcriptBytes = readFileSync(transcript);
    const before = directoryBytesSnapshot(sessionDir);
    const entered = deferred();
    const release = deferred();
    const internals = host as unknown as {
      lifecycleAdmissions: Map<string, number>;
      opening: Map<string, Promise<unknown>>;
      recoverForkTransactions(path: string, ghostName: string): Promise<void>;
      sessions: Map<string, typeof original>;
    };
    const recoverForkTransactions = internals.recoverForkTransactions.bind(internals);
    vi.spyOn(internals, "recoverForkTransactions").mockImplementation(async (path, ghostName) => {
      entered.resolve();
      await release.promise;
      await recoverForkTransactions(path, ghostName);
    });

    const reopening = host!.open("casper", id);
    await entered.promise;
    const key = sessionKeyOf("casper", id);
    expect(internals.lifecycleAdmissions.get(key)).toBe(1);
    expect(internals.opening.has(key)).toBe(false);

    try {
      await expect(host!.deleteSession("casper", id, "pi"))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(existsSync(tombstone)).toBe(false);
      expect(directoryBytesSnapshot(sessionDir)).toEqual(before);
      expect(internals.sessions.get(key)?.session).toBe(original.session);
      expect(((original as { sessionDisposed?: boolean }).sessionDisposed === true)).toBe(false);
      expect(readFileSync(transcript)).toEqual(transcriptBytes);
    } finally {
      release.resolve();
    }
    await expect(reopening).resolves.toBe(original);
    await expect(host!.deleteSession("casper", id, "pi")).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "omp-transcript", source: transcript }),
      ]),
    });
    expect(((original as { sessionDisposed?: boolean }).sessionDisposed === true)).toBe(true);
    expect(existsSync(transcript)).toBe(false);
  });

  it("hides a tombstoned crash residue and resumes deletion before the raw id can reopen", async () => {
    const { dir } = await setup();
    await host!.runTurn("casper", {
      sessionId: "delete-recovery",
      prompt: "persist me",
      emit: () => {},
    });
    const sessionDir = ghostPaths(dir).sessionDir;
    const stem = sessionFileNameFor("delete-recovery").slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    writeFileSync(tombstone, `${JSON.stringify({
      version: 1,
      kind: "delete",
      runtime: "pi",
      conversationId: "delete-recovery",
    })}\n`, { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([]);
    await expect(host!.open("casper", "delete-recovery"))
      .rejects.toMatchObject({ code: "session_deleting" });
    await expect(host!.conversationCwd("casper", "delete-recovery"))
      .rejects.toMatchObject({ code: "session_deleting" });
    await expect(host!.deleteSession("casper", "delete-recovery"))
      .resolves.toMatchObject({
        artifacts: expect.arrayContaining([
          expect.objectContaining({ artifact: "omp-transcript" }),
        ]),
      });
    expect(existsSync(tombstone)).toBe(false);
    expect(await host!.listSessions("casper")).toEqual([]);
  });

  it("durably accumulates every moved artifact and returns the full receipt after retries", async () => {
    let failAfterNextRecord = false;
    const { dir } = await setup(undefined, {
      transactionProbe: (stage) => {
        if (stage === "delete-artifact-recorded" && failAfterNextRecord) {
          failAfterNextRecord = false;
          throw new Error("injected crash after durable delete record");
        }
      },
    });
    const id = "delete-v2-recovery";
    await host!.runTurn("casper", { sessionId: id, prompt: "persist me", emit: () => {} });
    const sessionDir = ghostPaths(dir).sessionDir;
    await writeToolCwds(sessionDir, id, new Map([["tool-call", temp!.ownerHome]]));
    await writeConversationCwd(sessionDir, id, temp!.ownerHome);
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    const expectedKinds = ["omp-transcript", "tool-cwds", "conversation-cwd"];

    for (let moved = 1; moved <= expectedKinds.length; moved += 1) {
      failAfterNextRecord = true;
      await expect(host!.deleteSession("casper", id, "pi"))
        .rejects.toThrow("injected crash after durable delete record");
      const record = JSON.parse(readFileSync(tombstone, "utf8")) as {
        version: number;
        artifacts: TrashedConversation["artifacts"];
      };
      expect(record.version).toBe(4);
      expect(record.artifacts.map((entry) => entry.artifact)).toEqual(
        expectedKinds.slice(0, moved),
      );
      expect(record.artifacts.every((entry) =>
        !existsSync(entry.source) && existsSync(entry.trash)
      )).toBe(true);
      expect(await host!.listSessions("casper")).toEqual([]);
      await expect(host!.open("casper", id))
        .rejects.toMatchObject({ code: "session_deleting", status: 409 });
    }

    const finalRecord = JSON.parse(readFileSync(tombstone, "utf8")) as {
      artifacts: TrashedConversation["artifacts"];
    };
    const resumed = await host!.deleteSession("casper", id, "pi");
    expect(resumed.artifacts).toEqual(finalRecord.artifacts);
    expect(resumed.artifacts.map((entry) => entry.artifact)).toEqual(expectedKinds);
    expect(existsSync(tombstone)).toBe(false);
    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it.each([
    "delete-intent-recorded",
    "delete-artifact-fsync",
    "delete-artifact-renamed",
    "delete-receipt-write",
  ] as const)("resumes deletion after an injected %s crash boundary", async (blockedStage) => {
    let rejectStage = true;
    const { dir } = await setup(undefined, {
      transactionProbe: (stage) => {
        if (rejectStage && stage === blockedStage) {
          throw new Error(`injected ${blockedStage} failure`);
        }
      },
    });
    const id = `delete-boundary-${blockedStage}`;
    await host!.runTurn("casper", { sessionId: id, prompt: "persist me", emit: () => {} });
    const sessionDir = ghostPaths(dir).sessionDir;
    const transcript = join(sessionDir, sessionFileNameFor(id));
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);

    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toThrow(`injected ${blockedStage} failure`);
    const pending = JSON.parse(readFileSync(tombstone, "utf8")) as {
      version: number;
      pending: TrashedConversation["artifacts"][number];
      artifacts: TrashedConversation["artifacts"];
    };
    expect(pending.version).toBe(4);
    expect(pending.pending).toMatchObject({
      artifact: "omp-transcript",
      source: transcript,
      kind: "fallback",
    });
    expect(pending.artifacts).toEqual([]);
    if (blockedStage === "delete-intent-recorded") {
      expect(existsSync(transcript)).toBe(true);
      expect(existsSync(pending.pending.trash)).toBe(false);
    } else {
      expect(existsSync(transcript)).toBe(false);
      expect(existsSync(pending.pending.trash)).toBe(true);
    }
    expect(await host!.listSessions("casper")).toEqual([]);
    await expect(host!.open("casper", id))
      .rejects.toMatchObject({ code: "session_deleting", status: 409 });

    rejectStage = false;
    const resumed = await host!.deleteSession("casper", id, "pi");
    expect(resumed.artifacts).toEqual([
      expect.objectContaining({
        artifact: "omp-transcript",
        source: transcript,
        trash: pending.pending.trash,
        kind: "fallback",
      }),
    ]);
    expect(existsSync(tombstone)).toBe(false);
    expect(existsSync(pending.pending.trash)).toBe(true);
  });

  it("refuses a reserved Trash collision without overwriting either path", async () => {
    let stopAfterIntent = true;
    const { dir } = await setup(undefined, {
      transactionProbe: (stage) => {
        if (stopAfterIntent && stage === "delete-intent-recorded") {
          throw new Error("stop after delete intent");
        }
      },
    });
    const id = "delete-trash-collision";
    await host!.runTurn("casper", { sessionId: id, prompt: "persist me", emit: () => {} });
    const sessionDir = ghostPaths(dir).sessionDir;
    const transcript = join(sessionDir, sessionFileNameFor(id));
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toThrow("stop after delete intent");
    const original = readFileSync(transcript, "utf8");
    const record = JSON.parse(readFileSync(tombstone, "utf8")) as {
      pending: TrashedConversation["artifacts"][number];
    };
    writeFileSync(record.pending.trash, "collision", { flag: "wx" });
    stopAfterIntent = false;

    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toMatchObject({ code: "delete_recovery_conflict", status: 409 });
    expect(readFileSync(transcript, "utf8")).toBe(original);
    expect(readFileSync(record.pending.trash, "utf8")).toBe("collision");
    expect(existsSync(tombstone)).toBe(true);

    unlinkSync(record.pending.trash);
    await expect(host!.deleteSession("casper", id, "pi"))
      .resolves.toMatchObject({
        artifacts: [expect.objectContaining({ trash: record.pending.trash })],
      });
  });

  it("rejects tombstones that relabel or alias another Ghost artifact before any move", async () => {
    const stages: Array<{ stage: string; path: string }> = [];
    const { dir } = await setup(undefined, {
      transactionProbe: (stage, path) => {
        stages.push({ stage, path });
      },
    });
    const target = "delete-allowlist-target";
    const victim = "delete-allowlist-victim";
    await host!.runTurn("casper", { sessionId: target, prompt: "target", emit: () => {} });
    await host!.runTurn("casper", { sessionId: victim, prompt: "victim", emit: () => {} });
    await host!.listSessions("casper");
    const paths = ghostPaths(dir);
    const targetTranscript = join(paths.sessionDir, sessionFileNameFor(target));
    const victimTranscript = join(paths.sessionDir, sessionFileNameFor(victim));
    const character = paths.characterFile;
    const agentDb = join(paths.agentDir, "agent.db");
    if (!existsSync(agentDb)) writeFileSync(agentDb, "credentials-victim");
    const originals = new Map([
      [targetTranscript, readFileSync(targetTranscript, "utf8")],
      [victimTranscript, readFileSync(victimTranscript, "utf8")],
      [character, readFileSync(character, "utf8")],
      [agentDb, readFileSync(agentDb, "utf8")],
    ]);
    const stem = sessionFileNameFor(target).slice(0, -".jsonl".length);
    const marker = join(paths.sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    const trashRoot = join(
      dir,
      ".trash",
      ".conversation-11111111-1111-4111-8111-111111111111",
    );
    const trashFor = (source: string, index = 1) => join(
      trashRoot,
      String(index).padStart(3, "0")
        + "-22222222-2222-4222-8222-222222222222-"
        + basename(source),
    );
    const pending = (
      artifact: TrashedConversation["artifacts"][number]["artifact"],
      source: string,
      trash = trashFor(source),
    ) => ({ artifact, source, trash, kind: "fallback" as const });
    const cases: Array<[string, {
      artifacts?: TrashedConversation["artifacts"];
      pending: TrashedConversation["artifacts"][number];
    }]> = [
      ["character", { pending: pending("omp-transcript", character) }],
      ["credential store", { pending: pending("conversation-cwd", agentDb) }],
      ["other transcript", { pending: pending("omp-transcript", victimTranscript) }],
      ["wrong label", { pending: pending("conversation-cwd", targetTranscript) }],
      ["aliased destination", {
        pending: pending(
          "omp-transcript",
          targetTranscript,
          `${trashRoot}${sep}nested${sep}..${sep}${basename(trashFor(targetTranscript))}`,
        ),
      }],
      ["duplicate source", {
        artifacts: [pending("omp-transcript", targetTranscript)],
        pending: pending("omp-transcript", targetTranscript, trashFor(targetTranscript, 2)),
      }],
    ];

    for (const [name, rows] of cases) {
      stages.length = 0;
      writeFileSync(marker, `${JSON.stringify({
        version: 3,
        kind: "delete",
        runtime: "pi",
        conversationId: target,
        artifacts: rows.artifacts ?? [],
        trashRoot,
        pending: rows.pending,
      })}\n`, { mode: 0o600 });
      await expect(host!.deleteSession("casper", target, "pi"), name)
        .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
      expect(stages, name).toEqual([]);
      expect(existsSync(marker), name).toBe(true);
      for (const [path, bytes] of originals) {
        expect(readFileSync(path, "utf8"), `${name}: ${path}`).toBe(bytes);
      }
      rmSync(marker);
    }

    stages.length = 0;
    writeFileSync(marker, `${JSON.stringify({
      version: 2,
      kind: "delete",
      runtime: "pi",
      conversationId: target,
      artifacts: [{
        artifact: "omp-transcript",
        source: victimTranscript,
        trash: join(temp!.root, "legacy-victim-trash"),
        kind: "freedesktop",
      }],
    })}\n`, { mode: 0o600 });
    await expect(host!.deleteSession("casper", target, "pi"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(stages).toEqual([]);
    expect(readFileSync(victimTranscript, "utf8")).toBe(originals.get(victimTranscript));
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const legacyExactTrash = join(temp!.root, "legacy-exact-trash");
    const legacyInvalidCases: Array<[string, TrashedConversation["artifacts"]]> = [
      ["missing completed pair", [{
        artifact: "omp-transcript",
        source: targetTranscript,
        trash: legacyExactTrash,
        kind: "freedesktop",
      }]],
      ["duplicate completed source", [
        {
          artifact: "omp-transcript",
          source: targetTranscript,
          trash: join(temp!.root, "legacy-duplicate-source-one"),
          kind: "freedesktop",
        },
        {
          artifact: "omp-transcript",
          source: targetTranscript,
          trash: join(temp!.root, "legacy-duplicate-source-two"),
          kind: "freedesktop",
        },
      ]],
      ["duplicate completed destination", [
        {
          artifact: "omp-transcript",
          source: targetTranscript,
          trash: legacyExactTrash,
          kind: "freedesktop",
        },
        {
          artifact: "conversation-cwd",
          source: conversationCwdPath(paths.sessionDir, target),
          trash: legacyExactTrash,
          kind: "freedesktop",
        },
      ]],
    ];
    for (const [name, artifacts] of legacyInvalidCases) {
      stages.length = 0;
      writeFileSync(marker, `${JSON.stringify({
        version: 2,
        kind: "delete",
        runtime: "pi",
        conversationId: target,
        artifacts,
      })}\n`, { mode: 0o600 });
      await expect(host!.deleteSession("casper", target, "pi"), name)
        .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
      expect(stages, name).toEqual([]);
      expect(readFileSync(targetTranscript, "utf8"), name).toBe(originals.get(targetTranscript));
      expect(existsSync(marker), name).toBe(true);
      rmSync(marker);
    }

    await host!.close("casper", target);
    const legacyTrash = join(temp!.root, "legacy-target-trash");
    renameSync(targetTranscript, legacyTrash);
    writeFileSync(marker, `${JSON.stringify({
      version: 2,
      kind: "delete",
      runtime: "pi",
      conversationId: target,
      artifacts: [{
        artifact: "omp-transcript",
        source: targetTranscript,
        trash: legacyTrash,
        kind: "freedesktop",
      }],
    })}\n`, { mode: 0o600 });
    await expect(host!.deleteSession("casper", target, "pi")).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ source: targetTranscript, trash: legacyTrash }),
      ]),
    });
    expect(existsSync(legacyTrash)).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const claudeTarget = "delete-claude-allowlist-target";
    const claudeVictim = "delete-claude-allowlist-victim";
    const metadata = (conversationId: string) => `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId,
      sessionId: `sdk-${conversationId}`,
      created: "2026-08-27T00:00:00.000Z",
      modified: "2026-08-27T00:00:00.000Z",
      messageCount: 2,
      ownerTurnCount: 1,
    })}\n`;
    const claudeTargetPath = claudeSessionMetadataPath(paths.sessionDir, claudeTarget);
    const claudeVictimPath = claudeSessionMetadataPath(paths.sessionDir, claudeVictim);
    writeFileSync(claudeTargetPath, metadata(claudeTarget), { mode: 0o600 });
    writeFileSync(claudeVictimPath, metadata(claudeVictim), { mode: 0o600 });
    const claudeStem = sessionFileNameFor(claudeTarget).slice(0, -".jsonl".length);
    const claudeMarker = join(
      paths.sessionDir,
      `.ghost-delete-${claudeStem}.claude-code.pending.json`,
    );
    const claudeTrashRoot = join(
      dir,
      ".trash",
      ".conversation-33333333-3333-4333-8333-333333333333",
    );
    writeFileSync(claudeMarker, `${JSON.stringify({
      version: 3,
      kind: "delete",
      runtime: "claude-code",
      conversationId: claudeTarget,
      artifacts: [],
      trashRoot: claudeTrashRoot,
      pending: {
        artifact: "claude-sidecar",
        source: claudeVictimPath,
        trash: join(
          claudeTrashRoot,
          `001-44444444-4444-4444-8444-444444444444-${basename(claudeVictimPath)}`,
        ),
        kind: "fallback",
      },
    })}\n`, { mode: 0o600 });
    await expect(host!.deleteSession("casper", claudeTarget, "claude-code"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(readFileSync(claudeTargetPath, "utf8")).toBe(metadata(claudeTarget));
    expect(readFileSync(claudeVictimPath, "utf8")).toBe(metadata(claudeVictim));
    expect(existsSync(claudeMarker)).toBe(true);
    rmSync(claudeMarker);
  });

  it("filters exact malformed delete markers for both runtimes without trusting marker bytes", async () => {
    const logger = recordingLogger();
    const { dir } = await setup(undefined, {
      logger,
    });
    const piId = "pi-delete-marker-target";
    const claudeId = "claude-delete-marker-target";
    await host!.runTurn("casper", { sessionId: piId, prompt: "persist me", emit: () => {} });
    const sessionDir = ghostPaths(dir).sessionDir;
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      claudeSessionMetadataPath(sessionDir, claudeId),
      `${JSON.stringify({
        version: 1,
        runtime: "claude-code",
        conversationId: claudeId,
        sessionId: "sdk-claude-delete-marker-target",
        created: "2026-08-27T00:00:00.000Z",
        modified: "2026-08-27T00:00:00.000Z",
        messageCount: 2,
        ownerTurnCount: 1,
      })}\n`,
      { mode: 0o600 },
    );

    const unrelatedStem = sessionFileNameFor("unrelated-marker-name")
      .slice(0, -".jsonl".length);
    const unrelated = join(
      sessionDir,
      `.ghost-delete-${unrelatedStem}.claude-code.pending.json`,
    );
    writeFileSync(unrelated, JSON.stringify({
      version: 1,
      kind: "delete",
      runtime: "claude-code",
      conversationId: claudeId,
    }), { mode: 0o600 });
    expect((await host!.listSessions("casper")).map((row) => row.id).sort())
      .toEqual([`claude-code:${claudeId}`, `pi:${piId}`].sort());

    const sentinel = "R5-DELETE-MARKER-BYTES-MUST-NOT-LEAK";
    const piStem = sessionFileNameFor(piId).slice(0, -".jsonl".length);
    const piMarker = join(sessionDir, `.ghost-delete-${piStem}.pi.pending.json`);
    writeFileSync(piMarker, `{ invalid ${sentinel}\n`, { mode: 0o600 });
    const piHidden = await host!.listSessions("casper");
    expect(piHidden.map((row) => row.id)).toEqual([`claude-code:${claudeId}`]);
    await expect(host!.open("casper", piId))
      .rejects.toMatchObject({ code: "session_deleting", status: 409 });
    await expect(host!.conversationCwd("casper", piId))
      .rejects.toMatchObject({ code: "session_deleting", status: 409 });
    expect(JSON.stringify({ piHidden, logs: logger.records })).not.toContain(sentinel);
    await expect(host!.deleteSession("casper", piId, "pi"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(existsSync(piMarker)).toBe(true);
    expect(existsSync(join(sessionDir, sessionFileNameFor(piId)))).toBe(true);
    rmSync(piMarker);
    await expect(host!.deleteSession("casper", piId, "pi")).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "omp-transcript" }),
      ]),
    });

    const claudeStem = sessionFileNameFor(claudeId).slice(0, -".jsonl".length);
    const claudeMarker = join(
      sessionDir,
      `.ghost-delete-${claudeStem}.claude-code.pending.json`,
    );
    writeFileSync(claudeMarker, `{ invalid ${sentinel}\n`, { mode: 0o600 });
    chmodSync(claudeMarker, 0o000);
    expect(await host!.listSessions("casper")).toEqual([]);
    expect(JSON.stringify(logger.records)).not.toContain(sentinel);
    await expect(host!.deleteSession("casper", claudeId, "claude-code"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(existsSync(claudeMarker)).toBe(true);
    expect(existsSync(claudeSessionMetadataPath(sessionDir, claudeId))).toBe(true);
    chmodSync(claudeMarker, 0o600);
    rmSync(claudeMarker);

    symlinkSync(unrelated, claudeMarker);
    await expect(host!.deleteSession("casper", claudeId, "claude-code"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(existsSync(claudeSessionMetadataPath(sessionDir, claudeId))).toBe(true);
    rmSync(claudeMarker);

    execFileSync("mkfifo", [claudeMarker]);
    const timeout = Symbol("timeout");
    const fifo = await Promise.race([
      host!.deleteSession("casper", claudeId, "claude-code")
        .then(() => "resolved", () => "rejected"),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 500)),
    ]);
    expect(fifo).toBe("rejected");
    expect(existsSync(claudeSessionMetadataPath(sessionDir, claudeId))).toBe(true);
    rmSync(claudeMarker);

    writeFileSync(claudeMarker, "x".repeat(1_048_577), { mode: 0o600 });
    await expect(host!.deleteSession("casper", claudeId, "claude-code"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(existsSync(claudeSessionMetadataPath(sessionDir, claudeId))).toBe(true);
    rmSync(claudeMarker);
    await expect(host!.deleteSession("casper", claudeId, "claude-code"))
      .resolves.toMatchObject({
        artifacts: expect.arrayContaining([
          expect.objectContaining({ artifact: "claude-sidecar" }),
        ]),
      });
    expect(existsSync(unrelated)).toBe(true);
    rmSync(unrelated);
  });

});

describe("passive session recovery during whole-home moves", () => {
  function seedRollbackFork(sessionDir: string, conversationId: string): void {
    mkdirSync(sessionDir, { recursive: true });
    const binding = conversationCwdPath(sessionDir, conversationId);
    const toolCwds = toolCwdsPath(sessionDir, conversationId);
    const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
    writeFileSync(join(sessionDir, `.ghost-fork-${stem}.pending.json`), `${JSON.stringify({
      version: 3,
      kind: "fork",
      conversationId,
      tempTranscript: join(sessionDir, `.${sessionFileNameFor(conversationId)}.race.pending`),
      tempConversationCwd: `${binding}.race.pending`,
      tempToolCwds: `${toolCwds}.race.pending`,
    })}\n`, { mode: 0o600 });
  }

  function pauseFirstForkCleanup() {
    const entered = deferred();
    const resume = deferred();
    let paused = false;
    return {
      entered,
      resume,
      probe: async (stage: string) => {
        if (stage !== "fork-cleanup-unlink" || paused) return;
        paused = true;
        entered.resolve();
        await resume.promise;
      },
    };
  }

  async function reserveBlockedMove(coordinator: HomeOperationCoordinator): Promise<{
    move: Promise<() => void>;
    ready: () => boolean;
  }> {
    let ready = false;
    const move = coordinator.reserveMove("casper").then((release) => {
      ready = true;
      return release;
    });
    await Promise.resolve();
    return { move, ready: () => ready };
  }

  function pauseConversationFile(
    operation: "plan-read" | "plan-write" | "title-write",
  ) {
    const entered = deferred();
    const resume = deferred();
    return {
      entered,
      resume,
      probe: async (
        candidate:
          | "plan-read"
          | "plan-write"
          | "title-write"
          | "transcript-read"
          | "fork-read",
      ) => {
        if (candidate !== operation) return;
        entered.resolve();
        await resume.promise;
      },
    };
  }

  it("holds a list recovery lease until a concurrent rename can safely move the home", async () => {
    const recovery = pauseFirstForkCleanup();
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      transactionProbe: recovery.probe,
    });
    const sessionDir = ghostPaths(dir).sessionDir;
    seedRollbackFork(sessionDir, "list-race");
    const coordinator = homeOperationsFor(temp!.registry);

    const listing = host!.listSessions("casper");
    await recovery.entered.promise;
    const reserved = await reserveBlockedMove(coordinator);
    expect(reserved.ready()).toBe(false);
    expect(coordinator.moveReservationCount).toBe(1);

    recovery.resume.resolve();
    await listing;
    const releaseMove = await reserved.move;
    try {
      await host!.renameGhost("casper", "wisp");
    } finally {
      releaseMove();
    }

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(true);
  });

  it("holds pin publication and its announcement until a concurrent rename moves the home", async () => {
    const entered = deferred();
    const resume = deferred();
    const { dir } = await setup([{ kind: "text", text: "persisted" }], {
      pinWriter: async (...args) => {
        entered.resolve();
        await resume.promise;
        return writePins(...args);
      },
    });
    await host!.runTurn("casper", {
      sessionId: "pin-race",
      prompt: "remember this",
      emit: () => {},
    });
    const coordinator = homeOperationsFor(temp!.registry);

    const pinning = host!.setPinned("casper", "pin-race", true);
    await entered.promise;
    const reserved = await reserveBlockedMove(coordinator);
    expect(reserved.ready()).toBe(false);

    resume.resolve();
    await pinning;
    const releaseMove = await reserved.move;
    try {
      await host!.renameGhost("casper", "wisp");
    } finally {
      releaseMove();
    }

    expect(existsSync(dir)).toBe(false);
    expect((await readPinState(ghostPaths(join(temp!.root, "wisp")).sessionDir)).pinned)
      .toEqual(["pi:pin-race"]);
  });

  it("holds read publication and its announcement until a concurrent delete moves the home", async () => {
    const entered = deferred();
    const resume = deferred();
    const openedAt = new Date("2026-08-30T12:00:00.000Z");
    const { dir } = await setup([{ kind: "text", text: "persisted" }], {
      readWriter: async (...args) => {
        entered.resolve();
        await resume.promise;
        return writeReads(...args);
      },
    });
    await host!.runTurn("casper", {
      sessionId: "read-race",
      prompt: "remember this",
      emit: () => {},
    });
    const coordinator = homeOperationsFor(temp!.registry);

    const marking = host!.markRead("casper", "read-race", openedAt);
    await entered.promise;
    const reserved = await reserveBlockedMove(coordinator);
    expect(reserved.ready()).toBe(false);

    resume.resolve();
    await expect(marking).resolves.toBe(openedAt.toISOString());
    const releaseMove = await reserved.move;
    const { trash } = await host!.deleteGhost("casper").finally(releaseMove);

    expect(existsSync(dir)).toBe(false);
    expect((await readReadState(ghostPaths(trash).sessionDir)).reads).toEqual({
      "pi:read-race": openedAt.toISOString(),
    });
  });

  it("publishes a title before rename and cannot append into a reused old name", async () => {
    const title = pauseConversationFile("title-write");
    const conversationId = "title-write-race";
    const { dir } = await setup([{ kind: "text", text: "persisted" }], {
      title: { enabled: false },
      conversationFileProbe: title.probe,
    });
    await host!.runTurn("casper", { sessionId: conversationId, prompt: "remember", emit: () => {} });
    await host!.close("casper", conversationId);
    const coordinator = homeOperationsFor(temp!.registry);

    const naming = host!.renameConversation("casper", conversationId, "Moved safely");
    await title.entered.promise;
    const reserved = await reserveBlockedMove(coordinator);
    expect(reserved.ready()).toBe(false);

    title.resume.resolve();
    await expect(naming).resolves.toBe("Moved safely");
    const releaseMove = await reserved.move;
    try {
      await host!.renameGhost("casper", "wisp");
      expect(() => host!.createGhost("casper")).toThrowError(/finish moving/);
    } finally {
      releaseMove();
    }
    expect(existsSync(dir)).toBe(false);
    const replacement = host!.createGhost("casper");

    expect((await host!.listSessions("wisp"))
      .find((row) => row.conversationId === conversationId)?.title).toBe("Moved safely");
    expect(existsSync(join(
      ghostPaths(replacement.dir).sessionDir,
      sessionFileNameFor(conversationId),
    ))).toBe(false);
  });
});

describe("SessionHost.deleteGhost", () => {
  it("retires the old-home browser entry before moving a ghost with no Pi session", async () => {
    const closed: string[] = [];
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      browserSessionClose: async (homeDir) => {
        expect(existsSync(homeDir)).toBe(true);
        closed.push(homeDir);
      },
    });

    await host!.deleteGhost("casper");

    expect(closed).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ["cancelled", "cancelled"],
    ["timed-out", "timeout"],
  ] as const)("retires a %s browser open before moving the ghost home", async (_label, failure) => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    const relay = await failedRelayOpen(dir, failure, () => {
      expect(existsSync(dir)).toBe(true);
    });

    const deleting = host!.deleteGhost("casper");
    await relay.closeRequested;
    expect(existsSync(dir)).toBe(true);
    relay.settleCreate();
    await deleting;

    expect(relay.sent).toEqual(["open", "close"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("closes the ghost's conversations and moves the whole home into the trash", async () => {
    const { dir } = await setup();
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "one", emit: () => {} });
    const transcript = sessionFileNameFor("conv-1");
    expect(existsSync(join(ghostPaths(dir).sessionDir, transcript))).toBe(true);

    const { trash } = await host!.deleteGhost("casper");

    expect(existsSync(dir)).toBe(false);
    expect(temp!.registry.list()).toEqual([]);
    // The system trash, with the .trashinfo that makes it restorable.
    expect(trash).toBe(join(temp!.trashDir, "files", "casper"));
    expect(existsSync(join(temp!.trashDir, "info", "casper.trashinfo"))).toBe(true);
    // The conversation moved with the ghost; nothing was erased.
    expect(existsSync(join(ghostPaths(trash).sessionDir, transcript))).toBe(true);
    expect(existsSync(ghostPaths(trash).characterFile)).toBe(true);
    await expect(host!.listSessions("casper")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("refuses while one of the ghost's conversations is answering", async () => {
    await setup();
    const turn = host!.runTurn("casper", {
      sessionId: "conv-busy",
      prompt: "one",
      emit: () => {},
    });
    await expect(host!.deleteGhost("casper")).rejects.toMatchObject({
      code: "ghost_busy",
      status: 409,
    });
    await turn;
    await expect(host!.deleteGhost("casper")).resolves.toMatchObject({
      trash: join(temp!.trashDir, "files", "casper"),
    });
  });

  it("leaves the home in place when schedule cleanup fails and completes on retry", async () => {
    let systemdAvailable = false;
    const calls: string[][] = [];
    const { dir, temp } = await setup(undefined, {
      scheduleCommandRunner: async (args) => {
        calls.push([...args]);
        return systemdAvailable
          ? { stdout: "", stderr: "", code: 0 }
          : { stdout: "", stderr: "user manager unavailable", code: 1 };
      },
    });
    const unitDir = join(temp.ownerHome, ".config", "systemd", "user");
    const runtimeUnitDir = join(temp.ownerHome, ".runtime", "systemd", "user");
    const timer = "ghost-timer-v1-6-casper-standup.timer";
    const service = "ghost-timer-v1-6-casper-standup.service";
    const runtimeTimer = "ghost-timer-v1-6-casper-weekly.timer";
    const runtimeService = "ghost-timer-v1-6-casper-weekly.service";
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(runtimeUnitDir, { recursive: true });
    writeFileSync(join(unitDir, timer), "[Timer]\n");
    writeFileSync(join(unitDir, service), "[Service]\n");
    writeFileSync(join(runtimeUnitDir, runtimeTimer), "[Timer]\n");
    writeFileSync(join(runtimeUnitDir, runtimeService), "[Service]\n");

    await expect(host!.deleteGhost("casper")).rejects.toMatchObject({
      code: "schedule_cleanup_failed",
      status: 503,
    });
    expect(existsSync(dir)).toBe(true);
    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["casper"]);
    expect(readdirSync(unitDir).sort()).toEqual([service, timer]);
    expect(readdirSync(runtimeUnitDir).sort()).toEqual([runtimeService, runtimeTimer]);

    systemdAvailable = true;
    await expect(host!.deleteGhost("casper")).resolves.toMatchObject({
      trash: join(temp.trashDir, "files", "casper"),
    });
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(unitDir)).toEqual([]);
    expect(readdirSync(runtimeUnitDir)).toEqual([]);
    expect(calls.map((args) => args[1])).toEqual([
      "list-units",
      "list-units",
      "list-unit-files",
      "stop",
      "daemon-reload",
      "list-units",
      "list-unit-files",
    ]);
    expect(calls).toContainEqual(["--user", "stop", timer, runtimeTimer]);
  });

  it("blocks a new conversation while the ghost home is moving to trash", async () => {
    await setup();
    await host!.open("casper", "existing");
    const background = Promise.withResolvers<void>();
    const hosted = (host as unknown as {
      sessions: Map<string, { title?: Promise<void> }>;
    }).sessions.get(sessionKeyOf("casper", "existing"));
    expect(hosted).toBeDefined();
    hosted!.title = background.promise;

    const deleting = host!.deleteGhost("casper");
    await expect(host!.open("casper", "late"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });

    background.resolve();
    await deleting;
  });

  it("leaves other ghosts alone and refuses an unknown one", async () => {
    await setup();
    const mina = seedGhost(temp!.root, {
      name: "mina",
      provider: { baseUrl: provider!.url, modelId: provider!.modelId },
    });

    await host!.deleteGhost("casper");
    expect(temp!.registry.list().map((ghost) => ghost.name)).toEqual(["mina"]);
    expect(existsSync(mina)).toBe(true);

    await expect(host!.deleteGhost("casper")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});

describe("SessionHost.renameGhost", () => {
  it("fails closed when schedule cleanup cannot be inspected and completes on retry", async () => {
    const { temp } = await setup();
    const systemdDir = join(temp.ownerHome, ".config", "systemd");
    mkdirSync(systemdDir, { recursive: true });
    writeFileSync(join(systemdDir, "user"), "not a directory");

    await expect(host!.renameGhost("casper", "specter")).rejects.toMatchObject({
      code: "schedule_cleanup_failed",
      status: 503,
    });
    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["casper"]);
    expect(existsSync(join(temp.root, "specter"))).toBe(false);

    unlinkSync(join(systemdDir, "user"));
    mkdirSync(join(systemdDir, "user"));
    await expect(host!.renameGhost("casper", "specter")).resolves.toMatchObject({
      name: "specter",
    });
  });

  it("retires old-name schedules before rename so a new ghost can reuse the name", async () => {
    const { temp } = await setup();
    const runtimeUnitDir = join(temp.ownerHome, ".runtime", "systemd", "user");
    const timer = "ghost-timer-v1-6-casper-standup.timer";
    const service = "ghost-timer-v1-6-casper-standup.service";
    mkdirSync(runtimeUnitDir, { recursive: true });
    writeFileSync(join(runtimeUnitDir, timer), "[Timer]\n");
    writeFileSync(join(runtimeUnitDir, service), "[Service]\n");

    await expect(host!.renameGhost("casper", "wisp")).resolves.toMatchObject({ name: "wisp" });
    expect(readdirSync(runtimeUnitDir)).toEqual([]);

    const replacement = temp.registry.create("casper");
    expect(replacement.name).toBe("casper");
    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["casper", "wisp"]);
    expect(readdirSync(runtimeUnitDir)).toEqual([]);
  });

  it.each([
    ["cancelled", "cancelled"],
    ["timed-out", "timeout"],
  ] as const)("retires a %s browser open under the old home before the rename", async (_label, failure) => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    const relay = await failedRelayOpen(dir, failure, () => {
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(temp!.root, "wisp"))).toBe(false);
    });

    const renaming = host!.renameGhost("casper", "wisp");
    await relay.closeRequested;
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(false);
    relay.settleCreate();
    const renamed = await renaming;

    expect(relay.sent).toEqual(["open", "close"]);
    expect(renamed.dir).toBe(join(temp!.root, "wisp"));
  });

  it("leaves the old home unmoved and retries the same browser entry after close fails", async () => {
    let failClose = true;
    const closed: string[] = [];
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      browserSessionClose: async (homeDir) => {
        closed.push(homeDir);
        if (failClose) throw new Error("relay close failed");
      },
    });

    await expect(host!.renameGhost("casper", "wisp"))
      .rejects.toMatchObject({ code: "browser_cleanup_pending", status: 503 });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(false);
    expect(temp!.registry.get("casper").dir).toBe(dir);

    failClose = false;
    await expect(host!.renameGhost("casper", "wisp"))
      .resolves.toMatchObject({ name: "wisp" });
    expect(closed).toEqual([dir, dir]);
  });

  it("moves the home and keeps every conversation, pin, and file with it", async () => {
    const { dir } = await setup();
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "one", emit: () => {} });
    await host!.renameConversation("casper", "conv-1", "First light");
    await host!.setPinned("casper", "conv-1", true);
    writeFileSync(join(dir, "press.md"), "The Vandercook is a proof press.\n", "utf8");

    const renamed = await host!.renameGhost("casper", "wisp");

    expect(renamed).toMatchObject({ name: "wisp", dir: join(temp!.root, "wisp") });
    expect(existsSync(dir)).toBe(false);
    expect(temp!.registry.list().map((ghost) => ghost.name)).toEqual(["wisp"]);
    // The conversation id is the transcript filename, so it travelled intact.
    const sessions = await host!.listSessions("wisp");
    expect(sessions).toMatchObject([{
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
      title: "First light",
      pinned: true,
    }]);
    expect(readFileSync(join(renamed.dir, "press.md"), "utf8"))
      .toContain("Vandercook");
    // The old name is gone from the API, and the renamed ghost still answers.
    await expect(host!.listSessions("casper"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
    await host!.runTurn("wisp", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect((await host!.readTranscript("wisp", "conv-1")).messages.length)
      .toBeGreaterThanOrEqual(4);
  });

  it("leaves owner-authored character Markdown unchanged across a rename", async () => {
    await setup();
    const casperBefore = readFileSync(
      ghostPaths(temp!.registry.get("casper").dir).characterFile,
      "utf8",
    );
    const written = seedGhost(temp!.root, {
      name: "mina",
      character: "## The Archivist\n\nYou are mina.\n",
    });
    const minaBefore = readFileSync(ghostPaths(written).characterFile, "utf8");

    const wisp = await host!.renameGhost("casper", "wisp");
    expect(readFileSync(ghostPaths(wisp.dir).characterFile, "utf8"))
      .toBe(casperBefore);

    const renamedMina = await host!.renameGhost("mina", "vera");
    expect(readFileSync(ghostPaths(renamedMina.dir).characterFile, "utf8"))
      .toBe(minaBefore);
    expect(existsSync(written)).toBe(false);
  });

  it("checks the new name, the old ghost, the collision, and the turn in that order", async () => {
    await setup();
    seedGhost(temp!.root, { name: "mina" });

    await expect(host!.renameGhost("casper", "../escape"))
      .rejects.toMatchObject({ code: "invalid_name", status: 400 });
    await expect(host!.renameGhost("nobody", "wisp"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(host!.renameGhost("casper", "mina"))
      .rejects.toMatchObject({ code: "already_exists", status: 409 });
    // Its own name changes nothing and is not a collision with itself.
    await expect(host!.renameGhost("casper", "casper")).resolves.toMatchObject({ name: "casper" });

    const turn = host!.runTurn("casper", { sessionId: "conv-busy", prompt: "one", emit: () => {} });
    await expect(host!.renameGhost("casper", "wisp"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    await turn;
    await expect(host!.renameGhost("casper", "wisp")).resolves.toMatchObject({ name: "wisp" });
  });

  it("blocks both names while the ghost home is being renamed", async () => {
    await setup();
    await host!.open("casper", "existing");
    const background = Promise.withResolvers<void>();
    const hosted = (host as unknown as {
      sessions: Map<string, { title?: Promise<void> }>;
    }).sessions.get(sessionKeyOf("casper", "existing"));
    expect(hosted).toBeDefined();
    hosted!.title = background.promise;

    const renaming = host!.renameGhost("casper", "wisp");
    await expect(host!.open("casper", "late-old"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    await expect(host!.open("wisp", "late-new"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });

    background.resolve();
    await renaming;
  });
});

describe("pinned conversations", () => {
  async function twoConversations() {
    const fixture = await setup();
    await host!.runTurn("casper", { sessionId: "older", prompt: "one", emit: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host!.runTurn("casper", { sessionId: "newer", prompt: "two", emit: () => {} });
    return fixture;
  }

  it("lists every conversation with a pin flag, unpinned by default", async () => {
    await twoConversations();
    expect((await host!.listSessions("casper")).map((session) => session.pinned))
      .toEqual([false, false]);
  });

  it("puts a pinned conversation first, newest-updated within each group", async () => {
    const { dir } = await twoConversations();
    await host!.setPinned("casper", "older", true);

    expect((await host!.listSessions("casper")).map((s) => [s.id, s.pinned]))
      .toEqual([["pi:older", true], ["pi:newer", false]]);
    expect((await readPinState(ghostPaths(dir).sessionDir)).pinned).toEqual(["pi:older"]);

    // Pinning is idempotent, and pinning both falls back to recency.
    await host!.setPinned("casper", "older", true);
    await host!.setPinned("casper", "newer", true);
    expect((await host!.listSessions("casper")).map((session) => session.id))
      .toEqual(["pi:newer", "pi:older"]);
  });

  it("unpins, idempotently", async () => {
    const { dir } = await twoConversations();
    await host!.setPinned("casper", "older", true);
    await host!.setPinned("casper", "older", false);
    await host!.setPinned("casper", "older", false);
    expect((await host!.listSessions("casper")).map((session) => session.id))
      .toEqual(["pi:newer", "pi:older"]);
    expect((await readPinState(ghostPaths(dir).sessionDir)).pinned).toEqual([]);
  });

  it("refuses to pin a conversation that does not exist", async () => {
    await twoConversations();
    await expect(host!.setPinned("casper", "nope", true)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("drops the pin when the conversation is deleted", async () => {
    const { dir } = await twoConversations();
    await host!.setPinned("casper", "older", true);
    await host!.deleteSession("casper", "older");
    expect((await readPinState(ghostPaths(dir).sessionDir)).pinned).toEqual([]);
    expect((await host!.listSessions("casper")).map((session) => session.id))
      .toEqual(["pi:newer"]);
  });

  it("ignores a stale id on read and prunes it on the next write", async () => {
    const { dir } = await twoConversations();
    const sessionDir = ghostPaths(dir).sessionDir;
    await writePins(sessionDir, ["pi:ghost-of-a-conversation", "pi:older"]);

    expect((await host!.listSessions("casper")).map((s) => [s.id, s.pinned]))
      .toEqual([["pi:older", true], ["pi:newer", false]]);

    await host!.setPinned("casper", "newer", true);
    expect(((await readPinState(sessionDir)).pinned).sort()).toEqual(["pi:newer", "pi:older"]);
  });

  it("treats a malformed pins.json as nothing pinned", async () => {
    const { dir } = await twoConversations();
    const sessionDir = ghostPaths(dir).sessionDir;
    writeFileSync(join(sessionDir, "pins.json"), "{ not json at all", "utf8");

    expect((await host!.listSessions("casper")).map((session) => session.pinned))
      .toEqual([false, false]);
    // And a pin still lands, replacing the unreadable file wholesale.
    await host!.setPinned("casper", "older", true);
    expect((await readPinState(sessionDir)).pinned).toEqual(["pi:older"]);
  });
});

describe("runtime-qualified conversation identity", () => {
  it("expands legacy raw owner state across collisions and migrates it on mutation", async () => {
    const { dir } = await setup();
    await host!.runTurn("casper", {
      sessionId: "default",
      prompt: "Pi conversation",
      emit: () => {},
    });
    const sessionDir = ghostPaths(dir).sessionDir;
    const now = new Date().toISOString();
    writeFileSync(
      claudeSessionMetadataPath(sessionDir, "default"),
      JSON.stringify({
        version: 1,
        runtime: "claude-code",
        conversationId: "default",
        sessionId: "8f0a1c1e-0000-4000-8000-000000000000",
        created: now,
        modified: now,
        messageCount: 2,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const readAt = "2099-01-01T00:00:00.000Z";
    writeFileSync(join(sessionDir, "pins.json"), JSON.stringify({ pinned: ["default"] }), "utf8");
    writeFileSync(
      join(sessionDir, "reads.json"),
      JSON.stringify({ reads: { default: readAt } }),
      "utf8",
    );

    const legacy = await host!.listSessions("casper");
    expect(legacy.map((row) => [row.id, row.pinned, row.unread])).toEqual(expect.arrayContaining([
      ["pi:default", true, false],
      ["claude-code:default", true, false],
    ]));

    await host!.setPinned("casper", "default", false, "pi");
    expect(JSON.parse(readFileSync(join(sessionDir, "pins.json"), "utf8"))).toEqual({
      version: 2,
      pinned: ["claude-code:default"],
    });
    await host!.markRead("casper", "default", new Date(readAt), "pi");
    expect(JSON.parse(readFileSync(join(sessionDir, "reads.json"), "utf8"))).toEqual({
      version: 2,
      reads: {
        "pi:default": readAt,
        "claude-code:default": readAt,
      },
    });
  });

  it("migrates legacy owner state when an unpublished Pi fork is discarded", async () => {
    const { dir } = await setup();
    const forkId = "branch-collision";
    await host!.runTurn("casper", {
      sessionId: forkId,
      prompt: "Unpublished fork",
      emit: () => {},
    });
    const sessionDir = ghostPaths(dir).sessionDir;
    const now = new Date().toISOString();
    const claudePath = claudeSessionMetadataPath(sessionDir, forkId);
    writeFileSync(claudePath, JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: forkId,
      sessionId: "8f0a1c1e-0000-4000-8000-000000000000",
      created: now,
      modified: now,
      messageCount: 2,
    }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(sessionDir, "pins.json"), JSON.stringify({ pinned: [forkId] }), "utf8");
    writeFileSync(
      join(sessionDir, "reads.json"),
      JSON.stringify({ reads: { [forkId]: "2099-01-01T00:00:00.000Z" } }),
      "utf8",
    );

    await (host as unknown as {
      discardFork(ghostName: string, conversationId: string): Promise<void>;
    }).discardFork("casper", forkId);

    expect(existsSync(join(sessionDir, sessionFileNameFor(forkId)))).toBe(false);
    expect(existsSync(claudePath)).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir, "pins.json"), "utf8"))).toEqual({
      version: 2,
      pinned: [`claude-code:${forkId}`],
    });
    expect(JSON.parse(readFileSync(join(sessionDir, "reads.json"), "utf8"))).toEqual({
      version: 2,
      reads: { [`claude-code:${forkId}`]: "2099-01-01T00:00:00.000Z" },
    });
  });
});

describe("conversation titles", () => {
  it("reads native session_info names for listing and transcript restoration", async () => {
    const { dir } = await setup([{ kind: "text", text: "ok" }]);
    const paths = ghostPaths(dir);
    mkdirSync(paths.sessionDir, { recursive: true });
    const transcript = join(paths.sessionDir, sessionFileNameFor("native-title"));
    writeFileSync(transcript, "", { mode: 0o600 });
    const manager = SessionManager.open(transcript, paths.sessionDir, temp!.ownerHome);
    manager.appendSessionInfo("Native Pi Title");

    await expect(host!.listSessions("casper")).resolves.toContainEqual(
      expect.objectContaining({
        id: "pi:native-title",
        title: "Native Pi Title",
      }),
    );
    await expect(host!.readTranscript("casper", "native-title")).resolves.toMatchObject({
      title: "Native Pi Title",
    });
  });

  it("generates a title once, after the first turn, and never before or again", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "ok" }] });
    seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    let calls = 0;
    const prompts: string[] = [];
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      title: {
        generate: async ({ firstPrompt }) => {
          calls += 1;
          prompts.push(firstPrompt);
          return "Naming The Conversation";
        },
      },
    });

    // Not before the first turn.
    expect(calls).toBe(0);

    await host.runTurn("casper", { sessionId: "conv-1", prompt: "First message", emit: () => {} });
    // listSessions awaits the in-flight title write before reading.
    let sessions = await host.listSessions("casper");
    expect(calls).toBe(1);
    expect(prompts).toEqual(["First message"]);
    expect(sessions[0]?.title).toBe("Naming The Conversation");

    // A second turn does not regenerate — the conversation already has a title.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "Second message", emit: () => {} });
    sessions = await host.listSessions("casper");
    expect(calls).toBe(1);
    expect(sessions[0]?.title).toBe("Naming The Conversation");
  });

  it("swallows a title-generation error and still completes the turn", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "answer" }] });
    seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      title: { generate: async () => { throw new Error("title model exploded"); } },
    });
    const events: PiMessagesEvent[] = [];
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "hi", emit: (event) => events.push(event) });
    expect(events.at(-1)?.type).toBe("done");
    const sessions = await host.listSessions("casper");
    expect(sessions[0]?.title).toBeNull();
  });

  it("names a conversation from a real single completion on the cheapest usable model", async () => {
    // No injected generator: exercises resolution + one complete() call.
    await setup([{ kind: "text", text: "Fixing the platen roller" }]);
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "The platen roller slips", emit: () => {} });
    const sessions = await host!.listSessions("casper");
    expect(sessions[0]?.title).toBe("Fixing the platen roller");
  });
});

describe("a ghost's shell", () => {
  it("carries the ghost and the runtime-qualified conversation id", async () => {
    await setup([
      { kind: "tool", name: "bash", args: { command: 'echo "$GHOST/$GHOST_SESSION"' } },
      { kind: "text", text: "Checked." },
    ]);
    await host!.runTurn("casper", { sessionId: "conv-env", prompt: "Who are you?", emit: () => {} });
    const toolResults = provider!.requests.map((request) => JSON.stringify(request.messages)).join("\n");
    expect(toolResults).toContain("casper/pi:conv-env");
  });
});

describe("renaming a conversation", () => {
  async function titleOf(sessionId = "conv-1"): Promise<string | null> {
    const sessions = await host!.listSessions("casper");
    return sessions.find((session) => session.conversationId === sessionId
      && session.runtime === "pi")?.title ?? null;
  }

  it("names a conversation and keeps the titler from overwriting it", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "ok" }] });
    seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    // A conversation renamed before it is ever titled is the sharp case: the
    // background titler runs after the first turn and must lose.
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      title: { generate: async () => "Generated Title" },
    });
    await host.open("casper", "conv-1");

    expect(await host.renameConversation("casper", "conv-1", "The Vandercook")).toBe("The Vandercook");
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "hello", emit: () => {} });
    expect(await titleOf()).toBe("The Vandercook");
    expect((await host.readTranscript("casper", "conv-1")).title).toBe("The Vandercook");
  });

  it("renames an idle conversation the daemon has no session open for", async () => {
    await setup([{ kind: "text", text: "ok" }]);
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "hello", emit: () => {} });
    await host!.close("casper", "conv-1");

    const stored = await host!.renameConversation(
      "casper",
      "conv-1",
      "  Press   day\tproof\r\n\r\nnotes  ",
    );
    expect(stored).toBe("Press   day\tproof notes");
    expect(await titleOf()).toBe(stored);
    // The reopened conversation still resumes, with the new name on it.
    const handle = await host!.open("casper", "conv-1");
    expect(handle.session.sessionName).toBe(stored);
  });

  it("renames a conversation that is mid-turn", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Ready",
            question: "Ready?",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Wait" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Done." },
    ]);
    const turn = host!.runTurn("casper", {
      sessionId: "conv-live",
      prompt: "Start.",
      emit: () => {},
    });
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-live"));
    // The session name is independent of the active branch: the answer the
    // owner is about to give still lands on the running conversation.
    expect(await host!.renameConversation("casper", "conv-live", "Watching it work"))
      .toBe("Watching it work");
    host!.answerAsk("casper", "conv-live", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Yes"] }],
    });
    await turn;
    expect(await titleOf("conv-live")).toBe("Watching it work");
  });

  it("names a Claude Code conversation on its resume sidecar and lists it", async () => {
    const { dir } = await setup([{ kind: "text", text: "ok" }]);
    const sessionDir = ghostPaths(dir).sessionDir;
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      claudeSessionMetadataPath(sessionDir, "claude-conv"),
      JSON.stringify({
        version: 1,
        runtime: "claude-code",
        conversationId: "claude-conv",
        sessionId: "8f0a1c1e-0000-4000-8000-000000000000",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 2,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    expect((await host!.listSessions("casper")).find((session) => session.id === "claude-code:claude-conv"))
      .toMatchObject({ title: "Claude Code" });
    await expect(host!.renameConversation("casper", "claude-conv", " Mine now ", "claude-code"))
      .resolves.toBe("Mine now");
    expect((await host!.listSessions("casper")).find((session) => session.id === "claude-code:claude-conv"))
      .toMatchObject({ title: "Mine now" });
    const stored = JSON.parse(readFileSync(claudeSessionMetadataPath(sessionDir, "claude-conv"), "utf8"));
    expect(stored).toMatchObject({ version: 3, title: "Mine now", cwd: dir });
    await expect(host!.renameConversation("casper", "missing-conv", "Nope", "claude-code"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("404s an unknown conversation and refuses a title with nothing in it", async () => {
    await setup([{ kind: "text", text: "ok" }]);
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "hello", emit: () => {} });
    await expect(host!.renameConversation("casper", "no-such-conversation", "Anything"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(host!.renameConversation("casper", "conv-1", ""))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });
});

describe("model switch reaches a live cached session", () => {
  // A ghost home whose local provider declares two models, chat bound to
  // model-a. Both models exist in the catalogue when the session is built, so a
  // later switch resolves against the runtime the session already carries —
  // exactly the real switcher case (the switch changes the role, not the
  // provider's model list).
  function twoModelFile(baseUrl: string): GhostModelsFile {
    const model = (id: string): GhostModelDefinition => ({
      id,
      name: id,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    return {
      providers: {
        "ghost-local": {
          name: "ghost-local",
          baseUrl,
          api: "openai-completions",
          apiKey: "not-needed",
          models: [model("model-a"), model("model-b")],
        },
      },
      roles: { chat_model: { provider: "ghost-local", modelId: "model-a" } },
    };
  }

  function piRuntimeOf(handle: Awaited<ReturnType<SessionHost["open"]>>) {
    return (handle as typeof handle & {
      modelRuntime: { runtime: { refresh(options: { allowNetwork: boolean }): Promise<void> } };
    }).modelRuntime.runtime;
  }

  it("reloads cached credential and model state before an idle refresh resolves", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const handle = await host!.open("casper", "conv-auth-idle");
    const refresh = vi.spyOn(piRuntimeOf(handle), "refresh");

    await host!.refreshAuth("casper");

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: false }));
  });

  it("defers a login refresh that lands mid-turn until the owner releases", async () => {
    const barrier = createMockProviderBarrier();
    await setup([{ kind: "text", text: "held", barrier }]);
    const handle = await host!.open("casper", "conv-auth-busy");
    const reload = vi.spyOn(piRuntimeOf(handle), "refresh");

    const turn = host!.runTurn("casper", {
      sessionId: "conv-auth-busy",
      prompt: "hold credentials stable",
      emit: () => {},
    });
    await barrier.waitForArrivals();
    await host!.refreshAuth("casper");
    expect(reload).not.toHaveBeenCalled();

    barrier.release();
    await turn;
    expect(reload).toHaveBeenCalledOnce();
  });

  it("rebinds a cached session so the next turn runs the newly selected model", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "ok" }] });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    writeGhostModels(paths.home, twoModelFile(provider.url));
    host = new SessionHost({ registry: temp.registry, offline: true });

    // First turn: the session is built once and cached, bound to model-a.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "one", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-a");

    // Switch the role on disk exactly as ModelCatalog.setChatModel does, then
    // fire the same rebind hook it invokes. Without the rebind the cached
    // session would answer on model-a forever.
    setGhostModelRole(paths.home, "chat_model", "ghost-local", "model-b");
    await host.rebindModel("casper");

    // The SAME cached conversation now answers on model-b.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-b");
  });

  it("tracks inspect_image availability across live model rebinds", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "unused" }] });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    const models = twoModelFile(provider.url);
    models.providers["ghost-local"]!.models![1]!.input = ["text", "image"];
    writeGhostModels(paths.home, models);
    host = new SessionHost({ registry: temp.registry, offline: true });

    const handle = await host.open("casper", "vision-rebind");
    expect(handle.session.getActiveToolNames()).toContain("inspect_image");

    setGhostModelRole(paths.home, "chat_model", "ghost-local", "model-b");
    await host.rebindModel("casper");
    expect(handle.session.getActiveToolNames()).not.toContain("inspect_image");

    setGhostModelRole(paths.home, "chat_model", "ghost-local", "model-a");
    await host.rebindModel("casper");
    expect(handle.session.getActiveToolNames()).toContain("inspect_image");
  });

  it("rebinds a cleared chat role through the same Ghost catalogue-default resolver", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "unused" }] });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    const models = twoModelFile(provider.url);
    models.roles = { chat_model: { provider: "ghost-local", modelId: "model-b" } };
    writeGhostModels(paths.home, models);
    host = new SessionHost({ registry: temp.registry, offline: true });

    const handle = await host.open("casper", "conv-default-rebind");
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-b" });

    clearGhostModelRole(paths.home, "chat_model");
    await host.rebindModel("casper");

    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-a" });
  });

  it("defers a switch that lands mid-turn, then applies it to the next turn", async () => {
    temp = makeTempGhosts();
    // Stream slowly so a turn is still in flight when the switch lands.
    provider = await startMockProvider({
      script: [{ kind: "text", text: "one two three four five six" }],
      chunkDelayMs: 15,
    });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    writeGhostModels(paths.home, twoModelFile(provider.url));
    host = new SessionHost({ registry: temp.registry, offline: true });

    // Build and cache the session up front, so the timed turn below reuses it
    // (open() returns instantly and busy flips true within a microtask — no
    // race with a slow first-time build).
    await host.open("casper", "conv-1");

    // Start a turn but do not await it: it holds the session busy while it streams.
    const inflight = host.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "one",
      emit: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Switch while busy: the model must not be yanked out from under the run.
    setGhostModelRole(paths.home, "chat_model", "ghost-local", "model-b");
    await host.rebindModel("casper");
    await inflight;

    // The in-flight turn still ran on model-a — it was not rebound mid-turn.
    expect(provider.requests.at(-1)?.model).toBe("model-a");

    // The deferred switch applied once the turn settled: the next turn is model-b.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-b");
  });

  it("defers a model rebind until a raw external turn settles", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "ask",
          args: {
            questions: [{
              header: "Model",
              question: "Keep this model for the current turn?",
              options: [
                { label: "Yes", description: "Keep the current model" },
                { label: "No", description: "Change after this turn" },
              ],
              multiSelect: false,
            }],
          },
        },
        { kind: "text", text: "Remote model turn done." },
      ],
    });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    writeGhostModels(paths.home, twoModelFile(provider.url));
    host = new SessionHost({ registry: temp.registry, offline: true });
    const handle = await host.open("casper", "conv-remote-model");

    const remoteTurn = handle.session.prompt("Remote prompt.");
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-remote-model"));
    setGhostModelRole(paths.home, "chat_model", "ghost-local", "model-b");
    await host.rebindModel("casper");
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-a" });

    host.answerAsk("casper", "conv-remote-model", pending.id, {
      kind: "submit",
      results: [{ id: "question-1", selectedOptions: ["Yes"] }],
    });
    await remoteTurn;
    await waitFor(() => handle.model?.id === "model-b" ? true : null);
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-b" });
  });

});

describe("transcript resume", () => {
  it("returns renderable user/assistant history for a past conversation", async () => {
    await setup([{ kind: "text", text: "I restore letterpresses." }]);
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "What do you do?",
      emit: () => {},
    });
    const transcript = await host!.readTranscript("casper", "conv-1");
    expect(transcript).toMatchObject({
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
    expect(transcript.messages.length).toBeGreaterThanOrEqual(2);
    expect(transcript.messages[0]?.role).toBe("user");
    const roles = new Set(transcript.messages.map((message) => message.role));
    expect(roles.has("assistant")).toBe(true);
    // No private reasoning in any assistant message.
    for (const message of transcript.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          expect((part as { type?: string }).type).not.toBe("thinking");
        }
      }
    }
  });

  it("marks a restored tool call that failed, and leaves a successful one unmarked", async () => {
    await setup([
      { kind: "tool", name: "read", args: { file_path: "/nonexistent/never-written.md" } },
      { kind: "tool", name: "read", args: { path: join(process.cwd(), "package.json") } },
      { kind: "text", text: "One of those worked." },
    ]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "Read two things.",
      emit: (event) => events.push(event),
    });
    // What the live stream said, so the two cannot drift.
    const live = events
      .filter((event): event is Extract<PiMessagesEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end")
      .map((event) => [event.toolName, event.isError]);
    expect(live).toEqual([["read", true], ["read", false]]);

    const calls = (await host!.readTranscript("casper", "conv-1")).messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => (part as { type?: unknown }).type === "toolCall") as Array<{
        name: string;
        failed?: boolean;
        cwd?: string | null;
      }>;
    expect(calls.map((call) => [call.name, call.failed === true]))
      .toEqual([["read", true], ["read", false]]);
    expect(calls.map((call) => call.cwd)).toEqual([temp!.ownerHome, temp!.ownerHome]);
  });

  it("404s an unknown conversation id", async () => {
    await setup();
    await expect(host!.readTranscript("casper", "no-such-conversation"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("the first meeting", () => {
  /**
   * A ghost straight out of `GhostRegistry.create`: its character.md is the
   * untouched seed, which is the whole definition of "never been met".
   */
  async function setupSeeded() {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    provider = await startMockProvider({ script: [{ kind: "text", text: "hello" }] });
    const ghost = temp.registry.create("wisp");
    writeGhostModels(
      ghostPaths(ghost.dir).home,
      openAiCompatiblePreset({
        providerId: "ghost-local",
        baseUrl: provider.url,
        modelId: provider.modelId,
        apiKey: "not-needed",
      }),
    );
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
    });
    return ghost;
  }

  async function systemPromptFor(ghostName: string): Promise<string> {
    await host!.runTurn(ghostName, {
      sessionId: "conv-first",
      prompt: "Hello?",
      emit: () => {},
    });
    return provider!.requests[0]?.system ?? "";
  }

  it("interviews the owner while the character file is still the seed", async () => {
    await setupSeeded();
    const system = await systemPromptFor("wisp");
    expect(system).toContain("## First meeting");
    expect(system).toContain("one question at a time");
    // The interview ends by writing the approved character with a native file tool.
    expect(system).toContain("write it to `character.md`");
    expect(system).toContain("native file-writing tool");
    // And it is a ritual, not a gate.
    expect(system).toContain("Help with the owner's request first");
  });

  it("stops once the character file has been written", async () => {
    await setup();
    // `setup` seeds a ghost whose character.md the owner wrote.
    const system = await systemPromptFor("casper");
    expect(system).toContain("letterpress printer");
    expect(system).not.toContain("## First meeting");
  });
});
