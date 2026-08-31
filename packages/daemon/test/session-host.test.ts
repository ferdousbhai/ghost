/**
 * Session host against a mock provider. No real model is ever called.
 *
 * The properties under test are the ones the spike found are easy to lose:
 * sessions inside the ghost home, native OMP tools and discovery, a
 * Ghost persona layered onto the harness, and two ghosts staying separate
 * while answering at the same time in one process.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat as lstatAsync } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join, sep } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GhostMcpManager } from "../src/mcp-manager.js";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { LiveSessionControllerOptions } from "../src/live-voice.js";
import { createMCPToolName } from "../src/mcp-tool-names.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSessionMetadataPath } from "../src/claude-code.js";
import {
  ConversationMaintenance,
  maintenanceStatePath,
  type MaintenanceIdentity,
  type SettledMaintenanceTurn,
} from "../src/conversation-maintenance.js";
import { ghostPaths } from "../src/ghosts.js";
import {
  clearGhostModelRole,
  openAiCompatiblePreset,
  setChatModelRole,
  writeGhostModels,
  type GhostModelDefinition,
  type GhostModelsFile,
} from "../src/models.js";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
} from "../src/hooks.js";
import { LiveVoiceManager, type LiveVoiceStatus } from "../src/live-voice.js";
import {
  CollaborationManager,
  type CollaborationStatus,
} from "../src/collaboration.js";
import {
  PI_NATIVE_TOOL_NAMES,
  SessionHost,
  sessionFileNameFor,
  sessionKeyOf,
  type ConversationUpdatedEvent,
  type SessionHostOptions,
  type TrashedConversation,
} from "../src/session-host.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import type { PrincipalTaskServices } from "../src/principal-task-tools.js";
import type { TaskView } from "../src/tasks.js";
import { readPins, writePins } from "../src/pins.js";
import { ProjectBindingStore, projectBindingPath } from "../src/project-binding.js";
import { PROJECT_SCAN_MAX_ENTRIES } from "../src/project-resources.js";
import { piProjectSnapshotPaths } from "../src/project-snapshot.js";
import {
  readToolCwds,
  TOOL_CWDS_MAX_BYTES,
  toolCwdsPath,
  writeToolCwds,
} from "../src/tool-cwds.js";
import { homeOperationsFor } from "../src/home-operations.js";
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
        snapshot.push(`file:${relativePath}:${readFileSync(path).toString("base64")}`);
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
  script: Parameters<typeof startMockProvider>[0]["script"],
  options: Pick<
    SessionHostOptions,
    | "hooks"
    | "homeOperations"
    | "askTimeoutSeconds"
    | "liveVoice"
    | "collaboration"
    | "claudeCode"
    | "compaction"
    | "title"
    | "retention"
    | "sessionStartupProbe"
    | "toolCwdWriter"
    | "transactionProbe"
    | "transactionMarkerLstat"
    | "logger"
    | "maintenance"
    | "jobs"
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
    ...options,
  });
  return { dir, host, provider, temp };
}

async function modelSystemPrompt(
  sessionId: string,
  prompt = "Show that this conversation is ready.",
): Promise<string> {
  const before = provider?.requests.length ?? 0;
  await host!.runTurn("casper", { sessionId, prompt, emit: () => {} });
  const request = provider?.requests[before];
  if (!request) throw new Error("Expected the turn to reach the mock provider.");
  return request.system;
}

function testLiveVoice(startGate?: Promise<void>, startError?: Error): {
  manager: LiveVoiceManager;
  startEntered: Promise<void>;
} {
  let callbacks: LiveSessionControllerOptions["callbacks"] | undefined;
  let entered!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class TestLiveVoiceManager extends LiveVoiceManager {
    override async start(sessionKey: string, session: AgentSession): Promise<LiveVoiceStatus> {
      entered();
      if (startGate) await startGate;
      return super.start(sessionKey, session);
    }
  }
  const manager = new TestLiveVoiceManager({
    createController: (options) => {
      callbacks = options.callbacks;
      let muted = false;
      return {
        get phase() {
          return muted ? "muted" as const : "listening" as const;
        },
        get muted() {
          return muted;
        },
        async start() {
          if (startError) throw startError;
          callbacks?.onPhase("listening");
        },
        toggleMute() {
          muted = !muted;
        },
        async stop() {
          callbacks?.onTerminal();
        },
      };
    },
  });
  return { manager, startEntered };
}

function testWritableCollaboration(): {
  manager: CollaborationManager;
  session(): AgentSession;
  prompt(text: string): Promise<void>;
} {
  let collabSession: AgentSession | undefined;
  let promptGuest: ((text: string) => Promise<void>) | undefined;
  const manager = new CollaborationManager({
    createHost: (context) => {
      collabSession = context.session;
      promptGuest = context.promptGuest;
      return {
        link: "omp-collab://relay/room#key.write",
        webLink: "https://collab.example/room#key.write",
        viewLink: "omp-collab://relay/room#key",
        webViewLink: "https://collab.example/room#key",
        participants: [{ name: "owner", role: "host" as const }],
        async start() {},
        async stop() {},
      };
    },
  });
  return {
    manager,
    session() {
      if (!collabSession) throw new Error("test collaboration has not started");
      return collabSession;
    },
    prompt(text: string) {
      if (!promptGuest) throw new Error("test collaboration has not started");
      return promptGuest(text);
    },
  };
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

function recordMaintenanceTurns(
  finishTurn?: (turn: SettledMaintenanceTurn | undefined) => Promise<void>,
): {
  maintenance: NonNullable<SessionHostOptions["maintenance"]>;
  admitted: MaintenanceIdentity[];
  finished: Array<SettledMaintenanceTurn | undefined>;
  released: { count: number };
} {
  const admitted: MaintenanceIdentity[] = [];
  const finished: Array<SettledMaintenanceTurn | undefined> = [];
  const released = { count: 0 };
  const reservation = () => ({ drained: Promise.resolve(), release: () => {} });
  return {
    admitted,
    finished,
    released,
    maintenance: {
      admitOwnerAction: (identity) => {
        admitted.push(identity);
        return {
          ready: Promise.resolve(),
          finish: async (turn) => {
            finished.push(turn);
            await finishTurn?.(turn);
          },
          release: () => {
            released.count += 1;
          },
        };
      },
      reserveConversationDelete: reservation,
      completeConversationDelete: () => {},
      reserveGhostMove: reservation,
      completeGhostRename: async () => {},
      completeGhostDelete: () => {},
      beginShutdown: async () => {},
      disposeAll: async () => {},
    },
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

describe("SessionHost.open", () => {
  it("resumes a legacy Pi transcript at its historical cwd", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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
    expect(await host!.getProject("casper", "legacy-cwd", "pi"))
      .toMatchObject({ root: null, cwd: dir, reason: "legacy" });
  });

  it("bounds legacy Pi cwd inspection and rejects unsafe transcript shapes", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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
    await expect(host!.getProject("casper", "nul-cwd-legacy", "pi"))
      .resolves.toMatchObject({ cwd: temp!.ownerHome, reason: "default" });
    expect(directoryBytesSnapshot(paths.sessionDir)).toEqual(beforeNulRead);
    expect(existsSync(nulPrefix)).toBe(false);

    const sparse = writeTranscript("sparse-legacy", [header("sparse-legacy")]);
    truncateSync(sparse, 384 * 1024 * 1024);
    await expect(host!.getProject("casper", "sparse-legacy", "pi"))
      .resolves.toMatchObject({ cwd: dir, reason: "legacy" });

    const titleFirst = writeTranscript("title-first-legacy", [
      { type: "title", title: "Legacy title", source: "auto" },
      header("title-first-legacy"),
    ]);
    truncateSync(titleFirst, 384 * 1024 * 1024);
    await expect(host!.getProject("casper", "title-first-legacy", "pi"))
      .resolves.toMatchObject({ cwd: dir, reason: "legacy" });

    const longLine = join(paths.sessionDir, sessionFileNameFor("long-header"));
    writeFileSync(longLine, `${"x".repeat(64 * 1024 + 1)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    truncateSync(longLine, 384 * 1024 * 1024);
    await expect(host!.getProject("casper", "long-header", "pi"))
      .resolves.toMatchObject({ cwd: temp!.ownerHome, reason: "default" });

    const fifo = join(paths.sessionDir, sessionFileNameFor("fifo-header"));
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    await expect(host!.getProject("casper", "fifo-header", "pi"))
      .resolves.toMatchObject({ cwd: temp!.ownerHome, reason: "default" });

    const outside = join(temp!.root, "outside-session.jsonl");
    writeFileSync(outside, `${JSON.stringify(header("linked-header"))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const linked = join(paths.sessionDir, sessionFileNameFor("linked-header"));
    symlinkSync(outside, linked);
    await expect(host!.getProject("casper", "linked-header", "pi"))
      .resolves.toMatchObject({ cwd: temp!.ownerHome, reason: "default" });
    expect(readFileSync(outside, "utf8")).toContain('"cwd"');
  });

  it("starts unbound native tools at owner home without admitting home as a project", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    mkdirSync(join(temp!.ownerHome, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(temp!.ownerHome, "AGENTS.md"), "HOSTILE-OWNER-PROJECT");
    writeFileSync(
      join(temp!.ownerHome, ".omp", "extensions", "hostile.ts"),
      `export default (api: any) => api.registerTool({ name: "hostile_home_tool",
        label: "hostile", description: "hostile", parameters: { type: "object" },
        execute: async () => ({ content: [] }) });\n`,
    );
    writeFileSync(
      join(temp!.ownerHome, ".omp", "config.yml"),
      "retry:\n  modelFallback: false\n",
    );

    const handle = await host!.open("casper", "conv-owner-home");
    expect(handle.session.sessionManager.getCwd()).toBe(temp!.ownerHome);
    expect(handle.session.systemPrompt).not.toContain("HOSTILE-OWNER-PROJECT");
    expect(handle.session.getToolDefinition("hostile_home_tool")).toBeUndefined();
    expect(handle.sessionFile?.startsWith(ghostPaths(dir).sessionDir + sep)).toBe(true);
  });

  it("loads one trusted project snapshot while keeping executable project code disabled", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    const project = join(temp!.root, "trusted-project");
    const child = join(project, "packages", "app");
    mkdirSync(join(project, ".omp", "skills", "trusted-skill"), { recursive: true });
    mkdirSync(join(project, ".omp", "prompts"), { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
    mkdirSync(join(project, ".claude", "commands"), { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "TRUSTED-PROJECT-INSTRUCTION");
    writeFileSync(
      join(project, ".omp", "skills", "trusted-skill", "SKILL.md"),
      "---\nname: trusted-skill\ndescription: trusted\n---\n\nTrusted skill body.\n",
    );
    mkdirSync(join(project, ".omp", "skills", "invalid-skill"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "skills", "invalid-skill", "SKILL.md"),
      "---\nname: [unterminated\n---\n\nINVALID-SKILL-MUST-NOT-ENTER-PI\n",
    );
    writeFileSync(
      join(project, ".omp", "extensions", "blocked.ts"),
      `export default (api: any) => api.registerTool({ name: "blocked_project_tool",
        label: "blocked", description: "blocked", parameters: { type: "object" },
      execute: async () => ({ content: [] }) });\n`,
    );
    writeFileSync(
      join(project, ".omp", "prompts", "project-brief.md"),
      "---\ndescription: Summarize this project.\n---\n\nUse the trusted project brief.\n",
    );
    for (const [name, globs, interruptMode] of [
      ["rule-never", '"**/*.ts"', "never"],
      ["rule-prose", "['**/*.tsx', '**/*.jsx']", "prose-only"],
      ["rule-tool", undefined, "tool-only"],
      ["rule-always", undefined, "always"],
    ] as const) {
      writeFileSync(
        join(project, ".omp", "rules", `${name}.md`),
        `---\n${globs ? `globs: ${globs}\n` : ""}condition: ${name.toUpperCase()}\ninterruptMode: ${interruptMode}\n---\n\n${name} body\n`,
      );
    }
    writeFileSync(
      join(project, ".claude", "commands", "project-proof.md"),
      "---\ndescription: Proof the project.\n---\n\nUse the trusted proof command.\n",
    );
    const preview = await host!.previewProject("casper", "conv-project", "pi", project);
    expect(preview.resources.skills).toBe(1);
    expect(preview.resources.rules).toBe(4);
    expect(preview.warnings).toContainEqual(expect.stringContaining("skill metadata is invalid"));
    await host!.bindProject("casper", "conv-project", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    writeFileSync(join(project, "AGENTS.md"), "HOSTILE-LIVE-INSTRUCTION");

    const handle = await host!.open("casper", "conv-project");
    expect(handle.session.sessionManager.getCwd()).toBe(project);
    expect(handle.session.getToolDefinition("blocked_project_tool")).toBeUndefined();

    writeFileSync(
      join(project, ".omp", "skills", "trusted-skill", "SKILL.md"),
      "---\nname: trusted-skill\ndescription: replaced\n---\n\nHOSTILE-LIVE-SKILL\n",
    );
    for (const name of ["rule-never", "rule-prose", "rule-tool", "rule-always"]) {
      writeFileSync(join(project, ".omp", "rules", `${name}.md`), "MUTATED-LIVE-RULE");
    }
    await host!.runTurn("casper", {
      sessionId: "conv-project",
      prompt: "/skill:trusted-skill plate one",
      emit: () => {},
    });
    const projectSystem = provider!.requests.at(-1)!.system;
    expect(projectSystem).toContain("TRUSTED-PROJECT-INSTRUCTION");
    expect(projectSystem).not.toContain("HOSTILE-LIVE-INSTRUCTION");
    expect(projectSystem).not.toContain("INVALID-SKILL-MUST-NOT-ENTER-PI");
    expect(projectSystem).not.toContain("Trusted skill body");
    expect(projectSystem).not.toContain("Use the trusted project brief");
    expect(projectSystem).not.toContain("Use the trusted proof command");
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("/skill:trusted-skill plate one");
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).not.toContain("Trusted skill body");
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).not.toContain("HOSTILE-LIVE-SKILL");

    await host!.runTurn("casper", {
      sessionId: "conv-project",
      prompt: "/project-proof plate one",
      emit: () => {},
    });
    expect(JSON.stringify(provider!.requests.at(-1)?.messages))
      .not.toContain("Use the trusted proof command");
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("/project-proof");
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("plate one");

    const shellLikeText: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-project",
      prompt: "!cd escape",
      emit: (event) => shellLikeText.push(event),
    });
    expect(shellLikeText.at(-1)).toMatchObject({ type: "done" });
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("!cd escape");
    expect(await host!.getProject("casper", "conv-project", "pi"))
      .toMatchObject({ cwd: project, generation: 1 });

    await host!.runTurn("casper", {
      sessionId: "conv-project",
      prompt: "!pwd",
      emit: () => {},
    });
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("!pwd");

    await host!.runTurn("casper", {
      sessionId: "conv-project",
      prompt: "!cd packages/app",
      emit: () => {},
    });
    expect(JSON.stringify(provider!.requests.at(-1)?.messages)).toContain("!cd packages/app");
    expect(await host!.getProject("casper", "conv-project", "pi"))
      .toMatchObject({ root: project, cwd: project, relativeCwd: ".", generation: 1 });

    writeFileSync(join(project, "AGENTS.md"), "HOSTILE-AFTER-CACHE-CLOSE");
    await host!.close("casper", "conv-project");
    expect(((handle as { sessionDisposed?: boolean }).sessionDisposed === true)).toBe(true);
    const reopened = await host!.open("casper", "conv-project");
    expect(reopened.session.sessionManager.getCwd()).toBe(project);
    const reopenedSystem = await modelSystemPrompt("conv-project");
    expect(reopenedSystem).toContain("TRUSTED-PROJECT-INSTRUCTION");
    expect(reopenedSystem).toContain(`Current working directory: ${project}`);
    expect(reopenedSystem).not.toContain("HOSTILE-AFTER-CACHE-CLOSE");

    await host!.disposeAll();
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      offline: true,
    });
    const afterRestart = await host.open("casper", "conv-project");
    expect(afterRestart.session.sessionManager.getCwd()).toBe(project);
    const restartedSystem = await modelSystemPrompt("conv-project");
    expect(restartedSystem).toContain("TRUSTED-PROJECT-INSTRUCTION");
    expect(restartedSystem).not.toContain("HOSTILE-AFTER-CACHE-CLOSE");
  });

  it("keeps invalid UTF-8 project instructions, skills, and MCP out of Pi", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const project = join(temp!.root, "pi-invalid-project-utf8");
    const invalidSkill = join(project, ".omp", "skills", "invalid");
    const validSkill = join(project, ".omp", "skills", "valid");
    const namelessCollision = join(project, ".claude", "skills", "retained");
    const retainedGhostSkill = join(dir, "skills", "retained");
    mkdirSync(invalidSkill, { recursive: true });
    mkdirSync(validSkill, { recursive: true });
    mkdirSync(namelessCollision, { recursive: true });
    mkdirSync(retainedGhostSkill, { recursive: true });
    writeFileSync(
      join(project, ".omp", "AGENTS.md"),
      Buffer.concat([Buffer.from("INVALID-PI-INSTRUCTION-"), Buffer.from([0x80])]),
    );
    writeFileSync(join(project, "AGENTS.md"), "VALID-PI-FALLBACK-INSTRUCTION");
    writeFileSync(
      join(invalidSkill, "SKILL.md"),
      Buffer.concat([
        Buffer.from("---\nname: invalid\ndescription: invalid\n---\n\nINVALID-PI-SKILL-"),
        Buffer.from([0x80]),
      ]),
    );
    writeFileSync(
      join(validSkill, "SKILL.md"),
      "---\nname: valid\ndescription: valid\n---\n\nVALID-PI-SKILL",
    );
    writeFileSync(
      join(namelessCollision, "SKILL.md"),
      "---\ndescription: must not shadow the ghost skill\n---\n\nNAMELESS-PI-COLLISION",
    );
    writeFileSync(
      join(retainedGhostSkill, "SKILL.md"),
      "---\nname: retained\ndescription: ghost sibling\n---\n\nRETAINED-GHOST-SKILL",
    );
    writeFileSync(
      join(project, ".omp", "mcp.json"),
      Buffer.concat([
        Buffer.from('{"mcpServers":{"invalid":{"type":"stdio","command":"INVALID-PI-MCP-'),
        Buffer.from([0x80]),
        Buffer.from('"}}}'),
      ]),
    );
    const preview = await host!.previewProject("casper", "pi-invalid-utf8", "pi", project);
    expect(preview.resources).toMatchObject({ instructions: 1, skills: 1, mcpServers: 0 });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(".omp/AGENTS.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/skills/invalid/SKILL.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/mcp.json was ignored because it is not valid UTF-8"),
      expect.stringContaining("skill name or description is missing"),
    ]));
    await host!.bindProject("casper", "pi-invalid-utf8", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const opened = await host!.open("casper", "pi-invalid-utf8");
    const prompt = await modelSystemPrompt("pi-invalid-utf8");
    expect(prompt).toContain("VALID-PI-FALLBACK-INSTRUCTION");
    expect(opened.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["retained", "valid"]),
    );
    expect(opened.skills.find((skill) => skill.name === "retained")?.snapshotContent)
      .toContain("RETAINED-GHOST-SKILL");
    expect(prompt).not.toContain("NAMELESS-PI-COLLISION");
    expect(prompt).not.toContain("\uFFFD");
    expect(await host!.getProject("casper", "pi-invalid-utf8", "pi"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("serializes concurrent project transitions for one runtime conversation", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    const firstRoot = join(temp!.root, "project-one");
    const secondRoot = join(temp!.root, "project-two");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    const firstPreview = await host!.previewProject("casper", "conv-race", "pi", firstRoot);
    const secondPreview = await host!.previewProject("casper", "conv-race", "pi", secondRoot);
    const first = host!.bindProject("casper", "conv-race", "pi", {
      root: firstRoot,
      trustToken: firstPreview.trustToken,
      expectedGeneration: 0,
    });
    await expect(host!.bindProject("casper", "conv-race", "pi", {
      root: secondRoot,
      trustToken: secondPreview.trustToken,
      expectedGeneration: 0,
    })).rejects.toMatchObject({ code: "session_busy" });
    await first;
    expect(await host!.getProject("casper", "conv-race", "pi"))
      .toMatchObject({ root: firstRoot, generation: 1 });
  });

  it("preserves a live Pi runtime when project validation, identity, or persistence fails", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    writeMcpFixture(dir);
    const project = join(temp!.root, "failure-atomic-project");
    mkdirSync(project);
    const preview = await host!.previewProject("casper", "failure-atomic", "pi", project);
    await host!.bindProject("casper", "failure-atomic", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const opened = await host!.open("casper", "failure-atomic");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();
    const expectRuntimeUnchanged = async () => {
      const cached = (host as unknown as {
        sessions: Map<string, { session: AgentSession }>;
      }).sessions.get(sessionKeyOf("casper", "failure-atomic"));
      expect(cached?.session).toBe(opened.session);
      expect(cached?.session.getToolDefinition(toolName)).toBeDefined();
      expect(JSON.parse(readFileSync(
        projectBindingPath(ghostPaths(dir).sessionDir, "pi", "failure-atomic"),
        "utf8",
      ))).toMatchObject({ root: project, generation: 1 });
    };

    await expect(host!.bindProject("casper", "failure-atomic", "pi", {
      root: null,
      cwd: "relative",
      expectedGeneration: 1,
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expectRuntimeUnchanged();

    const movedProject = `${project}-original`;
    renameSync(project, movedProject);
    mkdirSync(project);
    await expect(host!.reloadProject("casper", "failure-atomic", "pi", 1))
      .rejects.toMatchObject({ code: "project_not_trusted", status: 403 });
    await expectRuntimeUnchanged();
    rmSync(project, { recursive: true, force: true });
    renameSync(movedProject, project);

    const bindings = (host as unknown as { projectBindings: ProjectBindingStore }).projectBindings;
    vi.spyOn(bindings, "write").mockRejectedValueOnce(new Error("injected sidecar failure"));
    await expect(host!.reloadProject("casper", "failure-atomic", "pi", 1))
      .rejects.toThrow("injected sidecar failure");
    await expectRuntimeUnchanged();
  });

  it("commits bind and reload before retrying failed Pi teardown without serving a stale cache", async () => {
    class FailingOnceCollaborationManager extends CollaborationManager {
      failNext = false;
      stopAttempts = 0;

      override async stop(sessionKey: string, reason?: string): Promise<CollaborationStatus> {
        this.stopAttempts += 1;
        if (this.failNext) {
          this.failNext = false;
          throw new Error("injected background teardown failure");
        }
        return super.stop(sessionKey, reason);
      }
    }
    const collaboration = new FailingOnceCollaborationManager();
    const logger = recordingLogger();
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      collaboration,
      logger,
    });
    writeMcpFixture(dir);
    const firstProject = join(temp!.root, "cleanup-first-project");
    const secondProject = join(temp!.root, "cleanup-second-project");
    mkdirSync(firstProject);
    mkdirSync(secondProject);
    writeFileSync(join(firstProject, "AGENTS.md"), "FIRST-PROJECT-SNAPSHOT");
    writeFileSync(join(secondProject, "AGENTS.md"), "SECOND-PROJECT-SNAPSHOT");
    const firstPreview = await host!.previewProject(
      "casper",
      "post-commit-cleanup",
      "pi",
      firstProject,
    );
    await host!.bindProject("casper", "post-commit-cleanup", "pi", {
      root: firstProject,
      trustToken: firstPreview.trustToken,
      expectedGeneration: 0,
    });

    const internals = host as unknown as {
      sessions: Map<string, { session: AgentSession }>;
      cleanupRetries: Map<string, { session: AgentSession }>;
    };
    const sessionKey = sessionKeyOf("casper", "post-commit-cleanup");
    const injectOneCleanupFailureSet = (handle: Awaited<ReturnType<SessionHost["open"]>>) => {
      const mcp = (handle as typeof handle & {
        mcp: { manager: { disconnectAll(): Promise<void> } };
      }).mcp;
      const originalDisconnect = mcp.manager.disconnectAll.bind(mcp.manager);
      let disconnectFailure = true;
      const disconnect = vi.spyOn(mcp.manager, "disconnectAll").mockImplementation(async () => {
        if (disconnectFailure) {
          disconnectFailure = false;
          throw new Error("injected MCP teardown failure");
        }
        await originalDisconnect();
      });
      const originalAbort = handle.session.abort.bind(handle.session);
      let abortFailure = true;
      const abort = vi.spyOn(handle.session, "abort").mockImplementation(async () => {
        if (abortFailure) {
          abortFailure = false;
          throw new Error("injected session abort failure");
        }
        await originalAbort();
      });
      const originalDispose = handle.session.dispose.bind(handle.session);
      let disposeFailure = true;
      const dispose = vi.spyOn(handle.session, "dispose").mockImplementation(async () => {
        if (disposeFailure) {
          disposeFailure = false;
          throw new Error("injected session teardown failure");
        }
        await originalDispose();
      });
      const collaborationAttempts = collaboration.stopAttempts;
      collaboration.failNext = true;
      return { abort, collaborationAttempts, disconnect, dispose };
    };
    const expectCommittedCleanupRetry = async (
      oldSession: AgentSession,
      expectedGeneration: number,
      expectedRoot: string,
      spies: ReturnType<typeof injectOneCleanupFailureSet>,
    ) => {
      expect(internals.sessions.has(sessionKey)).toBe(false);
      expect(internals.cleanupRetries.get(sessionKey)?.session).toBe(oldSession);
      expect(host!.cachedSessionCount).toBe(0);
      expect(await host!.getProject("casper", "post-commit-cleanup", "pi"))
        .toMatchObject({ generation: expectedGeneration, root: expectedRoot });
      expect(spies.disconnect).toHaveBeenCalledOnce();
      expect(spies.abort).toHaveBeenCalledOnce();
      expect(spies.dispose).toHaveBeenCalledOnce();
      expect(collaboration.stopAttempts).toBe(spies.collaborationAttempts + 1);

      const reopened = await host!.open("casper", "post-commit-cleanup");
      expect(reopened.session).not.toBe(oldSession);
      expect(internals.cleanupRetries.has(sessionKey)).toBe(false);
      expect(spies.disconnect).toHaveBeenCalledTimes(2);
      expect(spies.abort).toHaveBeenCalledTimes(2);
      expect(spies.dispose).toHaveBeenCalledTimes(2);
      expect(collaboration.stopAttempts).toBe(spies.collaborationAttempts + 2);
      return reopened;
    };

    const first = await host!.open("casper", "post-commit-cleanup");
    const firstFailures = injectOneCleanupFailureSet(first);
    const secondPreview = await host!.previewProject(
      "casper",
      "post-commit-cleanup",
      "pi",
      secondProject,
    );
    await expect(host!.bindProject("casper", "post-commit-cleanup", "pi", {
      root: secondProject,
      trustToken: secondPreview.trustToken,
      expectedGeneration: 1,
    })).resolves.toMatchObject({ generation: 2, root: secondProject });
    const second = await expectCommittedCleanupRetry(
      first.session,
      2,
      secondProject,
      firstFailures,
    );
    expect(await modelSystemPrompt("post-commit-cleanup"))
      .toContain("SECOND-PROJECT-SNAPSHOT");

    writeFileSync(join(secondProject, "AGENTS.md"), "RELOADED-PROJECT-SNAPSHOT");
    const reloadFailures = injectOneCleanupFailureSet(second);
    await expect(host!.reloadProject("casper", "post-commit-cleanup", "pi", 2))
      .resolves.toMatchObject({ generation: 3, root: secondProject });
    await expectCommittedCleanupRetry(
      second.session,
      3,
      secondProject,
      reloadFailures,
    );
    expect(await modelSystemPrompt("post-commit-cleanup"))
      .toContain("RELOADED-PROJECT-SNAPSHOT");
    expect(logger.records.filter((entry) =>
      entry.message === "committed project session cleanup is pending retry"
      && entry.fields?.code === "project_cleanup_pending")).toHaveLength(2);
  });

  it.each(["pi", "claude-code"] as const)(
    "abandons and idempotently forgets an unpublished %s project draft",
    async (runtime) => {
      const { dir } = await setup([{ kind: "text", text: "unused" }]);
      const id = `abandon-${runtime}`;
      const project = join(temp!.root, `abandon-${runtime}-project`);
      mkdirSync(project);
      writeFileSync(join(project, "AGENTS.md"), "UNPUBLISHED-DRAFT-SNAPSHOT");
      const preview = await host!.previewProject("casper", id, runtime, project);
      await host!.bindProject("casper", id, runtime, {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      const sessionDir = ghostPaths(dir).sessionDir;
      if (runtime === "pi") {
        await writeToolCwds(sessionDir, id, new Map([["draft-tool", temp!.ownerHome]]));
      }
      const binding = projectBindingPath(sessionDir, runtime, id);
      const snapshots = runtime === "pi" ? await piProjectSnapshotPaths(sessionDir, id) : [];
      const cwd = toolCwdsPath(sessionDir, id);
      expect(existsSync(binding)).toBe(true);
      if (runtime === "pi") {
        expect(snapshots).toHaveLength(1);
        expect(existsSync(cwd)).toBe(true);
      }

      await expect(host!.abandonProjectDraft("casper", id, runtime)).resolves.toEqual({
        ok: true,
        id: `${runtime}:${id}`,
        conversationId: id,
        runtime,
        abandoned: true,
      });
      expect(existsSync(binding)).toBe(false);
      expect(snapshots.every((path) => !existsSync(path))).toBe(true);
      expect(existsSync(cwd)).toBe(false);
      expect(await host!.getProject("casper", id, runtime)).toMatchObject({
        root: null,
        generation: 0,
      });
      await expect(host!.abandonProjectDraft("casper", id, runtime)).resolves.toMatchObject({
        abandoned: false,
      });

      const nextPreview = await host!.previewProject("casper", id, runtime, project);
      expect(nextPreview.trustToken).toEqual(expect.any(String));
      await expect(host!.abandonProjectDraft("casper", id, runtime)).resolves.toMatchObject({
        abandoned: true,
      });
      await expect(host!.bindProject("casper", id, runtime, {
        root: project,
        trustToken: nextPreview.trustToken,
        expectedGeneration: 0,
      })).rejects.toMatchObject({ code: "trust_token_invalid", status: 403 });
    },
  );

  it("retains an unpublished draft cleanup marker across failure and refuses published state", async () => {
    let rejectCleanup = true;
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      transactionProbe: (stage) => {
        if (rejectCleanup && stage === "draft-abandon-unlink") {
          throw new Error("injected draft cleanup failure");
        }
      },
    });
    const project = join(temp!.root, "draft-cleanup-project");
    mkdirSync(project);
    const bindDraft = async (id: string) => {
      const preview = await host!.previewProject("casper", id, "pi", project);
      await host!.bindProject("casper", id, "pi", {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
    };
    await bindDraft("cleanup-pending");
    const sessionDir = ghostPaths(dir).sessionDir;
    const pendingStem = sessionFileNameFor("cleanup-pending").slice(0, -".jsonl".length);
    const marker = join(
      sessionDir,
      `.ghost-draft-abandon-${pendingStem}.pi.pending.json`,
    );
    await expect(host!.abandonProjectDraft("casper", "cleanup-pending", "pi"))
      .rejects.toThrow("injected draft cleanup failure");
    expect(existsSync(marker)).toBe(true);
    await expect(host!.getProject("casper", "cleanup-pending", "pi"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    rejectCleanup = false;
    await expect(host!.abandonProjectDraft("casper", "cleanup-pending", "pi"))
      .resolves.toMatchObject({ abandoned: true });
    expect(existsSync(marker)).toBe(false);

    await bindDraft("published-draft");
    await host!.runTurn("casper", {
      sessionId: "published-draft",
      prompt: "publish this conversation",
      emit: () => {},
    });
    const binding = projectBindingPath(sessionDir, "pi", "published-draft");
    const bindingBytes = readFileSync(binding, "utf8");
    await expect(host!.abandonProjectDraft("casper", "published-draft", "pi"))
      .rejects.toMatchObject({ code: "project_draft_published", status: 409 });
    expect(readFileSync(binding, "utf8")).toBe(bindingBytes);
  });

  it.each(["draft-abandon-fsync", "draft-abandon-complete"] as const)(
    "retries unpublished cleanup after %s fails",
    async (blockedStage) => {
      let rejectStage = true;
      const { dir } = await setup([{ kind: "text", text: "unused" }], {
        transactionProbe: (stage) => {
          if (rejectStage && stage === blockedStage) {
            throw new Error(`injected ${blockedStage} failure`);
          }
        },
      });
      const id = `draft-${blockedStage}`;
      const project = join(temp!.root, id);
      mkdirSync(project);
      const preview = await host!.previewProject("casper", id, "pi", project);
      await host!.bindProject("casper", id, "pi", {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      const sessionDir = ghostPaths(dir).sessionDir;
      const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
      const marker = join(sessionDir, `.ghost-draft-abandon-${stem}.pi.pending.json`);
      const receipt = join(sessionDir, `.ghost-draft-abandon-${stem}.pi.complete.json`);
      await expect(host!.abandonProjectDraft("casper", id, "pi"))
        .rejects.toThrow(`injected ${blockedStage} failure`);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(receipt)).toBe(false);
      await expect(host!.getProject("casper", id, "pi"))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });

      rejectStage = false;
      await expect(host!.abandonProjectDraft("casper", id, "pi"))
        .resolves.toMatchObject({ abandoned: true });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(receipt)).toBe(true);
      await expect(host!.abandonProjectDraft("casper", id, "pi"))
        .resolves.toMatchObject({ abandoned: false });
    },
  );

  it("rejects draft abandonment while fork or delete ownership exists", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    const project = join(temp!.root, "draft-transaction-project");
    mkdirSync(project);
    const sessionDir = ghostPaths(dir).sessionDir;
    for (const [id, kind] of [["fork-owned-draft", "fork"], ["delete-owned-draft", "delete"]] as const) {
      const preview = await host!.previewProject("casper", id, "pi", project);
      await host!.bindProject("casper", id, "pi", {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
      const marker = kind === "fork"
        ? join(sessionDir, `.ghost-fork-${stem}.pending.json`)
        : join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
      writeFileSync(marker, "{}", { mode: 0o600 });
      await expect(host!.abandonProjectDraft("casper", id, "pi"))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(existsSync(projectBindingPath(sessionDir, "pi", id))).toBe(true);
      unlinkSync(marker);
    }
    const invalidId = "invalid-abandon-marker";
    const invalidPreview = await host!.previewProject("casper", invalidId, "pi", project);
    await host!.bindProject("casper", invalidId, "pi", {
      root: project,
      trustToken: invalidPreview.trustToken,
      expectedGeneration: 0,
    });
    const invalidStem = sessionFileNameFor(invalidId).slice(0, -".jsonl".length);
    const invalidMarker = join(
      sessionDir,
      `.ghost-draft-abandon-${invalidStem}.pi.pending.json`,
    );
    writeFileSync(invalidMarker, "{}", { mode: 0o600 });
    await expect(host!.abandonProjectDraft("casper", invalidId, "pi"))
      .rejects.toMatchObject({ code: "project_draft_cleanup_pending", status: 500 });
    expect(existsSync(projectBindingPath(sessionDir, "pi", invalidId))).toBe(true);
    unlinkSync(invalidMarker);

    const outsideMarker = join(temp!.root, "outside-draft-marker.json");
    writeFileSync(outsideMarker, "{}\n", { mode: 0o600 });
    symlinkSync(outsideMarker, invalidMarker);
    await expect(host!.abandonProjectDraft("casper", invalidId, "pi"))
      .rejects.toMatchObject({ code: "project_draft_cleanup_pending", status: 500 });
    expect(existsSync(projectBindingPath(sessionDir, "pi", invalidId))).toBe(true);
    unlinkSync(invalidMarker);

    execFileSync("mkfifo", [invalidMarker]);
    const timeout = Symbol("timeout");
    const fifo = await Promise.race([
      host!.abandonProjectDraft("casper", invalidId, "pi")
        .then(() => "resolved", () => "rejected"),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 500)),
    ]);
    expect(fifo).toBe("rejected");
    expect(existsSync(projectBindingPath(sessionDir, "pi", invalidId))).toBe(true);
    unlinkSync(invalidMarker);

    writeFileSync(invalidMarker, "x".repeat(1_048_577), { mode: 0o600 });
    await expect(host!.abandonProjectDraft("casper", invalidId, "pi"))
      .rejects.toMatchObject({ code: "project_draft_cleanup_pending", status: 500 });
    expect(existsSync(projectBindingPath(sessionDir, "pi", invalidId))).toBe(true);
    unlinkSync(invalidMarker);
    await expect(host!.abandonProjectDraft("casper", "never-created", "pi"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("rejects opposite-runtime turns, opens, and closes after a project transition wins admission", async () => {
    const { dir } = await setup([{ kind: "text", text: "must not run" }]);
    await host!.disposeAll();
    const bindingStore = new ProjectBindingStore({
      ownerHome: temp!.ownerHome,
      trustPath: join(temp!.root, "state", "opposite-transition-trust.json"),
    });
    const originalWrite = bindingStore.write.bind(bindingStore);
    let writeGate: {
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    } | null = null;
    vi.spyOn(bindingStore, "write").mockImplementation(async (input) => {
      const gate = writeGate;
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return originalWrite(input);
    });
    let claudeQueries = 0;
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      projectBindings: bindingStore,
      offline: true,
      claudeCode: {
        binaryPath: process.execPath,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        createQuery: () => {
          claudeQueries += 1;
          throw new Error("Claude query must not start during a project transition");
        },
      },
    });
    const project = join(temp!.root, "opposite-transition-project");
    mkdirSync(project);

    for (const [transitionRuntime, selectedRuntime, id] of [
      ["pi", "claude-code", "pi-transition"],
      ["claude-code", "pi", "claude-transition"],
    ] as const) {
      if (selectedRuntime === "claude-code") {
        setChatModelRole(ghostPaths(dir).home, "claude-code", "default");
      } else {
        clearGhostModelRole(ghostPaths(dir).home, "chat_model");
      }
      const preview = await host.previewProject("casper", id, transitionRuntime, project);
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      writeGate = gate;
      const binding = host.bindProject("casper", id, transitionRuntime, {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      await gate.entered.promise;

      await expect(host.runTurn("casper", { sessionId: id, prompt: "race", emit: () => {} }))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      await expect(host.open("casper", id))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      await expect(host.close("casper", id))
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(provider!.requests).toHaveLength(0);
      expect(claudeQueries).toBe(0);

      writeGate = null;
      gate.release.resolve();
      await expect(binding).resolves.toMatchObject({ root: project, generation: 1 });
    }
  });

  it("blocks preview, bind, and reload during runtime-neutral turn admission", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    await host!.disposeAll();
    const bindingStore = new ProjectBindingStore({
      ownerHome: temp!.ownerHome,
      trustPath: join(temp!.root, "state", "turn-admission-trust.json"),
    });
    const project = join(temp!.root, "turn-admission-project");
    mkdirSync(project);
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      projectBindings: bindingStore,
      offline: true,
    });
    const trusted = await host.previewProject("casper", "admitted", "pi", project);
    await host.bindProject("casper", "admitted", "pi", {
      root: project,
      trustToken: trusted.trustToken,
      expectedGeneration: 0,
    });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admittedHost = host as unknown as {
      runAdmittedTurn(ghostName: string, options: unknown): Promise<void>;
    };
    vi.spyOn(admittedHost, "runAdmittedTurn").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const previewSpy = vi.spyOn(bindingStore, "preview");
    const writeSpy = vi.spyOn(bindingStore, "write");
    const turn = host.runTurn("casper", {
      sessionId: "admitted",
      prompt: "route later",
      emit: () => {},
    });
    await entered.promise;

    await expect(host.previewProject("casper", "admitted", "pi", project))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host.bindProject("casper", "admitted", "pi", {
      root: null,
      expectedGeneration: 1,
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host.reloadProject("casper", "admitted", "pi", 1))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(previewSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();

    release.resolve();
    await turn;
  });

  it("blocks either runtime's project transition while a Pi session tears down", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const project = join(temp!.root, "teardown-project");
    mkdirSync(project);
    const trusted = await host!.previewProject("casper", "teardown", "pi", project);
    await host!.bindProject("casper", "teardown", "pi", {
      root: project,
      trustToken: trusted.trustToken,
      expectedGeneration: 0,
    });
    const opened = await host!.open("casper", "teardown");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalDispose = opened.session.dispose.bind(opened.session);
    vi.spyOn(opened.session, "dispose").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await originalDispose();
    });
    const closing = host!.close("casper", "teardown");
    await entered.promise;

    await expect(host!.previewProject("casper", "teardown", "pi", project))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.previewProject("casper", "teardown", "claude-code", project))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });

    release.resolve();
    await closing;
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
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
    const handle = await host!.open("casper", "conv-1");
    expect(handle.session.model?.id).toBe(provider!.modelId);
    expect(handle.session.model?.provider).toBe("ghost-local");
  });

  it("inherits OMP's native tools and adds Ghost's own capabilities", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("task");
    expect(handle.session.getToolDefinition("task")).toBeUndefined();
    for (const name of ["ghost_memory_write", "ghost_browser", "ghost_desktop"]) {
      expect(handle.session.getToolDefinition(name), `${name} must be available`).toBeDefined();
    }
  });

  it("attaches durable coding tools to a Pi principal before its first open", async () => {
    await setup([{ kind: "text", text: "ready" }]);
    const unavailable = async () => {
      throw new Error("not called by this provider fixture");
    };
    const create = vi.fn(async (
      input: Parameters<PrincipalTaskServices["tasks"]["create"]>[0],
    ): Promise<TaskView> => ({
      version: 3,
      id: "task-11111111-1111-4111-8111-111111111111",
      parent: input.parent,
      harness: input.harness,
      agent: input.agent ?? null,
      task: input.task,
      root: temp!.ownerHome,
      cwd: input.cwd ?? temp!.ownerHome,
      workspace: {
        strategy: "in-place",
        state: "active",
        root: temp!.ownerHome,
        cwd: input.cwd ?? temp!.ownerHome,
        branch: null,
        baseCommit: null,
        headCommit: null,
        review: "not_applicable",
        notice: "Running in place.",
      },
      state: "queued",
      createdAt: "2026-08-30T09:00:00.000Z",
      updatedAt: "2026-08-30T09:00:00.000Z",
      nativeSessionId: null,
      result: null,
      resultTruncated: false,
      error: null,
      events: [],
      eventsTruncated: false,
    }));
    const services = {
      tasks: {
        create,
        list: async () => ({ tasks: [], skipped: [] }),
        get: unavailable,
        send: unavailable,
        cancel: unavailable,
      },
    } as unknown as PrincipalTaskServices;
    host!.attachTaskServices(services);

    const prompt = await modelSystemPrompt("durable-task-tools");
    const handle = await host!.open("casper", "durable-task-tools");
    expect(handle.session.getActiveToolNames()).toEqual(expect.arrayContaining([
      "task",
      "task_list",
      "task_get",
      "task_send",
      "task_cancel",
    ]));
    expect(prompt).toContain("# Delegation");
    expect(prompt).not.toContain("Claude agents here:");
    expect(prompt).toContain("Current working directory:");
    expect(prompt).toContain("- task");
    const taskTool = handle.session.getToolDefinition("task");
    if (!taskTool) throw new Error("task tool was not registered");
    await taskTool.execute(
      "task-call",
      { harness: "codex", task: "Implement it." },
      undefined,
      undefined,
      { cwd: temp!.ownerHome } as never,
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ghostName: "casper",
      parent: {
        id: "pi:durable-task-tools",
        runtime: "pi",
        conversationId: "durable-task-tools",
      },
      harness: "codex",
      task: "Implement it.",
    }));
    expect(() => host!.attachTaskServices({
      ...services,
      tasks: { ...services.tasks },
    }))
      .toThrow(/already attached/);
  });

  it("reuses one session per conversation id and separates different ids", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    const first = await host!.open("casper", "conv-1");
    const again = await host!.open("casper", "conv-1");
    const other = await host!.open("casper", "conv-2");

    expect(again.session).toBe(first.session);
    expect(other.session).not.toBe(first.session);
    expect(other.sessionFile).not.toBe(first.sessionFile);
  });

  it("loads executable hooks from the visible ghost home", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const extDir = join(dir, "hooks", "pre");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "project.ts"),
      `export default function (pi: any) {
         pi.registerTool({ name: "project_tool", label: "project", description: "project tool",
           parameters: { type: "object", properties: {} },
           execute: async () => ({ content: [] }) });
       }\n`,
      "utf8",
    );
    const handle = await host!.open("casper", "conv-1");
    expect(handle.session.getToolDefinition("project_tool")).toBeDefined();
  });

  it("loads pinned ghost hook factories without importing Ghost custom-code tools", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const toolsDir = join(dir, "tools");
    const hooksDir = join(dir, "hooks", "pre");
    const imported = join(temp!.root, "evil-tool-imported");
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(toolsDir, "evil.ts"), `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(imported)}, "IMPORTED");
      export default function () {
      return { name: "evil_custom_tool", description: "must stay disabled",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [] }) };
    }\n`);
    writeFileSync(join(hooksDir, "bash.ts"), `export default function (pi: any) {
      pi.registerTool({ name: "ghost_owned_hook_tool", label: "hook", description: "hook root",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [] }) });
    }\n`);

    const handle = await host!.open("casper", "ghost-package-roots");
    expect(handle.session.getToolDefinition("evil_custom_tool")).toBeUndefined();
    expect(handle.session.getToolDefinition("ghost_owned_hook_tool")).toBeDefined();
    expect(handle.session.getToolDefinition("hostile_home_tool")).toBeUndefined();
    expect(existsSync(imported)).toBe(false);
  });

  it("loads only visible ghost MCP while unbound, never ambient coding-agent MCP", async () => {
    const logger = recordingLogger();
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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
      expect(mcp?.sources.get(name)).toMatchObject({
        level: "user",
        path: join(dir, "mcp.json"),
      });
      expect(mcp?.manager.getServerConfig(name)).toMatchObject({
        command: process.execPath,
        args: [serverPath],
        cwd: dir,
      });
    }
  });

  it("redacts an immediate hosted MCP HTTP connection failure from daemon and OMP logs", async () => {
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
      const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
      const { dir } = await setup([{ kind: "text", text: "hello" }], {
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

  it("discovers visible skills without enabling ghost agents", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    mkdirSync(join(dir, "skills", "inking"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
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
    const handle = await host!.open("casper", "conv-visible-artifacts");

    expect(handle.skills.map((skill) => skill.name)).toContain("inking");
    // Custom definitions can still appear in artifact previews, but neither
    // they nor an ambient OMP definition can activate Pi subagents in phase 1.
    expect(handle.session.getToolDefinition("task")).toBeUndefined();
    // This harness disables machine roots unless a test opts into them.
    expect(handle.skills.map((skill) => skill.name)).toEqual(["inking"]);
  });

  it("admits ambient machine skills without a hardcoded name allowlist", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    mkdirSync(join(temp!.ownerHome, ".claude"), { recursive: true });
    mkdirSync(join(temp!.ownerHome, ".agents"), { recursive: true });
    writeFileSync(join(temp!.ownerHome, ".claude", "CLAUDE.md"), "HOSTILE-CLAUDE-IDENTITY");
    writeFileSync(join(temp!.ownerHome, ".agents", "AGENTS.md"), "HOSTILE-AGENTS-IDENTITY");
    mkdirSync(ghostPaths(dir).agentDir, { recursive: true });
    writeFileSync(
      join(ghostPaths(dir).agentDir, "APPEND_SYSTEM.md"),
      "HOSTILE-PI-APPEND-SYSTEM",
    );

    const handle = await host!.open("casper", "conv-owner-context");
    const prompt = await modelSystemPrompt("conv-owner-context");
    expect(prompt).not.toContain("HOSTILE-CLAUDE-IDENTITY");
    expect(prompt).not.toContain("HOSTILE-AGENTS-IDENTITY");
    expect(prompt).not.toContain("HOSTILE-PI-APPEND-SYSTEM");
    expect(handle.session.systemPrompt).not.toContain("HOSTILE-PI-APPEND-SYSTEM");
  });

  it("discovers visible Ghost context without a principal-only skill command", async () => {
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
    expect(JSON.stringify(provider!.requests[0]?.messages)).not.toContain(
      "Check the tympan and packing",
    );
    expect(JSON.stringify(provider!.requests[0]?.messages)).toContain("/skill:press-review");
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
  it("reserves maintenance synchronously and disposes it only after its real drain", async () => {
    const drained = deferred();
    let beginCalls = 0;
    let disposeCalls = 0;
    const reservation = () => ({ drained: Promise.resolve(), release: () => {} });
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      admitOwnerAction: () => ({
        ready: Promise.resolve(),
        finish: async () => {},
        release: () => {},
      }),
      reserveConversationDelete: reservation,
      completeConversationDelete: () => {},
      reserveGhostMove: reservation,
      completeGhostRename: async () => {},
      completeGhostDelete: () => {},
      beginShutdown: () => {
        beginCalls += 1;
        return drained.promise;
      },
      disposeAll: async () => {
        disposeCalls += 1;
      },
    };
    await setup([{ kind: "text", text: "unused" }], { maintenance });

    host!.beginShutdown();
    expect(beginCalls).toBe(1);
    const disposing = host!.disposeAll();
    await Promise.resolve();
    expect(disposeCalls).toBe(0);
    drained.resolve();
    await disposing;
    expect(disposeCalls).toBe(1);
  });

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
    const stopEntered = deferred();
    const releaseStop = deferred();
    class BlockingVoiceManager extends LiveVoiceManager {
      override async stop(sessionKey: string): Promise<LiveVoiceStatus> {
        stopEntered.resolve();
        await releaseStop.promise;
        return super.stop(sessionKey);
      }
    }
    await setup([{ kind: "text", text: "unused" }], {
      liveVoice: new BlockingVoiceManager(),
    });
    await host!.open("casper", "conv-closing-home");

    const closing = host!.close("casper", "conv-closing-home");
    await stopEntered.promise;
    await expect(host!.renameGhost("casper", "renamed"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    await expect(host!.deleteGhost("casper"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });

    releaseStop.resolve();
    await closing;
  });

  it("disposes Pi and its runtime even when voice and collaboration cleanup fail", async () => {
    class FailingVoiceManager extends LiveVoiceManager {
      private failNext = true;

      override async stop(sessionKey: string): Promise<LiveVoiceStatus> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("voice teardown failed");
        }
        return super.stop(sessionKey);
      }
    }
    class FailingCollaborationManager extends CollaborationManager {
      private failNext = true;

      override async stop(sessionKey: string): Promise<CollaborationStatus> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("collaboration teardown failed");
        }
        return super.stop(sessionKey);
      }
    }
    await setup([{ kind: "text", text: "unused" }], {
      liveVoice: new FailingVoiceManager(),
      collaboration: new FailingCollaborationManager(),
    });
    const handle = await host!.open("casper", "conv-failed-close");
    const runtime = authRuntimeForTest(handle);
    const closeRuntime = vi.spyOn(runtime, "close");

    await expect(host!.close("casper", "conv-failed-close"))
      .rejects.toBeInstanceOf(AggregateError);
    expect(((handle as { sessionDisposed?: boolean }).sessionDisposed === true)).toBe(true);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(host!.cachedSessionCount).toBe(0);

    await expect(host!.close("casper", "conv-failed-close")).resolves.toBeUndefined();
    expect(closeRuntime).toHaveBeenCalledOnce();
  });

  it("retries every transient close stage before admitting a replacement session", async () => {
    const voice = testLiveVoice();
    const collaboration = testWritableCollaboration();
    let startups = 0;
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      liveVoice: voice.manager,
      collaboration: collaboration.manager,
      sessionStartupProbe: (stage) => {
        if (stage === "model-runtime") startups += 1;
      },
    });
    writeMcpFixture(dir);
    const conversationId = "conv-retry-all-cleanup";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    await host!.collaborationAction("casper", conversationId, {
      action: "start",
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: true,
    });
    const internals = host as unknown as {
      cleanupRetries: Map<string, typeof opened>;
    };
    const hostedMcp = opened as typeof opened & {
      mcp: { manager: { disconnectAll(): Promise<void> } };
    };
    const oldRuntime = authRuntimeForTest(opened);
    const closeRuntime = vi.spyOn(oldRuntime, "close");
    const originalVoiceStop = voice.manager.stop.bind(voice.manager);
    const voiceStop = vi.spyOn(voice.manager, "stop")
      .mockRejectedValueOnce(new Error("transient voice stop"))
      .mockImplementation((sessionKey) => originalVoiceStop(sessionKey));
    const originalCollaborationStop = collaboration.manager.stop.bind(collaboration.manager);
    const collaborationStop = vi.spyOn(collaboration.manager, "stop")
      .mockRejectedValueOnce(new Error("transient collaboration stop"))
      .mockImplementation((sessionKey, reason) => originalCollaborationStop(sessionKey, reason));
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
    expect(voiceStop.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(collaborationStop).toHaveBeenCalledTimes(2);
    expect(abort.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(voice.manager.status(key).active).toBe(false);
    expect(collaboration.manager.status(key).active).toBe(false);
    expect(replacement.session.getToolDefinition("mcp__reload_fixture_reload_echo")).toBeDefined();
  });

  it("keeps permanently failing cleanup as a typed replacement-open gate", async () => {
    const voice = testLiveVoice();
    const collaboration = testWritableCollaboration();
    let startups = 0;
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      liveVoice: voice.manager,
      collaboration: collaboration.manager,
      sessionStartupProbe: (stage) => {
        if (stage === "model-runtime") startups += 1;
      },
    });
    writeMcpFixture(dir);
    const conversationId = "conv-permanent-cleanup";
    const key = sessionKeyOf("casper", conversationId);
    const opened = await host!.open("casper", conversationId);
    await host!.liveVoiceAction("casper", conversationId, "start");
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
    const originalVoiceStop = voice.manager.stop.bind(voice.manager);
    vi.spyOn(voice.manager, "stop").mockImplementation((sessionKey) => {
      if (fail) return Promise.reject(new Error("permanent voice stop"));
      return originalVoiceStop(sessionKey);
    });
    const originalCollaborationStop = collaboration.manager.stop.bind(collaboration.manager);
    vi.spyOn(collaboration.manager, "stop").mockImplementation((sessionKey, reason) => {
      if (fail) return Promise.reject(new Error("permanent collaboration stop"));
      return originalCollaborationStop(sessionKey, reason);
    });
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
      closeHostedSession(key: string, reason: string): Promise<void>;
      cleanupRetries: Map<string, typeof opened>;
    };

    const first = internals.closeHostedSession(key, "first close");
    await entered.promise;
    const second = internals.closeHostedSession(key, "coalesced close");
    expect(second).toBe(first);
    expect(internals.cleanupRetries.get(key)?.session).toBe(opened.session);
    release.resolve();
    await Promise.all([first, second]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.cleanupRetries.has(key)).toBe(false);
  });

});

