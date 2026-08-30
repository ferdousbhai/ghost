import {
  linkSync,
  readFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  addMCPServer,
  expandEnvVars,
  readMCPConfigFile,
  removeMCPServer,
  updateMCPServer,
  writeMCPConfigFile,
  type MCPServerConfig,
} from "../src/mcp-config.js";
import { GhostMcpManager, McpToolCallError, type McpToolDefinition } from "../src/mcp-manager.js";
import { createMCPToolName, mintMcpToolNames } from "../src/mcp-tool-names.js";
import { MAX_PRIVATE_FILE_BYTES } from "../src/private-file.js";
import { tempDir, useCleanups } from "./helpers/fixtures.js";

const cleanups = useCleanups();

interface FixtureServer {
  server: McpServer;
  calls: unknown[];
  transport(): Promise<InMemoryTransport>;
}

/** An in-process MCP server with one `echo` tool that can be told to fail. */
async function fixtureServer(fail?: "throw" | "isError"): Promise<FixtureServer> {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  const calls: unknown[] = [];
  server.registerTool(
    "echo",
    { description: "Echo the input", inputSchema: { text: z.string() } },
    async ({ text }) => {
      calls.push({ text });
      if (fail === "throw") throw new Error("MCP_REMOTE_THROWN_SENTINEL");
      if (fail === "isError") {
        return {
          isError: true,
          content: [
            { type: "text", text: "MCP_REMOTE_TEXT_SENTINEL" },
            { type: "resource", resource: { uri: "secret://MCP_REMOTE_URI_SENTINEL", text: "MCP_REMOTE_RESOURCE_SENTINEL" } },
          ],
          _meta: { secret: "MCP_REMOTE_META_SENTINEL" },
        };
      }
      return { content: [{ type: "text", text: `echo: ${text}` }], _meta: { retained: "meta" } };
    },
  );
  cleanups.push(() => server.close());
  return {
    server,
    calls,
    async transport() {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      return clientSide;
    },
  };
}

/** A manager whose transports are the in-process fixtures, connected by name. */
async function connectedManager(fixtures: Record<string, FixtureServer>) {
  const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const manager = new GhostMcpManager({
    cwd: "/tmp",
    logger: { warn: (message, context) => logs.push({ message, ...(context ? { context } : {}) }) },
    transportFactory: async (name) => {
      const fixture = fixtures[name];
      if (!fixture) throw new Error(`no fixture for ${name}`);
      return fixture.transport();
    },
  });
  cleanups.push(() => manager.disconnectAll());
  const configs = Object.fromEntries(
    Object.keys(fixtures).map((name) => [name, { type: "http", url: `http://${name}.invalid/mcp` } as MCPServerConfig]),
  );
  const result = await manager.connectServers(configs);
  return { manager, logs, result };
}

const call = (tool: McpToolDefinition, params: Record<string, unknown>) =>
  tool.execute("call", params, undefined, undefined, {} as never);

describe("MCP tool names", () => {
  it("mints lowercase, server-prefixed, bounded names", () => {
    expect(createMCPToolName("GitHub", "github_list_issues")).toBe("mcp__github_list_issues");
    expect(createMCPToolName("my-server", "Do.Thing")).toBe("mcp__my_server_do_thing");
    const long = createMCPToolName("a".repeat(40), "b".repeat(40));
    expect(long).toHaveLength(64);
    expect(long).toBe(createMCPToolName("a".repeat(40), "b".repeat(40)));
    expect(createMCPToolName("---", "***")).toBe("mcp__server_tool");
  });

  it("keeps the first tool of a colliding pair", () => {
    const minted = mintMcpToolNames("srv", [{ name: "Do.Thing" }, { name: "do-thing" }, { name: "other" }]);
    expect(minted.named.map((entry) => entry.name)).toEqual(["mcp__srv_do_thing", "mcp__srv_other"]);
    expect(minted.collisions).toEqual(["do-thing"]);
  });
});

