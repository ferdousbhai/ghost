/**
 * HTTP tests over a real listening server on an ephemeral loopback port.
 *
 * The SSE assertions parse the body with the same algorithm the pinned
 * pi-messages client uses (see `parseSseStream`), so a framing change that
 * would break the real UI breaks these tests.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, parseSseStream, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
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

async function serve(
  script: Parameters<typeof startMockProvider>[0]["script"] = [
    { kind: "text", text: "hello there" },
  ],
  serverOptions: { maxBodyBytes?: number; apiToken?: string | null } = {},
) {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  provider = await startMockProvider({ script });
  seedGhost(temp.root, {
    name: "casper",
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  host = new SessionHost({ registry: temp.registry, offline: true });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    port: 0,
    // Routing and streaming are the subject here; auth has its own file.
    apiToken: null,
    ...serverOptions,
  });
  return `http://127.0.0.1:${listening.port}`;
}

/** POST a pi-messages turn and read the whole SSE body. */
async function postTurn(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; events: PiMessagesEvent[]; raw: string }> {
  const response = await fetch(`${base}/api/ghosts/casper/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    events: response.ok ? parseSseStream(raw) : [],
    raw,
  };
}

const TURN_BODY = {
  model: "ghost/casper",
  context: { messages: [{ role: "user", content: [{ type: "text", text: "Who are you?" }] }] },
  options: { sessionId: "conv-1" },
};

describe("GET /api/ghosts", () => {
  it("lists ghosts with name, dir, and createdAt", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`);
    expect(response.status).toBe(200);
    const ghosts = await response.json() as Array<Record<string, string>>;
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ name: "casper", dir: join(temp!.root, "casper") });
    expect(ghosts[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("POST /api/ghosts", () => {
  it("creates a ghost home with a seeded character.md", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mina" }),
    });
    expect(response.status).toBe(201);
    const ghost = await response.json() as { name: string; dir: string };
    expect(ghost.name).toBe("mina");
    expect(existsSync(join(ghost.dir, "character.md"))).toBe(true);
  });

  it("rejects a duplicate with 409 and a bad name with 400", async () => {
    const base = await serve();
    const duplicate = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "casper" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "already_exists" } });

    const traversal = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../escape" }),
    });
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toMatchObject({ error: { code: "invalid_name" } });
  });
});

describe("POST /api/ghosts/:name/messages", () => {
  it("streams one well-formed pi-messages turn", async () => {
    const base = await serve([
      { kind: "tool", name: "ghost_memory_list", args: {} },
      { kind: "text", text: "I set type for a living." },
    ]);
    const { status, headers, events, raw } = await postTurn(base, TURN_BODY);

    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("cache-control")).toBe("no-store");
    // Frames are `data: <json>\n\n`, the only shape the pinned client reads.
    expect(raw.startsWith("data: ")).toBe(true);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("start");
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_end");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types.at(-1)).toBe("done");
    expect(types.filter((type) => type === "done" || type === "error")).toHaveLength(1);

    const done = events.at(-1) as Extract<PiMessagesEvent, { type: "done" }>;
    expect(done.reason).toBe("stop");
    expect(done.usage.totalTokens).toBeGreaterThan(0);

    const text = events
      .filter((event): event is Extract<PiMessagesEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toContain("set type");
  });

  it("never leaks reasoning onto the wire", async () => {
    const base = await serve();
    const { events } = await postTurn(base, TURN_BODY);
    expect(events.some((event) => event.type.startsWith("thinking"))).toBe(false);
  });

  it("echoes the caller's turn id and mints one otherwise", async () => {
    const base = await serve();
    const echoed = await postTurn(base, TURN_BODY, { "x-ghost-turn-id": "turn-abc.1" });
    expect(echoed.headers.get("x-ghost-turn-id")).toBe("turn-abc.1");

    const minted = await postTurn(base, TURN_BODY, { "x-ghost-turn-id": "not a valid id!" });
    expect(minted.headers.get("x-ghost-turn-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps separate conversations in separate sessions", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-2" } });
    const { sessions } = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: unknown[];
    };
    expect(sessions).toHaveLength(2);
  });

  it("fails before the stream for an unknown ghost", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/nobody/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TURN_BODY),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("rejects a malformed pi-messages body with a client error", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: { messages: [] } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("still terminates the stream when the provider fails", async () => {
    const base = await serve([
      {
        kind: "error",
        status: 400,
        body: JSON.stringify({ error: { message: "boom", code: "invalid_request" } }),
      },
    ]);
    const { status, events } = await postTurn(base, TURN_BODY);
    expect(status).toBe(200);
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("error");
  });
});

describe("GET /api/ghosts/:name/sessions", () => {
  it("is empty before the first turn and lists it after", async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });
    await postTurn(base, TURN_BODY);
    const { sessions } = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{
        id: string;
        title: string | null;
        createdAt: string;
        updatedAt: string;
        messageCount: number;
      }>;
    };
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("conv-1");
    expect(sessions[0]?.messageCount).toBeGreaterThan(0);
    expect(sessions[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect("title" in sessions[0]!).toBe(true);
  });
});

describe("GET /api/ghosts/:name/sessions/:id/transcript", () => {
  it("returns the conversation's renderable messages", async () => {
    const base = await serve([{ kind: "text", text: "I set type for a living." }]);
    await postTurn(base, TURN_BODY);
    const response = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript`);
    expect(response.status).toBe(200);
    const transcript = await response.json() as {
      id: string;
      title: string | null;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(transcript.id).toBe("conv-1");
    expect(transcript.messages.length).toBeGreaterThanOrEqual(2);
    expect(transcript.messages[0]?.role).toBe("user");
    expect(transcript.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("404s an unknown conversation id", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/sessions/nope/transcript`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("routing and transport", () => {
  it("binds loopback only", async () => {
    await serve();
    expect(listening!.address).toBe("127.0.0.1");
    expect(listening!.port).toBeGreaterThan(0);
  });

  it("404s anything outside the contract and 405s the wrong method", async () => {
    const base = await serve();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/other`)).status).toBe(404);
    expect((await fetch(`${base}/api/ghosts/casper`)).status).toBe(404);
    expect((await fetch(`${base}/api/ghosts/casper/sessions`, { method: "POST" })).status)
      .toBe(405);
    expect((await fetch(`${base}/api/ghosts/casper/messages`)).status).toBe(405);
  });

  it("allows a loopback browser origin and refuses a remote one", async () => {
    const base = await serve();
    const local = await fetch(`${base}/api/ghosts`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const remote = await fetch(`${base}/api/ghosts`, {
      headers: { origin: "https://evil.example" },
    });
    expect(remote.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses an oversized body", async () => {
    const base = await serve(undefined, { maxBodyBytes: 256 });
    const response = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(1_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });
});
