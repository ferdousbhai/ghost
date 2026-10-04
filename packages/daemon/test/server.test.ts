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
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationDir, LOG_FILENAME } from "../src/conversation-log.js";
import { ghostPaths } from "../src/ghosts.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import { McpCatalog, type McpCatalogOptions } from "../src/mcp-catalog.js";
import type { TurnEvent } from "../src/turn-events.js";
import {
  startDaemonServer,
  type ListeningServer,
  type ServerOptions,
} from "../src/server.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
import { fakeHarness, onlyHarnesses, replies, type FakeHarness, type FakeTurn } from "./helpers/fake-harness.js";
import { makeTempGhosts, parseSseStream, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

let temp: TempGhosts | null = null;
let harness: FakeHarness | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;
let homeOperations: HomeOperationCoordinator | null = null;
const gates: Array<() => void> = [];

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await listening?.close();
  listening = null;
  homeOperations = null;
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
    mcpReadProbe?: McpCatalogOptions["readProbe"];
    scheduleCommandRunner?: SessionHostOptions["scheduleCommandRunner"];
    update?: ServerOptions["update"];
  } = {},
) {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  harness = fakeHarness(turns);
  seedGhost(temp.root, { name: "casper" });
  homeOperations = new HomeOperationCoordinator(temp.registry);
  host = new SessionHost({
    registry: temp.registry,
    homeOperations,
    ownerHome: temp.ownerHome,
    scheduleCommandRunner: serverOptions.scheduleCommandRunner
      ?? (async () => ({ stdout: "", stderr: "", code: 0 })),
    ...onlyHarnesses(harness),
  });
  const mcp = new McpCatalog({
    registry: temp.registry,
    ...(serverOptions.mcpReadProbe === undefined
      ? {}
      : { readProbe: serverOptions.mcpReadProbe }),
  });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    mcp,
    homeOperations,
    port: 0,
    relay: null,
    // Routing and streaming are the subject here; auth has its own file.
    apiToken: null,
    ...(serverOptions.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: serverOptions.maxBodyBytes }),
    ...(serverOptions.apiToken === undefined ? {} : { apiToken: serverOptions.apiToken }),
    ...(serverOptions.hooks === undefined ? {} : { hooks: serverOptions.hooks }),
    ...(serverOptions.update === undefined ? {} : { update: serverOptions.update }),
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

async function waitForHomeMove(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (homeOperations?.moveReservationCount !== 1) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the home-operation gate");
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  context: { messages: [{ role: "user", content: [{ type: "text", text: "Who are you?" }] }] },
  options: { sessionId: "conv-1" },
};

const turnBody = (sessionId: string, prompt = "Who are you?") => ({
  ...TURN_BODY,
  context: { messages: [{ role: "user", content: prompt }] },
  options: { sessionId },
});

/** A runner built without a hooks.json: nothing to read, nothing to replace. */
const noHooksFile = {
  config: () => undefined,
  replaceConfig: async (): Promise<never> => { throw new Error("This hook runner has no configuration file."); },
};

describe("listener shutdown", () => {
  it("finishes cleanly after admission already stopped an idle server", async () => {
    await serve();
    const current = listening!;
    const stopped = new Promise<void>((resolvePromise) => {
      current.server.once("close", resolvePromise);
    });
    current.server.close();
    await stopped;

    await expect(current.close()).resolves.toBeUndefined();
    listening = null;
  });
});

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

