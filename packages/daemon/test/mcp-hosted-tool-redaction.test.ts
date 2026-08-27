import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import {
  DeferredMCPTool,
  MCPTool,
} from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type {
  MCPServerConfig,
  MCPServerConnection,
  MCPToolCallResult,
  MCPToolDefinition,
  MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { describe, expect, it, vi } from "vitest";

type TransportKind = "stdio" | "http" | "sse";
type RequestHandler = (
  method: string,
  params?: Record<string, unknown>,
) => unknown | Promise<unknown>;

const tool: MCPToolDefinition = {
  name: "fixture_tool",
  description: "Fixture MCP tool",
  inputSchema: { type: "object", properties: {} },
};

const context = {} as CustomToolContext;

function configFor(kind: TransportKind): MCPServerConfig {
  if (kind === "stdio") return { type: "stdio", command: process.execPath };
  return { type: kind, url: `https://${kind}.fixture.invalid/mcp` };
}

function connection(
  kind: TransportKind,
  request: RequestHandler,
  redactErrors = true,
): MCPServerConnection {
  const transport: MCPTransport = {
    connected: true,
    async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      return await request(method, params) as T;
    },
    notify: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return {
    name: `${kind}-fixture`,
    config: configFor(kind),
    transport,
    serverInfo: { name: "fixture", version: "1" },
    capabilities: { tools: {} },
    ...(redactErrors ? { _redactErrors: true } : {}),
  };
}

function remoteError(...sentinels: string[]): MCPToolCallResult {
  return {
    isError: true,
    content: [
      { type: "text", text: sentinels[0] ?? "MCP_REMOTE_TEXT_SENTINEL" },
      {
        type: "resource",
        resource: {
          uri: `secret://${sentinels[1] ?? "MCP_REMOTE_URI_SENTINEL"}`,
          text: sentinels[2] ?? "MCP_REMOTE_RESOURCE_SENTINEL",
        },
      },
    ],
    _meta: { secret: sentinels[3] ?? "MCP_REMOTE_META_SENTINEL" },
  };
}

async function executeActive(
  activeConnection: MCPServerConnection,
  reconnect?: () => Promise<MCPServerConnection | null>,
) {
  const activeTool = MCPTool.fromTools(activeConnection, [tool], reconnect)[0];
  if (!activeTool) throw new Error("MCP fixture tool was not created");
  return activeTool.execute("fixture-call", {}, undefined, context);
}

async function executeDeferred(
  getConnection: () => Promise<MCPServerConnection>,
  reconnect?: () => Promise<MCPServerConnection | null>,
  redactErrors = true,
) {
  const deferredTool = DeferredMCPTool.fromTools(
    "deferred-fixture",
    [tool],
    getConnection,
    undefined,
    reconnect,
    redactErrors,
  )[0];
  if (!deferredTool) throw new Error("Deferred MCP fixture tool was not created");
  return deferredTool.execute("fixture-call", {}, undefined, context);
}

function expectHostedFailure(result: Awaited<ReturnType<typeof executeActive>>, sentinels: string[]): void {
  expect(result.content).toEqual([{ type: "text", text: "mcp_tool_call_failed" }]);
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({
    mcpToolName: tool.name,
    isError: true,
  });
  expect(result.details).not.toHaveProperty("rawContent");
  expect(result.details).not.toHaveProperty("mcpMeta");
  const serialized = JSON.stringify(result);
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
}

describe("hosted MCP tool-call redaction", () => {
  it.each<TransportKind>(["stdio", "http", "sse"])(
    "redacts remote isError content and metadata for %s",
    async (kind) => {
      const sentinels = [
        `MCP_${kind}_TEXT_SENTINEL`,
        `MCP_${kind}_URI_SENTINEL`,
        `MCP_${kind}_RESOURCE_SENTINEL`,
        `MCP_${kind}_META_SENTINEL`,
      ];
      const result = await executeActive(connection(kind, () => remoteError(...sentinels)));

      expectHostedFailure(result, sentinels);
    },
  );

  it("redacts thrown transport exceptions", async () => {
    const sentinel = "MCP_THROWN_EXCEPTION_SENTINEL";
    const result = await executeActive(connection("http", () => {
      throw new Error(sentinel);
    }));

    expectHostedFailure(result, [sentinel]);
  });

  it("redacts failures while translating local tool arguments", async () => {
    const sentinel = "mcp_argument_secret_sentinel";
    const artifactsDir = mkdtempSync(join(tmpdir(), "ghost-mcp-tool-redaction-"));
    const activeConnection = connection("stdio", () => {
      throw new Error("transport must not receive unresolved local arguments");
    });
    const activeTool = MCPTool.fromTools(activeConnection, [tool])[0];
    if (!activeTool) throw new Error("MCP fixture tool was not created");

    try {
      const result = await activeTool.execute(
        "fixture-call",
        { path: `local:///${sentinel}` },
        undefined,
        {
          localProtocolOptions: { getArtifactsDir: () => artifactsDir },
        } as CustomToolContext,
      );

      expectHostedFailure(result, [sentinel]);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("redacts an authentication retry response and preserves hosted policy across reconnect", async () => {
    const challenge = "MCP_AUTH_CHALLENGE_SENTINEL";
    const initialBody = "MCP_AUTH_INITIAL_BODY_SENTINEL";
    const retrySentinels = [
      "MCP_AUTH_RETRY_TEXT_SENTINEL",
      "MCP_AUTH_RETRY_URI_SENTINEL",
      "MCP_AUTH_RETRY_RESOURCE_SENTINEL",
      "MCP_AUTH_RETRY_META_SENTINEL",
    ];
    const initial = connection("http", () => ({
      isError: true,
      content: [{ type: "text", text: initialBody }],
      _meta: { "mcp/www_authenticate": [challenge] },
    }));
    const retried = connection("http", () => remoteError(...retrySentinels), false);
    const reconnect = vi.fn(async (options?: { authChallenge?: { wwwAuthenticate: readonly string[] } }) => {
      expect(options?.authChallenge?.wwwAuthenticate).toEqual([challenge]);
      return retried;
    });

    const result = await executeActive(initial, reconnect);

    expect(reconnect).toHaveBeenCalledOnce();
    expectHostedFailure(result, [challenge, initialBody, ...retrySentinels]);
  });

  it("redacts a retried network failure and preserves hosted policy across reconnect", async () => {
    const thrown = "MCP_RETRY_THROWN_SENTINEL";
    const retrySentinels = [
      "MCP_RETRY_TEXT_SENTINEL",
      "MCP_RETRY_URI_SENTINEL",
      "MCP_RETRY_RESOURCE_SENTINEL",
      "MCP_RETRY_META_SENTINEL",
    ];
    const initial = connection("sse", () => {
      throw new Error(`ECONNRESET ${thrown}`);
    });
    const retried = connection("sse", () => remoteError(...retrySentinels), false);
    const reconnect = vi.fn(async () => retried);

    const result = await executeActive(initial, reconnect);

    expect(reconnect).toHaveBeenCalledOnce();
    expectHostedFailure(result, [thrown, ...retrySentinels]);
  });

  it("redacts deferred/background connection and reconnect failures", async () => {
    const connectionFailure = "MCP_DEFERRED_CONNECTION_SENTINEL";
    const retrySentinels = [
      "MCP_DEFERRED_RETRY_TEXT_SENTINEL",
      "MCP_DEFERRED_RETRY_URI_SENTINEL",
      "MCP_DEFERRED_RETRY_RESOURCE_SENTINEL",
      "MCP_DEFERRED_RETRY_META_SENTINEL",
    ];
    const retried = connection("http", () => remoteError(...retrySentinels), false);
    const reconnect = vi.fn(async () => retried);
    const result = await executeDeferred(
      async () => {
        throw new Error(connectionFailure);
      },
      reconnect,
    );

    expect(reconnect).toHaveBeenCalledOnce();
    expectHostedFailure(result, [connectionFailure, ...retrySentinels]);
  });

  it("preserves successful hosted output and metadata", async () => {
    const text = "MCP_SUCCESS_TEXT_SENTINEL";
    const meta = "MCP_SUCCESS_META_SENTINEL";
    const success: MCPToolCallResult = {
      content: [{ type: "text", text }],
      _meta: { retained: meta },
    };

    const result = await executeActive(connection("http", () => success));

    expect(result.content).toEqual([{ type: "text", text }]);
    expect(result.isError).toBeUndefined();
    expect(result.details?.rawContent).toEqual(success.content);
    expect(result.details?.mcpMeta).toEqual(success._meta);
  });

  it("preserves ordinary non-hosted error diagnostics", async () => {
    const remoteSentinels = [
      "MCP_NONHOSTED_TEXT_SENTINEL",
      "MCP_NONHOSTED_URI_SENTINEL",
      "MCP_NONHOSTED_RESOURCE_SENTINEL",
      "MCP_NONHOSTED_META_SENTINEL",
    ];
    const thrownSentinel = "MCP_NONHOSTED_EXCEPTION_SENTINEL";

    const remoteResult = await executeActive(
      connection("stdio", () => remoteError(...remoteSentinels), false),
    );
    const thrownResult = await executeActive(connection("http", () => {
      throw new Error(thrownSentinel);
    }, false));

    expect(JSON.stringify(remoteResult)).toContain(remoteSentinels[0]);
    expect(remoteResult.details?.rawContent).toBeDefined();
    expect(remoteResult.details?.mcpMeta).toBeDefined();
    expect(JSON.stringify(thrownResult)).toContain(thrownSentinel);
  });
});
