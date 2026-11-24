/**
 * HTTP tests over a real listening server on an ephemeral loopback port, with
 * a scripted harness standing in for the owner's agent CLIs.
 *
 * The SSE assertions use Ghost's in-repo conformance parser
 * (`parseSseStream`), matching the shell's framing rules so a change that would
 * break the real UI breaks these tests.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationDir, LOG_FILENAME } from "../src/conversation-log.js";
import { ghostPaths } from "../src/ghosts.js";
import { parseHooksDocument } from "../src/hook-policy.js";
import type { TurnEvent, TurnResumeEvent } from "../src/turn-events.js";
import {
  startDaemonServer,
  type ListeningServer,
  type ServerOptions,
} from "../src/server.js";
import { TurnBuffer } from "../src/turn-buffer.js";
import { SessionHost } from "../src/session-host.js";
import { SIDECAR_FILENAMES } from "../src/sidecars.js";
import { fakeHarness, onlyHarnesses, replies, type FakeHarness, type FakeTurn } from "./helpers/fake-harness.js";
import { makeTempGhosts, parseSseStream, seedGhost, type TempGhosts, serverServices } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

let temp: TempGhosts | null = null;
let harness: FakeHarness | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;
const gates: Array<() => void> = [];

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  harness?.cleanup();
  harness = null;
  temp?.cleanup();
  temp = null;
});

async function serve(
  turns: FakeTurn[] = replies("hello there"),
  serverOptions: {
    maxBodyBytes?: number;
    apiToken?: string | null;
    hooks?: ServerOptions["hooks"];
    streamCutBytes?: number;
  } = {},
) {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  harness = fakeHarness(turns);
  seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    ...onlyHarnesses(harness),
  });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    ...serverServices(temp.registry),
    port: 0,
    // Routing and streaming are the subject here; auth has its own file.
    apiToken: null,
    ...(serverOptions.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: serverOptions.maxBodyBytes }),
    ...(serverOptions.apiToken === undefined ? {} : { apiToken: serverOptions.apiToken }),
    ...(serverOptions.hooks === undefined ? {} : { hooks: serverOptions.hooks }),
    ...(serverOptions.streamCutBytes === undefined ? {} : { streamCutBytes: serverOptions.streamCutBytes }),
  });
  return `http://127.0.0.1:${listening.port}`;
}

/**
 * Serve with a first turn that holds until released, so "a conversation is
 * answering" is a state the test owns rather than a race it has to win.
 */
async function serveHeld(after: FakeTurn[] = replies("after")): Promise<{ base: string; release(): void }> {
  const base = await serve([]);
  const gate = harness!.gate("hold");
  gates.push(gate.release);
  harness!.setTurns([{ events: [{ type: "text", block: "a", delta: "held" }], gate: gate.path }, ...after]);
  return { base, release: gate.release };
}

