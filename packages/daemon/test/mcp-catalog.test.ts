import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/ghosts.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function setup(): { catalog: McpCatalog; home: string } {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  const home = seedGhost(temp.root, { name: "casper" });
  return { catalog: new McpCatalog({ registry: temp.registry }), home };
}

function writeJson(home: string, relativePath: string, value: unknown): void {
  const path = join(home, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readServers(home: string, relativePath = ".omp/mcp.json"): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(home, relativePath), "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  return parsed.mcpServers ?? {};
}

describe("McpCatalog project-only discovery", () => {
  it("uses canonical precedence, keeps legacy-only rows, and never scans ambient files", async () => {
    const { catalog, home } = setup();
    writeJson(home, ".omp/mcp.json", {
      mcpServers: {
        shared: { type: "http", url: "https://canonical.example/mcp" },
        disabled: { type: "stdio", command: "disabled-server", enabled: false },
      },
    });
    writeJson(home, ".omp/.mcp.json", {
      mcpServers: {
        shared: { type: "http", url: "https://legacy.example/mcp" },
        disabled: { type: "stdio", command: "must-not-reappear" },
        legacy: { type: "stdio", command: "legacy-server" },
      },
    });
    for (const relativePath of [".pi/mcp.json", ".claude/mcp.json", ".codex/mcp.json"]) {
      writeJson(home, relativePath, {
        mcpServers: { ambient: { type: "stdio", command: "ambient-server" } },
      });
    }

    const snapshot = await catalog.list("casper");

    expect(snapshot.servers.map((server) => server.name)).toEqual(["disabled", "legacy", "shared"]);
    expect(snapshot.servers.find((server) => server.name === "shared")).toMatchObject({
      source: "canonical",
      path: ".omp/mcp.json",
      config: { type: "http", url: "https://canonical.example/mcp" },
    });
    expect(snapshot.servers.find((server) => server.name === "disabled")).toMatchObject({
      enabled: false,
      source: "canonical",
      config: { command: "disabled-server" },
    });
    expect(snapshot.servers.some((server) => server.name === "ambient")).toBe(false);
  });

  it("redacts header, environment, argument, OAuth, auth, userinfo, and query values", async () => {
    const { catalog, home } = setup();
    writeJson(home, ".omp/mcp.json", {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://owner:url-password@example.com/mcp?api_key=url-secret&region=eu",
          headers: { Authorization: "Bearer header-secret", "X-Api-Key": "header-key-secret" },
          headerPolicy: "origin-locked",
          auth: { type: "oauth", credentialId: "credential-secret", clientSecret: "auth-secret" },
          oauth: { clientId: "public-client", clientSecret: "oauth-secret" },
        },
        local: {
          type: "stdio",
          command: "mcp-server",
          args: ["--token", "argument-secret"],
          env: { API_TOKEN: "environment-secret", SAFE_SETTING: "also-not-returned" },
          envPolicy: "literal",
          cwd: "packages/local-server",
        },
      },
    });

    const snapshot = await catalog.list("casper");
    const serialized = JSON.stringify(snapshot);

    for (const secret of [
      "url-password",
      "url-secret",
      "header-secret",
      "header-key-secret",
      "credential-secret",
      "auth-secret",
      "public-client",
      "oauth-secret",
      "argument-secret",
      "environment-secret",
      "also-not-returned",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(snapshot.servers.find((server) => server.name === "remote")?.config).toEqual({
      type: "http",
      url: "https://example.com/mcp?api_key=%5Bconfigured%5D&region=%5Bconfigured%5D",
      headerPolicy: "origin-locked",
      headers: { keys: ["Authorization", "X-Api-Key"], configured: true },
      auth: { type: "oauth", configured: true },
      oauth: {
        configured: true,
        clientIdConfigured: true,
        clientSecretConfigured: true,
      },
    });
    expect(snapshot.servers.find((server) => server.name === "local")?.config).toEqual({
      type: "stdio",
      command: "mcp-server",
      cwd: "packages/local-server",
      envPolicy: "literal",
      argumentCount: 2,
      environment: { keys: ["API_TOKEN", "SAFE_SETTING"], configured: true },
    });
  });

  it("reports malformed files and rows without hiding valid siblings", async () => {
    const { catalog, home } = setup();
    writeJson(home, ".omp/mcp.json", {
      mcpServers: {
        good: { type: "stdio", command: "good-server" },
        broken: { type: "stdio" },
        "bad/name": { type: "stdio", command: "bad-name" },
      },
    });
    const legacyPath = join(home, ".omp", ".mcp.json");
    writeFileSync(legacyPath, "{ definitely not json", "utf8");

    const snapshot = await catalog.list("casper");

    expect(snapshot.servers.map((server) => server.name)).toEqual(["good"]);
    expect(snapshot.skipped.map((entry) => entry.path)).toEqual([
      ".omp/.mcp.json",
      ".omp/mcp.json#mcpServers.bad/name",
      ".omp/mcp.json#mcpServers.broken",
    ]);
    expect(snapshot.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("lets a malformed canonical row shadow a valid legacy row of the same name", async () => {
    const { catalog, home } = setup();
    writeJson(home, ".omp/mcp.json", { mcpServers: { shared: { type: "http" } } });
    writeJson(home, ".omp/.mcp.json", {
      mcpServers: { shared: { type: "http", url: "https://legacy.example/mcp" } },
    });

    const snapshot = await catalog.list("casper");

    expect(snapshot.servers).toEqual([]);
    expect(snapshot.skipped).toHaveLength(1);
    expect(snapshot.skipped[0]?.path).toBe(".omp/mcp.json#mcpServers.shared");
  });
});

describe("McpCatalog mutations", () => {
  it("adds to canonical, updates the owning legacy file, toggles, and removes", async () => {
    const { catalog, home } = setup();
    writeJson(home, ".omp/.mcp.json", {
      mcpServers: { legacy: { type: "stdio", command: "before" } },
    });

    await catalog.add("casper", "smithery:cloudflare.api-v1", {
      type: "http",
      url: "https://example.com/mcp",
    });
    await catalog.update("casper", "legacy", { type: "stdio", command: "after" });
    await catalog.setEnabled("casper", "legacy", false);

    expect(readServers(home)).toHaveProperty("smithery:cloudflare.api-v1");
    expect(readServers(home, ".omp/.mcp.json")).toEqual({
      legacy: { type: "stdio", command: "after", enabled: false },
    });

    const afterRemove = await catalog.remove("casper", "smithery:cloudflare.api-v1");
    expect(afterRemove.servers.map((server) => server.name)).toEqual(["legacy"]);
    expect(readServers(home)).not.toHaveProperty("smithery:cloudflare.api-v1");
  });

  it("uses structured errors for invalid names/configs, duplicates, and unknown servers", async () => {
    const { catalog } = setup();

    await expect(catalog.add("casper", "bad/name", { type: "stdio", command: "x" }))
      .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    await expect(catalog.add("casper", "missing-command", { type: "stdio" }))
      .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    await catalog.add("casper", "known", { type: "stdio", command: "one" });
    await expect(catalog.add("casper", "known", { type: "stdio", command: "two" }))
      .rejects.toMatchObject({ code: "mcp_server_exists", status: 409 });
    await expect(catalog.update("casper", "missing", { type: "stdio", command: "x" }))
      .rejects.toMatchObject({ code: "mcp_server_not_found", status: 404 });
    await expect(catalog.remove("casper", "missing"))
      .rejects.toMatchObject({ code: "mcp_server_not_found", status: 404 });
    await expect(catalog.setEnabled("casper", "known", "yes" as unknown as boolean))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(GhostError).toBeDefined();
  });

  it("serializes concurrent canonical writes without losing siblings", async () => {
    const { catalog, home } = setup();

    await Promise.all([
      catalog.add("casper", "alpha", { type: "stdio", command: "alpha-server" }),
      catalog.add("casper", "bravo", { type: "stdio", command: "bravo-server" }),
      catalog.add("casper", "charlie", { type: "http", url: "https://charlie.example/mcp" }),
    ]);

    expect(Object.keys(readServers(home)).sort()).toEqual(["alpha", "bravo", "charlie"]);

    const sameName = await Promise.allSettled([
      catalog.add("casper", "delta", { type: "stdio", command: "first" }),
      catalog.add("casper", "delta", { type: "stdio", command: "second" }),
    ]);
    expect(sameName.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sameName.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(Object.keys(readServers(home)).sort()).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("tests one server without opening a session or exposing transport errors", async () => {
    const { catalog, home } = setup();
    const serverPath = join(home, "probe-mcp.mjs");
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
    serverInfo: { name: "probe", version: "1.0.0" }
  });
  else if (request.method === "tools/list") send(request.id, { tools: [{
    name: "ping", description: "Probe tool", inputSchema: { type: "object", properties: {} }
  }] });
  else send(request.id, {});
});
`,
      "utf8",
    );
    await catalog.add("casper", "probe", {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
    });

    await expect(catalog.test("casper", "probe")).resolves.toEqual({
      name: "probe",
      ok: true,
      status: "connected",
      toolCount: 1,
      message: "Connection succeeded.",
    });
  });
});
