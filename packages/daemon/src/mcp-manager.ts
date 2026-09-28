/** Local MCP host adapter: owns stdio, HTTP/SSE, cwd and process environment. */
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  GhostMcpManagerCore,
  type McpManagerLogger,
} from "@ghost/runtime/mcp-manager";
import type { MCPServerConfig } from "@ghost/runtime/mcp-config-policy";


export interface McpManagerOptions {
  cwd: string;
  logger?: McpManagerLogger;
  /** Test seam: build the transport for one server. */
  transportFactory?: (name: string, config: MCPServerConfig) => Transport | Promise<Transport>;
}

export class GhostMcpManager extends GhostMcpManagerCore {
  constructor(options: McpManagerOptions) {
    super({
      logger: options.logger,
      transportFactory: options.transportFactory ?? ((_name, config) => createTransport(config, options.cwd)),
    });
  }
}

function createTransport(config: MCPServerConfig, cwd: string): Transport {
  if (!("url" in config)) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
      cwd: config.cwd ?? cwd,
      stderr: "ignore",
    });
  }
  const url = new URL(config.url);
  const requestInit: RequestInit = { headers: config.headers ?? {} };
  // The SDK does not copy requestInit.redirect into notification-stream GETs.
  // Inject at the fetch seam so the same header policy covers every HTTP leg.
  const fetchWithPolicy: FetchLike | undefined = config.headerPolicy === "origin-locked"
    ? (input, init) => fetch(input, { ...init, redirect: "manual" })
    : undefined;
  return config.type === "http"
    ? new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchWithPolicy })
    : new SSEClientTransport(url, { requestInit, fetch: fetchWithPolicy });
}
