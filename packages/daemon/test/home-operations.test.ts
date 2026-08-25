import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { readGhostModels } from "../src/models.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { deferred } from "./helpers/fake-login-runtime.js";
import { makeFakeCatalogRuntime, sampleCatalog } from "./helpers/fake-catalog-runtime.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

async function waitForMove(coordinator: HomeOperationCoordinator): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (coordinator.moveReservationCount !== 1) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the home-operation gate");
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

describe("path-bound mutations during whole-home moves", () => {
  it("drains deferred model runtime construction before rename and moves the completed change", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    host = new SessionHost({ registry: temp.registry, offline: true });
    const coordinator = new HomeOperationCoordinator(temp.registry);
    const constructionStarted = deferred<void>();
    const finishConstruction = deferred<void>();
    let runtimeCalls = 0;
    const catalog = new ModelCatalog({
      registry: temp.registry,
      homeOperations: coordinator,
      offline: true,
      createRuntime: async () => {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          constructionStarted.resolve();
          await finishConstruction.promise;
        }
        return makeFakeCatalogRuntime({
          models: sampleCatalog(),
          credentialed: ["openai-codex"],
        });
      },
      claudeCodePlanStatus: async () => false,
    });
    listening = await startDaemonServer({
      registry: temp.registry,
      host,
      catalog,
      homeOperations: coordinator,
      port: 0,
      relay: null,
      apiToken: null,
    });
    const base = `http://127.0.0.1:${listening.port}`;
    const selection = jsonRequest(`${base}/api/ghosts/casper/model`, "PUT", {
      provider: "openai-codex",
      id: "gpt-5-codex",
    });
    await constructionStarted.promise;

    const rename = jsonRequest(`${base}/api/ghosts/casper/name`, "PUT", { name: "wisp" });
    await waitForMove(coordinator);
    const blocked = await jsonRequest(`${base}/api/ghosts/casper/model`, "PUT", {
      provider: "openai-codex",
      id: "gpt-5-mini",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "ghost_busy" } });
    expect(runtimeCalls).toBe(1);

    finishConstruction.resolve();
    const [selected, renamed] = await Promise.all([selection, rename]);
    expect(selected.status).toBe(200);
    expect(renamed.status).toBe(200);
    expect(existsSync(join(temp.root, "casper"))).toBe(false);
    const movedModels = readGhostModels(ghostPaths(join(temp.root, "wisp")).agentDir);
    expect(movedModels?.roles?.chat_model).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5-codex",
    });
    expect(coordinator.moveReservationCount).toBe(0);

    const after = await jsonRequest(`${base}/api/ghosts/wisp/model`, "PUT", {
      provider: "openai-codex",
      id: "gpt-5-mini",
    });
    expect(after.status).toBe(200);
  });

  it("drains a deferred MCP writer before delete without recreating the old home", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    host = new SessionHost({ registry: temp.registry, offline: true });
    const coordinator = new HomeOperationCoordinator(temp.registry);
    const writerStarted = deferred<void>();
    const finishWriter = deferred<void>();
    let writerCalls = 0;
    const mcp = new McpCatalog({
      registry: temp.registry,
      homeOperations: coordinator,
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
      homeOperations: coordinator,
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
    await waitForMove(coordinator);
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
    const moved = JSON.parse(readFileSync(join(trash, ".omp", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(moved.mcpServers)).toEqual(["alpha"]);
    expect(coordinator.moveReservationCount).toBe(0);

    temp.registry.create("casper");
    const replacement = await jsonRequest(`${base}/api/ghosts/casper/mcp`, "POST", {
      name: "replacement",
      config: { type: "stdio", command: "replacement-server" },
    });
    expect(replacement.status).toBe(201);
    expect(writerCalls).toBe(2);
  });

  it("releases the operation gate when SessionHost refuses the reserved move", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    seedGhost(temp.root, { name: "wisp" });
    host = new SessionHost({ registry: temp.registry, offline: true });
    const coordinator = new HomeOperationCoordinator(temp.registry);
    const catalog = new ModelCatalog({
      registry: temp.registry,
      homeOperations: coordinator,
      offline: true,
      createRuntime: async () => makeFakeCatalogRuntime({
        models: sampleCatalog(),
        credentialed: ["openai-codex"],
      }),
      claudeCodePlanStatus: async () => false,
    });
    listening = await startDaemonServer({
      registry: temp.registry,
      host,
      catalog,
      homeOperations: coordinator,
      port: 0,
      relay: null,
      apiToken: null,
    });
    const base = `http://127.0.0.1:${listening.port}`;

    const refused = await jsonRequest(`${base}/api/ghosts/casper/name`, "PUT", { name: "wisp" });
    expect(refused.status).toBe(409);
    expect(coordinator.moveReservationCount).toBe(0);
    const mutation = await jsonRequest(`${base}/api/ghosts/casper/model`, "PUT", {
      provider: "openai-codex",
      id: "gpt-5-codex",
    });
    expect(mutation.status).toBe(200);
  });
});
