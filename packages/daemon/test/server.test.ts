/**
 * HTTP tests over a real listening server on an ephemeral loopback port.
 *
 * The SSE assertions parse the body with the same algorithm the pinned
 * pi-messages client uses (see `parseSseStream`), so a framing change that
 * would break the real UI breaks these tests.
 */
import { existsSync, readFileSync } from "node:fs";
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

async function waitForAsk(base: string, sessionId: string): Promise<{
  id: string;
  questions: Array<{ id: string; question: string }>;
}> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent(sessionId)}/ask`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { ask: null | {
      id: string;
      questions: Array<{ id: string; question: string }>;
    } };
    if (body.ask) return body.ask;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for ask interaction");
}

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
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
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

describe("OMP ask interaction", () => {
  it("publishes a blocking ask and accepts the first validated answer", async () => {
    const base = await serve([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "paper",
            question: "Which paper stock?",
            options: [{ label: "Cream" }, { label: "White" }],
            recommended: 0,
          }],
        },
      },
      { kind: "text", text: "Cream stock selected." },
    ]);
    const turn = postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: "conv-ask" },
    });
    const ask = await waitForAsk(base, "conv-ask");
    expect(ask.questions[0]).toMatchObject({ id: "paper", question: "Which paper stock?" });

    const queued = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "steer", text: "Keep the result understated." }),
    });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({
      streaming: true,
      steering: ["Keep the result understated."],
    });
    const queueStatus = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/queue`);
    expect(await queueStatus.json()).toMatchObject({ count: 1 });

    const invalid = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: ask.id,
        kind: "submit",
        results: [{ id: "paper", selectedOptions: ["Cardboard"] }],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_ask_answer" } });

    const accepted = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: ask.id,
        kind: "submit",
        results: [{ id: "paper", selectedOptions: ["Cream"] }],
      }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });

    const completed = await turn;
    expect(completed.events.at(-1)?.type).toBe("done");
    const after = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/ask`);
    expect(await after.json()).toEqual({ ask: null });

    const duplicate = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: ask.id, kind: "chat" }),
    });
    expect(duplicate.status).toBe(409);

    const tooLate = await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "followUp", text: "Too late" }),
    });
    expect(tooLate.status).toBe(409);
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

describe("PUT /api/ghosts/:name/sessions/:id/pin", () => {
  const setPin = (base: string, id: string, body: unknown) => fetch(
    `${base}/api/ghosts/casper/sessions/${encodeURIComponent(id)}/pin`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const listSessions = async (base: string) => (
    await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; pinned: boolean }>;
    }
  ).sessions;

  it("pins a conversation, lists it first, and unpins it again", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-2" } });
    expect((await listSessions(base)).map((session) => [session.id, session.pinned]))
      .toEqual([["conv-2", false], ["conv-1", false]]);

    const pinned = await setPin(base, "conv-1", { pinned: true });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ ok: true, pinned: true });
    expect(existsSync(join(temp!.root, "casper", ".sessions", "pins.json"))).toBe(true);
    expect((await listSessions(base)).map((session) => [session.id, session.pinned]))
      .toEqual([["conv-1", true], ["conv-2", false]]);

    // Idempotent both ways.
    expect((await setPin(base, "conv-1", { pinned: true })).status).toBe(200);
    const unpinned = await setPin(base, "conv-1", { pinned: false });
    expect(await unpinned.json()).toEqual({ ok: true, pinned: false });
    expect((await listSessions(base)).map((session) => session.id)).toEqual(["conv-2", "conv-1"]);
  });

  it("rejects a non-boolean or missing pinned", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    for (const body of [{}, { pinned: "true" }, { pinned: 1 }, { pinned: null }, []]) {
      const response = await setPin(base, "conv-1", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("404s an unknown conversation and 405s a non-PUT", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    const missing = await setPin(base, "nope", { pinned: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });

    const wrongMethod = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/pin`);
    expect(wrongMethod.status).toBe(405);
  });

  it("drops the pin when the conversation is deleted", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    expect((await setPin(base, "conv-1", { pinned: true })).status).toBe(200);

    await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, { method: "DELETE" });
    expect(JSON.parse(readFileSync(join(temp!.root, "casper", ".sessions", "pins.json"), "utf8")))
      .toEqual({ pinned: [] });
  });
});

