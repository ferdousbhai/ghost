/**
 * Session host against a mock provider. No real model is ever called.
 *
 * The properties under test are the ones the spike found are easy to lose:
 * sessions inside the ghost home, native OMP tools and discovery, a
 * Ghost persona layered onto the harness, and two ghosts staying separate
 * while answering at the same time in one process.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSessionMetadataPath } from "../src/claude-code.js";
import { GHOST_COMPACTION_PROMPT } from "../src/compaction.js";
import { withGhostArtifactRoot } from "../src/artifact-root.js";
import { ghostPaths } from "../src/ghosts.js";
import {
  clearGhostModelRole,
  openAiCompatiblePreset,
  setChatModelRole,
  writeGhostModels,
  type GhostModelDefinition,
  type GhostModelsFile,
} from "../src/models.js";
import { GhostHookRunner } from "../src/hooks.js";
import { migrateHostedConversations } from "../src/hosted-conversation-import.js";
import { LiveVoiceManager, type LiveVoiceStatus } from "../src/live-voice.js";
import {
  CollaborationManager,
  type CollaborationStatus,
} from "../src/collaboration.js";
import {
  SessionHost,
  forkConversationTitle,
  parseUserBashCommand,
  sessionFileNameFor,
  sessionKeyOf,
  type SessionHostOptions,
} from "../src/session-host.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { readPins, writePins } from "../src/pins.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import {
  createMockProviderBarrier,
  startMockProvider,
  type MockProvider,
} from "./helpers/mock-provider.js";

let temp: TempGhosts | null = null;
let provider: MockProvider | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  await provider?.close();
  provider = null;
  temp?.cleanup();
  temp = null;
});

const TEST_DOC = `# Restoring the Vandercook

Pull the roller bearings before you soak anything.
`;

function writeMcpFixture(
  dir: string,
  options: { enabled?: boolean; empty?: boolean } = {},
): void {
  const serverPath = join(dir, "reload-mcp.mjs");
  if (!existsSync(serverPath)) {
    writeFileSync(
      serverPath,
      `import { createInterface } from "node:readline";
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
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: options.empty ? {} : {
        reload_fixture: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath],
          ...(options.enabled === false ? { enabled: false } : {}),
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
    | "askTimeoutSeconds"
    | "liveVoice"
    | "collaboration"
    | "compaction"
    | "title"
    | "retention"
    | "conversationMaintenance"
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
    offline: true,
    ...options,
  });
  return { dir, host, provider, temp };
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

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for state");
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

function cleanupErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(cleanupErrorMessages);
  return [error instanceof Error ? error.message : String(error)];
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
  it("recognizes OMP's contextual and context-free command sigils", () => {
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

describe("OMP slash commands", () => {
  it("discovers the live OMP catalog and annotates Ghost's execution policy", async () => {
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
    // Ghost augments OMP's headless builder result with the unified registry so
    // an OMP user's familiar TUI-only commands remain discoverable but honest.
    expect(commands).toContainEqual(expect.objectContaining({
      name: "plan",
      source: "builtin",
      availability: "unsupported",
      unavailableReason: expect.stringContaining("interactive terminal UI"),
    }));
  });

  it("reports that an active Claude Code runtime has no OMP command catalog", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    setChatModelRole(ghostPaths(dir).home, "claude-code", "default");

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
      ["conv-plan", "/plan make a plan", "/plan"],
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
  it("keeps sessions, settings, and models inside the ghost home", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const handle = await host!.open("casper", "conv-1");

    const paths = ghostPaths(dir);
    expect(handle.sessionFile).toBeDefined();
    expect(handle.sessionFile!.startsWith(paths.sessionDir + sep)).toBe(true);
    expect(handle.sessionFile).toBe(join(paths.sessionDir, sessionFileNameFor("conv-1")));
    expect(handle.model).toEqual({ provider: "ghost-local", id: provider!.modelId });
  });

  it("leaves OMP retry behavior under the ghost home's own settings", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    writeFileSync(
      ghostPaths(dir).settingsFile,
      "retry:\n  modelFallback: false\n  fallbackRevertPolicy: never\n",
      "utf8",
    );

    const handle = await host!.open("casper", "conv-owner-retry");
    expect(handle.session.settings.get("retry.modelFallback")).toBe(false);
    expect(handle.session.settings.get("retry.fallbackRevertPolicy")).toBe("never");
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

    expect(names).toEqual(expect.arrayContaining([
      "read",
      "bash",
      "edit",
    ]));
    // Xdev may mount these behind read/write instead of advertising them at
    // top level; either way they are present in OMP's native registry.
    for (const name of ["write", "grep", "glob", "task", "hub", "web_search"]) {
      expect(handle.session.getToolByName(name), `${name} must be available`).toBeDefined();
    }
    // OMP may mount non-core capabilities under xd:// instead of advertising
    // them as top-level tools, but they remain invokable through its registry.
    for (const name of ["ghost_memory_write", "ghost_browser", "ghost_desktop"]) {
      expect(handle.session.getToolByName(name), `${name} must be available`).toBeDefined();
    }
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
    expect(handle.session.getToolByName("project_tool")).toBeDefined();
  });

  it("loads only the ghost home's MCP, never ambient coding-agent MCP", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const serverPath = join(dir, "project-mcp.mjs");
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
      serverInfo: { name: "ghost-project-fixture", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    send(request.id, { tools: [{
      name: "project_echo",
      description: "Echo from the ghost home's MCP.",
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
          ghost_project: {
            command: process.execPath,
            args: [serverPath],
          },
        },
      }),
      "utf8",
    );

    const handle = await host!.open("casper", "conv-mcp");
    const toolNames = handle.session.getAllToolInfos().map((tool) => tool.name);
    expect(toolNames).toContain("mcp__ghost_project_project_echo");
    // This machine deliberately has `node_repl` in ~/.codex/config.toml. Its
    // absence here is the live sovereignty regression, not a mocked condition.
    expect(toolNames.some((name) => name.startsWith("mcp__node_repl_"))).toBe(false);
  });

  it("discovers skills, agents, and commands from plain directories in the home", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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

    expect(handle.session.skills.map((skill) => skill.name)).toContain("inking");
    expect(handle.session.slashCommands?.map((command) => command.name) ?? [])
      .toContain("proofsheet");
    mkdirSync(join(dir, "skills", "engraving"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "engraving", "SKILL.md"),
      "---\nname: engraving\ndescription: Cut an engraving.\n---\n\nCut it.\n",
      "utf8",
    );
    await handle.session.refreshSkills();
    expect(handle.session.skills.map((skill) => skill.name)).toContain("engraving");
    // Subagents are discovered when `task` runs rather than at open, so assert
    // against the same discovery the tool uses.
    const { discoverAgents } = await import("@oh-my-pi/pi-coding-agent/task/discovery");
    const agents = await withGhostArtifactRoot(dir, () => discoverAgents(dir));
    expect(agents.agents.map((agent) => agent.name)).toContain("pressman");
    // The owner's global skills keep arriving alongside the ghost's own.
    expect(handle.session.skills.length).toBeGreaterThan(1);
  });

  it("keeps the owner's coding-agent identity file out of the prompt", async () => {
    // OMP hands the session exactly one user-level context file, the
    // highest-priority provider's, and Claude Code outranks the agent-dirs
    // provider. Excluding ~/.claude/CLAUDE.md drops instructions that open by
    // telling the model it is a coding agent, and is also what lets
    // ~/.agents/AGENTS.md through in its place.
    //
    // Bun resolves os.homedir() once per process, so this reads the real home
    // rather than a fixture, in the same spirit as the ambient-MCP check above.
    const ownerClaudeMd = join(homedir(), ".claude", "CLAUDE.md");
    const ownerAgentsMd = join(homedir(), ".agents", "AGENTS.md");
    if (!existsSync(ownerClaudeMd)) return;

    await setup([{ kind: "text", text: "hello" }]);
    const handle = await host!.open("casper", "conv-owner-context");
    const prompt = handle.session.systemPrompt.join("\n");

    const claudeLine = readFileSync(ownerClaudeMd, "utf8")
      .split("\n")
      .find((line) => line.trim().length > 0);
    expect(claudeLine).toBeDefined();
    expect(prompt).not.toContain(claudeLine!);

    // The other half of the same rule, once the owner has written one.
    if (existsSync(ownerAgentsMd)) {
      const agentsLine = readFileSync(ownerAgentsMd, "utf8")
        .split("\n")
        .find((line) => line.trim().length > 0);
      expect(agentsLine).toBeDefined();
      expect(prompt).toContain(agentsLine!);
    }
  });

  it("discovers OMP project context and supports /skill:name invocation", async () => {
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
    expect(handle.session.skills.map((skill) => skill.name)).toContain("press-review");
    expect(handle.session.systemPrompt.join("\n")).toContain(
      "Always identify the composing stick",
    );

    await host!.runTurn("casper", {
      sessionId: "conv-skill",
      prompt: "/skill:press-review focus on the rollers",
      emit: () => {},
    });
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
    expect(opened.session.isDisposed).toBe(true);

    await host!.disposeAll();
    expect(disposals).toBe(1);
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
    expect(first.session.isDisposed).toBe(false);
    expect(second.session.isDisposed).toBe(true);
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
    expect(opened.session.isDisposed).toBe(false);

    barrier.release();
    await turn;
    expect(host!.cachedSessionCount).toBe(1);
  });

  it("times out hung title providers so they cannot protect an unbounded cache", async () => {
    const titleSignals: AbortSignal[] = [];
    await setup([{ kind: "text", text: "done" }], {
      retention: { idleTtlMs: 0, maxSessions: 1 },
      title: {
        timeoutMs: 100,
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
    await waitFor(() => host!.cachedSessionCount === 1 ? true : null);
    expect(titleSignals).toHaveLength(2);
    await waitFor(() => titleSignals.every((signal) => signal.aborted) ? true : null);
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
      override async stop(): Promise<LiveVoiceStatus> {
        throw new Error("voice teardown failed");
      }
    }
    class FailingCollaborationManager extends CollaborationManager {
      override async stop(): Promise<CollaborationStatus> {
        throw new Error("collaboration teardown failed");
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
    expect(handle.session.isDisposed).toBe(true);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(host!.cachedSessionCount).toBe(0);

    await expect(host!.close("casper", "conv-failed-close")).resolves.toBeUndefined();
    expect(closeRuntime).toHaveBeenCalledOnce();
  });

  it("attempts every Pi cleanup stage when lifecycle hooks fail", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    writeMcpFixture(dir);
    const handle = await host!.open("casper", "conv-fault-isolation");
    const internals = handle as typeof handle & {
      mcp: { manager: { disconnectAll(): Promise<void> } };
    };
    expect(internals.mcp).toBeDefined();

    const originalBeginDispose = handle.session.beginDispose.bind(handle.session);
    let beginDisposeAttempts = 0;
    const beginDispose = vi.spyOn(handle.session, "beginDispose").mockImplementation(() => {
      originalBeginDispose();
      beginDisposeAttempts += 1;
      if (beginDisposeAttempts === 1) throw new Error("begin dispose failed after starting");
    });
    const originalDisconnect = internals.mcp.manager.disconnectAll.bind(internals.mcp.manager);
    const disconnect = vi.spyOn(internals.mcp.manager, "disconnectAll").mockImplementation(async () => {
      await originalDisconnect();
      throw new Error("MCP disconnect failed after stopping");
    });
    const originalSessionDispose = handle.session.dispose.bind(handle.session);
    const sessionDispose = vi.spyOn(handle.session, "dispose").mockImplementation(async (options) => {
      await originalSessionDispose(options);
      throw new Error("session dispose failed after stopping");
    });
    const runtime = authRuntimeForTest(handle);
    const originalRuntimeClose = runtime.close.bind(runtime);
    const runtimeClose = vi.spyOn(runtime, "close").mockImplementation(() => {
      originalRuntimeClose();
      throw new Error("runtime close failed after stopping");
    });

    const close = host!.close("casper", "conv-fault-isolation");
    await expect(close).rejects.toBeInstanceOf(AggregateError);
    const failure = await close.catch((error: unknown) => error as AggregateError);
    expect(cleanupErrorMessages(failure)).toEqual(expect.arrayContaining([
      "begin dispose failed after starting",
      "MCP disconnect failed after stopping",
      "session dispose failed after stopping",
      "runtime close failed after stopping",
    ]));
    expect(beginDispose).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(sessionDispose).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(host!.cachedSessionCount).toBe(0);

    const beginCalls = beginDispose.mock.calls.length;
    await expect(host!.close("casper", "conv-fault-isolation")).resolves.toBeUndefined();
    expect(beginDispose).toHaveBeenCalledTimes(beginCalls);
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("force cleanup continues across sessions after synchronous lifecycle failures", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const first = await host!.open("casper", "conv-force-first");
    const second = await host!.open("casper", "conv-force-second");

    const firstBeginOriginal = first.session.beginDispose.bind(first.session);
    let firstBeginAttempts = 0;
    vi.spyOn(first.session, "beginDispose").mockImplementation(() => {
      firstBeginOriginal();
      firstBeginAttempts += 1;
      if (firstBeginAttempts === 1) throw new Error("first begin dispose failed after starting");
    });
    const firstRuntime = authRuntimeForTest(first);
    const firstCloseOriginal = firstRuntime.close.bind(firstRuntime);
    vi.spyOn(firstRuntime, "close").mockImplementation(() => {
      firstCloseOriginal();
      throw new Error("first runtime close failed after stopping");
    });

    const secondBeginOriginal = second.session.beginDispose.bind(second.session);
    const secondBegin = vi.spyOn(second.session, "beginDispose").mockImplementation(() => {
      secondBeginOriginal();
    });
    const secondDisposeOriginal = second.session.dispose.bind(second.session);
    const secondDispose = vi.spyOn(second.session, "dispose").mockImplementation((options) =>
      secondDisposeOriginal(options)
    );
    const secondRuntime = authRuntimeForTest(second);
    const secondCloseOriginal = secondRuntime.close.bind(secondRuntime);
    const secondClose = vi.spyOn(secondRuntime, "close").mockImplementation(() => {
      secondCloseOriginal();
    });

    host!.forceDisposeAll();
    await waitFor(() => secondDispose.mock.calls.length > 0 ? true : null);
    expect(secondBegin).toHaveBeenCalled();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(host!.cachedSessionCount).toBe(0);

    const secondBeginCalls = secondBegin.mock.calls.length;
    host!.forceDisposeAll();
    expect(secondBegin).toHaveBeenCalledTimes(secondBeginCalls);
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
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
    expect(handle.session.getToolByName(toolName)).toBeUndefined();

    writeMcpFixture(dir, { empty: true });
    await host!.reloadMcp("casper");
    expect(handle.session.getToolByName(toolName)).toBeUndefined();

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(handle.session.getToolByName(toolName)).toBeDefined();
  });

  it("mounts the first server across open conversations and unmounts disabled or removed tools", async () => {
    const { dir } = await setup([{ kind: "text", text: "unused" }]);
    const first = await host!.open("casper", "conv-mcp-first");
    const second = await host!.open("casper", "conv-mcp-second");
    const toolName = "mcp__reload_fixture_reload_echo";
    expect(first.session.getToolByName(toolName)).toBeUndefined();
    expect(second.session.getToolByName(toolName)).toBeUndefined();

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(first.session.getToolByName(toolName)).toBeDefined();
    expect(second.session.getToolByName(toolName)).toBeDefined();
    expect(host!.mcpConnectionStatus("casper", "reload_fixture")).toBe("connected");

    writeMcpFixture(dir, { enabled: false });
    await host!.reloadMcp("casper");
    expect(first.session.getToolByName(toolName)).toBeUndefined();
    expect(second.session.getToolByName(toolName)).toBeUndefined();

    writeMcpFixture(dir);
    await host!.reloadMcp("casper");
    expect(first.session.getToolByName(toolName)).toBeDefined();
    writeMcpFixture(dir, { empty: true });
    await host!.reloadMcp("casper");
    expect(first.session.getToolByName(toolName)).toBeUndefined();
    expect(second.session.getToolByName(toolName)).toBeUndefined();
  });

  it("defers a busy conversation's reload until its turn settles", async () => {
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
    await host!.reloadMcp("casper");
    expect(handle.session.getToolByName(toolName)).toBeUndefined();
    host!.answerAsk("casper", "conv-mcp-busy", pending.id, {
      kind: "submit",
      results: [{ id: "ready", selectedOptions: ["Yes"] }],
    });
    await turn;

    expect(handle.session.getToolByName(toolName)).toBeDefined();
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
    expect(handle.session.getToolByName(toolName)).toBeUndefined();
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("deferred");

    host!.answerAsk("casper", "conv-mcp-remote", pending.id, {
      kind: "submit",
      results: [{ id: "remote-ready", selectedOptions: ["Yes"] }],
    });
    await remoteTurn;
    await waitFor(() => handle.session.getToolByName(toolName) ? true : null);
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
    expect(handle.session.getToolByName(toolName)).toBeUndefined();
    await expect(host!.reconnectMcp("casper", "reload_fixture")).resolves.toBe("deferred");

    await host!.liveVoiceAction("casper", "conv-mcp-voice", "stop");
    expect(handle.session.getToolByName(toolName)).toBeDefined();
    expect(host!.mcpConnectionStatus("casper", "reload_fixture")).toBe("connected");
  });
});

describe("SessionHost.runTurn", () => {
  it("lets OMP compact and retry a context overflow with Ghost's summary prompt", async () => {
    await setup([
      { kind: "text", text: "First context recorded." },
      { kind: "text", text: "Second context recorded." },
      {
        kind: "error",
        status: 400,
        body: JSON.stringify({
          error: {
            message: "maximum context length is 128000 tokens",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
      },
      { kind: "text", text: "A faithful compacted briefing." },
      { kind: "text", text: "Recovered after compaction." },
    ], {
      title: { enabled: false },
    }, {
      sequential: true,
    });
    const opened = await host!.open("casper", "conv-overflow");
    opened.session.settings.override("compaction.keepRecentTokens", 100);
    opened.session.settings.override("compaction.methodOrder", ["soft"]);

    const run = (prompt: string, emit: (event: PiMessagesEvent) => void = () => {}) =>
      host!.runTurn("casper", { sessionId: "conv-overflow", prompt, emit });
    await run(`Keep this first block. ${"letterpress context ".repeat(500)}`);
    await run(`Keep this second block. ${"workshop state ".repeat(500)}`);

    const events: PiMessagesEvent[] = [];
    await run("Continue despite the provider overflow.", (event) => events.push(event));

    expect(events.at(-1)?.type).toBe("done");
    expect(events
      .filter((event): event is Extract<PiMessagesEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.delta)
      .join(""))
      .toContain("Recovered after compaction");
    expect(provider!.requests.some((request) =>
      JSON.stringify(request.messages).includes(GHOST_COMPACTION_PROMPT.slice(0, 80))))
      .toBe(true);
    expect(readFileSync(opened.sessionFile!, "utf8")).toContain('"type":"compaction"');
  }, 15_000);

  it("does not hold the next turn behind OMP speculative compaction", async () => {
    let releaseCompaction!: () => void;
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });
    await setup([
      {
        kind: "text",
        text: "First context recorded.",
        usage: { promptTokens: 10_000 },
      },
      {
        kind: "text",
        text: "Second context recorded.",
        usage: { promptTokens: 45_000 },
      },
      { kind: "text", text: "Speculative briefing.", gate: compactionGate },
      { kind: "text", text: "The next turn stayed responsive." },
    ], {
      compaction: { enabled: true, thresholdTokens: 50_000 },
      title: { enabled: false },
    }, {
      sequential: true,
    });
    const opened = await host!.open("casper", "conv-speculation");
    opened.session.settings.override("compaction.keepRecentTokens", 100);
    opened.session.settings.override("compaction.methodOrder", ["soft"]);

    const run = (prompt: string, emit: (event: PiMessagesEvent) => void = () => {}) =>
      host!.runTurn("casper", { sessionId: "conv-speculation", prompt, emit });
    await run(`Keep this first block. ${"letterpress context ".repeat(500)}`);
    await run(`Keep this second block. ${"workshop state ".repeat(500)}`);
    await waitFor(() => provider!.requests.length >= 3 ? true : null);
    expect(JSON.stringify(provider!.requests[2]?.messages))
      .toContain(GHOST_COMPACTION_PROMPT.slice(0, 80));

    const events: PiMessagesEvent[] = [];
    const nextTurn = run("Answer while the summary is still running.", (event) => events.push(event));
    const completedBeforeCompaction = await Promise.race([
      nextTurn.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseCompaction();
    await nextTurn;

    expect(completedBeforeCompaction).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(events
      .filter((event): event is Extract<PiMessagesEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.delta)
      .join(""))
      .toContain("stayed responsive");
  }, 15_000);

  it("hands a failed primary turn to its ordered OMP fallback", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      modelId: "primary-model",
      script: [{
        kind: "error",
        status: 400,
        body: JSON.stringify({
          error: { message: "model unavailable", type: "invalid_request_error", code: "model_not_found" },
        }),
      }],
    });
    const fallback = await startMockProvider({
      modelId: "fallback-model",
      script: [{ kind: "text", text: "Fallback answered." }],
    });
    try {
      const dir = seedGhost(temp.root, { name: "casper" });
      const primaryFile = openAiCompatiblePreset({
        providerId: "primary",
        baseUrl: provider.url,
        modelId: provider.modelId,
        apiKey: "primary-key",
      });
      const fallbackFile = openAiCompatiblePreset({
        providerId: "fallback",
        baseUrl: fallback.url,
        modelId: fallback.modelId,
        apiKey: "fallback-key",
      });
      writeGhostModels(ghostPaths(dir).home, {
        providers: { ...primaryFile.providers, ...fallbackFile.providers },
        roles: { chat_model: { provider: "primary", modelId: provider.modelId } },
        fallbacks: {
          chat_model: [{ provider: "fallback", modelId: fallback.modelId }],
        },
      });
      host = new SessionHost({ registry: temp.registry, offline: true });
      const opened = await host.open("casper", "conv-fallback");
      expect(opened.session.settings.get("modelRoles")).toEqual({
        default: "primary/primary-model",
      });
      expect(opened.session.settings.get("retry.fallbackChains")).toEqual({
        default: ["fallback/fallback-model"],
      });
      const events: PiMessagesEvent[] = [];
      await host.runTurn("casper", {
        sessionId: "conv-fallback",
        prompt: "Please answer even if the primary is busy.",
        emit: (event) => events.push(event),
      });

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.model).toBe("primary-model");
      expect(fallback.requests).toHaveLength(1);
      expect(fallback.requests[0]?.model).toBe("fallback-model");
      expect(events).toContainEqual(expect.objectContaining({
        type: "model_fallback",
        phase: "applied",
        from: "primary/primary-model",
        to: "fallback/fallback-model",
        role: "default",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "model_fallback",
        phase: "succeeded",
        model: "fallback/fallback-model",
      }));
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      await fallback.close();
    }
  }, 15_000);

  it("runs a tool-using turn and streams a well-formed pi-messages sequence", async () => {
    await setup([
      { kind: "tool", name: "ghost_character", args: { action: "read" } },
      { kind: "text", text: "Pull the roller bearings first." },
    ]);
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "What did you restore?",
      emit: (event) => events.push(event),
    });

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("start");
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_end");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
    expect(types.filter((type) => type === "done" || type === "error")).toHaveLength(1);

    // Content indices are dense and monotonic across both provider steps.
    const indices = events
      .filter((event) => "contentIndex" in event)
      .map((event) => (event as { contentIndex: number }).contentIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(indices)).toEqual(new Set([0, 1]));

    const toolStart = events.find((event) => event.type === "toolcall_start");
    expect(toolStart).toMatchObject({ toolName: "ghost_character" });

    const text = events
      .filter((event): event is Extract<PiMessagesEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toContain("roller bearings");
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
    const opened = await host!.open("casper", "conv-ask");
    // Ghost owns the desktop interaction. OMP's notifier hard-codes its own
    // product identity, so it must stay off even though the HTTP broker can
    // still present and resolve the ask.
    expect(opened.session.settings.get("ask.notify")).toBe("off");
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

  it("re-opens a historical ask, commits a sibling answer, and resumes that branch", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "finish",
            header: "Finish",
            question: "Which finish should I use?",
            options: [{ label: "Matte" }, { label: "Gloss" }],
            recommended: 0,
          }],
        },
      },
      { kind: "text", text: "I will use that finish." },
    ]);
    const firstTurn = host!.runTurn("casper", {
      sessionId: "conv-reanswer",
      prompt: "Help choose the finish.",
      emit: () => {},
    });
    const firstAsk = await waitFor(() => host!.pendingAsk("casper", "conv-reanswer"));
    host!.answerAsk("casper", "conv-reanswer", firstAsk.id, {
      kind: "submit",
      results: [{ id: "finish", selectedOptions: ["Matte"] }],
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

    const events: PiMessagesEvent[] = [];
    const reanswer = host!.runAskReanswer("casper", {
      sessionId: "conv-reanswer",
      entryId: resultEntryId!,
      emit: (event) => events.push(event),
    });
    const revisedAsk = await waitFor(() => host!.pendingAsk("casper", "conv-reanswer"));
    host!.answerAsk("casper", "conv-reanswer", revisedAsk.id, {
      kind: "submit",
      results: [{ id: "finish", selectedOptions: ["Gloss"] }],
    });
    await reanswer;

    expect(events.some((event) => event.type === "branch_changed")).toBe(true);
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

  it("queues OMP steering and follow-up messages while a turn is live", async () => {
    await setup([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "ready",
            question: "Ready to continue?",
            options: [{ label: "Yes" }, { label: "No" }],
          }],
        },
      },
      { kind: "text", text: "I adjusted the direction." },
      { kind: "text", text: "And handled the follow-up." },
    ]);
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
      results: [{ id: "ready", selectedOptions: ["Yes"] }],
    });
    await turn;
    const requests = JSON.stringify(provider!.requests.map((request) => request.messages));
    expect(requests).toContain("Use the quieter direction.");
    expect(requests).toContain("Then explain the tradeoff.");
    expect(host!.queuedMessages("casper", "conv-queue").count).toBe(0);
  });

  it("awaits session_stop and sends only the current assistant pass", async () => {
    const hooks = new GhostHookRunner({ conversationIdleDelayMs: 0 });
    const active: boolean[] = [];
    const passes: unknown[][] = [];
    const ownerPrompts: string[] = [];
    const idleEvents: Array<{ conversation: string; outcome: string; idleFor: number }> = [];
    let idleResolve!: () => void;
    const idle = new Promise<void>((resolve) => { idleResolve = resolve; });
    await hooks.register((api) => {
      api.on("session_stop", (event) => {
        active.push(event.stop_hook_active);
        passes.push(event.messages);
        ownerPrompts.push(event.owner_prompt);
        if (!event.stop_hook_active) {
          return { decision: "block", reason: "Rewrite the answer without canned phrasing." };
        }
      });
      api.on("conversation_idle", (event) => {
        idleEvents.push({
          conversation: event.conversation_id,
          outcome: event.last_turn_outcome,
          idleFor: event.idle_for_ms,
        });
        idleResolve();
      });
    });
    await setup([
      // Avoid OMP's own canned-phrasing retry: this test owns the retry via
      // Ghost's session_stop hook and must observe both passes itself.
      { kind: "text", text: "The first answer circles around the point." },
      { kind: "text", text: "Here is the direct answer." },
    ], { hooks });

    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-hooks",
      prompt: "Answer me.",
      emit: (event) => events.push(event),
    });

    expect(active).toEqual([false, true]);
    expect(ownerPrompts).toEqual(["Answer me.", "Answer me."]);
    expect(passes).toHaveLength(2);
    expect(passes.every((messages) => messages.length === 1)).toBe(true);
    expect(passes.map((messages) => JSON.stringify(messages))).toEqual([
      expect.stringContaining("The first answer circles around the point."),
      expect.stringContaining("Here is the direct answer."),
    ]);
    expect(JSON.stringify(passes)).not.toContain("Answer me.");
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    await idle;
    expect(idleEvents).toHaveLength(1);
    expect(idleEvents[0]).toMatchObject({ conversation: "conv-hooks", outcome: "completed" });
    expect(idleEvents[0]!.idleFor).toBeGreaterThanOrEqual(0);
  });

  it("injects before_prompt context into the user turn without an extra model pass", async () => {
    const hooks = new GhostHookRunner();
    const acknowledge = vi.fn();
    const recordTurn = vi.fn(async () => {});
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Avoid the warning from the previous reply.",
        acknowledge,
      }));
    });
    await setup([{ kind: "text", text: "Direct answer." }], {
      hooks,
      conversationMaintenance: { recordTurn, forgetConversation: vi.fn(async () => {}) },
    });

    await host!.runTurn("casper", {
      sessionId: "conv-before-prompt",
      prompt: "Continue.",
      emit: () => {},
    });

    expect(provider!.requests).toHaveLength(1);
    expect(JSON.stringify(provider!.requests[0]?.messages)).toContain(
      "Avoid the warning from the previous reply.",
    );
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "omp",
      conversationId: "conv-before-prompt",
      ownerPrompt: "Continue.",
      assistantText: "Direct answer.",
      outcome: "completed",
    }));
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
    expect(handle.session.getToolByName("ghost_memory_write")).toBeDefined();
  });

  it("runs !command through OMP without asking the model", async () => {
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

  it("refuses a model-requested interactive PTY without running its command", async () => {
    const marker = "pty-command-must-not-run";
    const { dir } = await setup([
      {
        kind: "tool",
        name: "bash",
        args: { command: `touch ${marker}`, pty: true },
      },
      { kind: "text", text: "The interactive terminal was unavailable." },
    ]);
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conv-pty",
      prompt: "Run this in an interactive terminal.",
      emit: (event) => events.push(event),
    });

    expect(existsSync(join(dir, marker))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      summary: expect.stringContaining("headless daemon"),
    }));
    expect(events.at(-1)?.type).toBe("done");
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

  it("lets !cd move OMP's cwd without moving or forgetting the ghost home", async () => {
    const { dir } = await setup([{ kind: "text", text: "still Casper" }]);
    await host!.runTurn("casper", {
      sessionId: "conv-cd",
      prompt: "!cd docs",
      emit: () => {},
    });
    const handle = await host!.open("casper", "conv-cd");
    expect(handle.session.sessionManager.getCwd()).toBe(join(dir, "docs"));
    expect(handle.sessionFile?.startsWith(ghostPaths(dir).sessionDir + sep)).toBe(true);

    await host!.runTurn("casper", {
      sessionId: "conv-cd",
      prompt: "Do you still know who you are?",
      emit: () => {},
    });
    expect(provider!.requests.at(-1)?.system).toContain("letterpress printer");
  });

  it("persists a memory file the ghost writes", async () => {
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ghost_memory_write",
        args: {
          description: "I explained the press",
          content: "They wanted the story, not the spec sheet.",
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
      artifacts: [{ artifact: "omp-transcript", kind: "freedesktop" }],
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
    await expect(host!.deleteSession("casper", "conv-remote-delete"))
      .resolves.toMatchObject({
        artifacts: [{ artifact: "omp-transcript", kind: "freedesktop" }],
      });
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
  /** Two turns in one conversation, with a title, ready to branch off. */
  async function seedBranchable(title: string | null = "Weekend trip") {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "A branch-aware answer." }] });
    seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
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
    return { firstUser: original.messages.find((message) => message.role === "user")! };
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

  it("names each copy with the next free counter and never stacks counters", async () => {
    const { firstUser } = await seedBranchable();

    const first = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    expect(first.title).toBe("Weekend trip (2)");
    const second = await host!.forkConversation("casper", "conv-tree", firstUser.entryId);
    expect(second.title).toBe("Weekend trip (3)");

    // Branching a branch strips the counter before re-applying it.
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
});

