import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GhostMcpManager } from "../src/mcp-manager.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostError } from "../src/ghosts.js";
import { homeOperationsFor } from "../src/home-operations.js";
import {
  expandMcpServerConfig,
  McpCatalog,
} from "../src/mcp-catalog.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

interface McpUrlSanitizerVector {
  name: string;
  input: string;
  expected: string;
  sentinels: string[];
}

const mcpUrlSanitizerVectors = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../shell/test/fixtures/mcp-url-sanitizer-vectors.json",
  import.meta.url,
)), "utf8")) as McpUrlSanitizerVector[];

let temp: TempGhosts | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function readServers(home: string, relativePath = "mcp.json"): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(home, relativePath), "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  return parsed.mcpServers ?? {};
}

describe("McpCatalog ghost-only discovery", () => {
  it("expands ordinary MCP fields without expanding policy-protected maps", () => {
    vi.stubEnv("GHOST_MCP_ORDINARY", "ordinary-expanded");
    vi.stubEnv("GHOST_MCP_PROTECTED", "ambient-secret-must-not-enter-map");
    const ordinary = "$" + "{GHOST_MCP_ORDINARY}";
    const protectedValue = "$" + "{GHOST_MCP_PROTECTED}";

    expect(expandMcpServerConfig({
      type: "stdio",
      command: ordinary,
      args: [ordinary],
      env: { TOKEN: protectedValue },
      envPolicy: "literal",
      cwd: ordinary,
    })).toEqual({
      type: "stdio",
      command: "ordinary-expanded",
      args: ["ordinary-expanded"],
      env: { TOKEN: protectedValue },
      envPolicy: "literal",
      cwd: "ordinary-expanded",
    });
    for (const type of ["http", "sse"] as const) {
      expect(expandMcpServerConfig({
        type,
        url: `https://example.invalid/${ordinary}`,
        headers: { Authorization: protectedValue },
        headerPolicy: "origin-locked",
      })).toEqual({
        type,
        url: "https://example.invalid/ordinary-expanded",
        headers: { Authorization: protectedValue },
        headerPolicy: "origin-locked",
      });
    }

    expect(expandMcpServerConfig({
      type: "stdio",
      command: ordinary,
      env: { TOKEN: protectedValue },
    })).toMatchObject({
      command: "ordinary-expanded",
      env: { TOKEN: "ambient-secret-must-not-enter-map" },
    });
    expect(expandMcpServerConfig({
      type: "http",
      url: `https://example.invalid/${ordinary}`,
      headers: { Authorization: protectedValue },
    })).toMatchObject({
      url: "https://example.invalid/ordinary-expanded",
      headers: { Authorization: "ambient-secret-must-not-enter-map" },
    });
  });

  it("uses visible ghost config and never scans ambient or former hidden files", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", {
      mcpServers: {
        shared: { type: "http", url: "https://canonical.example/mcp" },
        disabled: { type: "stdio", command: "disabled-server", enabled: false },
      },
    });
    for (const relativePath of [
      ".omp/mcp.json",
      ".omp/.mcp.json",
      ".pi/mcp.json",
      ".claude/mcp.json",
      ".codex/mcp.json",
    ]) {
      writeJson(home, relativePath, {
        mcpServers: { ambient: { type: "stdio", command: "ambient-server" } },
      });
    }

    const snapshot = await catalog.list("casper");

    expect(snapshot.servers.map((server) => server.name)).toEqual(["disabled", "shared"]);
    expect(snapshot.servers.find((server) => server.name === "shared")).toMatchObject({
      source: "canonical",
      path: "mcp.json",
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
    writeJson(home, "mcp.json", {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://owner:url-password@example.com/mcp?api_key=url-secret&region=eu#url-fragment-secret",
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
      "url-fragment-secret",
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

  it("fails closed for malformed templated URLs with credential-bearing components", async () => {
    const { catalog, home } = setup();
    const hostTemplate = "$" + "{MCP_HOST_TEMPLATE}";
    writeJson(home, "mcp.json", {
      mcpServers: {
        templated: {
          type: "sse",
          url: `https://MCP_URL_USERNAME_SENTINEL:MCP_URL_PASSWORD_SENTINEL@${hostTemplate}/mcp?token=MCP_URL_QUERY_SENTINEL#MCP_URL_FRAGMENT_SENTINEL`,
        },
      },
    });

    const snapshot = await catalog.list("casper");
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.servers[0]?.config).toEqual({
      type: "sse",
      url: "[configured]",
    });
    for (const sentinel of [
      "MCP_URL_USERNAME_SENTINEL",
      "MCP_URL_PASSWORD_SENTINEL",
      "MCP_URL_QUERY_SENTINEL",
      "MCP_URL_FRAGMENT_SENTINEL",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("matches the shared safe-display URL vectors", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", {
      mcpServers: Object.fromEntries(mcpUrlSanitizerVectors.map((vector, index) => [
        `url-vector-${index}`,
        { type: "http", url: vector.input },
      ])),
    });

    const snapshot = await catalog.list("casper");
    const serialized = JSON.stringify(snapshot);
    for (const [index, vector] of mcpUrlSanitizerVectors.entries()) {
      expect(
        snapshot.servers.find((server) => server.name === `url-vector-${index}`)?.config,
        vector.name,
      ).toMatchObject({ type: "http", url: vector.expected });
      for (const sentinel of vector.sentinels) {
        expect(serialized, `${vector.name}: ${sentinel}`).not.toContain(sentinel);
      }
    }
  });

  it("reports malformed files and rows without hiding valid siblings", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", {
      mcpServers: {
        good: { type: "stdio", command: "good-server" },
        broken: { type: "stdio" },
        "bad/name": { type: "stdio", command: "bad-name" },
      },
    });
    const snapshot = await catalog.list("casper");

    expect(snapshot.servers.map((server) => server.name)).toEqual(["good"]);
    expect(snapshot.skipped.map((entry) => entry.path)).toEqual([
      "mcp.json#mcpServers.bad/name",
      "mcp.json#mcpServers.broken",
    ]);
    expect(snapshot.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("rejects invalid UTF-8 inside an otherwise valid MCP JSON string", async () => {
    const { catalog, home } = setup();
    writeFileSync(
      join(home, "mcp.json"),
      Buffer.concat([
        Buffer.from('{"mcpServers":{"bad":{"type":"stdio","command":"INVALID-'),
        Buffer.from([0x80]),
        Buffer.from('"}}}'),
      ]),
    );

    const snapshot = await catalog.list("casper");

    expect(snapshot.servers).toEqual([]);
    expect(snapshot.skipped).toEqual([
      { path: "mcp.json", reason: "MCP config is not valid UTF-8" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("\uFFFD");
  });

  it("rejects malformed field types without reflecting values or hiding valid siblings", async () => {
    const { catalog, home } = setup();
    const sentinel = "MCP_MALFORMED_SECRET_SENTINEL";
    const bad = { secret: sentinel };
    const malformed: Record<string, unknown> = {
      bad_type: { type: bad, command: "never" },
      bad_command: { type: "stdio", command: bad },
      bad_args: { type: "stdio", command: "never", args: [bad] },
      bad_env: { type: "stdio", command: "never", env: { TOKEN: bad } },
      bad_env_policy: { type: "stdio", command: "never", envPolicy: sentinel },
      bad_cwd: { type: "stdio", command: "never", cwd: bad },
      bad_enabled: { type: "stdio", command: "never", enabled: bad },
      bad_timeout: { type: "stdio", command: "never", timeout: bad },
      bad_request_id: { type: "stdio", command: "never", requestIdFormat: sentinel },
      bad_auth: { type: "stdio", command: "never", auth: { type: "oauth", clientSecret: bad } },
      bad_oauth: { type: "stdio", command: "never", oauth: { callbackPort: bad } },
      bad_url: { type: "http", url: bad },
      bad_headers: { type: "http", url: "https://valid.example", headers: { token: bad } },
      bad_header_policy: {
        type: "http",
        url: "https://valid.example",
        headerPolicy: sentinel,
      },
      bad_extra: { type: "stdio", command: "never", extra: bad },
    };
    writeJson(home, "mcp.json", {
      mcpServers: {
        valid: { type: "stdio", command: process.execPath, args: ["--version"] },
        ...malformed,
      },
    });

    const snapshot = await catalog.list("casper");
    expect(snapshot.servers.map((server) => server.name)).toEqual(["valid"]);
    expect(snapshot.skipped).toHaveLength(Object.keys(malformed).length);
    expect(JSON.stringify(snapshot)).not.toContain(sentinel);
    await expect(catalog.test("casper", "bad_command"))
      .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    for (const [index, config] of Object.values(malformed).entries()) {
      await expect(catalog.add("casper", `mutation-${index}`, config))
        .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    }
    expect(readFileSync(join(home, "mcp.json"), "utf8")).toContain(sentinel);
  });

  it("caps MCP reads even when the file is larger than its stat-time allowance", async () => {
    const { catalog, home } = setup();
    const path = join(home, "mcp.json");
    writeFileSync(path, `{"mcpServers":{},"padding":"${"x".repeat(1_048_576)}"}`, "utf8");

    const snapshot = await catalog.list("casper");
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.skipped).toEqual([
      { path: "mcp.json", reason: "MCP config exceeds the 1 MiB limit" },
    ]);
  });

  it("does not fall back to a former hidden row", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", { mcpServers: { shared: { type: "http" } } });
    writeJson(home, ".omp/.mcp.json", {
      mcpServers: { shared: { type: "http", url: "https://legacy.example/mcp" } },
    });

    const snapshot = await catalog.list("casper");

    expect(snapshot.servers).toEqual([]);
    expect(snapshot.skipped).toHaveLength(1);
    expect(snapshot.skipped[0]?.path).toBe("mcp.json#mcpServers.shared");
  });
});

describe("McpCatalog mutations", () => {
  it("adds, updates, toggles, and removes in visible ghost config", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", {
      mcpServers: { legacy: { type: "stdio", command: "before" } },
    });

    await catalog.add("casper", "smithery:cloudflare.api-v1", {
      type: "http",
      url: "https://example.com/mcp",
    });
    await catalog.update("casper", "legacy", { type: "stdio", command: "after" });
    await catalog.setEnabled("casper", "legacy", false);

    expect(readServers(home)).toHaveProperty("smithery:cloudflare.api-v1");
    expect(readServers(home)).toMatchObject({
      legacy: { type: "stdio", command: "after", enabled: false },
    });

    const afterRemove = await catalog.remove("casper", "smithery:cloudflare.api-v1");
    expect(afterRemove.servers.map((server) => server.name)).toEqual(["legacy"]);
    expect(readServers(home)).not.toHaveProperty("smithery:cloudflare.api-v1");
  });

  it("round-trips inherited-object server names through every catalog mutation", async () => {
    const { catalog, home } = setup();
    const names = ["__proto__", "constructor", "toString"];
    for (const name of names) {
      await catalog.add("casper", name, {
        type: "stdio",
        command: `${name}-before`,
      });
    }

    const listedByName = new Map((await catalog.list("casper")).servers.map((server) => [
      server.name,
      server,
    ]));
    for (const name of names) {
      expect(listedByName.get(name)).toMatchObject({
        name,
        enabled: true,
        source: "canonical",
        path: "mcp.json",
        config: { type: "stdio", command: `${name}-before` },
      });
    }
    const storedBefore = readServers(home);
    for (const name of names) expect(Object.hasOwn(storedBefore, name)).toBe(true);

    await catalog.update("casper", "__proto__", {
      type: "stdio",
      command: "proto-after",
    });
    await catalog.setEnabled("casper", "constructor", false);
    const afterRemove = await catalog.remove("casper", "toString");

    const remainingByName = new Map(afterRemove.servers.map((server) => [server.name, server]));
    expect(remainingByName.get("__proto__")).toMatchObject({
      enabled: true,
      config: { command: "proto-after" },
    });
    expect(remainingByName.get("constructor")).toMatchObject({
      enabled: false,
      config: { command: "constructor-before" },
    });
    expect(remainingByName.has("toString")).toBe(false);

    const storedAfter = readServers(home);
    expect(Object.hasOwn(storedAfter, "__proto__")).toBe(true);
    expect(Object.hasOwn(storedAfter, "constructor")).toBe(true);
    expect(Object.hasOwn(storedAfter, "toString")).toBe(false);
    const rawByName = new Map(Object.entries(storedAfter));
    expect(rawByName.get("__proto__")).toMatchObject({ command: "proto-after" });
    expect(rawByName.get("constructor")).toMatchObject({ enabled: false });
    expect(({} as Record<string, unknown>).command).toBeUndefined();
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

  for (const scenario of [
    { label: "successful cleanup", connectFails: false, disconnectFails: false, ok: true },
    { label: "failed connect and cleanup", connectFails: true, disconnectFails: true, ok: false },
  ] as const) {
    it(`holds the home lease through isolated probe ${scenario.label}`, async () => {
      const { home } = setup();
      const coordinator = homeOperationsFor(temp!.registry);
      const catalog = new McpCatalog({ registry: temp!.registry, homeOperations: coordinator });
      writeJson(home, "mcp.json", {
        mcpServers: { probe: { type: "stdio", command: "/bin/true" } },
      });
      const connectGate = Promise.withResolvers<void>();
      const connectEntered = Promise.withResolvers<void>();
      const disconnectGate = Promise.withResolvers<void>();
      const disconnectEntered = Promise.withResolvers<void>();
      const order: string[] = [];
      let connectManager: GhostMcpManager | undefined;
      let disconnectManager: GhostMcpManager | undefined;
      let observedConfigs: unknown;
      vi.spyOn(GhostMcpManager.prototype, "connectServers").mockImplementation(async function (
        this: GhostMcpManager,
        configs,
      ) {
        connectManager = this;
        observedConfigs = configs;
        order.push("connect-entered");
        connectEntered.resolve();
        await connectGate.promise;
        if (scenario.connectFails) {
          order.push("connect-failed");
          throw new Error("injected probe failure");
        }
        order.push("connect-completed");
        return {
          connectedServers: ["probe"],
          errors: new Map(),
          tools: [],
          exaApiKeys: [],
        };
      });
      vi.spyOn(GhostMcpManager.prototype, "disconnectAll").mockImplementation(async function (
        this: GhostMcpManager,
      ) {
        disconnectManager = this;
        order.push("disconnect-entered");
        disconnectEntered.resolve();
        await disconnectGate.promise;
        if (scenario.disconnectFails) {
          order.push("disconnect-failed");
          throw new Error("injected disconnect failure");
        }
        order.push("disconnect-completed");
      });

      let probeSettled = false;
      const probe = catalog.test("casper", "probe").then((result) => {
        probeSettled = true;
        order.push("probe-settled");
        return result;
      });
      await connectEntered.promise;
      let moveReady = false;
      const move = coordinator.reserveMove("casper").then((release) => {
        moveReady = true;
        order.push("move-ready");
        return release;
      });

      try {
        await vi.waitFor(() => expect(coordinator.moveReservationCount).toBe(1));
        expect(moveReady).toBe(false);
        expect(probeSettled).toBe(false);
        expect(temp!.registry.get("casper").dir).toBe(home);

        connectGate.resolve();
        await disconnectEntered.promise;
        expect(moveReady).toBe(false);
        expect(probeSettled).toBe(false);
        expect(temp!.registry.get("casper").dir).toBe(home);
      } finally {
        connectGate.resolve();
        disconnectGate.resolve();
      }

      const result = await probe;
      const releaseMove = await move;
      expect(result).toMatchObject({ name: "probe", ok: scenario.ok });
      expect(connectManager).toBeDefined();
      expect(disconnectManager).toBe(connectManager);
      expect(observedConfigs).toEqual({
        probe: { type: "stdio", command: "/bin/true", cwd: home },
      });
      const disconnectFinished = scenario.disconnectFails
        ? order.indexOf("disconnect-failed")
        : order.indexOf("disconnect-completed");
      expect(disconnectFinished).toBeGreaterThan(order.indexOf("disconnect-entered"));
      expect(disconnectFinished).toBeLessThan(order.indexOf("move-ready"));

      try {
        const moved = temp!.registry.rename("casper", `probe-${scenario.ok ? "success" : "failure"}`);
        expect(existsSync(home)).toBe(false);
        expect(readFileSync(join(moved.dir, "mcp.json"), "utf8")).toContain('"probe"');
      } finally {
        releaseMove();
      }
    });
  }

  it("uses the same policy-aware expansion for isolated connection probes", async () => {
    const { catalog, home } = setup();
    vi.stubEnv("GHOST_MCP_PROBE_ORDINARY", "probe-expanded");
    vi.stubEnv("GHOST_MCP_PROBE_PROTECTED", "probe-ambient-secret");
    const ordinary = "$" + "{GHOST_MCP_PROBE_ORDINARY}";
    const protectedValue = "$" + "{GHOST_MCP_PROBE_PROTECTED}";
    writeJson(home, "mcp.json", {
      mcpServers: {
        literal_stdio: {
          type: "stdio",
          command: ordinary,
          args: [ordinary],
          env: { TOKEN: protectedValue },
          envPolicy: "literal",
        },
        literal_http: {
          type: "http",
          url: `https://example.invalid/${ordinary}`,
          headers: { Authorization: protectedValue },
          headerPolicy: "origin-locked",
        },
        literal_sse: {
          type: "sse",
          url: `https://example.invalid/${ordinary}`,
          headers: { Authorization: protectedValue },
          headerPolicy: "origin-locked",
        },
        inherited_stdio: {
          type: "stdio",
          command: ordinary,
          env: { TOKEN: protectedValue },
        },
        inherited_http: {
          type: "http",
          url: `https://example.invalid/${ordinary}`,
          headers: { Authorization: protectedValue },
        },
      },
    });
    const observed = new Map<string, unknown>();
    vi.spyOn(GhostMcpManager.prototype, "connectServers").mockImplementation(async (configs) => {
      for (const [name, config] of Object.entries(configs)) observed.set(name, config);
      return {
        connectedServers: Object.keys(configs),
        errors: new Map(),
        tools: [],
      };
    });

    for (const name of [
      "literal_stdio",
      "literal_http",
      "literal_sse",
      "inherited_stdio",
      "inherited_http",
    ]) {
      await expect(catalog.test("casper", name)).resolves.toMatchObject({ ok: true });
    }
    expect(observed.get("literal_stdio")).toMatchObject({
      command: "probe-expanded",
      args: ["probe-expanded"],
      env: { TOKEN: protectedValue },
    });
    for (const name of ["literal_http", "literal_sse"]) {
      expect(observed.get(name)).toMatchObject({
        url: "https://example.invalid/probe-expanded",
        headers: { Authorization: protectedValue },
      });
    }
    expect(observed.get("inherited_stdio")).toMatchObject({
      command: "probe-expanded",
      env: { TOKEN: "probe-ambient-secret" },
    });
    expect(observed.get("inherited_http")).toMatchObject({
      url: "https://example.invalid/probe-expanded",
      headers: { Authorization: "probe-ambient-secret" },
    });
  });

  it("anchors absent and relative stdio cwd to the immutable config source root", async () => {
    const { catalog, home } = setup();
    const child = join(home, "child");
    mkdirSync(child);
    const serverPath = join(home, "cwd-probe.mjs");
    const absentResult = join(home, "absent-cwd.txt");
    const relativeResult = join(home, "relative-cwd.txt");
    writeFileSync(
      serverPath,
      `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.cwd());
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send(request.id, {
    protocolVersion: "2025-11-25", capabilities: { tools: {} },
    serverInfo: { name: "cwd-probe", version: "1.0.0" }
  });
  else if (request.method === "tools/list") send(request.id, { tools: [] });
  else send(request.id, {});
});
`,
      "utf8",
    );
    await catalog.add("casper", "absent-cwd", {
      type: "stdio",
      command: process.execPath,
      args: [serverPath, absentResult],
    });
    await catalog.add("casper", "relative-cwd", {
      type: "stdio",
      command: process.execPath,
      args: [serverPath, relativeResult],
      cwd: "child",
    });

    await expect(catalog.test("casper", "absent-cwd")).resolves.toMatchObject({ ok: true });
    await expect(catalog.test("casper", "relative-cwd")).resolves.toMatchObject({ ok: true });
    expect(readFileSync(absentResult, "utf8")).toBe(home);
    expect(readFileSync(relativeResult, "utf8")).toBe(child);
  });
});
