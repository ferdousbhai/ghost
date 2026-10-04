import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpCatalog } from "../src/mcp-catalog.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeSessionHost(fixture: TempGhosts): SessionHost {
  return new SessionHost({
    registry: fixture.registry,
    ownerHome: fixture.ownerHome,
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
}

afterEach(async () => {
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

/** Until the move holds the home: its file routes then answer ghost_busy. */
async function waitForMove(base: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while ((await fetch(`${base}/api/ghosts/casper/character`)).status !== 409) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the move to hold the home");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function jsonRequest(url: string, method: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

describe("file work during whole-home moves", () => {
  it("drains a deferred MCP writer before delete without recreating the old home", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    host = makeSessionHost(temp);
    const writerStarted = deferred<void>();
    const finishWriter = deferred<void>();
    let writerCalls = 0;
    const mcp = new McpCatalog({
      registry: temp.registry,
      writer: {
        add: async (path, name, config) => {
          writerCalls += 1;
          if (writerCalls === 1) {
            writerStarted.resolve();
            await finishWriter.promise;
          }
          let document: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
          if (existsSync(path)) {
            document = JSON.parse(readFileSync(path, "utf8")) as typeof document;
          }
          document.mcpServers[name] = config;
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
        },
      },
    });
    listening = await startDaemonServer({
      registry: temp.registry,
      host,
      mcp,
      port: 0,
      relay: null,
      apiToken: null,
    });
    const base = `http://127.0.0.1:${listening.port}`;
    const add = jsonRequest(`${base}/api/ghosts/casper/mcp`, "POST", {
      name: "alpha",
      config: { type: "stdio", command: "alpha-server" },
    });
    await writerStarted.promise;

    const deletion = fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    await waitForMove(base);
    const blocked = await jsonRequest(`${base}/api/ghosts/casper/mcp`, "POST", {
      name: "bravo",
      config: { type: "stdio", command: "bravo-server" },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "ghost_busy" } });
    expect(writerCalls).toBe(1);

    finishWriter.resolve();
    const [added, deleted] = await Promise.all([add, deletion]);
    expect(added.status).toBe(201);
    expect(deleted.status).toBe(200);
    const { trash } = await deleted.json() as { trash: string };
    expect(existsSync(join(temp.root, "casper"))).toBe(false);
    const moved = JSON.parse(readFileSync(join(trash, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(moved.mcpServers)).toEqual(["alpha"]);

    temp.registry.create("casper");
    const replacement = await jsonRequest(`${base}/api/ghosts/casper/mcp`, "POST", {
      name: "replacement",
      config: { type: "stdio", command: "replacement-server" },
    });
    expect(replacement.status).toBe(201);
    expect(writerCalls).toBe(2);
  });
});