async function waitForLaunches(count: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (harness!.calls().length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} harness launch(es)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function postTurn(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; events: TurnEvent[]; raw: string }> {
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
  prompt: "Who are you?",
  sessionId: "conv-1",
};

const turnBody = (sessionId: string, prompt = "Who are you?") => ({
  ...TURN_BODY,
  prompt,
  sessionId,
});

describe("GET /api/ghosts", () => {
  it("lists ghosts with name and dir", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`);
    expect(response.status).toBe(200);
    const ghosts = await response.json() as Array<Record<string, string>>;
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toEqual({ name: "casper", dir: join(temp!.root, "casper") });
  });
});

describe("/api/hooks/config", () => {
  it("reads and replaces the whole document through the runner", async () => {
    const path = join(temp?.root ?? "", "hooks.json");
    let document: Record<string, unknown> = { hooks: {} };
    // The runner's own admission, so the route's 400s are the loader's messages.
    const replaceConfig = vi.fn(async (next: unknown) => {
      parseHooksDocument(next, path);
      document = next as Record<string, unknown>;
      return { path, document };
    });
    const base = await serve(undefined, {
      hooks: { config: () => ({ path, document }), replaceConfig },
    });

    const read = await fetch(`${base}/api/hooks/config`);
    expect(await read.json()).toEqual({ path, document: { hooks: {} } });

    const next = { hooks: { session_stop: [{ hooks: [{ type: "command", command: "/bin/true" }] }] } };
    const written = await fetch(`${base}/api/hooks/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ path, document: next });
    expect(replaceConfig).toHaveBeenCalledWith(next);

    const rejected = await fetch(`${base}/api/hooks/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: { code: "invalid_request", message: `${path} must contain a JSON object.` },
    });

    const wrapped = await fetch(`${base}/api/hooks/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, document: next, hooks: {} }),
    });
    expect(wrapped.status).toBe(400);
    expect((await wrapped.json() as { error: { message: string } }).error.message)
      .toBe(`${path} has no top-level "path", "document"; send the document itself.`);
    const legacy = await fetch(`${base}/api/hooks/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hooks: {}, builtin: { next_work_turns: 1 } }),
    });
    expect(legacy.status).toBe(400);
    expect(document).toEqual(next);

    const posted = await fetch(`${base}/api/hooks/config`, { method: "POST" });
    expect(posted.status).toBe(405);
  });
});

describe("/api/ghosts/:name/character", () => {
  it("round-trips the persona file and refuses an oversize write", async () => {
    const base = await serve();
    const ghostDir = join(temp!.root, "casper");
    const route = `${base}/api/ghosts/casper/character`;
    const put = (body: unknown) => fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const written = await put({ body: "# Casper\n\nDry wit, direct answers.\n" });
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ ok: true, limit: 20_000 });
    expect(readFileSync(join(ghostDir, "character.md"), "utf8"))
      .toBe("# Casper\n\nDry wit, direct answers.\n");

    const read = await fetch(route);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      body: "# Casper\n\nDry wit, direct answers.\n",
      limit: 20_000,
    });

    const oversize = await put({ body: "x".repeat(20_001) });
    expect(oversize.status).toBe(400);
    expect((await oversize.json() as { error: { code: string } }).error.code)
      .toBe("limit_exceeded");
    expect(readFileSync(join(ghostDir, "character.md"), "utf8"))
      .toBe("# Casper\n\nDry wit, direct answers.\n");

    expect((await put({ body: 42 })).status).toBe(400);
    expect((await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(405);
    expect((await fetch(`${base}/api/ghosts/missing/character`)).status).toBe(404);
  });

  it("still serves an oversize hand-edited file so the owner can shorten it", async () => {
    const base = await serve();
    const ghostDir = join(temp!.root, "casper");
    writeFileSync(join(ghostDir, "character.md"), "y".repeat(20_400), "utf8");

    const read = await fetch(`${base}/api/ghosts/casper/character`);
    expect(read.status).toBe(200);
    const body = await read.json() as { body: string; limit: number };
    expect(body.body.length).toBe(20_400);
    expect(body.limit).toBe(20_000);
  });
});

describe("POST /api/ghosts/:name/messages admission", () => {
  it("refuses a second turn in an answering conversation before SSE, and admits it after", async () => {
    const { base, release } = await serveHeld();
    const first = postTurn(base, turnBody("conv-busy", "hold this turn"));
    await waitForLaunches(1);

    const rejected = await postTurn(base, turnBody("conv-busy", "must fail before SSE"));
    expect(rejected.status).toBe(409);
    expect(rejected.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(rejected.raw)).toMatchObject({ error: { code: "session_busy" } });

    // Another conversation of the same ghost is not held behind it.
    const other = await postTurn(base, turnBody("conv-other", "a different conversation"));
    expect(other.status).toBe(200);
    expect(other.events.at(-1)).toMatchObject({ type: "done" });

    release();
    expect((await first).events.at(-1)).toMatchObject({ type: "done" });
    const retried = await postTurn(base, turnBody("conv-busy", "after release"));
    expect(retried.status).toBe(200);
    expect(retried.events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "done" })]);
    expect(harness!.calls().map((call) => call.prompt)).not.toContain("must fail before SSE");
  });
});

describe("session Connect routes", () => {
  it("does not expose live voice or a collaboration host", async () => {
    const base = await serve();
    const segment = "conv-connect";
    for (const route of ["live", "collab"]) {
      const url = `${base}/api/ghosts/casper/sessions/${segment}/${route}`;
      expect((await fetch(url)).status).toBe(404);
      const posted = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      expect(posted.status).toBe(404);
    }
  });
});

describe("POST /api/ghosts/:name/messages", () => {
  it("streams one well-formed turn", async () => {
    const base = await serve([{
      events: [
        { type: "tool_start", id: "t1", name: "Read", args: { path: "character.md" } },
        { type: "tool_end", id: "t1", isError: false, output: "# casper" },
        { type: "text", block: "a", delta: "I set type for a living." },
      ],
    }]);
    const { status, headers, events, raw } = await postTurn(base, TURN_BODY);

    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("cache-control")).toBe("no-store");
    // The opening comment makes the accepted stream visible before harness
    // work; event frames retain the canonical `data: <json>\n\n` shape.
    expect(raw.startsWith(": keepalive\n\ndata: ")).toBe(true);

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "start",
      "harness",
      "tool_execution_start",
      "tool_execution_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);

    const text = events
      .filter((event): event is Extract<TurnEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("I set type for a living.");
  });

  it.each([100, 20_000])("resumes a long turn with %i-character deltas across memory and spooled replay", async (size) => {
    const deltas = Array.from({ length: 60 }, (_, index) => `${String(index).padStart(2, "0")}${"é".repeat(size)}`);
    const base = await serve([{
      events: deltas.map((delta) => ({ type: "text" as const, block: "a", delta })),
    }], { streamCutBytes: Math.max(2_000, size * 8) });
    const first = await postTurn(base, TURN_BODY);
    const responses: Array<Array<TurnEvent | TurnResumeEvent>> = [first.events];
    for (let last = responses.at(-1)?.at(-1); last?.type === "resume"; last = responses.at(-1)?.at(-1)) {
      const { turn, from } = last;
      const response = await fetch(`${base}/api/ghosts/casper/sessions/${TURN_BODY.sessionId}/stream?turn=${turn}&from=${from}`);
      expect(response.status).toBe(200);
      responses.push(parseSseStream(await response.text()));
    }

    expect(responses.length).toBeGreaterThan(2);
    const events = responses.flatMap((batch) => batch.filter((event): event is TurnEvent => event.type !== "resume"));
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toEqual([{ type: "done" }]);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta.slice(0, 2))).toEqual(deltas.map(delta => delta.slice(0, 2)));
    expect(events.filter((event) => event.type === "text_delta").every(event => deltas.includes(event.delta))).toBe(true);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    // Every response but the last ends in its resume frame, the only one it has.
    for (const batch of responses.slice(0, -1)) {
      expect(batch.filter((event) => event.type === "resume")).toEqual([batch.at(-1)]);
    }
  });

  it("terminates cleanly when replay storage fails", async () => {
    const base = await serve(replies("answer"));
    const failure = vi.spyOn(TurnBuffer.prototype, "push").mockImplementationOnce(() => { throw new Error("storage full"); });
    try {
      const { events } = await postTurn(base, TURN_BODY);
      expect(events).toEqual([{ type: "error", reason: "error", errorMessage: "Could not retain the turn stream; read the transcript." }]);
      await vi.waitFor(() => expect(host!.queuedMessages("casper", TURN_BODY.sessionId).streaming).toBe(false));
    } finally { failure.mockRestore(); }
  });

  it("waits for socket drain while the harness completes independently", async () => {
    const base = await serve(replies("completed behind a slow client"));
    let response: ServerResponse | undefined;
    let blocked = true;
    let dataWrites = 0;
    listening!.server.on("request", (_request, outgoing) => {
      response = outgoing;
      const write = outgoing.write.bind(outgoing);
      vi.spyOn(outgoing, "write").mockImplementation((chunk) => {
        const accepted = write(chunk);
        if (String(chunk).startsWith("data:")) {
          dataWrites++;
          return !blocked && accepted;
        }
        return accepted;
      });
    });
    const pending = postTurn(base, TURN_BODY);
    await vi.waitFor(() => {
      expect(dataWrites).toBe(1);
      expect(host!.queuedMessages("casper", TURN_BODY.sessionId).streaming).toBe(false);
    });
    blocked = false;
    response!.emit("drain");
    const { events } = await pending;
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join("")).toBe("completed behind a slow client");
  });

  it("refuses to resume a turn it does not know or past where the turn has reached", async () => {
    const base = await serve(replies("short"), { streamCutBytes: 1 });
    const { events } = await postTurn(base, TURN_BODY);
    const { turn } = events.at(-1) as unknown as TurnResumeEvent;
    const stream = (query: string, session = TURN_BODY.sessionId) =>
      fetch(`${base}/api/ghosts/casper/sessions/${session}/stream?${query}`);
    const unknown = await stream("turn=nope&from=0");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("turn_not_found");
    expect((await stream(`turn=${turn}&from=0`, "conv-other")).status).toBe(404);
    expect((await stream(`turn=${turn}&from=999`)).status).toBe(400);
  });

  it("streams reasoning for the activity line but never logs it", async () => {
    const base = await serve([{
      events: [
        { type: "thinking", block: "r", delta: "private reasoning" },
        { type: "text", block: "a", delta: "Answer." },
      ],
    }]);
    const { events } = await postTurn(base, TURN_BODY);
    expect(events.some((event) => event.type === "thinking")).toBe(true);
    const transcript = await (await fetch(`${base}/api/ghosts/casper/sessions/${TURN_BODY.sessionId}/transcript`)).text();
    expect(transcript).toContain("Answer.");
    expect(transcript).not.toContain("private reasoning");
  });

  it("ignores a caller-supplied turn id header", async () => {
    const base = await serve();
    const response = await postTurn(base, TURN_BODY, { "x-ghost-turn-id": "turn-abc.1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ghost-turn-id")).toBeNull();
  });

  it("keeps separate conversations in separate directories", async () => {
    const base = await serve(replies("one", "two"));
    await postTurn(base, TURN_BODY);
    await postTurn(base, { ...TURN_BODY, sessionId: "conv-2" });
    const { sessions } = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: unknown[];
    };
    expect(sessions).toHaveLength(2);
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    expect(harness!.calls().map((call) => call.cwd)).toEqual([
      conversationDir(sessionDir, "conv-1"),
      conversationDir(sessionDir, "conv-2"),
    ]);
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

  it("rejects a malformed turn body with a client error", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("still terminates the stream when the pass fails", async () => {
    const base = await serve([{ fail: "boom: the model crashed" }]);
    const { status, events } = await postTurn(base, TURN_BODY);
    expect(status).toBe(200);
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)).toMatchObject({ type: "error", errorMessage: expect.stringContaining("boom") });
    expect(terminalCount(events)).toBe(1);
  });
});

function terminalCount(events: readonly TurnEvent[]): number {
  return events.filter((event) => event.type === "done" || event.type === "error").length;
}

describe("/api/ghosts/:name/sessions/:id/queue", () => {
  const queueUrl = (base: string, id: string) => `${base}/api/ghosts/casper/sessions/${id}/queue`;
  const enqueue = (base: string, id: string, body: unknown) => fetch(queueUrl(base, id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("queues a follow-up during a live turn and runs it as the next pass of the same stream", async () => {
    const { base, release } = await serveHeld(replies("Kept it understated."));
    const turn = postTurn(base, turnBody("conv-queue", "Set the type."));
    await waitForLaunches(1);

    const queued = await enqueue(base, "conv-queue", { text: "Keep the result understated." });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toEqual({
      streaming: true,
      followUp: ["Keep the result understated."],
    });
    expect(await (await fetch(queueUrl(base, "conv-queue"))).json()).toMatchObject({ streaming: true, followUp: ["Keep the result understated."] });

    for (const body of [{ text: "   " }, {}]) {
      const response = await enqueue(base, "conv-queue", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }

    release();
    const completed = await turn;
    const ownerIndex = completed.events.findIndex((event) => event.type === "owner_message");
    expect(completed.events[ownerIndex]).toEqual({ type: "owner_message", text: "Keep the result understated." });
    expect(completed.events.slice(ownerIndex).some((event) => event.type === "text_delta")).toBe(true);
    expect(terminalCount(completed.events)).toBe(1);
    expect(harness!.calls().map((call) => call.message)).toEqual(["Set the type.", "Keep the result understated."]);

    expect(await (await fetch(queueUrl(base, "conv-queue"))).json())
      .toEqual({ streaming: false, followUp: [] });
    const tooLate = await enqueue(base, "conv-queue", { text: "Too late" });
    expect(tooLate.status).toBe(409);
    expect(await tooLate.json()).toMatchObject({ error: { code: "session_not_streaming" } });
    expect((await fetch(queueUrl(base, "conv-queue"), { method: "DELETE" })).status).toBe(405);
    // The removed automatic-work endpoint is no longer exposed.
    const continuation = queueUrl(base, "conv-queue").replace(/queue$/u, "continuation");
    expect((await fetch(continuation, { method: "DELETE" })).status).toBe(404);
  });
});

describe("GET /api/ghosts/:name/sessions", () => {
  it("is empty before the first turn and lists it after", async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });
    await postTurn(base, TURN_BODY);
    const { sessions } = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(sessions).toHaveLength(1);
    expect(Object.keys(sessions[0]!).sort()).toEqual([
      "effort",
      "harness",
      "id",
      "messageCount",
      "model",
      "pinned",
      "preview",
      "provider",
      "question",
      "running",
      "title",
      "unread",
      "updatedAt",
    ]);
    expect(sessions[0]).toMatchObject({
      id: "conv-1",
      title: "Who are you",
      preview: "Who are you?",
      harness: "local",
      messageCount: 2,
      pinned: false,
      unread: true,
      running: false,
    });
  });

  it("accepts a 128-character id and rejects any other shape before storage, on every route", async () => {
    const base = await serve(replies("boundary"));
    const boundary = "a".repeat(128);
    expect((await postTurn(base, turnBody(boundary))).status).toBe(200);
    const listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string }>;
    };
    expect(listing.sessions.map((row) => row.id)).toEqual([boundary]);
    expect((await fetch(`${base}/api/ghosts/casper/sessions/${boundary}/transcript`)).status).toBe(200);

    // A pin writes pins.json beside the conversations; an id naming a sidecar is refused, not a 500.
    expect((await fetch(`${base}/api/ghosts/casper/sessions/${boundary}/pin`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }),
    })).status).toBe(200);
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    expect(existsSync(join(sessionDir, "pins.json"))).toBe(true);
    for (const invalid of ["a".repeat(129), ".hidden", "folder/chat", "chat?draft", "\u{1f47b}", "\ud800", ...SIDECAR_FILENAMES]) {
      const rejected = await postTurn(base, turnBody(invalid));
      expect(rejected.status, invalid).toBe(400);
      expect(JSON.parse(rejected.raw)).toMatchObject({ error: { code: "invalid_conversation_id" } });
      // A lone surrogate cannot even be percent-encoded into a path.
      if (invalid === "\ud800") continue;
      const segment = encodeURIComponent(invalid);
      for (const [suffix, init] of [
        ["/transcript", {}],
        ["/pin", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) }],
        ["/title", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }],
        ["", { method: "DELETE" }],
      ] as const) {
        const response = await fetch(`${base}/api/ghosts/casper/sessions/${segment}${suffix}`, init);
        expect(response.status, `${invalid}${suffix}`).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_conversation_id" } });
      }
    }
    expect(harness!.calls()).toHaveLength(1);
    expect(existsSync(join(sessionDir, ".hidden"))).toBe(false);
    expect(JSON.parse(readFileSync(join(sessionDir, "pins.json"), "utf8"))).toMatchObject({ pinned: [boundary] });
  });
});

describe("PUT /api/ghosts/:name/sessions/:id/pin", () => {
  const setPin = (base: string, id: string, body: unknown) => fetch(
    `${base}/api/ghosts/casper/sessions/${id}/pin`,
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
    await postTurn(base, { ...TURN_BODY, sessionId: "conv-2" });
    expect((await listSessions(base)).map((session) => [session.id, session.pinned]))
      .toEqual([["conv-2", false], ["conv-1", false]]);

    const pinned = await setPin(base, "conv-1", { pinned: true });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ ok: true, pinned: true });
    expect(existsSync(join(temp!.root, "casper", "sessions", "pins.json"))).toBe(true);
    expect((await listSessions(base)).map((session) => [session.id, session.pinned]))
      .toEqual([["conv-1", true], ["conv-2", false]]);

    // Idempotent both ways.
    expect((await setPin(base, "conv-1", { pinned: true })).status).toBe(200);
    const unpinned = await setPin(base, "conv-1", { pinned: false });
    expect(await unpinned.json()).toEqual({ ok: true, pinned: false });
    expect((await listSessions(base)).map((session) => session.id))
      .toEqual(["conv-2", "conv-1"]);
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

    const wrongMethod = await fetch(
      `${base}/api/ghosts/casper/sessions/conv-1/pin`,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("drops the pin when the conversation is deleted", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    expect((await setPin(base, "conv-1", { pinned: true })).status).toBe(200);

    await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, {
      method: "DELETE",
    });
    expect(JSON.parse(readFileSync(join(temp!.root, "casper", "sessions", "pins.json"), "utf8")))
      .toEqual({ version: 2, pinned: [] });
  });
});

describe("PUT|DELETE /api/ghosts/:name/sessions/:id/question", () => {
  const ask = (base: string, id: string, body: unknown) => fetch(
    `${base}/api/ghosts/casper/sessions/${id}/question`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const questionOf = async (base: string, id: string) => (
    await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; question: { text: string; options: string[]; askedAt: string } | null }>;
    }
  ).sessions.find((session) => session.id === id)?.question;
  const questionsFile = () => join(temp!.root, "casper", "sessions", "questions.json");

  it("lists the question until the owner's next message answers it", async () => {
    const base = await serve(replies("first", "second"));
    await postTurn(base, TURN_BODY);
    expect(await questionOf(base, "conv-1")).toBeNull();
    // Turns that ask nothing write nothing.
    expect(existsSync(questionsFile())).toBe(false);

    const asked = await ask(base, "conv-1", { text: "  Ship it tonight? ", options: ["yes", " yes", "wait", ""] });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toMatchObject({ ok: true, question: { text: "Ship it tonight?", options: ["yes", "wait"] } });
    expect(await questionOf(base, "conv-1")).toMatchObject({ text: "Ship it tonight?", options: ["yes", "wait"] });

    await postTurn(base, { ...TURN_BODY, prompt: "yes" });
    expect(await questionOf(base, "conv-1")).toBeNull();
  });

  it("withdraws a question unanswered, and with its conversation", async () => {
    const base = await serve(replies("one", "two"));
    await postTurn(base, TURN_BODY);
    await ask(base, "conv-1", { text: "Which one?" });
    const dismissed = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/question`, { method: "DELETE" });
    expect(dismissed.status).toBe(200);
    expect(await questionOf(base, "conv-1")).toBeNull();

    await ask(base, "conv-1", { text: "Still there?" });
    await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, { method: "DELETE" });
    expect(JSON.parse(readFileSync(questionsFile(), "utf8"))).toEqual({ version: 2, questions: {} });
  });

  it("refuses an empty, oversized, or malformed question", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    for (const body of [
      {}, { text: "   " }, { text: "x".repeat(2_001) }, { text: "ok", options: "yes" },
      { text: "ok", options: [1] }, { text: "ok", options: ["a", "b", "c", "d", "e", "f", "g"] },
      { text: "ok", options: ["x".repeat(121)] },
    ]) {
      const response = await ask(base, "conv-1", body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await ask(base, "nope", { text: "hi" })).status).toBe(404);
  });
});