describe("SessionHost live voice ownership", () => {
  it("reserves a conversation before a delayed voice manager reports active", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const voice = testLiveVoice(startGate);
    await setup([{ kind: "text", text: "must not run" }], { liveVoice: voice.manager });
    await host!.open("casper", "conv-voice-race");

    const starting = host!.liveVoiceAction("casper", "conv-voice-race", "start");
    await voice.startEntered;

    await expect(host!.runTurn("casper", {
      sessionId: "conv-voice-race",
      prompt: "race the microphone",
      emit: () => {},
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.runTurn("casper", {
      sessionId: "conv-voice-race",
      prompt: "!printf should-not-run",
      emit: () => {},
    })).rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(provider!.requests).toHaveLength(0);

    const stopping = host!.liveVoiceAction("casper", "conv-voice-race", "stop");
    releaseStart();
    await expect(starting).resolves.toMatchObject({ active: true, phase: "listening" });
    await expect(stopping).resolves.toMatchObject({ active: false, phase: "stopped" });
    expect(host!.liveVoiceStatus("casper", "conv-voice-race").active).toBe(false);
  });
});

describe("SessionHost.reloadMcp", () => {
  it("publishes prepared reload and reconnect candidates only after a writable collab turn", async () => {
    const collaboration = testWritableCollaboration();
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "reload-ready",
            question: "Finish the collab turn?",
            options: [{ label: "Yes" }],
          }],
        },
      },
      { kind: "text", text: "Reload turn finished." },
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "reconnect-ready",
            question: "Finish the reconnect turn?",
            options: [{ label: "Yes" }],
          }],
        },
      },
      { kind: "text", text: "Reconnect turn finished." },
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "publication-ready",
            question: "Finish the publication-first turn?",
            options: [{ label: "Yes" }],
          }],
        },
      },
      { kind: "text", text: "Publication-first turn finished." },
    ], { collaboration: collaboration.manager });
    const conversationId = "collab-mcp-publication";
    const opened = await host!.open("casper", conversationId);
    await host!.collaborationAction("casper", conversationId, {
      action: "start",
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: true,
    });
    const collabPrompt = (text: string) => collaboration.prompt(text);
    const managerOf = () => (opened as unknown as {
      mcp: { manager: GhostMcpManager };
    }).mcp.manager;
    const originalConnect = GhostMcpManager.prototype.connectServers;
    let barrier: {
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
      prepared: ReturnType<typeof Promise.withResolvers<void>>;
    } | undefined;
    const connectSpy = vi.spyOn(GhostMcpManager.prototype, "connectServers").mockImplementation(async function (
      this: GhostMcpManager,
      configs,
    ) {
      const active = barrier;
      if (active) {
        barrier = undefined;
        active.entered.resolve();
        await active.release.promise;
      }
      try {
        return await originalConnect.call(this, configs);
      } finally {
        active?.prepared.resolve();
      }
    });
    const blockNextCandidate = () => {
      const next = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        prepared: Promise.withResolvers<void>(),
      };
      barrier = next;
      return next;
    };

    const initialManager = managerOf();
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(opened.session.getToolDefinition(toolName)).toBeUndefined();
    writeMcpFixture(dir);
    const reloadBarrier = blockNextCandidate();
    let reloadSettled = false;
    const reload = host!.reloadMcp("casper").finally(() => {
      reloadSettled = true;
    });
    await reloadBarrier.entered.promise;
    const reloadTurn = collabPrompt("Hold reload publication.");
    const reloadAsk = await waitFor(() => host!.pendingAsk("casper", conversationId));
    reloadBarrier.release.resolve();
    await reloadBarrier.prepared.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reloadSettled).toBe(false);
    expect(managerOf()).toBe(initialManager);
    expect(opened.session.getToolDefinition(toolName)).toBeUndefined();
    host!.answerAsk("casper", conversationId, reloadAsk.id, {
      kind: "submit",
      results: [{ id: "reload-ready", selectedOptions: ["Yes"] }],
    });
    await reloadTurn;
    await reload;
    expect(managerOf()).not.toBe(initialManager);
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();

    const reloadedManager = managerOf();
    const disconnect = vi.spyOn(reloadedManager, "disconnectAll");
    const reconnectBarrier = blockNextCandidate();
    let reconnectSettled = false;
    const reconnect = host!.reconnectMcp("casper", "reload_fixture").finally(() => {
      reconnectSettled = true;
    });
    await reconnectBarrier.entered.promise;
    const reconnectTurn = collabPrompt("Hold reconnect publication.");
    const reconnectAsk = await waitFor(() => host!.pendingAsk("casper", conversationId));
    reconnectBarrier.release.resolve();
    await reconnectBarrier.prepared.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reconnectSettled).toBe(false);
    expect(managerOf()).toBe(reloadedManager);
    expect(disconnect).not.toHaveBeenCalled();
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();
    host!.answerAsk("casper", conversationId, reconnectAsk.id, {
      kind: "submit",
      results: [{ id: "reconnect-ready", selectedOptions: ["Yes"] }],
    });
    await reconnectTurn;
    await reconnect;
    expect(managerOf()).not.toBe(reloadedManager);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();

    const publicationManager = managerOf();
    const publicationEntered = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    const originalRefresh = opened.session.reload.bind(opened.session);
    const refreshSpy = vi.spyOn(opened.session, "reload").mockImplementationOnce(
      async (...args) => {
        publicationEntered.resolve();
        await releasePublication.promise;
        return originalRefresh(...args);
      },
    );
    const publication = host!.reloadMcp("casper");
    await publicationEntered.promise;
    const requestsBeforePrompt = provider!.requests.length;
    let publicationFirstTurnSettled = false;
    const publicationFirstTurn = collabPrompt("Wait behind publication.").finally(() => {
      publicationFirstTurnSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider!.requests).toHaveLength(requestsBeforePrompt);
    expect(host!.pendingAsk("casper", conversationId)).toBeNull();
    expect(publicationFirstTurnSettled).toBe(false);
    releasePublication.resolve();
    await publication;
    expect(managerOf()).not.toBe(publicationManager);
    const publicationAsk = await waitFor(() => host!.pendingAsk("casper", conversationId));
    host!.answerAsk("casper", conversationId, publicationAsk.id, {
      kind: "submit",
      results: [{ id: "publication-ready", selectedOptions: ["Yes"] }],
    });
    await publicationFirstTurn;
    expect(refreshSpy).toHaveBeenCalled();
    connectSpy.mockRestore();
  });

  it("releases writable collaboration prompt ownership on error, abort, and shutdown", async () => {
    const collaboration = testWritableCollaboration();
    const recorded = recordMaintenanceTurns();
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "abort-ready",
            question: "Wait for abort?",
            options: [{ label: "Yes" }],
          }],
        },
      },
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "shutdown-ready",
            question: "Wait for shutdown?",
            options: [{ label: "Yes" }],
          }],
        },
      },
    ], { collaboration: collaboration.manager, maintenance: recorded.maintenance });
    const conversationId = "collab-prompt-release";
    const opened = await host!.open("casper", conversationId);
    await host!.collaborationAction("casper", conversationId, {
      action: "start",
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: true,
    });
    const prompt = (text: string) => collaboration.prompt(text);
    const hosted = (host as unknown as {
      sessions: Map<string, {
        rawCollaborationPrompts?: number;
        rawCollaborationIdle?: Promise<void>;
        mcpPublication?: Promise<void>;
      }>;
    }).sessions.get(sessionKeyOf("casper", conversationId));
    const expectReleased = () => {
      expect(hosted?.rawCollaborationPrompts ?? 0).toBe(0);
      expect(hosted?.rawCollaborationIdle).toBeUndefined();
      expect(hosted?.mcpPublication).toBeUndefined();
    };

    const failedPrompt = vi.spyOn(opened.session, "sendCustomMessage")
      .mockRejectedValueOnce(new Error("injected collaboration prompt failure"));
    await expect(prompt("Fail before dispatch."))
      .rejects.toThrow("injected collaboration prompt failure");
    failedPrompt.mockRestore();
    expectReleased();
    expect(recorded.finished).toEqual([undefined]);
    expect(recorded.released.count).toBe(1);
    await expect(host!.reloadMcp("casper")).resolves.toBeUndefined();

    const aborted = prompt("Abort this turn.");
    await waitFor(() => host!.pendingAsk("casper", conversationId));
    await opened.session.abort();
    await Promise.allSettled([aborted]);
    expectReleased();
    expect(recorded.finished).toEqual([undefined, undefined]);
    expect(recorded.released.count).toBe(2);
    await expect(host!.reloadMcp("casper")).resolves.toBeUndefined();

    const interruptedByShutdown = prompt("Shutdown during this turn.");
    await waitFor(() => host!.pendingAsk("casper", conversationId));
    const shutdown = host!.disposeAll();
    await Promise.allSettled([interruptedByShutdown, shutdown]);
    host = null;
    expectReleased();
    expect(recorded.finished).toEqual([undefined, undefined, undefined]);
    expect(recorded.released.count).toBe(3);
  });

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

  it("serializes project, delete, whole-ghost, and MCP ownership in both admission orders", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    writeMcpFixture(dir);
    await host!.disposeAll();
    const bindingStore = new ProjectBindingStore({
      ownerHome: temp!.ownerHome,
      trustPath: join(temp!.root, "state", "project-trust.json"),
    });
    const originalWrite = bindingStore.write.bind(bindingStore);
    const writeEntered = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    let delayNextWrite = true;
    vi.spyOn(bindingStore, "write").mockImplementation(async (input) => {
      if (delayNextWrite) {
        delayNextWrite = false;
        writeEntered.resolve();
        await releaseWrite.promise;
      }
      return originalWrite(input);
    });
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      projectBindings: bindingStore,
      offline: true,
    });
    const project = join(temp!.root, "ownership-project");
    mkdirSync(project);
    const preview = await host.previewProject("casper", "ownership", "pi", project);
    const binding = host.bindProject("casper", "ownership", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    await writeEntered.promise;
    await expect(host.withMcpReload("casper", async () => {}))
      .rejects.toMatchObject({ code: "session_busy" });
    await expect(host.deleteSession("casper", "ownership"))
      .rejects.toMatchObject({ code: "session_busy" });
    await expect(host.renameGhost("casper", "wisp"))
      .rejects.toMatchObject({ code: "ghost_busy" });
    releaseWrite.resolve();
    await binding;

    const mcpEntered = Promise.withResolvers<void>();
    const releaseMcp = Promise.withResolvers<void>();
    const mcpTransition = host.withMcpReload("casper", async () => {
      mcpEntered.resolve();
      await releaseMcp.promise;
    });
    await mcpEntered.promise;
    await expect(host.bindProject("casper", "ownership", "pi", {
      root: null,
      expectedGeneration: 1,
    })).rejects.toMatchObject({ code: "session_busy" });
    await expect(host.deleteSession("casper", "ownership"))
      .rejects.toMatchObject({ code: "session_busy" });
    await expect(host.renameGhost("casper", "wisp"))
      .rejects.toMatchObject({ code: "ghost_busy" });
    releaseMcp.resolve();
    await mcpTransition;

    const hosted = await host.open("casper", "ownership");
    const reconnectManager = (hosted as unknown as { mcp: { manager: GhostMcpManager } }).mcp.manager;
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
    const reconnecting = host.reconnectMcp("casper", "reload_fixture");
    await reconnectEntered.promise;
    await expect(host.deleteSession("casper", "ownership"))
      .rejects.toMatchObject({ code: "session_busy" });
    releaseReconnect.resolve();
    await reconnecting;
    expect((hosted as unknown as { mcp: { manager: unknown } }).mcp.manager)
      .not.toBe(reconnectManager);
    connectSpy.mockRestore();

    const deleteBackground = Promise.withResolvers<void>();
    (hosted as unknown as { title?: Promise<void> }).title = deleteBackground.promise;
    const deleting = host.deleteSession("casper", "ownership");
    expect((host as unknown as { deleting: Set<string> }).deleting.size).toBe(1);
    await expect(host.bindProject("casper", "ownership", "pi", {
      root: null,
      expectedGeneration: 1,
    })).rejects.toMatchObject({ code: "session_busy" });
    await expect(host.reconnectMcp("casper", "not-configured"))
      .rejects.toMatchObject({ code: "session_busy" });
    await expect(host.withMcpReload("casper", async () => {}))
      .rejects.toMatchObject({ code: "session_busy" });
    await expect(host.renameGhost("casper", "wisp"))
      .rejects.toMatchObject({ code: "ghost_busy" });
    deleteBackground.resolve();
    await deleting;

    const movingHosted = await host.open("casper", "move-block");
    const moveBackground = Promise.withResolvers<void>();
    (movingHosted as unknown as { title?: Promise<void> }).title = moveBackground.promise;
    const renaming = host.renameGhost("casper", "wisp");
    await waitFor(() =>
      (host as unknown as { reservedGhosts: Set<string> }).reservedGhosts.has("casper") || null);
    await expect(host.bindProject("casper", "move-block", "pi", {
      root: null,
      expectedGeneration: 0,
    })).rejects.toMatchObject({ code: "ghost_busy" });
    await expect(host.withMcpReload("casper", async () => {}))
      .rejects.toMatchObject({ code: "session_busy" });
    await expect(host.deleteSession("casper", "move-block"))
      .rejects.toMatchObject({ code: "ghost_busy" });
    moveBackground.resolve();
    await expect(renaming).resolves.toMatchObject({ name: "wisp" });
  });

  it("refreshes project MCP only through an explicit project reload", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const project = join(temp!.root, "mcp-bound-project");
    mkdirSync(project);
    mkdirSync(join(project, "runtime"));
    writeMcpFixture(project, { cwd: "runtime", project: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    for (let index = 0; index < PROJECT_SCAN_MAX_ENTRIES + 10; index += 1) {
      writeFileSync(join(project, ".omp", "rules", `wide-${index}.md`), `rule ${index}`);
    }
    const preview = await host!.previewProject("casper", "conv-project-mcp", "pi", project);
    expect(preview.warnings).toContainEqual(expect.stringContaining("entry limit"));
    await host!.bindProject("casper", "conv-project-mcp", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const handle = await host!.open("casper", "conv-project-mcp");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(handle.session.getToolDefinition(toolName)).toBeDefined();
    expect(readFileSync(join(project, "mcp-cwd.txt"), "utf8")).toBe(join(project, "runtime"));
    expect(readFileSync(join(project, "mcp-cwd.txt"), "utf8")).not.toBe(temp!.ownerHome);
    expect(await host!.getProject("casper", "conv-project-mcp", "pi"))
      .toMatchObject({ generation: 1, status: "ready", mcpStatus: "ready" });

    writeFileSync(join(project, ".omp", "mcp.json"), "{not-json", "utf8");
    await host!.reloadMcp("casper");

    expect(handle.session.getToolDefinition(toolName)).toBeDefined();
    expect(await host!.getProject("casper", "conv-project-mcp", "pi"))
      .toMatchObject({ generation: 1, status: "ready", mcpStatus: "ready" });

    await host!.reloadProject("casper", "conv-project-mcp", "pi", 1);
    const reopened = await host!.open("casper", "conv-project-mcp");
    expect(reopened.session.getToolDefinition(toolName)).toBeUndefined();
    expect(await host!.getProject("casper", "conv-project-mcp", "pi"))
      .toMatchObject({
        generation: 2,
        status: "degraded",
        mcpStatus: "degraded",
        error: { code: "project_mcp_degraded" },
      });
  });

  it("publishes project MCP health after manual reconnect success and failure", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const project = join(temp!.root, "manual-project-mcp-health");
    mkdirSync(project);
    writeMcpFixture(project, { project: true });
    const preview = await host!.previewProject("casper", "manual-project-health", "pi", project);
    await host!.bindProject("casper", "manual-project-health", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const serverPath = join(project, "reload-mcp.mjs");
    rmSync(serverPath);
    const opened = await host!.open("casper", "manual-project-health");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(opened.session.getToolDefinition(toolName)).toBeUndefined();
    expect(await host!.getProject("casper", "manual-project-health", "pi"))
      .toMatchObject({ generation: 1, status: "degraded", mcpStatus: "degraded" });

    const updates: ConversationUpdatedEvent[] = [];
    const unsubscribe = host!.subscribeConversationEvents("casper", (event) => {
      if (event.conversationId === "manual-project-health") updates.push(event);
    });
    writeMcpFixture(project, { project: true });
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("connected");
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();
    expect(await host!.getProject("casper", "manual-project-health", "pi"))
      .toMatchObject({ generation: 1, status: "ready", mcpStatus: "ready", error: null });
    expect(updates).toEqual([
      expect.objectContaining({
        runtime: "pi",
        conversationId: "manual-project-health",
        reason: "project",
      }),
    ]);

    rmSync(serverPath);
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("disconnected");
    expect(opened.session.getToolDefinition(toolName)).toBeUndefined();
    expect(await host!.getProject("casper", "manual-project-health", "pi"))
      .toMatchObject({
        generation: 1,
        status: "degraded",
        mcpStatus: "degraded",
        error: { code: "project_mcp_degraded" },
      });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      runtime: "pi",
      conversationId: "manual-project-health",
      reason: "project",
    });
    unsubscribe();
  });

  it("does not publish reconnect health over a newer project generation", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    const project = join(temp!.root, "manual-project-mcp-stale");
    mkdirSync(project);
    writeMcpFixture(project, { project: true });
    const conversationId = "manual-project-stale";
    const preview = await host!.previewProject("casper", conversationId, "pi", project);
    await host!.bindProject("casper", conversationId, "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    await host!.open("casper", conversationId);
    const current = await host!.getProject("casper", conversationId, "pi");
    const bindings = (host as unknown as {
      projectBindings: ProjectBindingStore;
    }).projectBindings;
    const originalUpdate = bindings.updateRuntimeStatus.bind(bindings);
    let advanced = false;
    const updateSpy = vi.spyOn(bindings, "updateRuntimeStatus").mockImplementation(
      async (...args) => {
        if (!advanced) {
          advanced = true;
          await bindings.write({
            sessionDir: ghostPaths(dir).sessionDir,
            runtime: "pi",
            conversationId,
            current,
            root: project,
            cwd: project,
            reason: "reloaded",
            status: "degraded",
            error: { code: "new_generation_health", message: "New generation owns health." },
            mcpStatus: "degraded",
            scope: "casper",
          });
        }
        return originalUpdate(...args);
      },
    );
    const updates: ConversationUpdatedEvent[] = [];
    const unsubscribe = host!.subscribeConversationEvents("casper", (event) => {
      if (event.conversationId === conversationId) updates.push(event);
    });

    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("connected");
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(await host!.getProject("casper", conversationId, "pi")).toMatchObject({
      generation: 2,
      status: "degraded",
      mcpStatus: "degraded",
      error: { code: "new_generation_health" },
    });
    expect(updates).toEqual([]);
    unsubscribe();
  });

  it("does not let a ghost-only reconnect rewrite bound-project health", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    writeMcpFixture(dir);
    const project = join(temp!.root, "ghost-only-reconnect-project");
    mkdirSync(project);
    const conversationId = "ghost-only-reconnect";
    const preview = await host!.previewProject("casper", conversationId, "pi", project);
    await host!.bindProject("casper", conversationId, "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    await host!.open("casper", conversationId);
    const current = await host!.getProject("casper", conversationId, "pi");
    const bindings = (host as unknown as {
      projectBindings: ProjectBindingStore;
    }).projectBindings;
    await expect(bindings.updateRuntimeStatus(
      ghostPaths(dir).sessionDir,
      "pi",
      conversationId,
      current,
      {
        status: "degraded",
        error: { code: "preserve_project_health", message: "Project health sentinel." },
        mcpStatus: "degraded",
      },
    )).resolves.toBe(true);
    const updates: ConversationUpdatedEvent[] = [];
    const unsubscribe = host!.subscribeConversationEvents("casper", (event) => {
      if (event.conversationId === conversationId) updates.push(event);
    });

    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("connected");
    expect(await host!.getProject("casper", conversationId, "pi")).toMatchObject({
      generation: 1,
      status: "degraded",
      mcpStatus: "degraded",
      error: { code: "preserve_project_health" },
    });
    expect(updates).toEqual([]);
    unsubscribe();
  });

  it("launches and reloads Pi MCP from the one immutable project scan", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    await host!.disposeAll();
    const project = join(temp!.root, "single-scan-project-mcp");
    mkdirSync(project);
    writeMcpFixture(project, { project: true });
    let mutateAfterScan = false;
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      offline: true,
      sessionStartupProbe: (stage) => {
        if (stage !== "model-runtime" || !mutateAfterScan) return;
        mutateAfterScan = false;
        writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
          mcpServers: {
            reload_fixture: { enabled: false, type: "stdio", command: "changed-after-scan" },
          },
        }));
      },
    });
    const preview = await host.previewProject("casper", "single-scan", "pi", project);
    await host.bindProject("casper", "single-scan", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    mutateAfterScan = true;
    const opened = await host.open("casper", "single-scan");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();
    const projectMcp = (host as unknown as {
      sessions: Map<string, { mcp?: { sources: Map<string, unknown> } }>;
    }).sessions.get(sessionKeyOf("casper", "single-scan"))?.mcp;
    expect(projectMcp?.sources.get("reload_fixture")).toMatchObject({
      level: "project",
      path: join(project, ".omp", "mcp.json"),
    });

    await host.reloadMcp("casper");
    expect(opened.session.getToolDefinition(toolName)).toBeDefined();

    await host.reloadProject("casper", "single-scan", "pi", 1);
    const reopened = await host.open("casper", "single-scan");
    expect(reopened.session).not.toBe(opened.session);
    expect(reopened.session.getToolDefinition(toolName)).toBeUndefined();
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
    expect(ghostMcp?.sources.get("reload_fixture")).toMatchObject({
      level: "user",
      path: join(dir, "mcp.json"),
    });
  });

  it("lets a bound project claim a ghost MCP name even when disabled or malformed", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    writeMcpFixture(dir);
    const project = join(temp!.root, "project-mcp-shadow");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { reload_fixture: { enabled: false, type: "stdio", command: "disabled" } },
    }));
    const preview = await host!.previewProject("casper", "project-shadow", "pi", project);
    const disabled = await host!.bindProject("casper", "project-shadow", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    expect(disabled).toMatchObject({
      status: "ready",
      mcpStatus: "off",
      resources: { mcpServers: 0 },
    });

    const handle = await host!.open("casper", "project-shadow");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();

    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { reload_fixture: { type: "stdio" } },
    }));
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    expect(await host!.getProject("casper", "project-shadow", "pi"))
      .toMatchObject({ status: "ready", mcpStatus: "off", generation: 1 });

    const malformed = await host!.reloadProject("casper", "project-shadow", "pi", 1);
    expect(malformed).toMatchObject({
      status: "degraded",
      mcpStatus: "degraded",
      resources: { mcpServers: 0 },
      error: { code: "project_mcp_degraded" },
    });
    const reopened = await host!.open("casper", "project-shadow");
    expect(reopened.session.getToolDefinition(toolName)).toBeUndefined();
    expect(await host!.getProject("casper", "project-shadow", "pi"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded", generation: 2 });
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
            id: "ready",
            question: "Ready?",
            options: [{ label: "Yes" }, { label: "No" }],
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
      results: [{ id: "ready", selectedOptions: ["Yes"] }],
    });
    await turn;

    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeDefined();
  });

  it("defers reload and reconnect across a raw collaboration-style turn", async () => {
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "remote-ready",
            question: "Ready?",
            options: [{ label: "Yes" }, { label: "No" }],
          }],
        },
      },
      { kind: "text", text: "Remote turn done." },
    ]);
    const handle = await host!.open("casper", "conv-mcp-remote");
    const toolName = "mcp__reload_fixture_reload_echo";

    // CollabHost calls AgentSession directly, bypassing SessionHost.runTurn()
    // and therefore never setting HostedSession.busy.
    const remoteTurn = handle.session.prompt("Ask from the writable room.");
    const pending = await waitFor(() => host!.pendingAsk("casper", "conv-mcp-remote"));
    expect(handle.session.isStreaming).toBe(true);

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("deferred");

    host!.answerAsk("casper", "conv-mcp-remote", pending.id, {
      kind: "submit",
      results: [{ id: "remote-ready", selectedOptions: ["Yes"] }],
    });
    await remoteTurn;
    await waitFor(() => handle.session.getToolDefinition(toolName) ? true : null);
    expect(host!.mcpConnectionStatus("casper", "reload_fixture")).toBe("connected");
  });

  it("defers reload and reconnect while voice owns the session, then applies them on stop", async () => {
    const voice = testLiveVoice();
    const { dir } = await setup([{ kind: "text", text: "unused" }], {
      liveVoice: voice.manager,
    });
    const handle = await host!.open("casper", "conv-mcp-voice");
    const toolName = "mcp__reload_fixture_reload_echo";
    await host!.liveVoiceAction("casper", "conv-mcp-voice", "start");

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(handle.session.getToolDefinition(toolName)).toBeUndefined();
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("deferred");

    await host!.liveVoiceAction("casper", "conv-mcp-voice", "stop");
    expect(handle.session.getToolDefinition(toolName)).toBeDefined();
    expect(host!.mcpConnectionStatus("casper", "reload_fixture")).toBe("connected");
  });
});

