import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostError } from "../src/ghosts.js";
import {
  expandMcpServerConfig,
  McpCatalog,
  normalizeMcpStdioCwd,
} from "../src/mcp-catalog.js";
import { homeOperationsFor } from "../src/home-operations.js";
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

    const snapshot = await catalog.listLeased("casper");

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

  it("redacts header, environment, argument, userinfo, and query values", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://owner:url-password@example.com/mcp?api_key=url-secret&region=eu#url-fragment-secret",
          headers: { Authorization: "Bearer header-secret", "X-Api-Key": "header-key-secret" },
          headerPolicy: "origin-locked",
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

    const snapshot = await catalog.listLeased("casper");
    const serialized = JSON.stringify(snapshot);

    for (const secret of [
      "url-password",
      "url-secret",
      "url-fragment-secret",
      "header-secret",
      "header-key-secret",
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

    const snapshot = await catalog.listLeased("casper");
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

    const snapshot = await catalog.listLeased("casper");
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
    const snapshot = await catalog.listLeased("casper");

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

    const snapshot = await catalog.listLeased("casper");

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
      former_auth: { type: "stdio", command: "never", auth: { type: "oauth", clientSecret: bad } },
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

    const snapshot = await catalog.listLeased("casper");
    expect(snapshot.servers.map((server) => server.name)).toEqual(["valid"]);
    expect(snapshot.skipped).toHaveLength(Object.keys(malformed).length);
    expect(JSON.stringify(snapshot)).not.toContain(sentinel);
    for (const [index, config] of Object.values(malformed).entries()) {
      await expect(catalog.addLeased("casper", `mutation-${index}`, config))
        .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    }
    expect(readFileSync(join(home, "mcp.json"), "utf8")).toContain(sentinel);
  });

  it("caps MCP reads even when the file is larger than its stat-time allowance", async () => {
    const { catalog, home } = setup();
    const path = join(home, "mcp.json");
    writeFileSync(path, `{"mcpServers":{},"padding":"${"x".repeat(1_048_576)}"}`, "utf8");

    const snapshot = await catalog.listLeased("casper");
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.skipped).toEqual([
      { path: "mcp.json", reason: "MCP config exceeds the 1 MiB limit" },
    ]);
  });

  it.each(["symlink", "hardlink"] as const)(
    "refuses a %s MCP catalog source",
    async (kind) => {
      const { catalog, home } = setup();
      const target = join(home, "outside-mcp.json");
      const path = join(home, "mcp.json");
      writeFileSync(target, '{"mcpServers":{"outside":{"command":"never"}}}\n');
      if (kind === "symlink") symlinkSync(target, path);
      else linkSync(target, path);

      await expect(catalog.listLeased("casper")).resolves.toEqual({
        servers: [],
        skipped: [{ path: "mcp.json", reason: "MCP config could not be read or parsed." }],
      });
    },
  );

  it.each(["replacement", "truncation"] as const)(
    "rejects pathname %s during pinned MCP catalog discovery",
    async (race) => {
      const { home } = setup();
      const path = join(home, "mcp.json");
      const displaced = join(home, "mcp-original.json");
      writeJson(home, "mcp.json", {
        mcpServers: { original: { type: "stdio", command: "original" } },
      });
      const catalog = new McpCatalog({
        registry: temp!.registry,
        privateReadProbe: (stage) => {
          if (stage !== "opened") return;
          if (race === "truncation") {
            truncateSync(path, 0);
            return;
          }
          renameSync(path, displaced);
          writeJson(home, "mcp.json", {
            mcpServers: { replacement: { type: "stdio", command: "replacement" } },
          });
        },
      });

      await expect(catalog.listLeased("casper")).resolves.toEqual({
        servers: [],
        skipped: [{ path: "mcp.json", reason: "MCP config could not be read or parsed." }],
      });
    },
  );

  it("does not fall back to a former hidden row", async () => {
    const { catalog, home } = setup();
    writeJson(home, "mcp.json", { mcpServers: { shared: { type: "http" } } });
    writeJson(home, ".omp/.mcp.json", {
      mcpServers: { shared: { type: "http", url: "https://legacy.example/mcp" } },
    });

    const snapshot = await catalog.listLeased("casper");

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

    await catalog.addLeased("casper", "smithery:cloudflare.api-v1", {
      type: "http",
      url: "https://example.com/mcp",
      enabled: true,
    });
    await catalog.updateLeased("casper", "legacy", { type: "stdio", command: "after" });
    await catalog.setEnabledLeased("casper", "legacy", false);

    expect(readServers(home)).toHaveProperty("smithery:cloudflare.api-v1");
    expect(readServers(home)).toMatchObject({
      legacy: { type: "stdio", command: "after", enabled: false },
    });

    const afterRemove = await catalog.removeLeased("casper", "smithery:cloudflare.api-v1");
    expect(afterRemove.servers.map((server) => server.name)).toEqual(["legacy"]);
    expect(readServers(home)).not.toHaveProperty("smithery:cloudflare.api-v1");
  });

  it("round-trips inherited-object server names through every catalog mutation", async () => {
    const { catalog, home } = setup();
    const names = ["__proto__", "constructor", "toString"];
    for (const name of names) {
      await catalog.addLeased("casper", name, {
        type: "stdio",
        command: `${name}-before`,
        enabled: true,
      });
    }

    const listedByName = new Map((await catalog.listLeased("casper")).servers.map((server) => [
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

    await catalog.updateLeased("casper", "__proto__", {
      type: "stdio",
      command: "proto-after",
    });
    await catalog.setEnabledLeased("casper", "constructor", false);
    const afterRemove = await catalog.removeLeased("casper", "toString");

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

    await expect(catalog.addLeased("casper", "bad/name", { type: "stdio", command: "x" }))
      .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    await expect(catalog.addLeased("casper", "missing-command", { type: "stdio" }))
      .rejects.toMatchObject({ code: "invalid_mcp_server", status: 400 });
    await catalog.addLeased("casper", "known", { type: "stdio", command: "one" });
    await expect(catalog.addLeased("casper", "known", { type: "stdio", command: "two" }))
      .rejects.toMatchObject({ code: "mcp_server_exists", status: 409 });
    await expect(catalog.updateLeased("casper", "missing", { type: "stdio", command: "x" }))
      .rejects.toMatchObject({ code: "mcp_server_not_found", status: 404 });
    await expect(catalog.removeLeased("casper", "missing"))
      .rejects.toMatchObject({ code: "mcp_server_not_found", status: 404 });
    await expect(catalog.setEnabledLeased("casper", "known", "yes" as unknown as boolean))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(GhostError).toBeDefined();
  });

  it("serializes concurrent canonical writes under the home lease without losing siblings", async () => {
    const { catalog: unleased, home } = setup();
    const lease = homeOperationsFor(temp!.registry);
    const catalog = {
      addLeased: (ghost: string, name: string, config: unknown) =>
        lease.withLease(ghost, () => unleased.addLeased(ghost, name, config)),
    };

    await Promise.all([
      catalog.addLeased("casper", "alpha", { type: "stdio", command: "alpha-server" }),
      catalog.addLeased("casper", "bravo", { type: "stdio", command: "bravo-server" }),
      catalog.addLeased("casper", "charlie", { type: "http", url: "https://charlie.example/mcp" }),
    ]);

    expect(Object.keys(readServers(home)).sort()).toEqual(["alpha", "bravo", "charlie"]);

    const sameName = await Promise.allSettled([
      catalog.addLeased("casper", "delta", { type: "stdio", command: "first" }),
      catalog.addLeased("casper", "delta", { type: "stdio", command: "second" }),
    ]);
    expect(sameName.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sameName.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(Object.keys(readServers(home)).sort()).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("anchors absent and relative stdio cwd to the config source root, leaving remote rows alone", () => {
    const root = "/home/owner/ghosts/casper";
    expect(normalizeMcpStdioCwd({ type: "stdio", command: "probe" }, root))
      .toEqual({ type: "stdio", command: "probe", cwd: root });
    expect(normalizeMcpStdioCwd({ command: "probe", cwd: "child" }, root))
      .toMatchObject({ cwd: join(root, "child") });
    expect(normalizeMcpStdioCwd({ command: "probe", cwd: "/srv/../opt/x" }, root))
      .toMatchObject({ cwd: "/opt/x" });
    const remote = { type: "http" as const, url: "https://example.invalid/mcp" };
    expect(normalizeMcpStdioCwd(remote, root)).toBe(remote);
  });
});
