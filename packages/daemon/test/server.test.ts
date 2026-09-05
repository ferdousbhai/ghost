/**
 * HTTP tests over a real listening server on an ephemeral loopback port.
 *
 * The SSE assertions use Ghost's in-repo conformance parser
 * (`parseSseStream`), matching the shell's framing rules so a change that would
 * break the real UI breaks these tests.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSessionMetadataPath } from "../src/claude-code.js";
import { ghostPaths } from "../src/ghosts.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import { McpCatalog, type McpCatalogOptions } from "../src/mcp-catalog.js";
import { listGhostMemory, trashGhostMemoryFile, writeGhostMemory } from "../src/memory-files.js";
import { setGhostModelRole } from "../src/models.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { projectBindingPath } from "../src/project-binding.js";
import {
  startDaemonServer,
  type ListeningServer,
  type ServerOptions,
} from "../src/server.js";
import {
  SessionHost,
  sessionFileNameFor,
  type SessionHostOptions,
} from "../src/session-host.js";
import { toolCwdsPath } from "../src/tool-cwds.js";
import { makeTempGhosts, parseSseStream, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

let temp: TempGhosts | null = null;
let provider: MockProvider | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;
let homeOperations: HomeOperationCoordinator | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  homeOperations = null;
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
  serverOptions: {
    maxBodyBytes?: number;
    apiToken?: string | null;
    hooks?: ServerOptions["hooks"];
    memoryReader?: ServerOptions["memoryReader"];
    memoryWriter?: ServerOptions["memoryWriter"];
    memoryTrasher?: ServerOptions["memoryTrasher"];
    conversationFileProbe?: SessionHostOptions["conversationFileProbe"];
    mcpReadProbe?: McpCatalogOptions["readProbe"];
    scheduleCommandRunner?: SessionHostOptions["scheduleCommandRunner"];
  } = {},
) {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  provider = await startMockProvider({ script });
  seedGhost(temp.root, {
    name: "casper",
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  homeOperations = new HomeOperationCoordinator(temp.registry);
  host = new SessionHost({
    registry: temp.registry,
    homeOperations,
    ownerHome: temp.ownerHome,
    offline: true,
    scheduleCommandRunner: serverOptions.scheduleCommandRunner
      ?? (async () => ({ stdout: "", stderr: "", code: 0 })),
    ...(serverOptions.conversationFileProbe === undefined
      ? {}
      : { conversationFileProbe: serverOptions.conversationFileProbe }),
  });
  const mcp = new McpCatalog({
    registry: temp.registry,
    homeOperations,
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
    // Routing and streaming are the subject here; auth has its own file.
    apiToken: null,
    ...(serverOptions.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: serverOptions.maxBodyBytes }),
    ...(serverOptions.apiToken === undefined ? {} : { apiToken: serverOptions.apiToken }),
    ...(serverOptions.hooks === undefined ? {} : { hooks: serverOptions.hooks }),
    ...(serverOptions.memoryReader === undefined
      ? {}
      : { memoryReader: serverOptions.memoryReader }),
    ...(serverOptions.memoryWriter === undefined
      ? {}
      : { memoryWriter: serverOptions.memoryWriter }),
    ...(serverOptions.memoryTrasher === undefined
      ? {}
      : { memoryTrasher: serverOptions.memoryTrasher }),
  });
  return `http://127.0.0.1:${listening.port}`;
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

const piId = (conversationId: string): string => `pi:${conversationId}`;
const piSegment = (conversationId: string): string => encodeURIComponent(piId(conversationId));
const claudeSegment = (conversationId: string): string =>
  encodeURIComponent(`claude-code:${conversationId}`);

function writeMcpRouteFixture(dir: string, fileName: string, toolName: string): string {
  const serverPath = join(dir, fileName);
  writeFileSync(
    serverPath,
    `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send(request.id, {
    protocolVersion: "2025-11-25", capabilities: { tools: {} },
    serverInfo: { name: "route-fixture", version: "1.0.0" }
  });
  else if (request.method === "tools/list") send(request.id, { tools: [{
    name: ${JSON.stringify(toolName)}, description: "Route fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }] });
  else send(request.id, {});
});
`,
    "utf8",
  );
  return serverPath;
}

function seedClaudeSidecar(conversationId: string): void {
  const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    claudeSessionMetadataPath(sessionDir, conversationId),
    `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId,
      sessionId: "8f0a1c1e-0000-4000-8000-000000000000",
      created: now,
      modified: now,
      messageCount: 2,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function waitForAsk(base: string, sessionId: string): Promise<{
  id: string;
  questions: Array<{ id: string; question: string }>;
}> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment(sessionId)}/ask`,
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
        { event: "before_prompt", source: "builtin", name: "Prompt policy", description: "Adds policy." },
        { event: "session_stop", source: "config", name: "Completion", description: "Checks completion." },
        {
          event: "session_stop",
          source: "builtin",
          name: "Review",
          description: "Reviews the pass.",
          settingsKey: "review",
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
        { event: "before_prompt", source: "builtin", name: "Prompt policy", description: "Adds policy." },
        { event: "session_stop", source: "config", name: "Completion", description: "Checks completion." },
        {
          event: "session_stop",
          source: "builtin",
          name: "Review",
          description: "Reviews the pass.",
          settingsKey: "review",
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

describe("conversation project binding", () => {
  it("binds a trusted project before the first turn with durable cwd and optimistic generation", async () => {
    const base = await serve();
    const project = join(temp!.root, "wide project");
    const child = join(project, "packages", "app");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# Project instructions\n");
    const route = `${base}/api/ghosts/casper/sessions/${piSegment("draft-project")}/project`;

    const relativePreview = await fetch(`${route}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "wide project" }),
    });
    expect(relativePreview.status).toBe(400);
    expect(await relativePreview.json()).toMatchObject({ error: { code: "invalid_request" } });

    const initial = await fetch(route);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      root: null,
      cwd: temp!.ownerHome,
      relativeCwd: null,
      generation: 0,
      status: "unbound",
      canRebind: true,
    });

    const preview = await fetch(`${route}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    expect(preview.status).toBe(200);
    const receipt = await preview.json() as { root: string; trustToken: string };
    expect(receipt.root).toBe(project);

    const relativeCwd = await fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        cwd: "packages/app",
        trustToken: receipt.trustToken,
        expectedGeneration: 0,
      }),
    });
    expect(relativeCwd.status).toBe(400);
    expect(await relativeCwd.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const relativeRoot = await fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: "wide project",
        trustToken: receipt.trustToken,
        expectedGeneration: 0,
      }),
    });
    expect(relativeRoot.status).toBe(400);
    expect(await relativeRoot.json()).toMatchObject({ error: { code: "invalid_request" } });

    const replacementPreview = await fetch(`${route}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    const replacementReceipt = await replacementPreview.json() as { trustToken: string };

    const bind = await fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        cwd: child,
        trustToken: replacementReceipt.trustToken,
        expectedGeneration: 0,
      }),
    });
    expect(bind.status).toBe(200);
    expect(await bind.json()).toMatchObject({
      root: project,
      cwd: child,
      relativeCwd: "packages/app",
      generation: 1,
      status: "ready",
      resources: { instructions: 1 },
    });

    const listing = await fetch(`${base}/api/ghosts/casper/sessions`);
    expect(await listing.json()).toEqual({ sessions: [] });

    const stale = await fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: null, expectedGeneration: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_generation" } });

    const reload = await fetch(`${route}/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedGeneration: 1 }),
    });
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ generation: 2, reason: "reloaded" });

    const removed = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("draft-project")}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      ok: true,
      trash: [
        expect.objectContaining({ artifact: "project-binding" }),
        expect.objectContaining({ artifact: "project-snapshot" }),
      ],
    });
    expect(await (await fetch(route)).json()).toMatchObject({ root: null, generation: 0 });
  });

  it("abandons only an unpublished runtime-qualified project draft", async () => {
    const base = await serve([{ kind: "text", text: "published" }]);
    const project = join(temp!.root, "abandon-route-project");
    mkdirSync(project);
    const id = "abandon-route";
    const route = `${base}/api/ghosts/casper/sessions/${piSegment(id)}/project`;
    const preview = await (await fetch(`${route}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })).json() as { trustToken: string };
    expect((await fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      }),
    })).status).toBe(200);

    const abandoned = await fetch(`${route}/draft`, { method: "DELETE" });
    expect(abandoned.status).toBe(200);
    expect(await abandoned.json()).toEqual({
      ok: true,
      id: `pi:${id}`,
      conversationId: id,
      runtime: "pi",
      abandoned: true,
    });
    expect(await (await fetch(`${route}/draft`, { method: "DELETE" })).json())
      .toMatchObject({ id: `pi:${id}`, abandoned: false });
    const wrongMethod = await fetch(`${route}/draft`);
    expect(wrongMethod.status).toBe(405);

    const nextPreview = await (await fetch(`${route}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })).json() as { trustToken: string };
    expect((await fetch(route, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        trustToken: nextPreview.trustToken,
        expectedGeneration: 0,
      }),
    })).status).toBe(200);
    await postTurn(base, { ...TURN_BODY, options: { sessionId: id } });
    const published = await fetch(`${route}/draft`, { method: "DELETE" });
    expect(published.status).toBe(409);
    expect(await published.json()).toMatchObject({
      error: { code: "project_draft_published" },
    });
  });

  it("binds preview receipts to one runtime conversation and freezes Claude after its first turn", async () => {
    const base = await serve();
    const project = join(temp!.root, "claude-project");
    mkdirSync(project, { recursive: true });
    const firstRoute = `${base}/api/ghosts/casper/sessions/${claudeSegment("claude-project")}/project`;
    const wrongRoute = `${base}/api/ghosts/casper/sessions/${piSegment("other")}/project`;
    const preview = await fetch(`${firstRoute}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    const receipt = await preview.json() as { trustToken: string };

    const wrong = await fetch(wrongRoute, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        trustToken: receipt.trustToken,
        expectedGeneration: 0,
      }),
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ error: { code: "trust_token_invalid" } });

    const secondPreview = await fetch(`${firstRoute}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    const secondReceipt = await secondPreview.json() as { trustToken: string };
    expect((await fetch(firstRoute, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        trustToken: secondReceipt.trustToken,
        expectedGeneration: 0,
      }),
    })).status).toBe(200);

    seedClaudeSidecar("claude-project");
    const frozen = await fetch(firstRoute);
    expect(await frozen.json()).toMatchObject({ canRebind: false, generation: 1 });
    const reload = await fetch(`${firstRoute}/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedGeneration: 1 }),
    });
    expect(reload.status).toBe(409);
    expect(await reload.json()).toMatchObject({
      error: { code: "project_rebind_requires_new_conversation" },
    });
  });
});

describe("/api/ghosts/:name/memory", () => {
  it("lists the plain memory files and rejects other methods", async () => {
    const base = await serve();
    const ghostDir = join(temp!.root, "casper");
    writeFileSync(
      join(ghostDir, "memory", "preferred-tone.md"),
      "The owner prefers direct answers. Lead with the decision.\n",
      "utf8",
    );

    const response = await fetch(`${base}/api/ghosts/casper/memory`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      memory: Array<{ path: string; slug: string; content: string; updated: string }>;
      skipped: unknown[];
    };
    expect(body.memory).toEqual([{
      path: "memory/preferred-tone.md",
      slug: "preferred-tone",
      content: "The owner prefers direct answers. Lead with the decision.",
      updated: expect.any(String),
    }]);
    expect(body.skipped).toEqual([]);

    expect((await fetch(`${base}/api/ghosts/casper/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).toBe(405);
    expect((await fetch(`${base}/api/ghosts/missing/memory`)).status).toBe(404);
  });

  it("writes one fact through the validating writer", async () => {
    const base = await serve();
    const ghostDir = join(temp!.root, "casper");
    const put = (body: unknown) => fetch(`${base}/api/ghosts/casper/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const created = await put({ content: "Prefers concise replies." });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      ok: true,
      slug: "prefers-concise-replies",
      path: "memory/prefers-concise-replies.md",
      created: true,
    });
    expect(readFileSync(join(ghostDir, "memory", "prefers-concise-replies.md"), "utf8"))
      .toBe("Prefers concise replies.\n");

    const replaced = await put({ name: "prefers-concise-replies", content: "Prefers one item." });
    expect((await replaced.json() as { created: boolean }).created).toBe(false);
    expect(readFileSync(join(ghostDir, "memory", "prefers-concise-replies.md"), "utf8"))
      .toBe("Prefers one item.\n");

    expect((await put({ content: "   " })).status).toBe(400);
    expect((await put({ content: 42 })).status).toBe(400);
    expect((await put({ name: "Not A Slug", content: "x" })).status).toBe(400);
  });

  it("holds the home lease through memory publication before a concurrent delete", async () => {
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const base = await serve(undefined, {
      memoryWriter: async (...args) => {
        writerEntered.resolve();
        await releaseWriter.promise;
        return writeGhostMemory(...args);
      },
    });
    const ghostDir = join(temp!.root, "casper");
    const writing = fetch(`${base}/api/ghosts/casper/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "The memory write owns its home path." }),
    });
    await writerEntered.promise;

    let deleteSettled = false;
    const deleting = fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" })
      .then((response) => {
        deleteSettled = true;
        return response;
      });
    await waitForHomeMove();
    expect(deleteSettled).toBe(false);

    releaseWriter.resolve();
    const [written, deleted] = await Promise.all([writing, deleting]);
    expect(written.status).toBe(200);
    expect(deleted.status).toBe(200);
    const { trash } = await deleted.json() as { trash: string };
    expect(existsSync(ghostDir)).toBe(false);
    expect(readFileSync(join(trash, "memory", "the-memory-write-owns-its-home.md"), "utf8"))
      .toBe("The memory write owns its home path.\n");
  });

  it("holds the home lease through a memory trash before a concurrent delete", async () => {
    const trasherEntered = Promise.withResolvers<void>();
    const releaseTrasher = Promise.withResolvers<void>();
    const base = await serve(undefined, {
      memoryTrasher: async (...args) => {
        trasherEntered.resolve();
        await releaseTrasher.promise;
        return trashGhostMemoryFile(...args);
      },
    });
    const ghostDir = join(temp!.root, "casper");
    writeFileSync(join(ghostDir, "memory", "doomed.md"), "doomed\n", "utf8");
    const trashing = fetch(`${base}/api/ghosts/casper/memory`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "memory/doomed.md", confirm: "memory/doomed.md" }),
    });
    await trasherEntered.promise;

    let deleteSettled = false;
    const deleting = fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" })
      .then((response) => {
        deleteSettled = true;
        return response;
      });
    await waitForHomeMove();
    expect(deleteSettled).toBe(false);

    releaseTrasher.resolve();
    const [trashed, deleted] = await Promise.all([trashing, deleting]);
    expect(trashed.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(existsSync(ghostDir)).toBe(false);
  });

  it.each(["rename", "delete"] as const)(
    "finishes an admitted memory read from the original home before %s and old-name reuse",
    async (move) => {
      const readerEntered = Promise.withResolvers<void>();
      const releaseReader = Promise.withResolvers<void>();
      let resolvedDir = "";
      const base = await serve(undefined, {
        memoryReader: async (dir) => {
          resolvedDir = dir;
          readerEntered.resolve();
          await releaseReader.promise;
          return listGhostMemory(dir);
        },
      });
      const originalHome = join(temp!.root, "casper");
      const memoryPath = join(originalHome, "memory", "original-home.md");
      writeFileSync(memoryPath, "This fact belongs to the original home.\n", "utf8");
      const originalInode = statSync(originalHome, { bigint: true }).ino;

      const reading = fetch(`${base}/api/ghosts/casper/memory`);
      await readerEntered.promise;
      expect(resolvedDir).toBe(originalHome);
      const moving = move === "rename"
        ? fetch(`${base}/api/ghosts/casper/name`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "wisp" }),
          })
        : fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
      await waitForHomeMove();

      releaseReader.resolve();
      const readResponse = await reading;
      expect(readResponse.status).toBe(200);
      expect(await readResponse.json()).toMatchObject({
        memory: [{
          path: "memory/original-home.md",
          content: "This fact belongs to the original home.",
        }],
      });
      const movedResponse = await moving;
      expect(movedResponse.status).toBe(200);
      const movedBody = await movedResponse.json() as { trash?: string };
      const movedHome = move === "rename" ? join(temp!.root, "wisp") : movedBody.trash!;
      expect(statSync(movedHome, { bigint: true }).ino).toBe(originalInode);

      const recreated = await fetch(`${base}/api/ghosts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "casper" }),
      });
      expect(recreated.status).toBe(201);
      expect(statSync(originalHome, { bigint: true }).ino).not.toBe(originalInode);
      expect(await (await fetch(`${base}/api/ghosts/casper/memory`)).json())
        .toEqual({ memory: [], skipped: [] });
      expect(readFileSync(join(movedHome, "memory", "original-home.md"), "utf8"))
        .toBe("This fact belongs to the original home.\n");
    },
  );

  it("moves confirmed memory files to Trash and refuses everything else", async () => {
    const base = await serve();
    const ghostDir = join(temp!.root, "casper");
    const doc = join(ghostDir, "docs", "delete-me.md");
    const memory = join(ghostDir, "memory", "delete-me-too.md");
    mkdirSync(join(ghostDir, "docs"), { recursive: true });
    writeFileSync(doc, "doc\n", "utf8");
    writeFileSync(memory, "temporary memory\n", "utf8");
    const remove = (body: unknown) => fetch(`${base}/api/ghosts/casper/memory`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await remove({
      path: "memory/delete-me-too.md",
      confirm: "memory/something-else.md",
    })).status).toBe(400);
    expect(existsSync(memory)).toBe(true);

    expect((await remove({ path: "docs/delete-me.md", confirm: "docs/delete-me.md" })).status)
      .toBe(400);
    expect(existsSync(doc)).toBe(true);

    expect((await remove({
      path: "memory/delete-me-too.md",
      confirm: "memory/delete-me-too.md",
    })).status).toBe(200);
    expect(existsSync(memory)).toBe(false);
    expect((await remove({ path: "character.md", confirm: "character.md" })).status).toBe(400);
    expect(existsSync(join(ghostDir, "character.md"))).toBe(true);
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

describe("POST /api/ghosts/:name/messages runtime admission", () => {
  const body = (sessionId: string, prompt: string) => ({
    ...TURN_BODY,
    context: { messages: [{ role: "user", content: prompt }] },
    options: { sessionId },
  });

  it("returns typed 409 for direct Bash under Claude without creating Pi state", async () => {
    const base = await serve([{ kind: "text", text: "must not run" }]);
    const home = ghostPaths(join(temp!.root, "casper")).home;
    const sessionDir = ghostPaths(home).sessionDir;
    setGhostModelRole(home, "chat_model", "claude-code", "default");
    const id = "http-claude-direct";

    const result = await postTurn(base, body(id, "!!cd /"));

    expect(result.status).toBe(409);
    expect(JSON.parse(result.raw)).toMatchObject({
      error: { code: "not_supported", message: expect.stringContaining("Claude Code") },
    });
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(provider!.requests).toHaveLength(0);
    expect(host!.cachedSessionCount).toBe(0);
    expect(existsSync(join(sessionDir, sessionFileNameFor(id)))).toBe(false);
    expect(existsSync(toolCwdsPath(sessionDir, id))).toBe(false);
    expect(existsSync(projectBindingPath(sessionDir, "pi", id))).toBe(false);
  });

  it("rejects invalid Claude resume timestamps before SSE or runtime admission", async () => {
    const base = await serve([{ kind: "text", text: "must not run" }]);
    const paths = ghostPaths(join(temp!.root, "casper"));
    setGhostModelRole(paths.home, "chat_model", "claude-code", "default");
    const conversationId = "http-invalid-claude-time";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    mkdirSync(paths.sessionDir, { recursive: true });
    const original = `${JSON.stringify({
      version: 3,
      runtime: "claude-code",
      conversationId,
      sessionId: "sdk-http-invalid-claude-time",
      created: "2026-01-01T00:00:00Z",
      modified: "not-a-timestamp",
      messageCount: 2,
      ownerTurnCount: 1,
      cwd: temp!.ownerHome,
      projectSnapshot: {
        root: null,
        declarative: {
          instructions: [],
          skills: [],
          rules: [],
          prompts: [],
          commands: [],
        },
        mcpServers: {},
        resourceWarnings: [],
        mcpWarnings: [],
      },
    })}\n`;
    writeFileSync(sidecar, original, { mode: 0o600 });
    const claude = (host as unknown as {
      claudeCode: { runTurn(...args: unknown[]): Promise<void> };
    }).claudeCode;
    const run = vi.spyOn(claude, "runTurn");

    const result = await postTurn(base, body(conversationId, "must fail before Claude starts"));

    expect(result.status).toBe(500);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(result.raw)).toMatchObject({
      error: { code: "claude_session_invalid" },
    });
    expect(result.events).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(provider!.requests).toHaveLength(0);
    expect(readFileSync(sidecar, "utf8")).toBe(original);
  });

  it("returns typed project_runtime_mismatch in both selected-runtime directions", async () => {
    const base = await serve([{ kind: "text", text: "must not run" }]);
    const home = ghostPaths(join(temp!.root, "casper")).home;
    const sessionDir = ghostPaths(home).sessionDir;
    const project = join(temp!.root, "http-runtime-mismatch-project");
    mkdirSync(project);

    for (const [selectedRuntime, oppositeRuntime, id, prompt] of [
      ["pi", "claude-code", "http-pi-mismatch", "ordinary owner message"],
      ["claude-code", "pi", "http-claude-mismatch", "!pwd"],
    ] as const) {
      if (selectedRuntime === "claude-code") {
        setGhostModelRole(home, "chat_model", "claude-code", "default");
      }
      const preview = await host!.previewProject("casper", id, oppositeRuntime, project);
      await host!.bindProject("casper", id, oppositeRuntime, {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      const oppositePath = projectBindingPath(sessionDir, oppositeRuntime, id);
      const oppositeBytes = readFileSync(oppositePath, "utf8");

      const result = await postTurn(base, body(id, prompt));

      expect(result.status).toBe(409);
      expect(JSON.parse(result.raw)).toMatchObject({
        error: { code: "project_runtime_mismatch" },
      });
      expect(result.headers.get("content-type")).toContain("application/json");
      expect(readFileSync(oppositePath, "utf8")).toBe(oppositeBytes);
      expect(existsSync(projectBindingPath(sessionDir, selectedRuntime, id))).toBe(false);
      expect(existsSync(join(sessionDir, sessionFileNameFor(id)))).toBe(false);
      expect(existsSync(toolCwdsPath(sessionDir, id))).toBe(false);
      expect(existsSync(claudeSessionMetadataPath(sessionDir, id))).toBe(false);
    }
    expect(provider!.requests).toHaveLength(0);
    expect(host!.cachedSessionCount).toBe(0);
  });

  it("keeps admitted HTTP turns and MCP transitions mutually exclusive before SSE", async () => {
    const base = await serve([{ kind: "text", text: "lease stayed intact" }]);
    const admitted = Promise.withResolvers<void>();
    const releaseStream = Promise.withResolvers<void>();
    const originalAdmit = host!.admitTurn.bind(host);
    vi.spyOn(host!, "admitTurn").mockImplementation(async (ghostName, options) => {
      const admission = await originalAdmit(ghostName, options);
      admitted.resolve();
      return {
        release: admission.release,
        run: async (streamOptions) => {
          await releaseStream.promise;
          await admission.run(streamOptions);
        },
      };
    });

    const firstId = "http-admitted-mcp-lease";
    const firstTurn = postTurn(base, body(firstId, "hold admission before streaming"));
    await admitted.promise;
    const collection = `${base}/api/ghosts/casper/mcp`;
    const rejectedMutation = await fetch(collection, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "blocked",
        config: { type: "stdio", command: process.execPath, args: ["--version"] },
      }),
    });
    expect(rejectedMutation.status).toBe(409);
    expect(await rejectedMutation.json()).toMatchObject({ error: { code: "session_busy" } });
    const ghostMcpPath = join(temp!.root, "casper", "mcp.json");
    expect(existsSync(ghostMcpPath)).toBe(false);

    writeFileSync(ghostMcpPath, JSON.stringify({
      mcpServers: {
        existing: {
          enabled: false,
          type: "stdio",
          command: process.execPath,
          args: ["--version"],
        },
      },
    }));
    const mcpBytes = readFileSync(ghostMcpPath, "utf8");
    const rejectedReconnect = await fetch(`${collection}/existing/reconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(rejectedReconnect.status).toBe(409);
    expect(await rejectedReconnect.json()).toMatchObject({ error: { code: "session_busy" } });
    expect(readFileSync(ghostMcpPath, "utf8")).toBe(mcpBytes);

    releaseStream.resolve();
    const first = await firstTurn;
    expect(first.status).toBe(200);
    expect(first.events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "done" })]);

    const transitionEntered = Promise.withResolvers<void>();
    const releaseTransition = Promise.withResolvers<void>();
    const transition = host!.withMcpReload("casper", async () => {
      transitionEntered.resolve();
      await releaseTransition.promise;
    });
    await transitionEntered.promise;
    const rejectedTurn = await postTurn(
      base,
      body("http-blocked-by-mcp-lease", "must fail before SSE"),
    );
    expect(rejectedTurn.status).toBe(409);
    expect(rejectedTurn.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(rejectedTurn.raw)).toMatchObject({ error: { code: "session_busy" } });
    expect(existsSync(join(
      ghostPaths(join(temp!.root, "casper")).sessionDir,
      sessionFileNameFor("http-blocked-by-mcp-lease"),
    ))).toBe(false);
    releaseTransition.resolve();
    await transition;

    const retriedTurn = await postTurn(
      base,
      body("http-after-mcp-lease", "run after the transition releases its lease"),
    );
    expect(retriedTurn.status).toBe(200);
    expect(retriedTurn.events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({ type: "done" })]);
  });
});

describe("GET /api/ghosts/:name/sessions/:id/commands", () => {
  it("serves Ghost's session command catalog and enforces GET", async () => {
    const base = await serve();
    const url = `${base}/api/ghosts/casper/sessions/${piSegment("conv-commands")}/commands`;

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      commands: Array<{ name: string; source: string; availability: string }>;
    };
    expect(body.commands).toContainEqual(expect.objectContaining({
      name: "tools",
      source: "builtin",
      availability: "available",
    }));
    expect(body.commands).toContainEqual(expect.objectContaining({
      name: "mcp",
      source: "builtin",
      availability: "unsupported",
    }));

    expect((await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).toBe(405);
    expect((await fetch(
      `${base}/api/ghosts/missing/sessions/${piSegment("conv-commands")}/commands`,
    )).status).toBe(404);

    setGhostModelRole(ghostPaths(join(temp!.root, "casper")).home, "chat_model", "claude-code", "default");
    const claude = await fetch(url);
    expect(claude.status).toBe(409);
    expect(await claude.json()).toMatchObject({
      error: { code: "not_supported", message: expect.stringContaining("Claude Code") },
    });
  });

  it("streams standalone command output instead of an assistant message", async () => {
    const base = await serve();
    const result = await postTurn(base, {
      ...TURN_BODY,
      context: { messages: [{ role: "user", content: "/tools" }] },
      options: { sessionId: "conv-tools" },
    });

    expect(result.status).toBe(200);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "command_output",
      command: "/tools",
      output: expect.stringContaining("read"),
    }));
    expect(result.events.some((event) => event.type === "text_start")).toBe(false);
    expect(provider!.requests).toHaveLength(0);
  });
});

describe("GET /api/ghosts/:name/sessions/:id/resources", () => {
  it("serves the immutable Pi admission snapshot and enforces GET", async () => {
    const base = await serve();
    const skillDirectory = join(
      temp!.ownerHome,
      ".agents",
      "skills",
      "obsidian-cli",
    );
    const skillPath = join(skillDirectory, "SKILL.md");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      skillPath,
      "---\nname: obsidian-cli\ndescription: Use the official Obsidian CLI.\n---\n",
    );
    writeFileSync(
      join(temp!.root, "casper", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          disabled: { type: "stdio", command: "never-start", enabled: false },
          broken: { type: "stdio" },
        },
      }),
    );
    const url = `${base}/api/ghosts/casper/sessions/${piSegment("conv-resources")}/resources`;

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: "pi",
      obsidian: { path: skillPath, status: "admitted" },
      skills: [expect.objectContaining({
        name: "obsidian-cli",
        source: "machine",
        precedence: 0,
        status: "admitted",
      })],
      mcpServers: expect.arrayContaining([
        expect.objectContaining({ name: "disabled", enabled: false, status: "disabled" }),
        expect.objectContaining({
          name: "broken",
          enabled: false,
          status: "skipped",
          reason: expect.any(String),
        }),
      ]),
    });
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("reports a cold Claude query as unavailable instead of reconstructing it", async () => {
    const base = await serve();
    setGhostModelRole(ghostPaths(join(temp!.root, "casper")).home, "chat_model", "claude-code", "default");
    const id = encodeURIComponent("claude-code:conv-resources");

    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${id}/resources`,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "session_resources_unavailable" },
    });
  });
});

describe("session Connect routes", () => {
  it("does not expose encrypted snapshot sharing", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "Not found.", code: "not_found" },
    });
  });

  it("does not expose live voice or a collaboration host", async () => {
    const base = await serve();
    const segment = piSegment("conv-connect");
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

  it("lists without opening a session and manages the project-owned config", async () => {
    const base = await serve();
    const collection = `${base}/api/ghosts/casper/mcp`;

    const empty = await fetch(collection);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ servers: [], skipped: [] });
    const sessions = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: unknown[];
    };
    expect(sessions.sessions).toEqual([]);

    const added = await jsonRequest(collection, "POST", {
      name: "probe",
      config: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", "process.exit(1)", "secret-argument"],
        env: { SECRET_TOKEN: "secret-environment" },
      },
    });
    expect(added.status).toBe(201);
    const addedBody = await added.json() as {
      servers: Array<Record<string, unknown>>;
    };
    expect(addedBody.servers).toContainEqual(expect.objectContaining({
      name: "probe",
      enabled: true,
      source: "canonical",
      connectionStatus: "not_loaded",
      config: expect.objectContaining({ command: process.execPath, argumentCount: 3 }),
    }));
    expect(JSON.stringify(addedBody)).not.toContain("secret-argument");
    expect(JSON.stringify(addedBody)).not.toContain("secret-environment");

    const reconnect = await jsonRequest(`${collection}/probe/reconnect`, "POST", {});
    expect(reconnect.status).toBe(200);
    expect(await reconnect.json()).toMatchObject({
      result: { name: "probe", status: "not_loaded", ok: false },
    });

    const tested = await jsonRequest(`${collection}/probe/test`, "POST", {});
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({
      result: { name: "probe", status: "failed", ok: false, toolCount: 0 },
    });

    const disabled = await jsonRequest(`${collection}/probe/enabled`, "PUT", { enabled: false });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      servers: [expect.objectContaining({ name: "probe", connectionStatus: "disabled" })],
    });

    const updated = await jsonRequest(`${collection}/probe`, "PUT", {
      config: { type: "stdio", command: "replacement", enabled: false },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      servers: [expect.objectContaining({
        name: "probe",
        config: expect.objectContaining({ command: "replacement" }),
      })],
    });

    const removed = await jsonRequest(`${collection}/probe`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ servers: [] });
    expect((await jsonRequest(`${collection}/missing/test`, "POST", {})).status).toBe(404);
    expect((await jsonRequest(collection, "PUT", {})).status).toBe(405);
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

  it.each([
    { action: "test", move: "rename" },
    { action: "reconnect", move: "delete" },
  ] as const)(
    "keeps composite $action and its response snapshot on one home through $move",
    async ({ action, move }) => {
      const actionEntered = Promise.withResolvers<void>();
      const releaseAction = Promise.withResolvers<void>();
      let readCount = 0;
      const base = await serve(undefined, {
        mcpReadProbe: async () => {
          readCount += 1;
          if (readCount !== 1) return;
          actionEntered.resolve();
          await releaseAction.promise;
        },
      });
      const originalHome = join(temp!.root, "casper");
      writeFileSync(join(originalHome, "mcp.json"), JSON.stringify({
        mcpServers: {
          original: {
            type: "stdio",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        },
      }));
      const originalInode = statSync(originalHome, { bigint: true }).ino;

      const acting = jsonRequest(
        `${base}/api/ghosts/casper/mcp/original/${action}`,
        "POST",
        {},
      );
      await actionEntered.promise;
      const moving = requestHomeMove(base, move);
      await waitForHomeMove();

      releaseAction.resolve();
      const actionResponse = await acting;
      expect(actionResponse.status).toBe(200);
      expect(await actionResponse.json()).toMatchObject({
        servers: [expect.objectContaining({ name: "original" })],
        result: expect.objectContaining({ name: "original" }),
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
        config: { type: "stdio", command: `${name}-before` },
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

  it("returns post-reload connection state for every mutation of an open session", async () => {
    const base = await serve();
    const collection = `${base}/api/ghosts/casper/mcp`;
    const ghostDir = join(temp!.root, "casper");
    const firstServer = writeMcpRouteFixture(ghostDir, "route-mcp-first.mjs", "first_echo");
    const secondServer = writeMcpRouteFixture(ghostDir, "route-mcp-second.mjs", "second_echo");
    const opened = await host!.open("casper", "route-mcp-live");
    const firstTool = "mcp__route_fixture_first_echo";
    const secondTool = "mcp__route_fixture_second_echo";

    const added = await jsonRequest(collection, "POST", {
      name: "route_fixture",
      config: { type: "stdio", command: process.execPath, args: [firstServer] },
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      servers: [expect.objectContaining({
        name: "route_fixture",
        connectionStatus: "connected",
      })],
    });
    expect(host!.mcpConnectionStatus("casper", "route_fixture")).toBe("connected");
    expect(opened.session.getToolDefinition(firstTool)).toBeDefined();

    const disabled = await jsonRequest(`${collection}/route_fixture/enabled`, "PUT", {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      servers: [expect.objectContaining({
        name: "route_fixture",
        connectionStatus: "disabled",
      })],
    });
    expect(opened.session.getToolDefinition(firstTool)).toBeUndefined();

    const enabled = await jsonRequest(`${collection}/route_fixture/enabled`, "PUT", {
      enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      servers: [expect.objectContaining({
        name: "route_fixture",
        connectionStatus: "connected",
      })],
    });
    expect(host!.mcpConnectionStatus("casper", "route_fixture")).toBe("connected");
    expect(opened.session.getToolDefinition(firstTool)).toBeDefined();

    const replaced = await jsonRequest(`${collection}/route_fixture`, "PUT", {
      config: { type: "stdio", command: process.execPath, args: [secondServer] },
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      servers: [expect.objectContaining({
        name: "route_fixture",
        connectionStatus: "connected",
      })],
    });
    expect(host!.mcpConnectionStatus("casper", "route_fixture")).toBe("connected");
    expect(opened.session.getToolDefinition(firstTool)).toBeUndefined();
    expect(opened.session.getToolDefinition(secondTool)).toBeDefined();

    const removed = await jsonRequest(`${collection}/route_fixture`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ servers: [] });
    expect(opened.session.getToolDefinition(secondTool)).toBeUndefined();
    expect(host!.mcpConnectionStatus("casper", "route_fixture")).toBe("disconnected");
  });

  it("reports a live reload failure without discarding the old manager or durable mutation", async () => {
    const base = await serve();
    const collection = `${base}/api/ghosts/casper/mcp`;
    const ghostDir = join(temp!.root, "casper");
    const firstServer = writeMcpRouteFixture(ghostDir, "route-mcp-stable.mjs", "stable_echo");
    const secondServer = writeMcpRouteFixture(ghostDir, "route-mcp-next.mjs", "next_echo");
    const opened = await host!.open("casper", "route-mcp-reload-failure");
    const stableTool = "mcp__route_fixture_stable_echo";
    const nextTool = "mcp__route_fixture_next_echo";

    const added = await jsonRequest(collection, "POST", {
      name: "route_fixture",
      config: { type: "stdio", command: process.execPath, args: [firstServer] },
    });
    expect(added.status).toBe(201);
    expect(opened.session.getToolDefinition(stableTool)).toBeDefined();

    vi.spyOn(opened.session, "reload")
      .mockRejectedValueOnce(new Error("injected live MCP publication failure"));
    const failed = await jsonRequest(`${collection}/route_fixture`, "PUT", {
      config: {
        type: "stdio",
        command: process.execPath,
        args: [secondServer],
        cwd: ghostDir,
      },
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(opened.session.getToolDefinition(stableTool)).toBeDefined();
    expect(opened.session.getToolDefinition(nextTool)).toBeUndefined();
    expect(host!.mcpConnectionStatus("casper", "route_fixture")).toBe("connected");

    const durable = await fetch(collection);
    expect(durable.status).toBe(200);
    expect(await durable.json()).toMatchObject({
      servers: [expect.objectContaining({
        name: "route_fixture",
        connectionStatus: "connected",
        config: expect.objectContaining({ cwd: ghostDir }),
      })],
    });

    const retried = await jsonRequest(`${collection}/route_fixture`, "PUT", {
      config: {
        type: "stdio",
        command: process.execPath,
        args: [secondServer],
        cwd: ghostDir,
      },
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      servers: [expect.objectContaining({ connectionStatus: "connected" })],
    });
    expect(opened.session.getToolDefinition(stableTool)).toBeUndefined();
    expect(opened.session.getToolDefinition(nextTool)).toBeDefined();
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
  it("rejects unsupported first-turn Claude project MCP before SSE or runtime publication", async () => {
    const base = await serve();
    const ghostDir = join(temp!.root, "casper");
    const paths = ghostPaths(ghostDir);
    setGhostModelRole(paths.home, "chat_model", "claude-code", "default");
    const project = join(temp!.root, "claude-prestream-secret-project");
    const sentinel = "CLAUDE_PRESTREAM_PROJECT_SECRET";
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        secret: {
          type: "stdio",
          command: process.execPath,
          env: { PROJECT_TOKEN: sentinel },
        },
      },
    }));
    const conversationId = "claude-prestream-secret";
    const projectRoute = `${base}/api/ghosts/casper/sessions/${claudeSegment(conversationId)}/project`;
    const preview = await (await fetch(`${projectRoute}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })).json() as { trustToken: string };
    const bound = await fetch(projectRoute, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      }),
    });
    expect(bound.status).toBe(200);
    const before = await (await fetch(projectRoute)).json() as Record<string, unknown>;
    const claude = (host as unknown as {
      claudeCode: {
        admitProjectSnapshot(...args: unknown[]): Promise<unknown>;
        runTurn(...args: unknown[]): Promise<void>;
      };
    }).claudeCode;
    const scan = vi.spyOn(claude, "admitProjectSnapshot");
    const run = vi.spyOn(claude, "runTurn");

    const response = await fetch(`${base}/api/ghosts/casper/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...TURN_BODY, options: { sessionId: conversationId } }),
    });
    const raw = await response.text();
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(raw).not.toContain("data:");
    expect(JSON.parse(raw)).toMatchObject({
      error: { code: "claude_project_mcp_secrets_unsupported" },
    });
    expect(raw).not.toContain(sentinel);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(provider!.requests).toHaveLength(0);
    expect(existsSync(claudeSessionMetadataPath(paths.sessionDir, conversationId))).toBe(false);
    expect(existsSync(join(paths.sessionDir, sessionFileNameFor(conversationId)))).toBe(false);
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toMatchObject({ sessions: [] });
    expect(await (await fetch(projectRoute)).json()).toMatchObject(before);
  });

  it("streams one well-formed pi-messages turn", async () => {
    const base = await serve([
      { kind: "tool", name: "ghost_memory_list", args: {} },
      { kind: "text", text: "I set type for a living." },
    ]);
    const { status, headers, events, raw } = await postTurn(base, TURN_BODY);

    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("cache-control")).toBe("no-store");
    // The opening comment makes the accepted stream visible before runtime
    // work; event frames retain the canonical `data: <json>\n\n` shape.
    expect(raw.startsWith(": keepalive\n\ndata: ")).toBe(true);

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

describe("Ghost ask interaction", () => {
  it("publishes a blocking ask and accepts the first validated answer", async () => {
    const base = await serve([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Paper",
            question: "Which paper stock?",
            options: [
              { label: "Cream", description: "Warm paper stock" },
              { label: "White", description: "Bright paper stock" },
            ],
            multiSelect: false,
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
    expect(ask.questions[0]).toMatchObject({ id: "question-1", question: "Which paper stock?" });

    const queued = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "steer", text: "Keep the result understated." }),
    });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({
      streaming: true,
      steering: ["Keep the result understated."],
    });
    const queueStatus = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/queue`,
    );
    expect(await queueStatus.json()).toMatchObject({ count: 1 });

    const invalid = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: ask.id,
        kind: "submit",
        results: [{ id: "question-1", selectedOptions: ["Cardboard"] }],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_ask_answer" } });

    const accepted = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: ask.id,
        kind: "submit",
        results: [{ id: "question-1", selectedOptions: ["Cream"] }],
      }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });

    const completed = await turn;
    expect(completed.events.at(-1)?.type).toBe("done");
    const after = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/ask`);
    expect(await after.json()).toEqual({ ask: null });

    const duplicate = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: ask.id, kind: "chat" }),
    });
    expect(duplicate.status).toBe(409);

    const tooLate = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/queue`, {
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
    expect(sessions[0]).toMatchObject({
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
    expect(sessions[0]?.messageCount).toBeGreaterThan(0);
    expect(sessions[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect("title" in sessions[0]!).toBe(true);
  });

  it("keeps equal Pi and Claude resume ids distinct through actions and deletion", async () => {
    const base = await serve();
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "default" } });
    seedClaudeSidecar("default");

    const listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{
        id: string;
        conversationId: string;
        runtime: "pi" | "claude-code";
        pinned: boolean;
        unread: boolean;
      }>;
    };
    expect(listing.sessions.map(({ id, conversationId, runtime }) => ({
      id,
      conversationId,
      runtime,
    }))).toEqual(expect.arrayContaining([
      { id: "pi:default", conversationId: "default", runtime: "pi" },
      { id: "claude-code:default", conversationId: "default", runtime: "claude-code" },
    ]));

    const piTranscript = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("default")}/transcript`,
    );
    expect(piTranscript.status).toBe(200);
    expect(await piTranscript.json()).toMatchObject({
      id: "pi:default",
      conversationId: "default",
      runtime: "pi",
    });
    const claudeTranscript = await fetch(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent("claude-code:default")}/transcript`,
    );
    expect(claudeTranscript.status).toBe(200);
    // The sidecar predates presentation history: readable, empty, and honest
    // about the missing prefix.
    expect(await claudeTranscript.json()).toMatchObject({
      id: "claude-code:default",
      conversationId: "default",
      runtime: "claude-code",
      messages: [],
      total: 0,
      truncated: false,
      historyTruncated: true,
    });
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${claudeSegment("missing")}/transcript`,
    )).status).toBe(404);

    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent("claude-code:default")}/pin`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    )).status).toBe(200);
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("default")}/read`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
    )).status).toBe(200);
    const changed = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; pinned: boolean; unread: boolean }>;
    };
    expect(changed.sessions.find((row) => row.id === "pi:default"))
      .toMatchObject({ pinned: false, unread: false });
    expect(changed.sessions.find((row) => row.id === "claude-code:default"))
      .toMatchObject({ pinned: true, unread: true });

    const deleted = await fetch(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent("claude-code:default")}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      trash: [{ artifact: "claude-sidecar" }],
    });
    expect((await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string }>;
    }).sessions.map((row) => row.id)).toEqual(["pi:default"]);
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("default")}/transcript`,
    )).status).toBe(200);
  });

  it("round-trips an unsafe Pi resume id without accepting its filename as an alias", async () => {
    const base = await serve();
    const conversationId = "folder/chat?draft=#one and two";
    expect((await postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: conversationId },
    })).status).toBe(200);
    expect((await postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: conversationId },
    })).status).toBe(200);

    const firstHandle = await host!.open("casper", conversationId);
    expect(await host!.open("casper", conversationId)).toBe(firstHandle);
    const sessionFile = firstHandle.sessionFile;
    await host!.close("casper", conversationId);
    const reopened = await host!.open("casper", conversationId);
    expect(reopened).not.toBe(firstHandle);
    expect(reopened.sessionFile).toBe(sessionFile);
    const listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; conversationId: string; messageCount: number }>;
    };
    expect(listing.sessions).toEqual([
      expect.objectContaining({
        id: piId(conversationId),
        conversationId,
        messageCount: 4,
      }),
    ]);

    const transcriptUrl = `${base}/api/ghosts/casper/sessions/`
      + `${encodeURIComponent(piId(conversationId))}/transcript`;
    const transcript = await fetch(transcriptUrl);
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({
      id: piId(conversationId),
      conversationId,
      runtime: "pi",
      total: 4,
    });

    const generatedStem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
    expect(generatedStem).not.toBe(conversationId);
    expect((await postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: generatedStem },
    })).status).toBe(200);
    const afterAlias = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; conversationId: string }>;
    };
    expect(afterAlias.sessions.map((row) => row.conversationId))
      .toEqual(expect.arrayContaining([conversationId, generatedStem]));
    expect(await host!.open("casper", generatedStem)).not.toBe(firstHandle);
    expect((await (await fetch(transcriptUrl)).json() as { total: number }).total).toBe(4);
  });

  it("preserves boundary Unicode ids and rejects overflow without truncation", async () => {
    const base = await serve();
    const asciiBoundary = "a".repeat(200);
    const astralBoundary = `${"b".repeat(199)}\u{1f47b}`;
    for (const conversationId of [asciiBoundary, astralBoundary]) {
      expect((await postTurn(base, {
        ...TURN_BODY,
        options: { sessionId: conversationId },
      })).status).toBe(200);
    }

    const listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; conversationId: string }>;
    };
    expect(listing.sessions.map((row) => row.conversationId)).toEqual(expect.arrayContaining([
      asciiBoundary,
      astralBoundary,
    ]));
    const transcript = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment(astralBoundary)}/transcript`,
    );
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({
      id: piId(astralBoundary),
      conversationId: astralBoundary,
    });
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment(astralBoundary)}/pin`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    )).status).toBe(200);

    const overflow = "c".repeat(201);
    const rejectedPost = await postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: overflow },
    });
    expect(rejectedPost.status).toBe(400);
    expect(JSON.parse(rejectedPost.raw)).toMatchObject({
      error: { code: "invalid_conversation_id" },
    });
    for (const suffix of ["transcript", "pin"]) {
      const response = await fetch(
        `${base}/api/ghosts/casper/sessions/${piSegment(overflow)}/${suffix}`,
        suffix === "pin"
          ? {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pinned: true }),
            }
          : {},
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_conversation_id" } });
    }
  });

  it("rejects lone surrogates before storage and omits malformed stored identities", async () => {
    const base = await serve();
    const sessionDir = ghostPaths(join(temp!.root, "casper")).sessionDir;
    for (const [index, invalid] of ["\ud800", "\udc00"].entries()) {
      const rejected = await postTurn(base, {
        ...TURN_BODY,
        options: { sessionId: invalid },
      });
      expect(rejected.status).toBe(400);
      expect(JSON.parse(rejected.raw)).toMatchObject({
        error: { code: "invalid_conversation_id" },
      });

      const seedId = `unsafe/identity-${index}`;
      expect((await postTurn(base, {
        ...TURN_BODY,
        options: { sessionId: seedId },
      })).status).toBe(200);
      const handle = await host!.open("casper", seedId);
      const sessionFile = handle.sessionFile!;
      await host!.close("casper", seedId);
      const original = readFileSync(sessionFile, "utf8");
      expect(original).toContain(JSON.stringify(seedId));
      writeFileSync(
        sessionFile,
        original.replace(JSON.stringify(seedId), JSON.stringify(invalid)),
        "utf8",
      );
      expect(existsSync(join(sessionDir, sessionFileNameFor(seedId)))).toBe(true);

      await expect(host!.readTranscript("casper", invalid)).rejects.toMatchObject({
        code: "invalid_conversation_id",
        status: 400,
      });
      await expect(host!.renameConversation("casper", invalid, "No alias"))
        .rejects.toMatchObject({ code: "invalid_conversation_id", status: 400 });
    }
    const listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ conversationId: string }>;
    };
    expect(listing.sessions).toEqual([]);
  });

  it("omits transplanted hash metadata and rejects every file-backed alias action", async () => {
    const base = await serve();
    const requested = "unsafe/requested identity";
    const stored = "unsafe/stored identity";
    expect((await postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: requested },
    })).status).toBe(200);
    const handle = await host!.open("casper", requested);
    const requestedPath = handle.sessionFile!;
    await host!.close("casper", requested);
    const original = readFileSync(requestedPath, "utf8");
    expect(original).toContain(JSON.stringify(requested));
    writeFileSync(
      requestedPath,
      original.replace(JSON.stringify(requested), JSON.stringify(stored)),
      "utf8",
    );

    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });
    const actionRequests: Array<() => Promise<Response>> = [
      () => fetch(`${base}/api/ghosts/casper/sessions/${piSegment(requested)}/transcript`),
      () => fetch(`${base}/api/ghosts/casper/sessions/${piSegment(requested)}/title`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Must not relabel" }),
      }),
      () => fetch(`${base}/api/ghosts/casper/sessions/${piSegment(requested)}/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fork", entryId: "not-reached" }),
      }),
      () => fetch(`${base}/api/ghosts/casper/sessions/${piSegment(requested)}`, {
        method: "DELETE",
      }),
    ];
    for (const request of actionRequests) {
      const response = await request();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "session_identity_mismatch" } });
    }
    expect(existsSync(requestedPath)).toBe(true);

    expect((await postTurn(base, {
      ...TURN_BODY,
      options: { sessionId: stored },
    })).status).toBe(200);
    const listing = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; conversationId: string }>;
    };
    expect(listing.sessions).toEqual([
      expect.objectContaining({ id: piId(stored), conversationId: stored }),
    ]);
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment(stored)}/transcript`,
    )).status).toBe(200);
    expect((await fetch(`${base}/api/ghosts/casper/sessions/${piSegment(stored)}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Correct physical identity" }),
    })).status).toBe(200);
  });
});

describe("PUT /api/ghosts/:name/sessions/:id/pin", () => {
  const setPin = (base: string, id: string, body: unknown) => fetch(
    `${base}/api/ghosts/casper/sessions/${piSegment(id)}/pin`,
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
      .toEqual([["pi:conv-2", false], ["pi:conv-1", false]]);

    const pinned = await setPin(base, "conv-1", { pinned: true });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ ok: true, pinned: true });
    expect(existsSync(join(temp!.root, "casper", "sessions", "pins.json"))).toBe(true);
    expect((await listSessions(base)).map((session) => [session.id, session.pinned]))
      .toEqual([["pi:conv-1", true], ["pi:conv-2", false]]);

    // Idempotent both ways.
    expect((await setPin(base, "conv-1", { pinned: true })).status).toBe(200);
    const unpinned = await setPin(base, "conv-1", { pinned: false });
    expect(await unpinned.json()).toEqual({ ok: true, pinned: false });
    expect((await listSessions(base)).map((session) => session.id))
      .toEqual(["pi:conv-2", "pi:conv-1"]);
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
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}/pin`,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("drops the pin when the conversation is deleted", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    expect((await setPin(base, "conv-1", { pinned: true })).status).toBe(200);

    await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}`, {
      method: "DELETE",
    });
    expect(JSON.parse(readFileSync(join(temp!.root, "casper", "sessions", "pins.json"), "utf8")))
      .toEqual({ version: 2, pinned: [] });
  });
});

describe("PUT /api/ghosts/:name/sessions/:id/title", () => {
  const rename = (base: string, id: string, body: unknown) => fetch(
    `${base}/api/ghosts/casper/sessions/${piSegment(id)}/title`,
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
  ).sessions.find((session) => session.id === piId(id))?.title ?? null;

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
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}/title`,
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
    expect(sessions.map((session) => session.id)).toEqual(["pi:conv-1"]);
    expect((await fetch(
      `${base}/api/ghosts/wisp/sessions/${piSegment("conv-1")}/transcript`,
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

    const deleted = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const body = await deleted.json() as {
      ok: boolean;
      trash: Array<{ artifact: string; source: string; trash: string; kind: string }>;
    };
    expect(body).toMatchObject({
      ok: true,
      trash: [{ artifact: "omp-transcript", kind: "fallback" }],
    });
    expect(existsSync(body.trash[0]!.source)).toBe(false);
    expect(existsSync(body.trash[0]!.trash)).toBe(true);
    expect(await (await fetch(`${base}/api/ghosts/casper/sessions`)).json())
      .toEqual({ sessions: [] });
    expect((await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}/transcript`,
    )).status)
      .toBe(404);

    const missing = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}`, {
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
            header: "Paper",
            question: "Which paper stock?",
            options: [
              { label: "Cream", description: "Warm paper stock" },
              { label: "White", description: "Bright paper stock" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Cream stock selected." },
    ]);
    const turn = postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-ask" } });
    const ask = await waitForAsk(base, "conv-ask");

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
    expect(existsSync(join(temp!.root, "casper"))).toBe(true);
    expect(existsSync(join(temp!.root, "wisp"))).toBe(false);

    await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-ask")}/ask`, {
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
    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}/transcript`,
    );
    expect(response.status).toBe(200);
    const transcript = await response.json() as {
      id: string;
      conversationId: string;
      runtime: "pi";
      title: string | null;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(transcript).toMatchObject({
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
    expect(transcript.messages.length).toBeGreaterThanOrEqual(2);
    expect(transcript.messages[0]?.role).toBe("user");
    expect(transcript.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it.each(["rename", "delete"] as const)(
    "finishes an admitted transcript read from the original home before %s and old-name reuse",
    async (move) => {
      const readerEntered = Promise.withResolvers<void>();
      const releaseReader = Promise.withResolvers<void>();
      let resolvedPath = "";
      const base = await serve([{ kind: "text", text: "Original-home answer." }], {
        conversationFileProbe: async (operation, path) => {
          if (operation !== "transcript-read") return;
          resolvedPath = path;
          readerEntered.resolve();
          await releaseReader.promise;
        },
      });
      await postTurn(base, TURN_BODY);
      const originalHome = join(temp!.root, "casper");
      const originalTranscript = join(
        ghostPaths(originalHome).sessionDir,
        sessionFileNameFor("conv-1"),
      );
      const originalInode = statSync(originalHome, { bigint: true }).ino;

      const reading = fetch(
        `${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}/transcript`,
      );
      await readerEntered.promise;
      expect(resolvedPath).toBe(originalTranscript);
      const moving = move === "rename"
        ? fetch(`${base}/api/ghosts/casper/name`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "wisp" }),
          })
        : fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
      await waitForHomeMove();

      releaseReader.resolve();
      const readResponse = await reading;
      expect(readResponse.status).toBe(200);
      const originalResult = await readResponse.json() as {
        messages: Array<{ content: unknown }>;
      };
      expect(JSON.stringify(originalResult.messages)).toContain("Original-home answer.");
      const movedResponse = await moving;
      expect(movedResponse.status).toBe(200);
      const movedBody = await movedResponse.json() as { trash?: string };
      const movedHome = move === "rename" ? join(temp!.root, "wisp") : movedBody.trash!;
      expect(statSync(movedHome, { bigint: true }).ino).toBe(originalInode);
      expect(existsSync(join(
        ghostPaths(movedHome).sessionDir,
        sessionFileNameFor("conv-1"),
      ))).toBe(true);

      const recreated = await fetch(`${base}/api/ghosts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "casper" }),
      });
      expect(recreated.status).toBe(201);
      expect(statSync(originalHome, { bigint: true }).ino).not.toBe(originalInode);
      expect((await fetch(
        `${base}/api/ghosts/casper/sessions/${piSegment("conv-1")}/transcript`,
      )).status).toBe(404);
      if (move === "rename") {
        const renamed = await fetch(
          `${base}/api/ghosts/wisp/sessions/${piSegment("conv-1")}/transcript`,
        );
        expect(renamed.status).toBe(200);
        expect(JSON.stringify(await renamed.json())).toContain("Original-home answer.");
      }
    },
  );

  it("404s an unknown conversation id", async () => {
    const base = await serve();
    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("nope")}/transcript`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("Ghost conversation tree routes", () => {
  it("branches a user message off into a new conversation over HTTP", async () => {
    const base = await serve([{ kind: "text", text: "Branch answer." }]);
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-tree" } });
    await postTurn(base, {
      ...TURN_BODY,
      context: { messages: [{ role: "user", content: "Original follow-up" }] },
      options: { sessionId: "conv-tree" },
    });
    const original = await (await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-tree")}/transcript`,
    )).json() as { messages: Array<{ role: string; entryId: string }> };
    const firstUser = original.messages.find((message) => message.role === "user")!;
    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-tree")}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "fork", entryId: firstUser.entryId }),
      },
    );
    expect(response.status).toBe(200);
    const forked = await response.json() as {
      id: string;
      conversationId: string;
      runtime: "pi";
      sessionId: string;
      title: string | null;
      draft: string;
      transcript: { id: string; messages: unknown[] };
    };
    expect(forked.draft).toBe("Who are you?");
    expect(forked.transcript).toMatchObject({ id: forked.id, messages: [] });
    expect(forked.conversationId).toBe(forked.sessionId);
    expect(forked.sessionId).not.toBe("conv-tree");

    // The source conversation is untouched.
    const source = await (await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-tree")}/transcript`,
    )).json() as { messages: unknown[] };
    expect(source.messages).toEqual(original.messages);

    // And the new conversation is listed and resumable by its own id.
    const listed = await (await fetch(`${base}/api/ghosts/casper/sessions`)).json() as {
      sessions: Array<{ id: string; title: string | null }>;
    };
    expect(listed.sessions.map((row) => row.id)).toContain(forked.id);
    await postTurn(base, {
      ...TURN_BODY,
      context: { messages: [{ role: "user", content: "Alternative question" }] },
      options: { sessionId: forked.sessionId },
    });
    const alternative = await (await fetch(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent(forked.id)}/transcript`,
    )).json() as { messages: unknown[] };
    expect(JSON.stringify(alternative.messages)).toContain("Alternative question");
    expect(JSON.stringify(alternative.messages)).not.toContain("Original follow-up");
  });

  it("rejects an unknown branch action, a non-user entry, and an unknown conversation", async () => {
    const base = await serve([{ kind: "text", text: "Branch answer." }]);
    await postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-tree" } });
    const transcript = await (await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-tree")}/transcript`,
    )).json() as { messages: Array<{ role: string; entryId: string }> };
    const assistant = transcript.messages.find((message) => message.role === "assistant")!;
    const branch = async (body: unknown, sessionId = "conv-tree") => fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment(sessionId)}/branch`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );

    const navigate = await branch({ action: "navigate", entryId: assistant.entryId });
    expect(navigate.status).toBe(400);
    expect(await navigate.json()).toMatchObject({ error: { code: "invalid_request" } });

    const nonUser = await branch({ action: "fork", entryId: assistant.entryId });
    expect(nonUser.status).toBe(400);
    expect(await nonUser.json()).toMatchObject({ error: { code: "invalid_branch" } });

    const unknown = await branch({ action: "fork", entryId: assistant.entryId }, "nope");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("streams a historical Ask re-answer and its resumed model continuation", async () => {
    const base = await serve([
      {
        kind: "tool",
        name: "ask",
        args: {
          questions: [{
            header: "Paper",
            question: "Which paper stock?",
            options: [
              { label: "Cream", description: "Warm paper stock" },
              { label: "White", description: "Bright paper stock" },
            ],
            multiSelect: false,
          }],
        },
      },
      { kind: "text", text: "Stock selected." },
    ]);
    const initial = postTurn(base, { ...TURN_BODY, options: { sessionId: "conv-reanswer" } });
    const firstAsk = await waitForAsk(base, "conv-reanswer");
    await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-reanswer")}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: firstAsk.id,
        kind: "submit",
        results: [{ id: "question-1", selectedOptions: ["Cream"] }],
      }),
    });
    await initial;
    const transcript = await (await fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-reanswer")}/transcript`,
    )).json() as { messages: Array<{ content: unknown }> };
    const askCall = transcript.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => (part as { name?: unknown }).name === "ask") as {
        ghostAsk?: { resultEntryId?: string };
      };

    const reanswerResponse = fetch(
      `${base}/api/ghosts/casper/sessions/${piSegment("conv-reanswer")}/reanswer`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ entryId: askCall.ghostAsk?.resultEntryId }),
      },
    ).then(async (response) => ({ response, raw: await response.text() }));
    const revised = await waitForAsk(base, "conv-reanswer");
    await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-reanswer")}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        askId: revised.id,
        kind: "submit",
        results: [{ id: "question-1", selectedOptions: ["White"] }],
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

  it("refuses to guess a runtime for an unqualified session action id", async () => {
    const base = await serve();
    await postTurn(base, TURN_BODY);
    const response = await fetch(`${base}/api/ghosts/casper/sessions/conv-1/transcript`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_conversation_id" },
    });
  });

  it("decodes valid ghost names and conversation ids", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts/casp%65r/sessions`)).status).toBe(200);

    await postTurn(base, TURN_BODY);
    const transcript = await fetch(
      `${base}/api/ghosts/casp%65r/sessions/${piSegment("conv-1")}/transcript`,
    );
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({
      id: "pi:conv-1",
      conversationId: "conv-1",
      runtime: "pi",
    });
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

describe("background job routes", () => {
  it("lists an unopened conversation's jobs as empty and 404s an unknown cancel", async () => {
    const base = await serve();
    const listed = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-jobs")}/jobs`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ jobs: [] });

    const cancelled = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-jobs")}/jobs/job-1/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(404);
    expect(await cancelled.json()).toMatchObject({ error: { code: "not_found" } });

    const wrongMethod = await fetch(`${base}/api/ghosts/casper/sessions/${piSegment("conv-jobs")}/jobs`, { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
  });
});
