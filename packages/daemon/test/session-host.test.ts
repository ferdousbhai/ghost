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
import { PI_BUILTIN_TOOL_NAMES, SessionHost, sessionFileNameFor } from "../src/session-host.js";
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

async function setup(script: Parameters<typeof startMockProvider>[0]["script"]) {
  temp = makeTempGhosts();
  provider = await startMockProvider({ script });
  const dir = seedGhost(temp.root, {
    name: "casper",
    notes: { "press.md": PUBLIC_NOTE },
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  host = new SessionHost({ registry: temp.registry, offline: true });
  return { dir, host, provider, temp };
}

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

  it("exposes only the ghost's own tools — no bash, no filesystem", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    const handle = await host!.open("casper", "conv-1");
    const names = handle.session.getActiveToolNames();

    expect(names.length).toBeGreaterThan(0);
    for (const builtin of PI_BUILTIN_TOOL_NAMES) {
      expect(names, `built-in ${builtin} must not be active`).not.toContain(builtin);
    }
    expect(names.every((name) => name.startsWith("ghost_"))).toBe(true);
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
    expect(request?.toolNames.every((name) => name.startsWith("ghost_"))).toBe(true);
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
  it("lists the ghost's own sessions", async () => {
    await setup([{ kind: "text", text: "hello" }]);
    await host!.runTurn("casper", { sessionId: "conv-1", prompt: "hi", emit: () => {} });
    const sessions = await host!.listSessions("casper");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.messageCount).toBeGreaterThan(0);
    expect(sessions[0]?.path).toContain(`${sep}.sessions${sep}`);
  });
});