describe("GhostMcpManager", () => {
  it("connects and lists tools as pi definitions", async () => {
    const fixture = await fixtureServer();
    const { manager, logs, result } = await connectedManager({ fixture });
    expect(result.connectedServers).toEqual(["fixture"]);
    expect(result.errors.size).toBe(0);
    expect(manager.getConnectionStatus("fixture")).toBe("connected");
    expect(manager.getAllServerNames()).toEqual(["fixture"]);
    expect(manager.getServerConfig("fixture")).toMatchObject({ type: "http" });
    expect(logs).toEqual([]);

    const [tool] = manager.getTools();
    expect(tool).toMatchObject({ name: "mcp__fixture_echo", mcpServerName: "fixture", description: "Echo the input" });
    expect(tool!.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
  });

  it("calls a tool and keeps its content and metadata", async () => {
    const fixture = await fixtureServer();
    const { manager } = await connectedManager({ fixture });
    const reply = await call(manager.getTools()[0]!, { text: "hi" });
    expect(reply.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(reply.details).toEqual({
      serverName: "fixture",
      mcpToolName: "echo",
      rawContent: [{ type: "text", text: "echo: hi" }],
      mcpMeta: { retained: "meta" },
    });
    expect(fixture.calls).toEqual([{ text: "hi" }]);
  });

  it("throws a stable code for remote errors and thrown failures, with no server text", async () => {
    const remote = await fixtureServer("isError");
    const thrown = await fixtureServer("throw");
    const { manager } = await connectedManager({ remote, thrown });
    expect(manager.getTools()).toHaveLength(2);
    for (const tool of manager.getTools()) {
      const failure = await call(tool, { text: "x" }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(McpToolCallError);
      expect((failure as Error).message).toBe("mcp_tool_call_failed");
    }
  });

  it("reports a failed connection with a stable code and no detail", async () => {
    const logs: Array<Record<string, unknown> | undefined> = [];
    const manager = new GhostMcpManager({ cwd: "/tmp", logger: { warn: (_message, context) => logs.push(context) } });
    cleanups.push(() => manager.disconnectAll());
    const result = await manager.connectServers({
      missing: { type: "http", url: "http://127.0.0.1:1/mcp", timeout: 500 },
      withAuth: { type: "http", url: "http://127.0.0.1:1/mcp", auth: { type: "apikey", credentialId: "SECRET_ID" } },
    });
    expect(result.connectedServers).toEqual([]);
    expect([...result.errors.entries()].sort()).toEqual([
      ["missing", "mcp_connection_failed"],
      ["withAuth", "mcp_connection_failed"],
    ]);
    expect(manager.getConnectionStatus("missing")).toBe("disconnected");
    expect(logs.map((log) => log?.server).sort()).toEqual(["missing", "withAuth"]);
    expect(logs.every((log) => log?.code === "mcp_connection_failed" && Object.keys(log).length === 2)).toBe(true);
  });

  it("re-lists tools when a server announces a change and survives reconnects", async () => {
    const fixture = await fixtureServer();
    const { manager } = await connectedManager({ fixture });
    const changes: string[][] = [];
    manager.setOnToolsChanged((tools) => {
      changes.push(tools.map((tool) => tool.name).sort());
    });

    fixture.server.registerTool("second", { description: "Second tool" }, async () => ({ content: [] }));
    await vi.waitFor(() => expect(changes.at(-1)).toEqual(["mcp__fixture_echo", "mcp__fixture_second"]));

    expect(await manager.reconnectServer("fixture")).toBe(true);
    expect(manager.getTools().map((tool) => tool.name).sort()).toEqual(["mcp__fixture_echo", "mcp__fixture_second"]);
    expect(await manager.reconnectServer("unknown")).toBe(false);

    const stale = manager.getTools()[0]!;
    await manager.disconnectAll();
    expect(manager.getConnectionStatus("fixture")).toBe("disconnected");
    expect(manager.getTools()).toEqual([]);
    await expect(call(stale, { text: "late" })).rejects.toBeInstanceOf(McpToolCallError);
  });
});

describe("mcp.json writer", () => {
  it("adds, updates, and removes servers atomically and prototype-safely", async () => {
    const dir = tempDir("ghost-mcp-config-");
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "mcp.json");

    await addMCPServer(path, "one", { type: "stdio", command: "one" });
    await expect(addMCPServer(path, "one", { type: "stdio", command: "again" })).rejects.toThrow(/already exists/);
    await expect(addMCPServer(path, "bad/name", { type: "stdio", command: "x" })).rejects.toThrow(/Server name/);
    await expect(addMCPServer(path, "nourl", { type: "http" } as MCPServerConfig)).rejects.toThrow(/Invalid server config/);
    await updateMCPServer(path, "one", { type: "stdio", command: "one", enabled: false });
    expect((await readMCPConfigFile(path)).mcpServers).toEqual({ one: { type: "stdio", command: "one", enabled: false } });

    await expect(removeMCPServer(path, "toString")).rejects.toThrow(/not found/);
    await removeMCPServer(path, "one");
    expect((await readMCPConfigFile(path)).mcpServers).toEqual({});

    writeFileSync(path, "{ not json");
    await expect(readMCPConfigFile(path)).rejects.toThrow();
  });

  it("bounds the complete pretty-printed mcp.json before publication", async () => {
    const dir = tempDir("ghost-mcp-config-bounds-");
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "mcp.json");
    const empty = { mcpServers: {}, padding: "" };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(empty, null, 2)}\n`);
    const exact = {
      mcpServers: {},
      padding: "x".repeat(MAX_PRIVATE_FILE_BYTES - baseBytes),
    };

    await writeMCPConfigFile(path, exact);
    expect(readFileSync(path)).toHaveLength(MAX_PRIVATE_FILE_BYTES);
    const before = readFileSync(path);

    const prettyExpansion = { mcpServers: {}, future: Array(150_000).fill(0) };
    expect(Buffer.byteLength(JSON.stringify(prettyExpansion))).toBeLessThan(MAX_PRIVATE_FILE_BYTES);
    expect(Buffer.byteLength(`${JSON.stringify(prettyExpansion, null, 2)}\n`))
      .toBeGreaterThan(MAX_PRIVATE_FILE_BYTES);
    await expect(writeMCPConfigFile(path, prettyExpansion)).rejects.toThrow(/1 MiB/);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(["symlink", "hardlink"] as const)(
    "refuses a %s during the locked mutation reread",
    async (kind) => {
      const dir = tempDir("ghost-mcp-config-unsafe-");
      cleanups.push(dir.cleanup);
      const target = join(dir.path, "target.json");
      const path = join(dir.path, "mcp.json");
      writeFileSync(target, '{"mcpServers":{"kept":{"command":"kept"}}}\n');
      if (kind === "symlink") symlinkSync(target, path);
      else linkSync(target, path);

      await expect(addMCPServer(path, "added", { type: "stdio", command: "added" }))
        .rejects.toThrow();
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
        mcpServers: { kept: { command: "kept" } },
      });
    },
  );

  it("refuses pathname replacement during the locked mutation reread", async () => {
    const dir = tempDir("ghost-mcp-config-replaced-");
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "mcp.json");
    const displaced = join(dir.path, "mcp-original.json");
    writeFileSync(path, '{"mcpServers":{"original":{"command":"original"}}}\n');

    await expect(addMCPServer(
      path,
      "added",
      { type: "stdio", command: "added" },
      {
        readProbe: (stage) => {
          if (stage !== "opened") return;
          renameSync(path, displaced);
          writeFileSync(path, '{"mcpServers":{"replacement":{"command":"replacement"}}}\n');
        },
      },
    )).rejects.toThrow(/changed/);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcpServers: { replacement: { command: "replacement" } },
    });
    expect(JSON.parse(readFileSync(displaced, "utf8"))).toEqual({
      mcpServers: { original: { command: "original" } },
    });
  });

  it("refuses truncation during the locked mutation reread", async () => {
    const dir = tempDir("ghost-mcp-config-truncated-");
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "mcp.json");
    writeFileSync(path, '{"mcpServers":{"original":{"command":"original"}}}\n');

    await expect(updateMCPServer(
      path,
      "original",
      { type: "stdio", command: "updated" },
      { readProbe: (stage) => stage === "opened" && truncateSync(path, 0) },
    )).rejects.toThrow(/changed/);
    expect(readFileSync(path)).toHaveLength(0);
  });

  it("expands environment references with optional defaults", () => {
    const ref = (name: string): string => "$" + `{${name}}`;
    expect(expandEnvVars(`x-${ref("GHOST_TEST_MISSING:-fallback")}-${ref("GHOST_TEST_MISSING")}`, {})).toBe("x-fallback-");
    expect(expandEnvVars(`${ref("A")}/${ref("B")}`, { A: "1", B: "2" })).toBe("1/2");
  });
});
