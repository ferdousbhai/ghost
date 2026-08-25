/**
 * Session host against a mock provider. No real model is ever called.
 *
 * The properties under test are the ones the spike found are easy to lose:
 * sessions inside the ghost home, native OMP tools and discovery, a
 * Ghost persona layered onto the harness, and two ghosts staying separate
 * while answering at the same time in one process.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import {
  openAiCompatiblePreset,
  setChatModelRole,
  writeGhostModels,
  type GhostModelDefinition,
  type GhostModelsFile,
} from "../src/models.js";
import { GhostHookRunner } from "../src/hooks.js";
import {
  SessionHost,
  forkConversationTitle,
  parseUserBashCommand,
  sessionFileNameFor,
  sessionKeyOf,
} from "../src/session-host.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { readPins, writePins } from "../src/pins.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";

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

const TEST_DOC = `---
title: Restoring the Vandercook
---

Pull the roller bearings before you soak anything.
`;

async function setup(
  script: Parameters<typeof startMockProvider>[0]["script"],
  hooks?: GhostHookRunner,
) {
  temp = makeTempGhosts();
  provider = await startMockProvider({ script });
  const dir = seedGhost(temp.root, {
    name: "casper",
    docs: { "press.md": TEST_DOC },
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  host = new SessionHost({
    registry: temp.registry,
    offline: true,
    ...(hooks ? { hooks } : {}),
  });
  return { dir, host, provider, temp };
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
    expect(sessionKeyOf("casper", "")).toBe(sessionKeyOf("casper", undefined));
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

  it("binds the configured model before open() resolves", async () => {
    // The model bind is awaited (not fire-and-forget), so by the time open()
    // returns the session already reports the configured model — a first
    // prompt cannot race ahead of the bind onto pi's default.
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

  it("loads native OMP project extensions from the ghost home", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const extDir = join(dir, ".omp", "extensions");
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

  it("loads only the ghost home's project MCP, never ambient coding-agent MCP", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const { mkdirSync } = await import("node:fs");
    const ompDir = join(dir, ".omp");
    const serverPath = join(dir, "project-mcp.mjs");
    mkdirSync(ompDir, { recursive: true });
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
      description: "Echo from the ghost home's project MCP.",
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
      join(ompDir, "mcp.json"),
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

  it("discovers OMP project context and supports /skill:name invocation", async () => {
    const { dir } = await setup([{ kind: "text", text: "skill applied" }]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Workshop rule\nAlways identify the composing stick.\n",
      "utf8",
    );
    const skillDir = join(dir, ".omp", "skills", "press-review");
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

describe("SessionHost.runTurn", () => {
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
      writeGhostModels(ghostPaths(dir).agentDir, {
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
      const { dir } = await setup([ASK_STEP, { kind: "text", text: "Matte it is." }]);
      // OMP reads `ask.timeout` (seconds) from the ghost home's own config, the
      // only lever a test has on the auto-select deadline.
      mkdirSync(join(dir, ".omp"), { recursive: true });
      writeFileSync(join(dir, ".omp", "config.yml"), "ask:\n  timeout: 1\n", "utf8");
      const turn = host!.runTurn("casper", {
        sessionId: "conv-timedout",
        prompt: "Choose a finish.",
        emit: () => {},
      });
      await waitFor(() => host!.pendingAsk("casper", "conv-timedout"));
      await turn;

      expect(await settledOf("conv-timedout")).toBe("timedOut");
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
    const hooks = new GhostHookRunner();
    const active: boolean[] = [];
    const passes: unknown[][] = [];
    await hooks.register((api) => {
      api.on("session_stop", (event) => {
        active.push(event.stop_hook_active);
        passes.push(event.messages);
        if (!event.stop_hook_active) {
          return { decision: "block", reason: "Rewrite the answer without canned phrasing." };
        }
      });
    });
    await setup([
      // Avoid OMP's own canned-phrasing retry: this test owns the retry via
      // Ghost's session_stop hook and must observe both passes itself.
      { kind: "text", text: "The first answer circles around the point." },
      { kind: "text", text: "Here is the direct answer." },
    ], hooks);

    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-hooks",
      prompt: "Answer me.",
      emit: (event) => events.push(event),
    });

    expect(active).toEqual([false, true]);
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
  });

  it("injects before_prompt context into the user turn without an extra model pass", async () => {
    const hooks = new GhostHookRunner();
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Avoid the warning from the previous reply.",
      }));
    });
    await setup([{ kind: "text", text: "Direct answer." }], hooks);

    await host!.runTurn("casper", {
      sessionId: "conv-before-prompt",
      prompt: "Continue.",
      emit: () => {},
    });

    expect(provider!.requests).toHaveLength(1);
    expect(JSON.stringify(provider!.requests[0]?.messages)).toContain(
      "Avoid the warning from the previous reply.",
    );
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
    await expect(host!.deleteSession("casper", "conv-busy-delete")).resolves.toBeUndefined();
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
    expect(forked.transcript.id).toBe(forked.sessionId);

    // The source keeps every entry, its leaf, and its title.
    const after = await host!.readTranscript("casper", "conv-tree");
    expect(after.messages).toEqual(before.messages);
    expect(JSON.stringify(after.messages)).toContain("Original follow-up");
    expect(after.title).toBe("Weekend trip");

    // The copy is a first-class conversation: listed, and resumable by its id.
    const listed = await host!.listSessions("casper");
    expect(listed.map((row) => row.id)).toContain(forked.sessionId);
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
    expect(listed.find((row) => row.id === forked.sessionId)?.title).toBeNull();
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
    expect(listed.map((row) => row.id)).toEqual(["conv-tree"]);
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
    expect(sessions[0]?.id).toBe("conv-1");
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
    expect(sessions.map((session) => session.id)).toEqual(["newer", "older"]);
  });

  it("deletes a stored conversation and lets the id start fresh", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    await host!.runTurn("casper", { sessionId: "conv-delete", prompt: "one", emit: () => {} });
    const path = join(ghostPaths(dir).sessionDir, sessionFileNameFor("conv-delete"));
    expect(existsSync(path)).toBe(true);

    await host!.deleteSession("casper", "conv-delete");
    expect(existsSync(path)).toBe(false);
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
      .toEqual([["older", true], ["newer", false]]);
    expect(await readPins(ghostPaths(dir).sessionDir)).toEqual(["older"]);

    // Pinning is idempotent, and pinning both falls back to recency.
    await host!.setPinned("casper", "older", true);
    await host!.setPinned("casper", "newer", true);
    expect((await host!.listSessions("casper")).map((session) => session.id))
      .toEqual(["newer", "older"]);
  });

  it("unpins, idempotently", async () => {
    const { dir } = await twoConversations();
    await host!.setPinned("casper", "older", true);
    await host!.setPinned("casper", "older", false);
    await host!.setPinned("casper", "older", false);
    expect((await host!.listSessions("casper")).map((session) => session.id))
      .toEqual(["newer", "older"]);
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
    expect((await host!.listSessions("casper")).map((session) => session.id)).toEqual(["newer"]);
  });

  it("ignores a stale id on read and prunes it on the next write", async () => {
    const { dir } = await twoConversations();
    const sessionDir = ghostPaths(dir).sessionDir;
    await writePins(sessionDir, ["ghost-of-a-conversation", "older"]);

    expect((await host!.listSessions("casper")).map((s) => [s.id, s.pinned]))
      .toEqual([["older", true], ["newer", false]]);

    await host!.setPinned("casper", "newer", true);
    expect((await readPins(sessionDir)).sort()).toEqual(["newer", "older"]);
  });

  it("treats a malformed pins.json as nothing pinned", async () => {
    const { dir } = await twoConversations();
    const sessionDir = ghostPaths(dir).sessionDir;
    writeFileSync(join(sessionDir, "pins.json"), "{ not json at all", "utf8");

    expect((await host!.listSessions("casper")).map((session) => session.pinned))
      .toEqual([false, false]);
    // And a pin still lands, replacing the unreadable file wholesale.
    await host!.setPinned("casper", "older", true);
    expect(await readPins(sessionDir)).toEqual(["older"]);
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

  it("rebinds a cached session so the next turn runs the newly selected model", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "ok" }] });
    const dir = seedGhost(temp.root, { name: "casper" });
    const paths = ghostPaths(dir);
    writeGhostModels(paths.agentDir, twoModelFile(provider.url));
    host = new SessionHost({ registry: temp.registry, offline: true });

    // First turn: the session is built once and cached, bound to model-a.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "one", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-a");

    // Switch the role on disk exactly as ModelCatalog.setChatModel does, then
    // fire the same rebind hook it invokes. Without the rebind the cached
    // session would answer on model-a forever.
    setChatModelRole(paths.agentDir, "ghost-local", "model-b");
    await host.rebindModel("casper");

    // The SAME cached conversation now answers on model-b.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-b");
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
    writeGhostModels(paths.agentDir, twoModelFile(provider.url));
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
    setChatModelRole(paths.agentDir, "ghost-local", "model-b");
    await host.rebindModel("casper");
    await inflight;

    // The in-flight turn still ran on model-a — it was not rebound mid-turn.
    expect(provider.requests.at(-1)?.model).toBe("model-a");

    // The deferred switch applied once the turn settled: the next turn is model-b.
    await host.runTurn("casper", { sessionId: "conv-1", prompt: "two", emit: () => {} });
    expect(provider.requests.at(-1)?.model).toBe("model-b");
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
    expect(transcript.id).toBe("conv-1");
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
      ghostPaths(ghost.dir).agentDir,
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