describe("SessionHost.runTurn", () => {
  it("holds a terminal frame until the tool-cwd sidecar is durable", async () => {
    const writerEntered = deferred();
    const releaseWriter = deferred();
    await setup(
      [
        { kind: "tool", name: "ghost_character", args: { action: "read" } },
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
        { kind: "tool", name: "ghost_character", args: { action: "read" } },
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
        { kind: "tool", name: "ghost_character", args: { action: "read" } },
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
        { kind: "tool", name: "ghost_character", args: { action: "read" } },
        { kind: "tool", name: "ghost_character", args: { action: "read" } },
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

  it("pauses OMP's built-in ask until the shell supplies a validated answer", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "finish",
            header: "Finish",
            question: "Which finish should I use?",
            options: [
              { label: "Matte", description: "Quiet and low-glare" },
              { label: "Gloss", description: "Brighter and reflective" },
            ],
            recommended: 0,
          }],
        },
      },
      { kind: "text", text: "Matte it is." },
    ]);
    await host!.open("casper", "conv-ask");
    // Ghost owns the desktop interaction. OMP's notifier hard-codes its own
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
      expect.objectContaining({ id: "finish", question: "Which finish should I use?" }),
    ]);
    host!.answerAsk("casper", "conv-ask", pending.id, {
      kind: "submit",
      results: [{ id: "finish", selectedOptions: ["Matte"] }],
    });
    await turn;

    expect(host!.pendingAsk("casper", "conv-ask")).toBeNull();
    expect(events.at(-1)?.type).toBe("done");
    expect(provider!.requests.filter((request) => request.system.includes("letterpress printer")))
      .toHaveLength(2);
    expect(JSON.stringify(provider!.requests[1]?.messages)).toContain("Matte");
  });

  describe("how a historical ask settled", () => {
    const ASK_STEP = {
      kind: "tool" as const,
      name: "ask",
      args: {
        questions: [{
          id: "finish",
          question: "Which finish should I use?",
          options: [{ label: "Matte" }, { label: "Gloss" }],
          recommended: 0,
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
        results: [{ id: "finish", selectedOptions: ["Matte"] }],
      });
      await turn;

      expect(await settledOf("conv-submitted")).toBe("submitted");
      const transcript = await host!.readTranscript("casper", "conv-submitted");
      const askCall = transcript.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((part) => (part as { name?: unknown }).name === "ask") as {
          ghostAsk?: unknown;
        };
      expect(askCall.ghostAsk).toEqual({ settled: "submitted" });
      expect(transcript.messages.every((message) => !("parentId" in message))).toBe(true);
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

    it("answers a timed-out question with nothing when it recommended nothing", async () => {
      const { questions } = ASK_STEP.args;
      const [question] = questions;
      const { recommended: _recommended, ...open } = question!;
      await setup([
        { ...ASK_STEP, args: { questions: [open] } },
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

  it("acknowledges a Pi stop only after the owner turn releases", async () => {
    const barrier = createMockProviderBarrier();
    const finishEntered = deferred();
    const allowFinish = deferred();
    const recorded = recordMaintenanceTurns(async () => {
      finishEntered.resolve();
      await allowFinish.promise;
    });
    await setup([
      { kind: "text", text: "held", barrier },
      { kind: "text", text: "fresh answer" },
    ], { maintenance: recorded.maintenance });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "stop-then-send",
      prompt: "Hold this turn.",
      emit: (event) => events.push(event),
    });
    await barrier.waitForArrivals();

    await expect(host!.stopTurn("casper", "stop-then-send", "claude-code"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });

    let acknowledged = false;
    const stopping = host!.stopTurn("casper", "stop-then-send", "pi").then((stopped) => {
      acknowledged = true;
      return stopped;
    });
    await finishEntered.promise;
    expect(acknowledged).toBe(false);
    allowFinish.resolve();

    await expect(stopping).resolves.toBe(true);
    await turn;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    await expect(host!.stopTurn("casper", "stop-then-send", "pi")).resolves.toBe(false);
    barrier.release();

    const retryEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "stop-then-send",
      prompt: "Start a fresh turn.",
      emit: (event) => retryEvents.push(event),
    });
    expect(retryEvents.at(-1)).toMatchObject({ type: "done" });
  });

  it("admits and settles a writable collaboration prompt as its own persisted owner pass", async () => {
    const collaboration = testWritableCollaboration();
    const recorded = recordMaintenanceTurns();
    const finishEntered = deferred();
    const allowFinish = deferred();
    const admitOwnerAction = recorded.maintenance.admitOwnerAction.bind(recorded.maintenance);
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      ...recorded.maintenance,
      admitOwnerAction: (identity) => {
        const admission = admitOwnerAction(identity);
        return {
          ...admission,
          finish: async (turn) => {
            finishEntered.resolve();
            await allowFinish.promise;
            await admission.finish(turn);
          },
        };
      },
    };
    const hooks = new GhostHookRunner();
    const before: string[] = [];
    const stopped: string[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        before.push(event.prompt);
      });
      api.on("session_stop", (event) => {
        stopped.push(event.owner_prompt);
      });
    });
    await setup([{ kind: "text", text: "Collaboration answer." }], {
      collaboration: collaboration.manager,
      hooks,
      maintenance,
    });
    await host!.collaborationAction("casper", "same-raw-id", {
      action: "start",
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: true,
    });

    let publicAgentEnds = 0;
    collaboration.session().subscribe((event) => {
      if (event.type === "agent_end") publicAgentEnds += 1;
    });
    const remoteTurn = collaboration.prompt("Set this collaboratively.");
    await finishEntered.promise;
    allowFinish.resolve();
    await remoteTurn;
    await waitFor(() => publicAgentEnds === 1 ? true : null);

    expect(before).toEqual(["Set this collaboratively."]);
    expect(stopped).toEqual(["Set this collaboratively."]);
    expect(recorded.admitted).toEqual([{
      ghostName: "casper",
      runtime: "pi",
      conversationId: "same-raw-id",
    }]);
    expect(recorded.finished).toEqual([
      expect.objectContaining({
        ownerPrompt: "Set this collaboratively.",
        assistantText: expect.stringContaining("Collaboration answer."),
        sourceRevision: { kind: "pi-leaf", value: expect.any(String) },
      }),
    ]);
    expect(recorded.released.count).toBe(1);
    expect(publicAgentEnds).toBe(1);
  });

  it("publishes a generic raw collaboration error when maintenance persistence rejects", async () => {
    const collaboration = testWritableCollaboration();
    const recorded = recordMaintenanceTurns(async (turn) => {
      if (turn) throw new Error("sensitive collaboration persistence failure");
    });
    await setup([{ kind: "text", text: "Persisted collaboration answer." }], {
      collaboration: collaboration.manager,
      maintenance: recorded.maintenance,
    });
    await host!.collaborationAction("casper", "strict-collaboration", {
      action: "start",
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: true,
    });
    const agentEnds: AgentSessionEvent[] = [];
    collaboration.session().subscribe((event) => {
      if (event.type === "agent_end") agentEnds.push(event);
    });

    await expect(collaboration.prompt("Persist this remote owner turn."))
      .rejects.toMatchObject({ code: "session_settlement_failed", status: 500 });

    expect(agentEnds).toHaveLength(1);
    expect(JSON.stringify(agentEnds)).not.toContain("sensitive collaboration persistence failure");
    expect(recorded.finished).toEqual([expect.objectContaining({
      assistantText: expect.stringContaining("Persisted collaboration answer."),
    })]);
    expect(recorded.released.count).toBe(1);
    expect(JSON.stringify(await host!.readTranscript("casper", "strict-collaboration")))
      .toContain("Persisted collaboration answer.");
  });

  it("admits a live-voice delegation before its model pass and settles its durable leaf", async () => {
    class DelegatingVoiceManager extends LiveVoiceManager {
      override async start(
        _sessionKey: string,
        _session: AgentSession,
        sendCustomMessage?: AgentSession["sendCustomMessage"],
      ): Promise<LiveVoiceStatus> {
        await sendCustomMessage?.({
          customType: "live-delegation",
          content: "Handle this spoken request.",
          display: true,
          details: { attribution: "agent" },
        }, { triggerTurn: true });
        return {
          supported: true,
          active: true,
          phase: "listening",
          muted: false,
          inputLevel: 0,
          outputLevel: 0,
          transcript: [],
        };
      }
    }
    const recorded = recordMaintenanceTurns();
    const finishEntered = deferred();
    const allowFinish = deferred();
    const admitOwnerAction = recorded.maintenance.admitOwnerAction.bind(recorded.maintenance);
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      ...recorded.maintenance,
      admitOwnerAction: (identity) => {
        const admission = admitOwnerAction(identity);
        return {
          ...admission,
          finish: async (turn) => {
            finishEntered.resolve();
            await allowFinish.promise;
            await admission.finish(turn);
          },
        };
      },
    };
    const hooks = new GhostHookRunner();
    const before: string[] = [];
    const stopped: string[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        before.push(event.prompt);
      });
      api.on("session_stop", (event) => {
        stopped.push(event.owner_prompt);
      });
    });
    await setup([{ kind: "text", text: "Voice answer." }], {
      liveVoice: new DelegatingVoiceManager(),
      hooks,
      maintenance,
    });

    const opened = await host!.open("casper", "same-raw-id");
    let publicAgentEnds = 0;
    opened.session.subscribe((event) => {
      if (event.type === "agent_end") publicAgentEnds += 1;
    });
    const start = host!.liveVoiceAction("casper", "same-raw-id", "start");
    await finishEntered.promise;
    allowFinish.resolve();
    await start;
    await waitFor(() => publicAgentEnds === 1 ? true : null);

    expect(before).toEqual(["Handle this spoken request."]);
    expect(stopped).toEqual(["Handle this spoken request."]);
    expect(recorded.admitted).toEqual([{
      ghostName: "casper",
      runtime: "pi",
      conversationId: "same-raw-id",
    }]);
    expect(recorded.finished).toEqual([
      expect.objectContaining({
        ownerPrompt: "Handle this spoken request.",
        assistantText: expect.stringContaining("Voice answer."),
        sourceRevision: { kind: "pi-leaf", value: expect.any(String) },
      }),
    ]);
    expect(recorded.released.count).toBe(1);
    expect(publicAgentEnds).toBe(1);
  });

  it("publishes a generic raw voice error when maintenance persistence rejects", async () => {
    class DelegatingVoiceManager extends LiveVoiceManager {
      override async start(
        _sessionKey: string,
        _session: AgentSession,
        sendCustomMessage?: AgentSession["sendCustomMessage"],
      ): Promise<LiveVoiceStatus> {
        await sendCustomMessage?.({
          customType: "live-delegation",
          content: "Persist this spoken request.",
          display: true,
          details: { attribution: "agent" },
        }, { triggerTurn: true });
        return {
          supported: true,
          active: true,
          phase: "listening",
          muted: false,
          inputLevel: 0,
          outputLevel: 0,
          transcript: [],
        };
      }
    }
    const recorded = recordMaintenanceTurns(async (turn) => {
      if (turn) throw new Error("sensitive voice persistence failure");
    });
    await setup([{ kind: "text", text: "Persisted voice answer." }], {
      liveVoice: new DelegatingVoiceManager(),
      maintenance: recorded.maintenance,
    });
    const opened = await host!.open("casper", "strict-live-voice");
    const agentEnds: AgentSessionEvent[] = [];
    opened.session.subscribe((event) => {
      if (event.type === "agent_end") agentEnds.push(event);
    });

    await expect(host!.liveVoiceAction("casper", "strict-live-voice", "start"))
      .rejects.toMatchObject({ code: "session_settlement_failed", status: 500 });

    expect(agentEnds).toHaveLength(1);
    expect(JSON.stringify(agentEnds)).not.toContain("sensitive voice persistence failure");
    expect(recorded.finished).toEqual([expect.objectContaining({
      assistantText: expect.stringContaining("Persisted voice answer."),
    })]);
    expect(recorded.released.count).toBe(1);
    expect(JSON.stringify(await host!.readTranscript("casper", "strict-live-voice")))
      .toContain("Persisted voice answer.");
  });

  it("awaits session_stop and sends only the current assistant pass", async () => {
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
        if (active.length <= GHOST_SESSION_STOP_CONTINUATION_CAP) {
          return { decision: "block", reason: "Rewrite the answer without canned phrasing." };
        }
      });
    });
    // The hook blocks every pass, so the cap ends the turn: one initial pass
    // plus GHOST_SESSION_STOP_CONTINUATION_CAP continuations. Avoid OMP's own
    // canned-phrasing retry: this test owns the retry via Ghost's session_stop
    // hook and must observe every pass itself.
    const passCount = GHOST_SESSION_STOP_CONTINUATION_CAP + 1;
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

  it("records the durable Pi leaf as failed when a continuation cannot start", async () => {
    class ContinuingHooks extends GhostHookRunner {
      calls = 0;

      override hasHandlers(event: Parameters<GhostHookRunner["hasHandlers"]>[0]): boolean {
        return event === "session_stop" || super.hasHandlers(event);
      }

      override async emitSessionStop(): Promise<{ continue: true; additionalContext: string }> {
        this.calls += 1;
        return { continue: true, additionalContext: "Revise this answer." };
      }
    }
    const hooks = new ContinuingHooks();
    let acknowledgements = 0;
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "A retained maintenance notice.",
        acknowledge: () => {
          acknowledgements += 1;
          throw new Error("sensitive acknowledgement failure");
        },
      }));
    });
    const logger = recordingLogger("warn");
    const recorded = recordMaintenanceTurns();
    await setup([{ kind: "text", text: "Initial durable answer." }], {
      hooks,
      maintenance: recorded.maintenance,
      logger,
    });
    const opened = await host!.open("casper", "continuation-start-failure");
    const sendCustomMessage = opened.session.sendCustomMessage.bind(opened.session);
    vi.spyOn(opened.session, "sendCustomMessage").mockImplementation(async (message, options) => {
      if (typeof message !== "string" && message.customType === "session-stop-continuation") {
        throw new Error("injected continuation start failure");
      }
      return sendCustomMessage(message, options);
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "continuation-start-failure",
      prompt: "Give me an answer.",
      emit: (event) => events.push(event),
    });

    expect(hooks.calls).toBe(1);
    expect(acknowledgements).toBe(1);
    expect(recorded.finished).toEqual([
      expect.objectContaining({
        ownerPrompt: "Give me an answer.",
        assistantText: expect.stringContaining("Initial durable answer."),
        outcome: "failed",
        sourceRevision: { kind: "pi-leaf", value: expect.any(String) },
      }),
    ]);
    expect(recorded.released.count).toBe(1);
    expect(events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "error" })]);
    expect(logger.records).toContainEqual({
      level: "warn",
      message: "before_prompt hook acknowledgement failed",
      fields: { ghost: "casper", conversation: "continuation-start-failure", runtime: "pi" },
    });
    expect(JSON.stringify(logger.records)).not.toContain("sensitive acknowledgement failure");
  });

  it("records the latest replacement leaf as failed when later stop settlement fails", async () => {
    class FailingReplacementHooks extends GhostHookRunner {
      calls = 0;

      override hasHandlers(event: Parameters<GhostHookRunner["hasHandlers"]>[0]): boolean {
        return event === "session_stop" || super.hasHandlers(event);
      }

      override async emitSessionStop(): Promise<
        { continue: true; additionalContext: string } | undefined
      > {
        this.calls += 1;
        if (this.calls === 1) {
          return { continue: true, additionalContext: "Persist a replacement." };
        }
        throw new Error("injected post-replacement stop failure");
      }
    }
    const hooks = new FailingReplacementHooks();
    const recorded = recordMaintenanceTurns();
    await setup([
      { kind: "text", text: "Initial durable answer." },
      { kind: "text", text: "Replacement durable answer." },
    ], { hooks, maintenance: recorded.maintenance }, { sequential: true });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "post-replacement-stop-failure",
      prompt: "Give me an answer.",
      emit: (event) => events.push(event),
    });

    const opened = await host!.open("casper", "post-replacement-stop-failure");
    const latestAssistant = opened.session.sessionManager.getBranch().findLast((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
    );
    expect(hooks.calls).toBe(2);
    expect(latestAssistant?.type).toBe("message");
    expect(recorded.finished).toEqual([
      expect.objectContaining({
        ownerPrompt: "Give me an answer.",
        assistantText: expect.stringContaining("Replacement durable answer."),
        outcome: "failed",
        sourceRevision: { kind: "pi-leaf", value: latestAssistant?.id },
      }),
    ]);
    expect(recorded.released.count).toBe(1);
    expect(events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "error" })]);
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

  it("drains maintenance before an owner turn and records a durable Pi revision before done", async () => {
    const ready = deferred();
    const finishEntered = deferred();
    const allowFinish = deferred();
    let released = 0;
    let settled: MaintenanceIdentity | undefined;
    let turn: SettledMaintenanceTurn | undefined;
    const drainedReservation = () => ({ drained: Promise.resolve(), release: () => {} });
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      admitOwnerAction: (identity) => {
        settled = identity;
        return {
          ready: ready.promise,
          finish: async (value) => {
            turn = value;
            finishEntered.resolve();
            await allowFinish.promise;
          },
          release: () => {
            released += 1;
          },
        };
      },
      reserveConversationDelete: drainedReservation,
      completeConversationDelete: () => {},
      reserveGhostMove: drainedReservation,
      completeGhostRename: async () => {},
      completeGhostDelete: () => {},
      beginShutdown: async () => {},
      disposeAll: async () => {},
    };
    await setup([{ kind: "text", text: "Durable answer." }], { maintenance });
    const events: PiMessagesEvent[] = [];
    const running = host!.runTurn("casper", {
      sessionId: "maintenance-pi",
      prompt: "Remember this.",
      emit: (event) => events.push(event),
    });

    await waitFor(() => settled ?? null);
    expect(provider!.requests).toHaveLength(0);
    expect(settled).toEqual({
      ghostName: "casper",
      runtime: "pi",
      conversationId: "maintenance-pi",
    });
    ready.resolve();
    await finishEntered.promise;
    expect(events.at(-1)?.type).not.toBe("done");
    expect(released).toBe(0);
    expect(turn).toMatchObject({
      sourceRevision: { kind: "pi-leaf", value: expect.any(String) },
      cwd: temp!.ownerHome,
      ownerPrompt: "Remember this.",
      assistantText: expect.stringContaining("Durable answer."),
      outcome: "completed",
      source: { runtime: "pi", createdAt: expect.any(String) },
    });
    allowFinish.resolve();
    await running;
    expect(events.at(-1)?.type).toBe("done");
    expect(released).toBe(1);
  });

  it("turns a rejected durable Pi maintenance record into one generic terminal error", async () => {
    const finishEntered = deferred();
    const allowFailure = deferred();
    const order: string[] = [];
    let rejectNext = true;
    const recorded = recordMaintenanceTurns(async (turn) => {
      if (!turn || !rejectNext) return;
      rejectNext = false;
      order.push("finish");
      finishEntered.resolve();
      await allowFailure.promise;
      throw new Error("sensitive sidecar persistence failure");
    });
    const hooks = new GhostHookRunner();
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Attach this notice before acknowledging it.",
        acknowledge: () => {
          order.push("acknowledge");
        },
      }));
    });
    await setup([{ kind: "text", text: "Durable model answer." }], {
      hooks,
      maintenance: recorded.maintenance,
    });
    const failedEvents: PiMessagesEvent[] = [];
    const failed = host!.runTurn("casper", {
      sessionId: "strict-pi-maintenance",
      prompt: "Remember this owner turn.",
      emit: (event) => failedEvents.push(event),
    });

    await finishEntered.promise;
    expect(order).toEqual(["acknowledge", "finish"]);
    expect(failedEvents.some((event) => event.type === "done" || event.type === "error"))
      .toBe(false);
    expect(recorded.released.count).toBe(0);
    allowFailure.resolve();
    await failed;

    const terminals = failedEvents.filter((event) =>
      event.type === "done" || event.type === "error"
    );
    expect(terminals).toEqual([{
      type: "error",
      reason: "error",
      usage: expect.any(Object),
      errorMessage: "Could not durably settle this owner turn.",
    }]);
    expect(JSON.stringify(failedEvents)).not.toContain("sensitive sidecar persistence failure");
    expect(recorded.finished).toEqual([expect.objectContaining({
      sourceRevision: { kind: "pi-leaf", value: expect.any(String) },
      assistantText: expect.stringContaining("Durable model answer."),
    })]);
    expect(recorded.released.count).toBe(1);
    expect(JSON.stringify(await host!.readTranscript("casper", "strict-pi-maintenance")))
      .toContain("Durable model answer.");

    const retriedEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "strict-pi-maintenance",
      prompt: "Retry after the persistence fault.",
      emit: (event) => retriedEvents.push(event),
    });
    expect(retriedEvents.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "done" })]);
    expect(recorded.released.count).toBe(2);
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

  it("layers the ghost persona onto OMP's native prompt and tools", async () => {
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
    expect(handle.session.getToolDefinition("ghost_memory_write")).toBeDefined();
  });

  it("rejects opposite-runtime project bindings before draft and duplicate admission", async () => {
    let claudeQueries = 0;
    const { dir } = await setup([{ kind: "text", text: "must not run" }], {
      title: { enabled: false },
      claudeCode: {
        binaryPath: process.execPath,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        createQuery: () => {
          claudeQueries += 1;
          throw new Error("Claude query must not start across a project runtime mismatch");
        },
      },
    });
    const home = ghostPaths(dir).home;
    const sessionDir = ghostPaths(dir).sessionDir;
    const project = join(temp!.root, "runtime-mismatch-project");
    mkdirSync(project);

    for (const selectedRuntime of ["pi", "claude-code"] as const) {
      const oppositeRuntime = selectedRuntime === "pi" ? "claude-code" : "pi";
      for (const identityKind of ["draft", "duplicate"] as const) {
          const id = `${selectedRuntime}-${identityKind}`;
          if (selectedRuntime === "claude-code") {
            setChatModelRole(home, "claude-code", "default");
          } else {
            clearGhostModelRole(home, "chat_model");
          }

          if (identityKind === "duplicate" && selectedRuntime === "pi") {
            await host!.open("casper", id);
            await host!.close("casper", id);
          } else if (identityKind === "duplicate") {
            mkdirSync(sessionDir, { recursive: true });
            const now = new Date().toISOString();
            writeFileSync(claudeSessionMetadataPath(sessionDir, id), JSON.stringify({
              version: 1,
              runtime: "claude-code",
              conversationId: id,
              sessionId: "8f0a1c1e-0000-4000-8000-000000000000",
              created: now,
              modified: now,
              messageCount: 2,
            }), { encoding: "utf8", mode: 0o600 });
          }

          const preview = await host!.previewProject(
            "casper",
            id,
            oppositeRuntime,
            project,
          );
          await host!.bindProject("casper", id, oppositeRuntime, {
            root: project,
            trustToken: preview.trustToken,
            expectedGeneration: 0,
          });
          const selectedBinding = projectBindingPath(sessionDir, selectedRuntime, id);
          const oppositeBinding = projectBindingPath(sessionDir, oppositeRuntime, id);
          const selectedArtifact = selectedRuntime === "pi"
            ? join(sessionDir, sessionFileNameFor(id))
            : claudeSessionMetadataPath(sessionDir, id);
          const selectedBytes = existsSync(selectedArtifact)
            ? readFileSync(selectedArtifact, "utf8")
            : null;
          const oppositeBytes = readFileSync(oppositeBinding, "utf8");
          const providerRequests = provider!.requests.length;
          const events: PiMessagesEvent[] = [];

          await expect(host!.runTurn("casper", {
            sessionId: id,
            prompt: "ordinary owner message",
            emit: (event) => events.push(event),
          })).rejects.toMatchObject({ code: "project_runtime_mismatch", status: 409 });

          expect(events).toEqual([]);
          expect(provider!.requests).toHaveLength(providerRequests);
          expect(claudeQueries).toBe(0);
          expect(host!.cachedSessionCount).toBe(0);
          expect(existsSync(selectedBinding)).toBe(false);
          expect(existsSync(toolCwdsPath(sessionDir, id))).toBe(false);
          expect(readFileSync(oppositeBinding, "utf8")).toBe(oppositeBytes);
          if (selectedBytes === null) expect(existsSync(selectedArtifact)).toBe(false);
          else expect(readFileSync(selectedArtifact, "utf8")).toBe(selectedBytes);
      }
    }
  });

  it.each(["!printf ghost-bash", "!!printf secret", "!cd docs"])(
    "treats shell-like owner text as an ordinary Pi prompt: %s",
    async (prompt) => {
      await setup([{ kind: "text", text: "ordinary model answer" }]);
      const events: PiMessagesEvent[] = [];
      await host!.runTurn("casper", {
        sessionId: "literal-shell-like-prompt",
        prompt,
        emit: (event) => events.push(event),
      });

      expect(provider!.requests).toHaveLength(1);
      expect(JSON.stringify(provider!.requests[0]?.messages)).toContain(prompt);
      expect(events.at(-1)?.type).toBe("done");
      expect(JSON.stringify(events)).toContain("ordinary model answer");
    },
  );

  it("persists a memory file the ghost writes", async () => {
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ghost_memory_write",
        args: {
          content: "I explained the press. They wanted the story, not the spec sheet.",
          name: "explained-the-press.md",
        },
      },
      { kind: "text", text: "Written down." },
    ]);
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "Remember that.",
      emit: () => {},
    });

    const memoryDir = join(dir, "memory");
    const files = readdirSync(memoryDir).filter((name) => name.endsWith(".md"));
    expect(files).toContain("explained-the-press.md");
    expect(readFileSync(join(memoryDir, files[0]!), "utf8")).toContain("spec sheet");
  });

  it("refuses a second concurrent turn in the same conversation", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
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

  it("refuses conversation and whole-home moves during a raw collaboration-style turn", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "remote-delete",
            question: "Can the remote turn finish?",
            options: [{ label: "Yes" }, { label: "No" }],
          }],
        },
      },
      { kind: "text", text: "Finished remotely." },
    ]);
    const handle = await host!.open("casper", "conv-remote-delete");
    const remoteTurn = handle.session.prompt("Writable collaboration prompt.");
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
      results: [{ id: "remote-delete", selectedOptions: ["Yes"] }],
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
    await setup([{ kind: "text", text: "hello" }]);
    await expect(
      host!.runTurn("nobody", { sessionId: "c", prompt: "hi", emit: () => {} }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("legacy fork recovery", () => {
  async function seedLegacyFork(options: {
    version?: 1 | 2;
    transactionProbe?: SessionHostOptions["transactionProbe"];
  } = {}) {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [
      { kind: "text", text: "Legacy fork answer." },
      { kind: "text", text: "Resumed normally." },
    ] });
    seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const bindings = new ProjectBindingStore({
      ownerHome: temp.ownerHome,
      trustPath: join(temp.root, "state", "legacy-fork-trust.json"),
    });
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      projectBindings: bindings,
      offline: true,
      title: { enabled: false },
      ...(options.transactionProbe ? { transactionProbe: options.transactionProbe } : {}),
    });
    const conversationId = "legacy-fork";
    await host.runTurn("casper", {
      sessionId: conversationId,
      prompt: "Legacy fork question",
      emit: () => {},
    });
    await host.close("casper", conversationId);

    const sessionDir = ghostPaths(join(temp.root, "casper")).sessionDir;
    const transcript = join(sessionDir, sessionFileNameFor(conversationId));
    const binding = projectBindingPath(sessionDir, "pi", conversationId);
    const toolCwds = toolCwdsPath(sessionDir, conversationId);
    const token = "legacy-recovery";
    const temporaryTranscript = join(sessionDir, `.${basename(transcript)}.${token}.pending`);
    const temporaryBinding = `${binding}.${token}.pending`;
    const temporaryToolCwds = `${toolCwds}.${token}.pending`;
    const project = await host.getProject("casper", conversationId, "pi");
    await bindings.clone(sessionDir, "pi", conversationId, project, temporaryBinding);
    await writeToolCwds(
      sessionDir,
      conversationId,
      new Map([["legacy-tool", temp.ownerHome]]),
      temporaryToolCwds,
    );
    renameSync(transcript, temporaryTranscript);
    const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
    const marker = join(sessionDir, `.ghost-fork-${stem}.pending.json`);
    const version = options.version ?? 2;
    writeFileSync(marker, JSON.stringify({
      version,
      kind: "fork",
      conversationId,
      tempTranscript: temporaryTranscript,
      tempProjectBinding: temporaryBinding,
      ...(version === 2
        ? { tempProjectSnapshot: null, projectSnapshotGeneration: null }
        : {}),
      tempToolCwds: temporaryToolCwds,
    }), { mode: 0o600 });
    return {
      conversationId,
      sessionDir,
      transcript,
      binding,
      toolCwds,
      temporaryTranscript,
      temporaryBinding,
      temporaryToolCwds,
      marker,
    };
  }

  it.each([1, 2] as const)(
    "finishes a complete v%s publication and treats it as an ordinary conversation",
    async (version) => {
      const legacy = await seedLegacyFork({ version });

      expect((await host!.listSessions("casper")).map((row) => row.id))
        .toContain(`pi:${legacy.conversationId}`);
      expect(existsSync(legacy.marker)).toBe(false);
      expect(existsSync(legacy.transcript)).toBe(true);
      expect(existsSync(legacy.binding)).toBe(true);
      expect(existsSync(legacy.toolCwds)).toBe(true);
      expect(JSON.stringify(await host!.readTranscript("casper", legacy.conversationId)))
        .toContain("Legacy fork question");

      await host!.runTurn("casper", {
        sessionId: legacy.conversationId,
        prompt: "Continue this recovered conversation",
        emit: () => {},
      });
      expect(JSON.stringify(await host!.readTranscript("casper", legacy.conversationId)))
        .toContain("Resumed normally.");
      await expect(host!.deleteSession("casper", legacy.conversationId, "pi"))
        .resolves.toMatchObject({ artifacts: expect.any(Array) });
    },
  );

  it("rolls back an incomplete unpublished legacy fork", async () => {
    const legacy = await seedLegacyFork();
    unlinkSync(legacy.temporaryTranscript);

    expect((await host!.listSessions("casper")).map((row) => row.id))
      .not.toContain(`pi:${legacy.conversationId}`);
    for (const path of [
      legacy.marker,
      legacy.transcript,
      legacy.binding,
      legacy.toolCwds,
      legacy.temporaryBinding,
      legacy.temporaryToolCwds,
    ]) expect(existsSync(path)).toBe(false);
  });

  it("keeps a failed recovery hidden and retries the same publication", async () => {
    let rejectFsync = true;
    const legacy = await seedLegacyFork({
      transactionProbe: (stage) => {
        if (rejectFsync && stage === "fork-cleanup-fsync") {
          throw new Error("injected legacy recovery fsync failure");
        }
      },
    });

    expect((await host!.listSessions("casper")).map((row) => row.id))
      .not.toContain(`pi:${legacy.conversationId}`);
    expect(existsSync(legacy.marker)).toBe(true);
    rejectFsync = false;
    expect((await host!.listSessions("casper")).map((row) => row.id))
      .toContain(`pi:${legacy.conversationId}`);
    expect(existsSync(legacy.marker)).toBe(false);
  });

  it("blocks conversation and whole-home moves while an invalid marker remains", async () => {
    const legacy = await seedLegacyFork();
    renameSync(legacy.temporaryTranscript, legacy.transcript);
    writeFileSync(legacy.marker, JSON.stringify({
      version: 2,
      kind: "fork",
      conversationId: legacy.conversationId,
    }), { mode: 0o600 });

    expect((await host!.listSessions("casper")).map((row) => row.id))
      .not.toContain(`pi:${legacy.conversationId}`);
    await expect(host!.open("casper", legacy.conversationId))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    await expect(host!.deleteSession("casper", legacy.conversationId, "pi"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    const deleteMarker = join(
      legacy.sessionDir,
      `.ghost-delete-${sessionFileNameFor(legacy.conversationId).slice(0, -".jsonl".length)}.pi.pending.json`,
    );
    expect(existsSync(deleteMarker)).toBe(false);
    await expect(host!.renameGhost("casper", "renamed"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    await expect(host!.deleteGhost("casper"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    expect(existsSync(join(temp!.root, "casper"))).toBe(true);

    unlinkSync(legacy.marker);
    await expect(host!.renameGhost("casper", "renamed")).resolves.toMatchObject({ name: "renamed" });
  });

  it("marks in-flight legacy recovery as ghost-busy", async () => {
    const entered = deferred();
    const release = deferred();
    const legacy = await seedLegacyFork({
      transactionProbe: async (stage) => {
        if (stage !== "fork-cleanup-fsync") return;
        entered.resolve();
        await release.promise;
      },
    });
    const recovery = host!.listSessions("casper");
    await entered.promise;

    await expect(host!.renameGhost("casper", "renamed"))
      .rejects.toMatchObject({ code: "ghost_busy", status: 409 });
    release.resolve();
    await expect(recovery).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `pi:${legacy.conversationId}` }),
    ]));
  });
});

