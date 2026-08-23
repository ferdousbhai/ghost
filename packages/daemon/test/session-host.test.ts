/**
 * Session host against a mock provider. No real model is ever called.
 *
 * The properties under test are the ones the spike found are easy to lose:
 * sessions inside the ghost home, no built-in tools, a persona that fully
 * replaces pi's coding-agent prompt, and two ghosts staying separate while
 * answering at the same time in one process.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { ghostToolNamesFor } from "@ghost/extensions";
import { GhostHookRunner } from "../src/hooks.js";
import {
  PI_BUILTIN_TOOL_NAMES,
  SessionHost,
  sessionFileNameFor,
  sessionKeyOf,
} from "../src/session-host.js";

/**
 * Every tool a creator session may expose. The real invariant is "only the
 * ghost's own extension tools, nothing from pi" — a name prefix was a loose
 * proxy for it, and the vision fallback tool is deliberately `look_at_image`
 * (a model-facing verb, not `ghost_`-prefixed), so assert membership instead.
 */
const CREATOR_GHOST_TOOLS = new Set([...ghostToolNamesFor({}), "ask"]);
import type { PiMessagesEvent } from "../src/pi-messages.js";
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

const PUBLIC_NOTE = `---
public: true
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
    notes: { "press.md": PUBLIC_NOTE },
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

  it("exposes only the ghost's own tools — no bash, no filesystem", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    const handle = await host!.open("casper", "conv-1");
    const names = handle.session.getActiveToolNames();

    expect(names.length).toBeGreaterThan(0);
    for (const builtin of PI_BUILTIN_TOOL_NAMES) {
      expect(names, `built-in ${builtin} must not be active`).not.toContain(builtin);
    }
    for (const name of names) {
      expect(CREATOR_GHOST_TOOLS, `${name} must be a ghost tool`).toContain(name);
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

  it("does not load extensions dropped into the ghost home", async () => {
    const { dir } = await setup([{ kind: "text", text: "hello" }]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const extDir = join(dir, ".pi", "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "evil.ts"),
      `export default function (pi: any) {
         pi.registerTool({ name: "evil_tool", label: "evil", description: "no",
           parameters: { type: "object", properties: {} },
           execute: async () => ({ content: [] }) });
       }\n`,
      "utf8",
    );
    await host!.close("casper", "conv-1");
    const handle = await host!.open("casper", "conv-1");
    expect(handle.session.getActiveToolNames()).not.toContain("evil_tool");
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
      { kind: "tool", name: "ghost_notes_list", args: {} },
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
    expect(toolStart).toMatchObject({ toolName: "ghost_notes_list" });

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
    expect(provider!.requests).toHaveLength(2);
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
        ghostAsk?: { resultEntryId?: string; count?: number };
      };
    expect(askCall.ghostAsk).toMatchObject({ count: 1 });
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
        ghostAsk?: { index?: number; count?: number; previousTargetId?: string };
      };
    expect(revisedCall.ghostAsk).toMatchObject({ index: 1, count: 2 });
    expect(revisedCall.ghostAsk?.previousTargetId).toBeTruthy();
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

  it("awaits session_stop and keeps a blocked revision inside one streamed turn", async () => {
    const hooks = new GhostHookRunner();
    const active: boolean[] = [];
    await hooks.register((api) => {
      api.on("session_stop", (event) => {
        active.push(event.stop_hook_active);
        if (!event.stop_hook_active) {
          return { decision: "block", reason: "Rewrite the answer without canned phrasing." };
        }
      });
    });
    await setup([
      { kind: "text", text: "Great question!" },
      { kind: "text", text: "Here is the direct answer." },
    ], hooks);

    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conv-hooks",
      prompt: "Answer me.",
      emit: (event) => events.push(event),
    });

    expect(provider!.requests).toHaveLength(2);
    expect(active).toEqual([false, true]);
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

  it("gives the provider the ghost's persona and none of pi's coding prompt", async () => {
    await setup([{ kind: "text", text: "hi" }]);
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "Who are you?",
      emit: () => {},
    });

    const request = provider!.requests[0];
    expect(request?.system).toContain("casper");
    expect(request?.system).toContain("letterpress printer");
    // pi's coding-agent prompt and its built-in tools are both absent.
    expect(request?.system.toLowerCase()).not.toContain("coding agent");
    expect(request?.toolNames ?? []).not.toContain("bash");
    for (const name of request?.toolNames ?? []) {
      expect(CREATOR_GHOST_TOOLS, `${name} must be a ghost tool`).toContain(name);
    }
  });

  it("persists a memory file the ghost writes", async () => {
    const { dir } = await setup([
      {
        kind: "tool",
        name: "ghost_memory_write",
        args: {
          description: "A visitor asked about the press",
          content: "They wanted the story, not the spec sheet.",
          name: "visitor-asked-about-press.md",
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
    expect(files).toContain("visitor-asked-about-press.md");
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

describe("conversation branching", () => {
  it("rewinds a user message into a draft and keeps both sibling branches navigable", async () => {
    await setup([{ kind: "text", text: "A branch-aware answer." }]);
    await host!.runTurn("casper", {
      sessionId: "conv-tree",
      prompt: "Original question",
      emit: () => {},
    });
    await host!.runTurn("casper", {
      sessionId: "conv-tree",
      prompt: "Original follow-up",
      emit: () => {},
    });
    const original = await host!.readTranscript("casper", "conv-tree");
    const firstUser = original.messages.find((message) => message.role === "user")!;

    const rewound = await host!.branchConversation("casper", "conv-tree", firstUser.entryId);
    expect(rewound.draft).toBe("Original question");
    expect(rewound.transcript.messages).toEqual([]);

    await host!.runTurn("casper", {
      sessionId: "conv-tree",
      prompt: "Alternative question",
      emit: () => {},
    });
    const alternative = await host!.readTranscript("casper", "conv-tree");
    const alternativeUser = alternative.messages.find((message) => message.role === "user")!;
    expect(alternativeUser.branch).toMatchObject({ index: 1, count: 2 });
    expect(alternativeUser.branch?.previousTargetId).toBeTruthy();
    expect(JSON.stringify(alternative.messages)).not.toContain("Original follow-up");

    const navigated = await host!.navigateConversation(
      "casper",
      "conv-tree",
      alternativeUser.branch!.previousTargetId!,
    );
    expect(JSON.stringify(navigated.transcript.messages)).toContain("Original follow-up");
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
      character: "---\npublic: true\ntitle: casper\n---\n\n# casper\n\nYou set type.\n",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const mina = seedGhost(temp.root, {
      name: "mina",
      character: "---\npublic: true\ntitle: mina\n---\n\n# mina\n\nYou keep bees.\n",
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