describe("GET /api/hooks", () => {
  it("returns the exact empty daemon-global projection when no runner is supplied", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/hooks`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: false,
      total: 0,
      events: [],
      hooks: [],
    });
  });

  it("returns only the runner's bounded redacted projection", async () => {
    const projection: ReturnType<NonNullable<ServerOptions["hooks"]>["status"]> = {
      active: true,
      total: 3,
      events: [
        { event: "before_prompt", count: 1 },
        { event: "session_stop", count: 2 },
      ],
      hooks: [
        { event: "before_prompt", name: "Prompt policy", description: "Adds policy." },
        { event: "session_stop", name: "Completion", description: "Checks completion." },
        {
          event: "session_stop",
          name: "Review",
          description: "Reviews the pass.",
        },
      ],
    };
    const status = vi.fn(() => projection);
    Object.assign(projection as unknown as Record<string, unknown>, {
      scheduler: { nextRun: "secret" },
      error: "secret",
      errors: ["secret"],
      commands: ["secret"],
      prompts: ["secret"],
      contexts: ["secret"],
    });
    Object.assign(projection.hooks[0] as unknown as Record<string, unknown>, {
      command: "secret",
      args: ["secret"],
      arguments: ["secret"],
      path: "/secret",
      paths: ["/secret"],
      prompt: "secret",
      context: "secret",
    });
    const base = await serve(undefined, { hooks: { ...noHooksFile, status } });

    const response = await fetch(`${base}/api/hooks`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      active: true,
      total: 3,
      events: [
        { event: "before_prompt", count: 1 },
        { event: "session_stop", count: 2 },
      ],
      hooks: [
        { event: "before_prompt", name: "Prompt policy", description: "Adds policy." },
        { event: "session_stop", name: "Completion", description: "Checks completion." },
        {
          event: "session_stop",
          name: "Review",
          description: "Reviews the pass.",
        },
      ],
    });
    expect(status).toHaveBeenCalledTimes(1);

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "command",
      "commands",
      "args",
      "arguments",
      "path",
      "paths",
      "prompt",
      "prompts",
      "context",
      "contexts",
      "error",
      "errors",
      "scheduler",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("rejects non-GET methods without invoking the status projection", async () => {
    const status = vi.fn(() => ({
      active: false,
      total: 0,
      events: [],
      hooks: [],
    }));
    const base = await serve(undefined, { hooks: { ...noHooksFile, status } });
    const response = await fetch(`${base}/api/hooks`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: { code: "method_not_allowed", message: "POST is not allowed here." },
    });
    expect(status).not.toHaveBeenCalled();
  });
});

describe("/api/hooks/config", () => {
  const empty = () => ({
    active: false,
    total: 0,
    events: [],
    hooks: [],
  });

  it("is absent when the runner has no configuration file", async () => {
    const base = await serve(undefined, { hooks: { ...noHooksFile, status: empty } });
    const response = await fetch(`${base}/api/hooks/config`);
    expect(response.status).toBe(404);
  });

  it("reads and replaces the whole document through the runner", async () => {
    const path = join(temp?.root ?? "", "hooks.json");
    let document: Record<string, unknown> = { hooks: {} };
    const replaceConfig = vi.fn(async (next: unknown) => {
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        throw new Error(`${path} must contain a JSON object.`);
      }
      document = next as Record<string, unknown>;
      return { path, document };
    });
    const base = await serve(undefined, {
      hooks: { status: empty, config: () => ({ path, document }), replaceConfig },
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

describe("ghost MCP routes", () => {
  const jsonRequest = (url: string, method: string, body?: unknown) => fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

  const requestHomeMove = (base: string, move: "rename" | "delete") => move === "rename"
    ? jsonRequest(`${base}/api/ghosts/casper/name`, "PUT", { name: "wisp" })
    : fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });

  const movedHomeFrom = async (
    response: Response,
    move: "rename" | "delete",
  ): Promise<string> => {
    expect(response.status).toBe(200);
    const body = await response.json() as { trash?: string };
    return move === "rename" ? join(temp!.root, "wisp") : body.trash!;
  };

  const recreateOldName = async (base: string): Promise<string> => {
    const response = await jsonRequest(`${base}/api/ghosts`, "POST", { name: "casper" });
    expect(response.status).toBe(201);
    return join(temp!.root, "casper");
  };

  it("keeps malformed MCP values out of HTTP and rejects them on mutation", async () => {
    const base = await serve();
    const collection = `${base}/api/ghosts/casper/mcp`;
    const sentinel = "MCP_HTTP_MALFORMED_SENTINEL";
    const ghostDir = join(temp!.root, "casper");
    writeFileSync(join(ghostDir, "mcp.json"), JSON.stringify({
      mcpServers: {
        valid: { type: "stdio", command: process.execPath, args: ["--version"] },
        malformed: { type: "http", url: { secret: sentinel } },
      },
    }));

    const listed = await fetch(collection);
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(sentinel);
    expect(JSON.parse(listedText)).toMatchObject({
      servers: [expect.objectContaining({ name: "valid" })],
      skipped: [expect.objectContaining({
        path: "mcp.json#mcpServers.malformed",
      })],
    });

    const mutation = await jsonRequest(collection, "POST", {
      name: "rejected",
      config: { type: "stdio", command: { secret: sentinel } },
    });
    expect(mutation.status).toBe(400);
    expect(await mutation.text()).not.toContain(sentinel);
  });

  it.each(["rename", "delete"] as const)(
    "finishes an admitted catalog list before %s and isolates old-name reuse",
    async (move) => {
      const readEntered = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      let readCount = 0;
      let resolvedHome = "";
      const base = await serve(undefined, {
        mcpReadProbe: async (home) => {
          readCount += 1;
          if (readCount !== 1) return;
          resolvedHome = home;
          readEntered.resolve();
          await releaseRead.promise;
        },
      });
      const originalHome = join(temp!.root, "casper");
      writeFileSync(join(originalHome, "mcp.json"), JSON.stringify({
        mcpServers: { original: { type: "stdio", command: "/bin/true" } },
      }));
      const originalInode = statSync(originalHome, { bigint: true }).ino;

      const listing = fetch(`${base}/api/ghosts/casper/mcp`);
      await readEntered.promise;
      expect(resolvedHome).toBe(originalHome);
      const moving = requestHomeMove(base, move);
      await waitForHomeMove();

      releaseRead.resolve();
      const listResponse = await listing;
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        servers: [expect.objectContaining({ name: "original" })],
      });
      const movedHome = await movedHomeFrom(await moving, move);
      expect(statSync(movedHome, { bigint: true }).ino).toBe(originalInode);

      const replacementHome = await recreateOldName(base);
      expect(statSync(replacementHome, { bigint: true }).ino).not.toBe(originalInode);
      expect(await (await fetch(`${base}/api/ghosts/casper/mcp`)).json())
        .toEqual({ servers: [], skipped: [] });
      expect(JSON.parse(readFileSync(join(movedHome, "mcp.json"), "utf8")))
        .toMatchObject({ mcpServers: { original: expect.any(Object) } });
    },
  );

  it("keeps inherited-object MCP names as ordinary own entries over HTTP", async () => {
    const base = await serve();
    const collection = `${base}/api/ghosts/casper/mcp`;
    const names = ["__proto__", "constructor", "toString"];
    for (const name of names) {
      const response = await jsonRequest(collection, "POST", {
        name,
        config: { type: "stdio", command: `${name}-before`, enabled: true },
      });
      expect(response.status).toBe(201);
    }

    const listed = await (await fetch(collection)).json() as {
      servers: Array<{ name: string; source: string; path: string }>;
    };
    const listedByName = new Map(listed.servers.map((server) => [server.name, server]));
    for (const name of names) {
      expect(listedByName.get(name)).toMatchObject({
        name,
        source: "canonical",
        path: "mcp.json",
      });
    }

    expect((await jsonRequest(`${collection}/__proto__`, "PUT", {
      config: { type: "stdio", command: "proto-after" },
    })).status).toBe(200);
    expect((await jsonRequest(`${collection}/constructor/enabled`, "PUT", {
      enabled: false,
    })).status).toBe(200);
    expect((await jsonRequest(`${collection}/toString`, "DELETE")).status).toBe(200);

    const final = await (await fetch(collection)).json() as {
      servers: Array<{ name: string; enabled: boolean; config: { command?: string } }>;
    };
    const finalByName = new Map(final.servers.map((server) => [server.name, server]));
    expect(finalByName.get("__proto__")).toMatchObject({
      enabled: true,
      config: { command: "proto-after" },
    });
    expect(finalByName.get("constructor")).toMatchObject({ enabled: false });
    expect(finalByName.has("toString")).toBe(false);

    const persisted = JSON.parse(readFileSync(join(temp!.root, "casper", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.hasOwn(persisted.mcpServers, "__proto__")).toBe(true);
    expect(Object.hasOwn(persisted.mcpServers, "constructor")).toBe(true);
    expect(Object.hasOwn(persisted.mcpServers, "toString")).toBe(false);
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

  it("blocks old-name reuse until a whole-home rename releases its reservation", async () => {
    const cleanupEntered = Promise.withResolvers<void>();
    const resumeCleanup = Promise.withResolvers<void>();
    let paused = false;
    const base = await serve(undefined, {
      scheduleCommandRunner: async () => {
        if (!paused) {
          paused = true;
          cleanupEntered.resolve();
          await resumeCleanup.promise;
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const renaming = fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wisp" }),
    });
    await cleanupEntered.promise;

    const blocked = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "casper" }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "ghost_busy" } });

    resumeCleanup.resolve();
    expect((await renaming).status).toBe(200);
    const reused = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "casper" }),
    });
    expect(reused.status).toBe(201);
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
      "tool_execution_start",
      "tool_execution_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.reason).toBe("stop");

    const text = events
      .filter((event): event is Extract<TurnEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("I set type for a living.");
  });

  it("never leaks reasoning onto the wire", async () => {
    const base = await serve([{
      events: [
        { type: "thinking", block: "r", delta: "private reasoning" },
        { type: "text", block: "a", delta: "Answer." },
      ],
    }]);
    const { events, raw } = await postTurn(base, TURN_BODY);
    expect(events.some((event) => event.type.startsWith("thinking"))).toBe(false);
    expect(raw).not.toContain("private reasoning");
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
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-2" } });
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
      body: JSON.stringify({ context: { messages: [] } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("still terminates the stream when the harness fails", async () => {
    const base = await serve([{ exit: 1, stderr: "boom: the harness crashed" }]);
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
      count: 1,
      followUp: ["Keep the result understated."],
    });
    expect(await (await fetch(queueUrl(base, "conv-queue"))).json()).toMatchObject({ streaming: true, count: 1 });

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
    expect(harness!.calls().map((call) => call.prompt)).toEqual(["Set the type.", "Keep the result understated."]);

    expect(await (await fetch(queueUrl(base, "conv-queue"))).json())
      .toEqual({ streaming: false, count: 0, followUp: [] });
    const tooLate = await enqueue(base, "conv-queue", { text: "Too late" });
    expect(tooLate.status).toBe(409);
    expect(await tooLate.json()).toMatchObject({ error: { code: "session_not_streaming" } });
    expect((await fetch(queueUrl(base, "conv-queue"), { method: "DELETE" })).status).toBe(405);
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
      "createdAt",
      "harness",
      "id",
      "messageCount",
      "pinned",
      "preview",
      "title",
      "unread",
      "updatedAt",
    ]);
    expect(sessions[0]).toMatchObject({
      id: "conv-1",
      title: null,
      preview: "Who are you?",
      harness: "fake",
      messageCount: 2,
      pinned: false,
      unread: true,
    });
    expect(sessions[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    for (const invalid of ["a".repeat(129), ".hidden", "folder/chat", "chat?draft", "\u{1f47b}", "\ud800"]) {
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

  it("lists agents, sets and clears the ghost's preference, and switches a conversation", async () => {
    const base = await serve();
    const ghostHarness = (init?: RequestInit) => fetch(`${base}/api/ghosts/casper/harness`, init);
    const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    expect(await (await ghostHarness()).json()).toMatchObject({ harnesses: [{ id: "fake", eligible: true }], ghostDefault: null });
    expect(await (await ghostHarness(put({ harness: "fake" }))).json()).toMatchObject({ ghostDefault: "fake" });
    expect(await (await ghostHarness(put({ harness: null }))).json()).toMatchObject({ ghostDefault: null });
    expect((await ghostHarness(put({ harness: "nope" }))).status).toBe(400);
    expect((await ghostHarness(put({}))).status).toBe(400);
    expect((await ghostHarness({ method: "DELETE" })).status).toBe(405);

    const switched = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/harness`, put({ harness: "fake" }));
    expect(await switched.json()).toEqual({ id: "conv-1", harness: "fake" });
    expect((await fetch(`${base}/api/ghosts/casper/sessions/conv-1/harness`, put({ harness: null }))).status).toBe(400);
  });

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