describe("multi-ghost", () => {
  it("keeps two ghosts separate while they answer concurrently", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "ghost_memory_write",
          args: { content: "Someone asked who I am." },
        },
        { kind: "text", text: "I am who I am." },
      ],
    });
    const casper = seedGhost(temp.root, {
      name: "casper",
      character: "# casper\n\nYou set type.\n",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const mina = seedGhost(temp.root, {
      name: "mina",
      character: "# mina\n\nYou keep bees.\n",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    for (const [dir, shellPath] of [[casper, "/bin/bash"], [mina, "/bin/sh"]] as const) {
      writeFileSync(ghostPaths(dir).settingsFile, `shellPath: ${shellPath}\n`);
    }
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
    });

    await Promise.all([
      host.runTurn("casper", { sessionId: "c", prompt: "Who are you?", emit: () => {} }),
      host.runTurn("mina", { sessionId: "c", prompt: "Who are you?", emit: () => {} }),
    ]);

    // Each ghost's session file and memory landed in its own home.
    for (const dir of [casper, mina]) {
      const paths = ghostPaths(dir);
      expect(existsSync(paths.sessionDir)).toBe(true);
      expect(readdirSync(paths.sessionDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
      expect(readdirSync(join(dir, "memory")).some((f) => f.endsWith(".md"))).toBe(true);
    }
    // Personas did not cross: each provider request carried one ghost's prompt.
    const systems = provider.requests.map((request) => request.system);
    expect(systems.some((system) => system.includes("set type"))).toBe(true);
    expect(systems.some((system) => system.includes("keep bees"))).toBe(true);
    for (const system of systems) {
      expect(system.includes("set type") && system.includes("keep bees")).toBe(false);
    }

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
  });
});

