import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";

let temp: TempGhosts | null = null;
let provider: MockProvider | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  await provider?.close();
  provider = null;
  temp?.cleanup();
  temp = null;
});

async function setup(): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  provider = await startMockProvider({ script: [{ kind: "text", text: "hello" }] });
  seedGhost(temp.root, {
    name: "casper",
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    scheduleUnitDir: join(temp.ownerHome, ".config", "systemd", "user"),
    scheduleRuntimeUnitDir: join(temp.ownerHome, ".runtime", "systemd", "user"),
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    machineSkillPaths: [],
    offline: true,
    title: { enabled: false },
  });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    port: 0,
    apiToken: null,
  });
  return `http://127.0.0.1:${listening.port}`;
}

const TURN_BODY = {
  model: "ghost/casper",
  context: { messages: [{ role: "user", content: "Who are you?" }] },
  options: { sessionId: "conv-1" },
};

async function postTurn(base: string): Promise<void> {
  const response = await fetch(`${base}/api/ghosts/casper/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(TURN_BODY),
  });
  expect(response.status).toBe(200);
  await response.text();
}

async function nextEvent(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
): Promise<{
  type: string;
  id: string;
  conversationId: string;
  runtime: "pi";
  updatedAt: string;
}> {
  const decoder = new TextDecoder();
  let buffer = "";
  const read = async () => {
    for (;;) {
      const frameEnd = buffer.indexOf("\n\n");
      if (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
        if (line) return JSON.parse(line.slice(5).trim()) as {
          type: string;
          id: string;
          conversationId: string;
          runtime: "pi";
          updatedAt: string;
        };
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("conversation event stream ended");
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/gu, "\n");
    }
  };
  return await Promise.race([
    read(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for conversation event")), 2_000);
    }),
  ]);
}

async function expectStreamClosed(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
): Promise<void> {
  await Promise.race([
    (async () => {
      for (;;) {
        if ((await reader.read()).done) return;
      }
    })(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for conversation stream close")), 2_000);
    }),
  ]);
}

describe("conversation unread state", () => {
  it("starts unread, marks read, then becomes unread after a newer turn", async () => {
    await setup();
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "first",
      emit: () => {},
    });
    let row = (await host!.listSessions("casper"))[0]!;
    expect(row.unread).toBe(true);

    await host!.markRead(
      "casper",
      row.conversationId,
      new Date(Date.parse(row.updatedAt) + 1),
    );
    row = (await host!.listSessions("casper"))[0]!;
    expect(row.unread).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await host!.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "second",
      emit: () => {},
    });
    expect((await host!.listSessions("casper"))[0]).toMatchObject({
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
      unread: true,
    });
  });
});

describe("GET /api/ghosts/:name/events", () => {
  it("pushes small invalidations for turns and read changes", async () => {
    const base = await setup();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/ghosts/casper/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();

    await postTurn(base);
    expect(await nextEvent(reader)).toMatchObject({
      type: "conversation-updated",
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
    let listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ unread: boolean }>;
    };
    expect(listing.sessions[0]?.unread).toBe(true);

    const marked = await fetch(`${base}/api/ghosts/casper/sessions/pi%3Aconv-1/read`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(marked.status).toBe(200);
    expect(await nextEvent(reader)).toMatchObject({
      type: "conversation-updated",
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
    listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ unread: boolean }>;
    };
    expect(listing.sessions[0]?.unread).toBe(false);

    controller.abort();
    await expect(reader.closed).rejects.toBeDefined();
  });

  it("opens no hosted session and unregisters a dropped client", async () => {
    const base = await setup();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/ghosts/casper/events`, {
      signal: controller.signal,
    });
    const internals = host as unknown as {
      sessions: Map<string, unknown>;
      conversationListeners: Map<string, Set<unknown>>;
    };
    expect(internals.sessions.size).toBe(0);
    expect(internals.conversationListeners.get("casper")?.size).toBe(1);

    controller.abort();
    await expect(response.body!.getReader().closed).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internals.conversationListeners.has("casper")).toBe(false);
    expect(internals.sessions.size).toBe(0);
  });

  it.each(["rename", "delete"] as const)(
    "closes the old stream on %s and isolates a recreated old name",
    async (move) => {
      const base = await setup();
      const oldResponse = await fetch(`${base}/api/ghosts/casper/events`);
      expect(oldResponse.status).toBe(200);
      const oldReader = oldResponse.body!.getReader();

      const moved = move === "rename"
        ? await fetch(`${base}/api/ghosts/casper/name`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "wisp" }),
          })
        : await fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
      expect(moved.status).toBe(200);
      await expectStreamClosed(oldReader);

      const recreated = await fetch(`${base}/api/ghosts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "casper" }),
      });
      expect(recreated.status).toBe(201);
      seedGhost(temp!.root, {
        name: "casper",
        provider: { baseUrl: provider!.url, modelId: provider!.modelId },
      });

      const controller = new AbortController();
      const newResponse = await fetch(`${base}/api/ghosts/casper/events`, {
        signal: controller.signal,
      });
      const newReader = newResponse.body!.getReader();
      await postTurn(base);
      expect(await nextEvent(newReader)).toMatchObject({
        type: "conversation-updated",
        id: "pi:conv-1",
      });
      const internals = host as unknown as {
        conversationListeners: Map<string, Set<unknown>>;
      };
      expect(internals.conversationListeners.get("casper")?.size).toBe(1);

      controller.abort();
      await expect(newReader.closed).rejects.toBeDefined();
    },
  );

  it("does not let a delayed old unsubscribe remove the replacement incarnation", async () => {
    const base = await setup();
    const unsubscribeOld = host!.subscribeConversationEvents("casper", () => {}, () => {});
    const renamed = await fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wisp" }),
    });
    expect(renamed.status).toBe(200);
    expect((await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "casper" }),
    })).status).toBe(201);

    const unsubscribeNew = host!.subscribeConversationEvents("casper", () => {});
    unsubscribeOld();
    const internals = host as unknown as {
      conversationListeners: Map<string, Set<unknown>>;
    };
    expect(internals.conversationListeners.get("casper")?.size).toBe(1);
    unsubscribeNew();
    expect(internals.conversationListeners.has("casper")).toBe(false);
  });
});