describe("PUT /api/ghosts/:name/name", () => {
  const rename = (base: string, name: string, body: unknown) => fetch(
    `${base}/api/ghosts/${encodeURIComponent(name)}/name`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  it("renames the ghost, moves its home, and keeps the conversation id valid", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);

    const renamed = await rename(base, "casper", { name: "wisp" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ ok: true, name: "wisp" });
    expect(existsSync(join(temp!.root, "casper"))).toBe(false);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(true);

    const { sessions } = await (await fetch(`${base}/api/ghosts/wisp/sessions`)).json() as {
      sessions: Array<{ id: string }>;
    };
    expect(sessions.map((session) => session.id)).toEqual(["conv-1"]);
    expect((await fetch(
      `${base}/api/ghosts/wisp/sessions/conv-1/transcript`,
    )).status).toBe(200);
    expect((await fetch(`${base}/api/ghosts/casper/sessions`)).status).toBe(404);
  });

  it("returns a retryable 503 without moving the home when schedule cleanup fails", async () => {
    const base = await serve(undefined, {
      scheduleCommandRunner: async () => ({
        stdout: "",
        stderr: "systemd manager unavailable",
        code: 1,
      }),
    });

    const response = await rename(base, "casper", { name: "wisp" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "schedule_cleanup_failed" },
    });
    expect(existsSync(join(temp!.root, "casper"))).toBe(true);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(false);
  });

  it("refuses a bad name, an unknown ghost, and a taken name", async () => {
    const base = await serve();
    await (await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mina" }),
    })).json();

    for (const body of [{}, { name: 7 }, { name: ".hidden" }, { name: "with/slash" }]) {
      const response = await rename(base, "casper", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await rename(base, "nobody", { name: "wisp" })).status).toBe(404);
    const taken = await rename(base, "casper", { name: "mina" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: "already_exists" } });
    // Its own name is a no-op, not a collision.
    expect((await rename(base, "casper", { name: "casper" })).status).toBe(200);
    expect((await fetch(`${base}/api/ghosts/casper/name`)).status).toBe(405);
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
    const body = await deleted.json() as { ok: boolean; trash: string };
    expect(body.ok).toBe(true);
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    // The whole conversation directory moves, its log with it.
    expect(existsSync(conversationDir(sessionDir, "conv-1"))).toBe(false);
    expect(existsSync(join(body.trash, LOG_FILENAME))).toBe(true);
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });

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
    const { base, release } = await serveHeld();
    const turn = postTurn(base, turnBody("conv-held"));
    await waitForLaunches(1);

    const renameBusy = await fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wisp" }),
    });
    expect(renameBusy.status).toBe(409);
    expect(await renameBusy.json()).toMatchObject({ error: { code: "ghost_busy" } });
    const busy = await fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "ghost_busy" } });
    const sessionBusy = await fetch(`${base}/api/ghosts/casper/sessions/conv-held`, { method: "DELETE" });
    expect(sessionBusy.status).toBe(409);
    expect(await sessionBusy.json()).toMatchObject({ error: { code: "session_busy" } });
    expect(existsSync(join(temp!.root, "casper"))).toBe(true);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(false);

    release();
    await turn;

    const deleted = await fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
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
      title: string | null;
      harness: string | null;
      messages: Array<{ role: string; content: unknown }>;
      total: number;
      truncated: boolean;
    };
    expect(transcript).toMatchObject({ id: "conv-1", title: null, harness: "fake", total: 2, truncated: false });
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

  it("reads the renamed home's conversation after a rename and nothing under a recreated old name", async () => {
    const base = await serve(replies("Original-home answer."));
    await postTurn(base, TURN_BODY);
    expect((await fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wisp" }),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "casper" }),
    })).status).toBe(201);

    const renamed = await fetch(`${base}/api/ghosts/wisp/sessions/conv-1/transcript`);
    expect(renamed.status).toBe(200);
    expect(JSON.stringify(await renamed.json())).toContain("Original-home answer.");
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript`)).json())
      .toMatchObject({ id: "conv-1", messages: [], total: 0 });
  });

  it("reads a conversation with no log yet as empty, and 404s an unknown ghost", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/sessions/nope/transcript`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "nope", harness: null, messages: [], total: 0 });
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
    expect(await transcript.json()).toMatchObject({ id: "conv-1", harness: "fake" });
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

describe("GET /api/status", () => {
  it("reports the last update check, and null when none is known", async () => {
    const base = await serve(undefined, {
      update: () => ({ latest: "0.9.0", command: "omarchy-update", url: "https://github.com/ferdousbhai/ghost/releases/tag/v0.9.0" }),
    });
    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ update: { latest: "0.9.0", command: "omarchy-update" } });
    await listening!.close();
    const quiet = await serve();
    expect(await (await fetch(`${quiet}/api/status`)).json()).toMatchObject({ update: null });
  });
});