describe("session listing", () => {
  it("lists the ghost's own conversations in the sidebar shape", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
    await host!.runTurn("casper", { sessionId: "older", prompt: "one", emit: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host!.runTurn("casper", { sessionId: "newer", prompt: "two", emit: () => {} });
    const sessions = await host!.listSessions("casper");
    expect(sessions.map((session) => session.id)).toEqual(["pi:newer", "pi:older"]);
  });

  it("trashes a stored conversation and lets the id start fresh", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    await host!.runTurn("casper", { sessionId: "conv-delete", prompt: "one", emit: () => {} });
    const path = join(ghostPaths(dir).sessionDir, sessionFileNameFor("conv-delete"));
    const maintenancePath = maintenanceStatePath(
      ghostPaths(dir).sessionDir,
      "pi",
      "conv-delete",
    );
    writeFileSync(maintenancePath, "maintenance state\n", { mode: 0o600 });
    expect(existsSync(path)).toBe(true);

    const trashed = await host!.deleteSession("casper", "conv-delete");
    expect(existsSync(path)).toBe(false);
    expect(trashed.artifacts).toMatchObject([
      { artifact: "omp-transcript", source: path, kind: "fallback" },
      { artifact: "maintenance-state", source: maintenancePath, kind: "fallback" },
    ]);
    expect(existsSync(maintenancePath)).toBe(false);
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
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
      recoverLegacyForkTransactions(path: string, ghostName: string): Promise<void>;
      sessions: Map<string, typeof original>;
    };
    const recoverLegacyForkTransactions = internals.recoverLegacyForkTransactions.bind(internals);
    vi.spyOn(internals, "recoverLegacyForkTransactions").mockImplementation(async (path, ghostName) => {
      entered.resolve();
      await release.promise;
      await recoverLegacyForkTransactions(path, ghostName);
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

  it("drains conversation maintenance before publishing a deletion tombstone", async () => {
    const deleteDrain = deferred();
    let reservedIdentity: MaintenanceIdentity | undefined;
    let completedIdentity: MaintenanceIdentity | undefined;
    let released: string | undefined;
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      admitOwnerAction: () => ({
        ready: Promise.resolve(),
        finish: async () => {},
        release: () => {},
      }),
      reserveConversationDelete: (identity) => {
        reservedIdentity = identity;
        return {
          drained: deleteDrain.promise,
          release: (outcome) => {
            released = outcome;
          },
        };
      },
      completeConversationDelete: (identity) => {
        expect(released).toBeUndefined();
        completedIdentity = identity;
      },
      reserveGhostMove: () => ({ drained: Promise.resolve(), release: () => {} }),
      completeGhostRename: async () => {},
      completeGhostDelete: () => {},
      beginShutdown: async () => {},
      disposeAll: async () => {},
    };
    const { dir } = await setup([{ kind: "text", text: "hello" }], { maintenance });
    const id = "delete-maintenance-drain";
    await host!.runTurn("casper", { sessionId: id, prompt: "one", emit: () => {} });
    const sessionDir = ghostPaths(dir).sessionDir;
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);

    const deleting = host!.deleteSession("casper", id, "pi");
    expect(reservedIdentity).toEqual({
      ghostName: "casper",
      runtime: "pi",
      conversationId: id,
    });
    await Promise.resolve();
    expect(existsSync(tombstone)).toBe(false);
    expect(released).toBeUndefined();
    deleteDrain.resolve();
    await deleting;
    expect(existsSync(tombstone)).toBe(false);
    expect(completedIdentity).toEqual(reservedIdentity);
    expect(released).toBe("completed");
  });

  it("suppresses due maintenance and external idle hooks across tombstoned delete recovery", async () => {
    const hooks = new GhostHookRunner();
    const scheduled: Array<() => void> = [];
    let updateRuns = 0;
    let externalRuns = 0;
    let failFirstIntent = true;
    const retryEntered = deferred();
    const allowRetry = deferred();
    let blockRetryMove = true;
    const { dir } = await setup([{ kind: "text", text: "Remember this durably." }], {
      hooks,
      transactionProbe: async (stage) => {
        if (stage === "delete-intent-recorded" && failFirstIntent) {
          failFirstIntent = false;
          throw new Error("injected tombstone-stage failure");
        }
        if (stage === "delete-artifact-fsync" && blockRetryMove) {
          blockRetryMove = false;
          retryEntered.resolve();
          await allowRetry.promise;
        }
      },
    });
    const externalMutation = join(dir, "memory", "external-idle-must-not-run.md");
    const maintenance = new ConversationMaintenance({
      registry: temp!.registry,
      homeOperations: homeOperationsFor(temp!.registry),
      hooks,
      withRuntime: async () => {
        throw new Error("the injected updater does not borrow a model runtime");
      },
      idleSeconds: 1,
      schedule: (run) => {
        scheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
      update: async ({ writeMemory }) => {
        updateRuns += 1;
        await writeMemory({
          name: "maintenance-must-not-run",
          content: "This write must remain suppressed during deletion recovery.",
        });
      },
    });
    await hooks.register(maintenance.hookFactory);
    await hooks.register((api) => {
      api.on("conversation_idle", () => {
        externalRuns += 1;
        writeFileSync(externalMutation, "external idle mutation\n");
      }, { idleSeconds: 1 });
    });
    host!.setConversationMaintenance(maintenance);
    const id = "delete-maintenance-suppressed";
    await host!.runTurn("casper", {
      sessionId: id,
      prompt: "Remember this.",
      emit: () => {},
    });
    expect(scheduled).toHaveLength(1);

    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toThrow("injected tombstone-stage failure");
    scheduled[0]?.();
    expect(updateRuns).toBe(0);
    expect(externalRuns).toBe(0);
    expect(existsSync(externalMutation)).toBe(false);
    expect(existsSync(maintenanceStatePath(ghostPaths(dir).sessionDir, "pi", id))).toBe(true);

    const retry = host!.deleteSession("casper", id, "pi");
    await retryEntered.promise;
    scheduled[0]?.();
    expect(updateRuns).toBe(0);
    expect(externalRuns).toBe(0);
    expect(existsSync(externalMutation)).toBe(false);
    allowRetry.resolve();
    await retry;
    scheduled[0]?.();
    expect(updateRuns).toBe(0);
    expect(externalRuns).toBe(0);
    expect(existsSync(externalMutation)).toBe(false);
  });

  it("hides a tombstoned crash residue and resumes deletion before the raw id can reopen", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    await host!.runTurn("casper", {
      sessionId: "delete-recovery",
      prompt: "persist me",
      emit: () => {},
    });
    const project = join(temp!.root, "delete-recovery-project");
    mkdirSync(project);
    const preview = await host!.previewProject("casper", "delete-recovery", "pi", project);
    await host!.bindProject("casper", "delete-recovery", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
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
    await expect(host!.getProject("casper", "delete-recovery", "pi"))
      .rejects.toMatchObject({ code: "session_deleting" });
    await expect(host!.deleteSession("casper", "delete-recovery"))
      .resolves.toMatchObject({
        artifacts: expect.arrayContaining([
          expect.objectContaining({ artifact: "omp-transcript" }),
          expect.objectContaining({ artifact: "project-binding" }),
        ]),
      });
    expect(existsSync(tombstone)).toBe(false);
    expect(await host!.listSessions("casper")).toEqual([]);
  });

  it("durably accumulates every moved artifact and returns the full receipt after retries", async () => {
    let failAfterNextRecord = false;
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
      transactionProbe: (stage) => {
        if (stage === "delete-artifact-recorded" && failAfterNextRecord) {
          failAfterNextRecord = false;
          throw new Error("injected crash after durable delete record");
        }
      },
    });
    const id = "delete-v2-recovery";
    await host!.runTurn("casper", { sessionId: id, prompt: "persist me", emit: () => {} });
    const project = join(temp!.root, "delete-v2-project");
    mkdirSync(project);
    writeFileSync(join(project, "AGENTS.md"), "DELETE-V2-SNAPSHOT");
    const preview = await host!.previewProject("casper", id, "pi", project);
    await host!.bindProject("casper", id, "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const sessionDir = ghostPaths(dir).sessionDir;
    await writeToolCwds(sessionDir, id, new Map([["tool-call", temp!.ownerHome]]));
    writeFileSync(
      maintenanceStatePath(sessionDir, "pi", id),
      "durable maintenance sidecar\n",
      { mode: 0o600 },
    );
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const tombstone = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    const expectedKinds = [
      "omp-transcript",
      "tool-cwds",
      "project-binding",
      "maintenance-state",
      "project-snapshot",
    ];

    for (let moved = 1; moved <= expectedKinds.length; moved += 1) {
      failAfterNextRecord = true;
      await expect(host!.deleteSession("casper", id, "pi"))
        .rejects.toThrow("injected crash after durable delete record");
      const record = JSON.parse(readFileSync(tombstone, "utf8")) as {
        version: number;
        artifacts: TrashedConversation["artifacts"];
      };
      expect(record.version).toBe(3);
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
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
    expect(pending.version).toBe(3);
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
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
      ["credential store", { pending: pending("project-binding", agentDb) }],
      ["other transcript", { pending: pending("omp-transcript", victimTranscript) }],
      ["wrong label", { pending: pending("project-binding", targetTranscript) }],
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
          artifact: "project-binding",
          source: projectBindingPath(paths.sessionDir, "pi", target),
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

  it("claims synchronously and treats every non-absent draft/delete marker result as authoritative", async () => {
    let draftMarker = "";
    let deleteMarker = "";
    let injected: { path: string; code: "EACCES" | "EIO" } | null = null;
    let blocked: {
      path: string;
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    } | null = null;
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
      transactionMarkerLstat: async (path) => {
        if (blocked?.path === path) {
          blocked.entered.resolve();
          await blocked.release.promise;
        }
        if (injected?.path === path) {
          throw Object.assign(new Error(`injected ${injected.code}`), { code: injected.code });
        }
        return lstatAsync(path);
      },
    });
    const id = "marker-admission";
    await host!.runTurn("casper", { sessionId: id, prompt: "persist", emit: () => {} });
    await host!.listSessions("casper");
    const sessionDir = ghostPaths(dir).sessionDir;
    const stem = sessionFileNameFor(id).slice(0, -".jsonl".length);
    const transcript = join(sessionDir, sessionFileNameFor(id));
    const original = readFileSync(transcript, "utf8");
    draftMarker = join(sessionDir, `.ghost-draft-abandon-${stem}.pi.pending.json`);
    deleteMarker = join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`);
    const missing = join(temp!.root, "missing-marker-target");

    symlinkSync(missing, draftMarker);
    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    expect(lstatSync(draftMarker).isSymbolicLink()).toBe(true);
    expect(readFileSync(transcript, "utf8")).toBe(original);
    unlinkSync(draftMarker);

    symlinkSync(missing, deleteMarker);
    await expect(host!.deleteSession("casper", id, "pi"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(lstatSync(deleteMarker).isSymbolicLink()).toBe(true);
    expect(readFileSync(transcript, "utf8")).toBe(original);
    unlinkSync(deleteMarker);

    for (const code of ["EACCES", "EIO"] as const) {
      const draftBytes = `draft-${code}\n`;
      writeFileSync(draftMarker, draftBytes, { mode: 0o600 });
      injected = { path: draftMarker, code };
      await expect(host!.deleteSession("casper", id, "pi"), `draft ${code}`)
        .rejects.toMatchObject({ code: "session_busy", status: 409 });
      expect(readFileSync(draftMarker, "utf8"), `draft ${code}`).toBe(draftBytes);
      expect(readFileSync(transcript, "utf8"), `draft ${code}`).toBe(original);
      injected = null;
      unlinkSync(draftMarker);

      const deleteBytes = `delete-${code}\n`;
      writeFileSync(deleteMarker, deleteBytes, { mode: 0o600 });
      injected = { path: deleteMarker, code };
      await expect(host!.deleteSession("casper", id, "pi"), `delete ${code}`)
        .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
      expect(readFileSync(deleteMarker, "utf8"), `delete ${code}`).toBe(deleteBytes);
      expect(readFileSync(transcript, "utf8"), `delete ${code}`).toBe(original);
      injected = null;
      unlinkSync(deleteMarker);
    }

    const synchronousId = "synchronous-delete-claim";
    await host!.runTurn("casper", {
      sessionId: synchronousId,
      prompt: "persist",
      emit: () => {},
    });
    const synchronousStem = sessionFileNameFor(synchronousId).slice(0, -".jsonl".length);
    blocked = {
      path: join(
        sessionDir,
        `.ghost-draft-abandon-${synchronousStem}.pi.pending.json`,
      ),
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    const deleting = host!.deleteSession("casper", synchronousId, "pi");
    await blocked.entered.promise;
    const project = join(temp!.root, "claim-blocked-project");
    mkdirSync(project);
    await expect(host!.previewProject("casper", synchronousId, "pi", project))
      .rejects.toMatchObject({ code: "session_busy", status: 409 });
    blocked.release.resolve();
    await expect(deleting).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "omp-transcript" }),
      ]),
    });
  });

  it("filters exact malformed delete markers for both runtimes without trusting marker bytes", async () => {
    const logger = recordingLogger();
    const { dir } = await setup([{ kind: "text", text: "hello" }], {
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
    await expect(host!.getProject("casper", piId, "pi"))
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
    await expect(host!.getProject("casper", claudeId, "claude-code"))
      .rejects.toMatchObject({ code: "session_deleting", status: 409 });
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

describe("SessionHost.deleteGhost", () => {
  it("closes the ghost's conversations and moves the whole home into the trash", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
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

  it("blocks a new conversation while the ghost home is moving to trash", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
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
  it("drains maintenance and transfers its identity after the home rename but before release", async () => {
    const moveDrained = deferred();
    let reservedGhost = "";
    let completedRename: [string, string] | undefined;
    let reservationReleased = false;
    const maintenance: NonNullable<SessionHostOptions["maintenance"]> = {
      admitOwnerAction: () => ({
        ready: Promise.resolve(),
        finish: async () => {},
        release: () => {},
      }),
      reserveConversationDelete: () => ({ drained: Promise.resolve(), release: () => {} }),
      completeConversationDelete: () => {},
      reserveGhostMove: (ghostName) => {
        reservedGhost = ghostName;
        return {
          drained: moveDrained.promise,
          release: () => {
            reservationReleased = true;
          },
        };
      },
      completeGhostRename: async (previousName, nextName) => {
        expect(existsSync(join(temp!.root, previousName))).toBe(false);
        expect(existsSync(join(temp!.root, nextName))).toBe(true);
        expect(reservationReleased).toBe(false);
        completedRename = [previousName, nextName];
      },
      completeGhostDelete: () => {},
      beginShutdown: async () => {},
      disposeAll: async () => {},
    };
    await setup([{ kind: "text", text: "unused" }], { maintenance });

    const renaming = host!.renameGhost("casper", "wisp");
    expect(reservedGhost).toBe("casper");
    expect(existsSync(join(temp!.root, "casper"))).toBe(true);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(false);
    moveDrained.resolve();
    await expect(renaming).resolves.toMatchObject({ name: "wisp" });
    expect(completedRename).toEqual(["casper", "wisp"]);
    expect(reservationReleased).toBe(true);
  });

  it("moves the home and keeps every conversation, pin, and memory with it", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "one", emit: () => {} });
    await host!.renameConversation("casper", "conv-1", "First light");
    await host!.setPinned("casper", "conv-1", true);
    writeFileSync(join(dir, "memory", "press.md"), "The Vandercook is a proof press.\n", "utf8");

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
    expect(readFileSync(join(renamed.dir, "memory", "press.md"), "utf8"))
      .toContain("Vandercook");
    // The old name is gone from the API, and the renamed ghost still answers.
    await expect(host!.listSessions("casper"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
    await host!.runTurn("wisp", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect((await host!.readTranscript("wisp", "conv-1")).messages.length)
      .toBeGreaterThanOrEqual(4);
  });

  it("leaves owner-authored character Markdown unchanged across a rename", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
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
    await setup([{ kind: "text", text: "hello" }]);
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
    const fixture = await setup([{ kind: "text", text: "hello" }]);
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
    expect(await readPins(ghostPaths(dir).sessionDir)).toEqual(["pi:older"]);

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
    expect(await readPins(ghostPaths(dir).sessionDir)).toEqual([]);
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
    expect(await readPins(ghostPaths(dir).sessionDir)).toEqual([]);
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
    expect((await readPins(sessionDir)).sort()).toEqual(["pi:newer", "pi:older"]);
  });

  it("treats a malformed pins.json as nothing pinned", async () => {
    const { dir } = await twoConversations();
    const sessionDir = ghostPaths(dir).sessionDir;
    writeFileSync(join(sessionDir, "pins.json"), "{ not json at all", "utf8");

    expect((await host!.listSessions("casper")).map((session) => session.pinned))
      .toEqual([false, false]);
    // And a pin still lands, replacing the unreadable file wholesale.
    await host!.setPinned("casper", "older", true);
    expect(await readPins(sessionDir)).toEqual(["pi:older"]);
  });
});

describe("runtime-qualified conversation identity", () => {
  it("expands legacy raw owner state across collisions and migrates it on mutation", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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

});

describe("conversation titles", () => {
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

const transcriptText = async (sessionId: string) =>
  JSON.stringify((await host!.readTranscript("casper", sessionId)).messages);
const waitForTranscript = async (sessionId: string, text: string) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await transcriptText(sessionId)).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`transcript never contained ${JSON.stringify(text)}`);
};

describe("background jobs", () => {

  it("starts a background bash job and delivers its result as a follow-up turn", async () => {
    await setup([
      { kind: "tool", name: "bash", args: { command: "sleep 0.2; echo finished-job", background: true, label: "slow echo" } },
      { kind: "text", text: "Started it." },
      { kind: "text", text: "The job finished." },
    ]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", { sessionId: "conv-jobs", prompt: "Run it in the background.", emit: (event) => events.push(event) });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolName: "bash",
      isError: false,
      summary: expect.stringContaining("Started background job"),
    }));
    expect(host!.listJobs("casper", "conv-jobs")).toMatchObject([{ label: "slow echo", command: "sleep 0.2; echo finished-job" }]);

    await waitFor(() => provider!.requests.find((request) =>
      JSON.stringify(request.messages).includes("Background job") && JSON.stringify(request.messages).includes("finished-job")) ?? null, 10_000);
    await waitForTranscript("conv-jobs", "The job finished.");
    expect(host!.listJobs("casper", "conv-jobs")).toMatchObject([{ status: "completed", exitCode: 0, output: expect.stringContaining("finished-job") }]);

  });

  it("moves a long foreground command to the background after the wait budget", async () => {
    await setup([
      { kind: "tool", name: "bash", args: { command: "echo early; sleep 0.8; echo late-output" } },
      { kind: "text", text: "Carrying on." },
      { kind: "text", text: "Got the late output." },
    ], { jobs: { autoBackgroundMs: 200 } });
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", { sessionId: "conv-auto-jobs", prompt: "Run the slow thing.", emit: (event) => events.push(event) });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolName: "bash",
      isError: false,
      summary: expect.stringContaining("continuing as background job"),
    }));
    expect(host!.listJobs("casper", "conv-auto-jobs")).toMatchObject([{ status: "running" }]);
    await waitFor(() => provider!.requests.find((request) =>
      JSON.stringify(request.messages).includes("Background job") && JSON.stringify(request.messages).includes("late-output")) ?? null, 10_000);
    await waitForTranscript("conv-auto-jobs", "Got the late output.");
  });

  it("cancels a job through the host, keeps a session with running jobs, and kills jobs on close", async () => {
    await setup([
      { kind: "tool", name: "bash", args: { command: "sleep 30", background: true } },
      { kind: "text", text: "Waiting in the background." },
      { kind: "text", text: "Noted the cancellation." },
    ]);
    await host!.runTurn("casper", { sessionId: "conv-cancel-jobs", prompt: "Sleep in the background.", emit: () => {} });
    const [job] = host!.listJobs("casper", "conv-cancel-jobs");
    expect(job).toMatchObject({ status: "running" });

    expect(host!.cancelJob("casper", "conv-cancel-jobs", "missing")).toMatchObject({ outcome: "not_found", job: null });
    expect(host!.cancelJob("casper", "conv-cancel-jobs", job!.id)).toMatchObject({ outcome: "cancelled" });
    await waitFor(() => host!.listJobs("casper", "conv-cancel-jobs")[0]?.status === "cancelled" ? true : null);
    await waitFor(() => provider!.requests.find((request) =>
      JSON.stringify(request.messages).includes("Background job") && JSON.stringify(request.messages).includes("was cancelled")) ?? null, 10_000);
    await waitForTranscript("conv-cancel-jobs", "Noted the cancellation.");
    expect(host!.cancelJob("casper", "conv-cancel-jobs", job!.id)).toMatchObject({ outcome: "already_settled" });

    await host!.close("casper", "conv-cancel-jobs");
    expect(host!.listJobs("casper", "conv-cancel-jobs")).toEqual([]);
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

    expect(await host!.renameConversation("casper", "conv-1", "  Press day  ")).toBe("Press day");
    expect(await titleOf()).toBe("Press day");
    // The reopened conversation still resumes, with the new name on it.
    const handle = await host!.open("casper", "conv-1");
    expect(handle.session.sessionName).toBe("Press day");
  });

  it("renames a conversation that is mid-turn", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "ready",
            question: "Ready?",
            options: [{ label: "Yes" }, { label: "No" }],
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
    // A title write touches the title slot, not the turn: the answer the owner
    // is about to give still lands on a running conversation.
    expect(await host!.renameConversation("casper", "conv-live", "Watching it work"))
      .toBe("Watching it work");
    host!.answerAsk("casper", "conv-live", pending.id, {
      kind: "submit",
      results: [{ id: "ready", selectedOptions: ["Yes"] }],
    });
    await turn;
    expect(await titleOf("conv-live")).toBe("Watching it work");
  });

  it("refuses a Claude Code conversation, whose name that runtime owns", async () => {
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
    expect((await host!.listSessions("casper")).map((session) => session.id))
      .toContain("claude-code:claude-conv");
    await expect(host!.renameConversation("casper", "claude-conv", "Mine now", "claude-code"))
      .rejects.toMatchObject({ code: "not_supported", status: 409 });
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
    setChatModelRole(paths.home, "ghost-local", "model-b");
    await host.rebindModel("casper");

    // The SAME cached conversation now answers on model-b.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-b");
  });

  it("rebinds a cleared chat role through the same OMP default resolver", async () => {
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
    setChatModelRole(paths.home, "ghost-local", "model-b");
    await host.rebindModel("casper");
    await inflight;

    // The in-flight turn still ran on model-a — it was not rebound mid-turn.
    expect(provider.requests.at(-1)?.model).toBe("model-a");

    // The deferred switch applied once the turn settled: the next turn is model-b.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-b");
  });

  it("defers a model rebind until a raw collaboration-style turn settles", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "ask",
          args: {
            questions: [{
              id: "remote-model",
              question: "Keep this model for the current turn?",
              options: [{ label: "Yes" }, { label: "No" }],
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
    setChatModelRole(paths.home, "ghost-local", "model-b");
    await host.rebindModel("casper");
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-a" });

    host.answerAsk("casper", "conv-remote-model", pending.id, {
      kind: "submit",
      results: [{ id: "remote-model", selectedOptions: ["Yes"] }],
    });
    await remoteTurn;
    await waitFor(() => handle.model?.id === "model-b" ? true : null);
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-b" });
  });

  it("defers a switch while voice is active and applies it when voice stops", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "unused" }] });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    writeGhostModels(paths.home, twoModelFile(provider.url));
    const voice = testLiveVoice();
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      liveVoice: voice.manager,
    });
    const handle = await host.open("casper", "conv-voice-model");
    await host.liveVoiceAction("casper", "conv-voice-model", "start");

    setChatModelRole(paths.home, "ghost-local", "model-b");
    await host.rebindModel("casper");
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-a" });

    await host.liveVoiceAction("casper", "conv-voice-model", "stop");
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-b" });
  });

  it("applies a deferred switch after voice startup fails", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "unused" }] });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    writeGhostModels(paths.home, twoModelFile(provider.url));
    const voice = testLiveVoice(startGate, new Error("microphone unavailable"));
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      liveVoice: voice.manager,
    });
    const handle = await host.open("casper", "conv-voice-start-failure");
    const starting = host.liveVoiceAction("casper", "conv-voice-start-failure", "start");
    await voice.startEntered;

    setChatModelRole(paths.home, "ghost-local", "model-b");
    await host.rebindModel("casper");
    releaseStart();
    await expect(starting).rejects.toMatchObject({ code: "live_start_failed", status: 502 });

    expect(host.liveVoiceStatus("casper", "conv-voice-start-failure")).toMatchObject({
      active: false,
      phase: "error",
      error: "microphone unavailable",
    });
    expect(handle.model).toEqual({ provider: "ghost-local", id: "model-b" });
  });
});

describe("transcript resume", () => {
  it("projects a legacy Pi bash execution as readable assistant text", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const timestamp = Date.parse("2026-08-31T12:00:00.000Z");
    const handle = await host!.open("casper", "legacy-bash");
    handle.session.sessionManager.appendMessage({
      role: "bashExecution",
      command: "printf legacy",
      output: "legacy output\n",
      exitCode: 7,
      cancelled: false,
      truncated: true,
      excludeFromContext: true,
      timestamp,
    });

    expect((await host!.readTranscript("casper", "legacy-bash")).messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        timestamp,
        content: [{
          type: "text",
          text: "$ printf legacy\nlegacy output\n[output truncated]\n[exit 7]",
        }],
      }),
    ]);
  });

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
      { kind: "tool", name: "ghost_character", args: { action: "read" } },
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
    expect(live).toEqual([["read", true], ["ghost_character", false]]);

    const calls = (await host!.readTranscript("casper", "conv-1")).messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => (part as { type?: unknown }).type === "toolCall") as Array<{
        name: string;
        failed?: boolean;
        cwd?: string | null;
      }>;
    expect(calls.map((call) => [call.name, call.failed === true]))
      .toEqual([["read", true], ["ghost_character", false]]);
    expect(calls.map((call) => call.cwd)).toEqual([temp!.ownerHome, temp!.ownerHome]);
  });

  it("404s an unknown conversation id", async () => {
    await setup([{ kind: "text", text: "hello" }]);
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
    // The interview ends by writing the character file with the ghost's own tool.
    expect(system).toContain("ghost_character");
    // And it is a ritual, not a gate.
    expect(system).toContain("Help with the owner's request first");
  });

  it("stops once the character file has been written", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    // `setup` seeds a ghost whose character.md the owner wrote.
    const system = await systemPromptFor("casper");
    expect(system).toContain("letterpress printer");
    expect(system).not.toContain("## First meeting");
  });
});