describe("multi-ghost", () => {
  it("keeps two ghosts separate while they answer concurrently", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "ghost_memory_write",
          args: { description: "Who asked", content: "Someone asked who I am." },
        },
        { kind: "text", text: "I am who I am." },
      ],
    });
    const casper = seedGhost(temp.root, {
      name: "casper",
      character: "---\ntitle: casper\n---\n\n# casper\n\nYou set type.\n",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const mina = seedGhost(temp.root, {
      name: "mina",
      character: "---\ntitle: mina\n---\n\n# mina\n\nYou keep bees.\n",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    host = new SessionHost({ registry: temp.registry, offline: true });

    await Promise.all([
      host.runTurn("casper", { sessionId: "c", prompt: "Who are you?", emit: () => {} }),
      host.runTurn("mina", { sessionId: "c", prompt: "Who are you?", emit: () => {} }),
    ]);

    // Each ghost's session file and memory landed in its own home.
    for (const dir of [casper, mina]) {
      const paths = ghostPaths(dir);
      expect(existsSync(paths.sessionDir)).toBe(true);
      expect(readdirSync(paths.sessionDir).length).toBe(1);
      expect(readdirSync(join(dir, "memory")).some((f) => f.endsWith(".md"))).toBe(true);
    }
    // Personas did not cross: each provider request carried one ghost's prompt.
    const systems = provider.requests.map((request) => request.system);
    expect(systems.some((system) => system.includes("set type"))).toBe(true);
    expect(systems.some((system) => system.includes("keep bees"))).toBe(true);
    for (const system of systems) {
      expect(system.includes("set type") && system.includes("keep bees")).toBe(false);
    }
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
    expect(existsSync(path)).toBe(true);

    const trashed = await host!.deleteSession("casper", "conv-delete");
    expect(existsSync(path)).toBe(false);
    expect(trashed.artifacts).toMatchObject([
      { artifact: "omp-transcript", source: path, kind: "freedesktop" },
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

  it("trashes a hosted fixture with its projection so startup cannot resurrect it", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const conversations = join(dir, "conversations");
    const source = join(conversations, "imported.json");
    writeFileSync(source, JSON.stringify({
      id: "imported",
      catalog: {
        id: "imported",
        title: "Imported chat",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      messages: [],
    }));
    expect(await migrateHostedConversations(dir)).toMatchObject({ imported: 1 });

    const trashed = await host!.deleteSession("casper", "imported");

    expect(trashed.artifacts.map((entry) => entry.artifact))
      .toEqual(["hosted-source", "omp-transcript"]);
    expect(existsSync(source)).toBe(false);
    expect(await migrateHostedConversations(dir)).toEqual({
      found: 0,
      imported: 0,
      existing: 0,
      failures: [],
    });
    expect(await host!.listSessions("casper")).toEqual([]);
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

  it("follows the rename into a seeded character title and leaves a written one alone", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    const written = seedGhost(temp!.root, {
      name: "mina",
      character: "---\ntitle: The Archivist\n---\n\n# mina\n\nYou are mina.\n",
    });

    const wisp = await host!.renameGhost("casper", "wisp");
    expect(readFileSync(ghostPaths(wisp.dir).characterFile, "utf8"))
      .toContain("title: wisp");
    // The rest of the persona is the ghost's own words and is untouched.
    expect(readFileSync(ghostPaths(wisp.dir).characterFile, "utf8"))
      .toContain("letterpress printer");

    const renamedMina = await host!.renameGhost("mina", "vera");
    expect(readFileSync(ghostPaths(renamedMina.dir).characterFile, "utf8"))
      .toContain("title: The Archivist");
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
  /** Two conversations, `older` first, so ordering is unambiguous. */
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
      "utf8",
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
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
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
    }), "utf8");
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
      "utf8",
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

  function authRuntimeOf(handle: Awaited<ReturnType<SessionHost["open"]>>) {
    return (handle as typeof handle & {
      modelRuntime: {
        authStorage: { reload(): Promise<void> };
        modelRegistry: {
          hydrateCredentialScopedModelCaches(): Promise<void>;
          refresh(mode: "offline"): Promise<void>;
        };
      };
    }).modelRuntime;
  }

  it("reloads cached credential and model state before an idle refresh resolves", async () => {
    await setup([{ kind: "text", text: "unused" }]);
    const handle = await host!.open("casper", "conv-auth-idle");
    const runtime = authRuntimeOf(handle);
    const reload = vi.spyOn(runtime.authStorage, "reload");
    const hydrate = vi.spyOn(runtime.modelRegistry, "hydrateCredentialScopedModelCaches");
    const refresh = vi.spyOn(runtime.modelRegistry, "refresh");

    await host!.refreshAuth("casper");

    expect(reload).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith("offline");
  });

  it("defers a login refresh that lands mid-turn until the owner releases", async () => {
    const barrier = createMockProviderBarrier();
    await setup([{ kind: "text", text: "held", barrier }]);
    const handle = await host!.open("casper", "conv-auth-busy");
    const runtime = authRuntimeOf(handle);
    const reload = vi.spyOn(runtime.authStorage, "reload");

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
      }>;
    expect(calls.map((call) => [call.name, call.failed === true]))
      .toEqual([["read", true], ["ghost_character", false]]);
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
    expect(system).toContain("## Your first meeting");
    expect(system).toContain("one question at a time");
    // The interview ends by writing the character file with the ghost's own tool.
    expect(system).toContain("ghost_character");
    // And it is a ritual, not a gate.
    expect(system).toContain("Their request always comes first");
  });

  it("stops once the character file has been written", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    // `setup` seeds a ghost whose character.md the owner wrote.
    const system = await systemPromptFor("casper");
    expect(system).toContain("letterpress printer");
    expect(system).not.toContain("## Your first meeting");
  });
});