describe("DELETE /api/ghosts/:name/sessions/:id", () => {
  it("permanently deletes a stored conversation", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);

    const deleted = await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });
    expect((await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript`)).status)
      .toBe(404);

    const missing = await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("DELETE /api/ghosts/:name", () => {
  it("moves the ghost home into the XDG trash once the name is confirmed", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    const dir = join(temp!.root, "casper");

    const deleted = await fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const body = await deleted.json() as { ok: boolean; trash: string };
    expect(body.ok).toBe(true);
    expect(body.trash).toBe(join(temp!.trashDir, "files", "casper"));
    expect(existsSync(join(temp!.trashDir, "info", "casper.trashinfo"))).toBe(true);
    // A move, never an rm: the persona is still readable where it went.
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(body.trash, "character.md"))).toBe(true);

    expect(await (await fetch(`${base}/api/ghosts`)).json()).toEqual([]);
  });

  it("refuses a missing or mismatched confirmation without touching the home", async () => {
    const base = await serve();
    const dir = join(temp!.root, "casper");

    for (const path of ["/api/ghosts/casper", "/api/ghosts/casper?confirm=Casper"]) {
      const response = await fetch(`${base}${path}`, { method: "DELETE" });
      expect(response.status, path).toBe(400);
      expect(await response.json(), path)
        .toMatchObject({ error: { code: "confirmation_required" } });
    }
    expect(existsSync(dir)).toBe(true);
  });

  it("404s an unknown ghost", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/nobody?confirm=nobody`, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("409s while any of the ghost's conversations is answering", async () => {
    // A blocking `ask` holds the turn open, so "busy" is a state the test owns
    // rather than a race it has to win.
    const base = await serve([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "paper",
            question: "Which paper stock?",
            options: [{ label: "Cream" }, { label: "White" }],
          }],
        },
      },
      { kind: "text", text: "Cream stock selected." },
    ]);
    const turn = postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-ask" } });
    const ask = await waitForAsk(base, "conv-ask");

    const busy = await fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "ghost_busy" } });
    expect(existsSync(join(temp!.root, "casper"))).toBe(true);

    await fetch(`${base}/api/ghosts/casper/sessions/conv-ask/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: ask.id, kind: "cancel" }),
    });
    await turn;

    const deleted = await fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
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

describe("OMP conversation tree routes", () => {
  it("rewinds, creates, and navigates sibling user-message branches over HTTP", async () => {
    const base = await serve([{ kind: "text", text: "Branch answer." }]);
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-tree" } });
    await postTurn(base, {
      ...TURN_BODY,
      context: { messages: [{ role: "user", content: "Original follow-up" }] },
      options: { sessionId: "conv-tree" },
    });
    const original = await (await fetch(
      `${base}/api/ghosts/casper/sessions/conv-tree/transcript`,
    )).json() as { messages: Array<{ role: string; entryId: string }> };
    const firstUser = original.messages.find((message) => message.role === "user")!;
    const rewind = await fetch(`${base}/api/ghosts/casper/sessions/conv-tree/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rewind", entryId: firstUser.entryId }),
    });
    expect(rewind.status).toBe(200);
    expect(await rewind.json()).toMatchObject({ draft: "Who are you?", transcript: { messages: [] } });

    await postTurn(base, {
      ...TURN_BODY,
      context: { messages: [{ role: "user", content: "Alternative question" }] },
      options: { sessionId: "conv-tree" },
    });
    const alternative = await (await fetch(
      `${base}/api/ghosts/casper/sessions/conv-tree/transcript`,
    )).json() as {
      messages: Array<{
        role: string;
        branch?: { index: number; count: number; previousTargetId?: string };
      }>;
    };
    const branch = alternative.messages.find((message) => message.role === "user")?.branch;
    expect(branch).toMatchObject({ index: 1, count: 2 });

    const navigate = await fetch(`${base}/api/ghosts/casper/sessions/conv-tree/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "navigate", entryId: branch?.previousTargetId }),
    });
    expect(navigate.status).toBe(200);
    expect(JSON.stringify(await navigate.json())).toContain("Original follow-up");
  });

  it("streams a historical Ask re-answer and its resumed model continuation", async () => {
    const base = await serve([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            id: "paper",
            question: "Which paper stock?",
            options: [{ label: "Cream" }, { label: "White" }],
          }],
        },
      },
      { kind: "text", text: "Stock selected." },
    ]);
    const initial = postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-reanswer" } });
    const firstAsk = await waitForAsk(base, "conv-reanswer");
    await fetch(`${base}/api/ghosts/casper/sessions/conv-reanswer/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: firstAsk.id,
        kind: "submit",
        results: [{ id: "paper", selectedOptions: ["Cream"] }],
      }),
    });
    await initial;
    const transcript = await (await fetch(
      `${base}/api/ghosts/casper/sessions/conv-reanswer/transcript`,
    )).json() as { messages: Array<{ content: unknown }> };
    const askCall = transcript.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => (part as { name?: unknown }).name === "ask") as {
        ghostAsk?: { resultEntryId?: string };
      };

    const reanswerResponse = fetch(`${base}/api/ghosts/casper/sessions/conv-reanswer/reanswer`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ entryId: askCall.ghostAsk?.resultEntryId }),
    }).then(async (response) => ({ response, raw: await response.text() }));
    const revised = await waitForAsk(base, "conv-reanswer");
    await fetch(`${base}/api/ghosts/casper/sessions/conv-reanswer/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: revised.id,
        kind: "submit",
        results: [{ id: "paper", selectedOptions: ["White"] }],
      }),
    });
    const completed = await reanswerResponse;
    expect(completed.response.status).toBe(200);
    const events = parseSseStream(completed.raw);
    expect(events.some((event) => event.type === "branch_changed")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
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

  it("returns a typed 400 for malformed percent-encoding in dynamic path segments", async () => {
    const base = await serve();
    for (const path of [
      "/api/ghosts/%/sessions",
      "/api/ghosts/casper/sessions/%/transcript",
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toEqual({
        error: {
          code: "invalid_request",
          message: "URL path segments must use valid percent-encoding.",
        },
      });
    }
  });

  it("decodes valid ghost names and conversation ids", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts/casp%65r/sessions`)).status).toBe(200);

    await postTurn(base, TURN_BODY);
    const transcript = await fetch(`${base}/api/ghosts/casp%65r/sessions/conv%2D1/transcript`);
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({ id: "conv-1" });
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