describe("PUT /api/ghosts/:name/sessions/:id/title", () => {
  const rename = (base: string, id: string, body: unknown) => fetch(
    `${base}/api/ghosts/casper/sessions/${id}/title`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const titleOf = async (base: string, id: string) => (
    await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; title: string | null }>;
    }
  ).sessions.find((session) => session.id === id)?.title ?? null;

  it("names a conversation and trims it", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);

    const named = await rename(base, "conv-1", { title: "  The Vandercook  " });
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ ok: true, title: "The Vandercook" });
    expect(await titleOf(base, "conv-1")).toBe("The Vandercook");
  });

  it("rejects an empty, non-string, non-printable, or overlong title", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    for (const body of [
      {},
      { title: null },
      { title: 7 },
      { title: ["a"] },
      { title: "" },
      { title: "   " },
      { title: "\u0001\u007f" },
      { title: "x".repeat(121) },
      [],
    ]) {
      const response = await rename(base, "conv-1", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    // Exactly at the cap is fine.
    expect((await rename(base, "conv-1", { title: "x".repeat(120) })).status).toBe(200);
  });

  it("404s an unknown conversation and 405s a non-PUT", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    const missing = await rename(base, "nope", { title: "Anything" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/conv-1/title`,
    )).status).toBe(405);
  });
});

describe("DELETE /api/ghosts/:name/sessions/:id", () => {
  it("moves a stored conversation to recoverable Trash", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);

    const deleted = await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    // The whole conversation directory moves, its log with it.
    const trashed = join(temp!.trashDir, "files", basename(conversationDir(sessionDir, "conv-1")));
    expect(existsSync(conversationDir(sessionDir, "conv-1"))).toBe(false);
    expect(existsSync(join(trashed, LOG_FILENAME))).toBe(true);
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });

    const missing = await fetch(`${base}/api/ghosts/casper/sessions/conv-1`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("GET /api/ghosts/:name/sessions/:id/transcript", () => {
  it("returns the conversation's renderable messages", async () => {
    const base = await serve(replies("I set type for a living."));
    await postTurn(base, TURN_BODY);
    const response = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript`);
    expect(response.status).toBe(200);
    const transcript = await response.json() as {
      id: string;
      messages: Array<{ role: string; content: unknown }>;
      total: number;
      truncated: boolean;
    };
    expect(transcript).toMatchObject({ id: "conv-1", total: 2, truncated: false });
    expect(transcript.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", [{ type: "text", text: "Who are you?" }]],
      ["assistant", [{ type: "text", text: "I set type for a living." }]],
    ]);
  });

  it("pages with limit and offset and rejects a non-numeric one", async () => {
    const base = await serve(replies("one", "two"));
    await postTurn(base, turnBody("conv-1", "first"));
    await postTurn(base, turnBody("conv-1", "second"));
    const page = await (await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript?limit=1&offset=2`)).json() as {
      messages: Array<{ role: string; content: unknown }>;
      total: number;
      truncated: boolean;
    };
    expect(page).toMatchObject({ total: 4, truncated: true });
    expect(page.messages).toEqual([expect.objectContaining({ role: "user", content: [{ type: "text", text: "second" }] })]);
    for (const query of ["limit=many", "offset=later"]) {
      const response = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("reads a conversation with no log yet as empty, and 404s an unknown ghost", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/sessions/nope/transcript`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "nope", messages: [], total: 0, truncated: false, readThrough: expect.any(String) });
    expect((await fetch(`${base}/api/ghosts/nobody/sessions/nope/transcript`)).status).toBe(404);
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
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/other`)).status).toBe(404);
    expect((await fetch(`${base}/api/ghosts/casper`)).status).toBe(404);
    expect((await fetch(`${base}/api/ghosts/casper/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/ghosts/casper/sessions`, { method: "POST" })).status)
      .toBe(405);
    expect((await fetch(`${base}/api/ghosts/casper/messages`)).status).toBe(405);
  });

  it("has no route that makes, renames, or removes a ghost", async () => {
    const base = await serve();
    const send = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect((await send("POST", "/api/ghosts", { name: "wisp" })).status).toBe(405);
    expect((await send("PUT", "/api/ghosts/casper/name", { name: "wisp" })).status).toBe(404);
    expect((await send("DELETE", "/api/ghosts/casper?confirm=casper")).status).toBe(404);
    expect(temp!.registry.list().map((ghost) => ghost.name)).toEqual(["casper"]);
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
    const response = await fetch(`${base}/api/ghosts/casper/character`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x".repeat(1_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });
});

describe("GET /api/status", () => {
  it("reports running source without release polling state", async () => {
    const base = await serve();
    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ version: "0.0.0-test", source: { commit: null, root: null }, startedAt: expect.any(String), restartNeeded: false });
  });
});

describe("attachments", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const url = (base: string, id: string) => `${base}/api/ghosts/casper/sessions/${id}/attachments`;

  it("stores an image in the conversation directory before its first turn and serves it back", async () => {
    const base = await serve();
    const saved = await fetch(url(base, "hud-new"), { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    expect(saved.status).toBe(201);
    const { path } = await saved.json() as { path: string };
    expect(path).toMatch(/^attachments\/[a-z0-9]+-[0-9a-f]{8}\.png$/);
    const dir = conversationDir(ghostPaths(join(temp!.root, "casper")).sessionDir, "hud-new");
    expect(readFileSync(join(dir, path))).toEqual(PNG);
    // A directory holding only attachments is not a conversation yet.
    expect((await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as { sessions: unknown[] }).sessions).toEqual([]);

    const served = await fetch(`${url(base, "hud-new")}/${path.slice("attachments/".length)}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
  });

  it("copies a local file named by path, and refuses what is not an image", async () => {
    const base = await serve();
    const local = join(temp!.root, "shot.png");
    writeFileSync(local, PNG);
    const copied = await fetch(url(base, "c1"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: local }) });
    expect(copied.status).toBe(201);
    // The media type is matched as the CORS gate matches it: case and parameters aside.
    const cased = await fetch(url(base, "c1"), { method: "POST", headers: { "content-type": "Application/JSON; charset=utf-8" }, body: JSON.stringify({ path: local }) });
    expect(cased.status).toBe(201);

    const text = await fetch(url(base, "c1"), { method: "POST", headers: { "content-type": "image/png" }, body: "not an image" });
    expect(text.status).toBe(415);
    const relative = await fetch(url(base, "c1"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "shot.png" }) });
    expect(relative.status).toBe(400);
    const directory = await fetch(url(base, "c1"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: temp!.root }) });
    expect(directory.status).toBe(404);
    for (const name of ["..%2F.conversation.jsonl", "x.png", "abc-0000000g.png"]) {
      expect((await fetch(`${url(base, "c1")}/${name}`)).status, name).toBe(404);
    }
  });
});
