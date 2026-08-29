import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MachineDocuments } from "@ghost/extensions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghostCli } from "../src/cli/main.js";
import { DocumentsService } from "../src/documents.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse } from "./helpers/http-fetch.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";

class Sink {
  value = "";
  isTTY = false;
  write(chunk: string): void {
    this.value += chunk;
  }
}

const API_TOKEN = "a".repeat(64);
let temp: TempGhosts;
let provider: MockProvider;
let host: SessionHost;
let listening: ListeningServer | null;
let tokenFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  provider = await startMockProvider({ script: [{ kind: "text", text: "hello" }] });
  seedGhost(temp.root, {
    name: "casper",
    provider: { baseUrl: provider.url, modelId: provider.modelId },
  });
  const memoryDir = join(temp.root, "casper", "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "favorite-tea.md"), "The owner likes oolong tea.\n", { mode: 0o600 });
  const documents = new DocumentsService(new MachineDocuments(temp.documentsDir));
  const homeOperations = new HomeOperationCoordinator(temp.registry);
  host = new SessionHost({
    registry: temp.registry,
    homeOperations,
    ownerHome: temp.ownerHome,
    offline: true,
    extensionOptions: { documents: new MachineDocuments(temp.documentsDir) },
  });
  const mcp = new McpCatalog({ registry: temp.registry });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    documents,
    homeOperations,
    mcp,
    apiToken: API_TOKEN,
    relay: null,
    port: 0,
  });
  tokenFile = join(temp.root, ".state", "api-token");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
  env = {
    GHOSTD_PORT: String(listening.port),
    GHOSTD_API_TOKEN_FILE: tokenFile,
    XDG_CONFIG_HOME: join(temp.root, ".config"),
  };
  await host.open("casper", "conv-1");
});

afterEach(async () => {
  await listening?.close();
  await host.disposeAll();
  await provider.close();
  temp.cleanup();
});

async function cli(argv: string[], overrides: { env?: NodeJS.ProcessEnv } = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await ghostCli(argv, {
    env: overrides.env ?? env,
    home: temp.ownerHome,
    stdout,
    stderr,
    fetch: fetchNoReuse,
    stdin: { isTTY: true },
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}

describe("ghost CLI against a real daemon server", () => {
  it("lists, creates, and persists a validated default mode 0600", async () => {
    const listed = await cli(["list"]);
    expect(listed).toMatchObject({ code: 0 });
    expect(listed.stdout).toContain("casper");

    expect(await cli(["new", "probe", "--json"])).toMatchObject({ code: 0 });
    const used = await cli(["use", "casper"]);
    expect(used).toMatchObject({ code: 0, stdout: "casper\n" });
    const path = join(env.XDG_CONFIG_HOME!, "ghost", "cli.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ghost: "casper" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await cli(["use"])).toMatchObject({ code: 0, stdout: "casper\n" });

    const defaultSessions = await cli(["sessions"]);
    expect(defaultSessions).toMatchObject({ code: 0 });
    expect(defaultSessions.stdout).toContain("conv-1");
  });

  it("lists sessions and reports status", async () => {
    const sessions = await cli(["sessions", "-g", "casper"]);
    expect(sessions.code).toBe(0);
    expect(sessions.stdout).toContain("conv-1");

    const status = await cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`http://127.0.0.1:${listening!.port}`);
    expect(status.stdout).toContain("authenticated  yes");
  });

  it("reports no ask and empty plan, todo, and jobs", async () => {
    expect(await cli(["ask", "-g", "casper", "-s", "conv"])).toMatchObject({
      code: 0,
      stdout: "No pending question.\n",
    });
    expect((await cli(["plan", "-g", "casper", "-s", "conv"])).stdout).toContain("planning off");
    expect(await cli(["todo", "-g", "casper", "-s", "conv", "--json"])).toMatchObject({
      code: 0,
      stdout: "{\"todo\":[]}\n",
    });
    expect(await cli(["jobs", "-g", "casper", "-s", "conv", "--json"])).toMatchObject({
      code: 0,
      stdout: "{\"jobs\":[]}\n",
    });
  });

  it("lists and reads memory through the current memory API", async () => {
    const listed = await cli(["memory", "-g", "casper", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      memory: [{
        path: "memory/favorite-tea.md",
        slug: "favorite-tea",
        content: "The owner likes oolong tea.",
      }],
      skipped: [],
    });
    expect(await cli(["memory", "show", "favorite-tea", "-g", "casper"])).toMatchObject({
      code: 0,
      stdout: "The owner likes oolong tea.\n",
    });
  });

  it("keeps destructive removal behind --yes", async () => {
    const result = await cli(["rm", "casper"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires --yes");
    expect(temp.registry.get("casper").name).toBe("casper");
  });

  it("maps a wrong token to exit 4 with the owner hint", async () => {
    writeFileSync(tokenFile, `${"b".repeat(64)}\n`, { mode: 0o600 });
    const result = await cli(["status"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("ghostd api-token");
    expect(result.stderr).toContain(tokenFile);
  });

  it("re-reads a rotated token once after a 401", async () => {
    writeFileSync(tokenFile, `${"b".repeat(64)}\n`, { mode: 0o600 });
    let calls = 0;
    const retryingFetch: typeof fetchNoReuse = async (input, init) => {
      calls += 1;
      const response = await fetchNoReuse(input, init);
      if (response.status === 401) writeFileSync(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
      return response;
    };
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await ghostCli(["list", "--json"], {
      env,
      home: temp.ownerHome,
      stdout,
      stderr,
      fetch: retryingFetch,
      stdin: { isTTY: true },
    });
    expect(code, stderr.value).toBe(0);
    expect(calls).toBe(2);
    expect(JSON.parse(stdout.value)).toEqual([expect.objectContaining({ name: "casper" })]);
  });

  it("maps a closed daemon to exit 3", async () => {
    const port = listening!.port;
    await listening!.close();
    listening = null;
    const result = await cli(["status"], { env: { ...env, GHOSTD_PORT: String(port) } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("cannot reach ghostd");
  });

  it("returns empty work projections for a valid unknown public conversation id", async () => {
    const headers = { authorization: `Bearer ${API_TOKEN}` };
    const base = `http://127.0.0.1:${listening!.port}/api/ghosts/casper/sessions/${encodeURIComponent("pi:unknown")}`;
    const [plan, jobs] = await Promise.all([
      fetchNoReuse(`${base}/plan`, { headers }),
      fetchNoReuse(`${base}/jobs`, { headers }),
    ]);
    expect(await plan.json()).toEqual({ planning: false, plan: null, todo: [] });
    expect(await jobs.json()).toEqual({ jobs: [] });
  });
});
