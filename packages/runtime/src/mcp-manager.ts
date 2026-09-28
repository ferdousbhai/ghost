/**
 * Ghost's MCP client manager.
 *
 * One manager per hosted session connects the servers a ghost (and its bound
 * project) configured, exposes their tools as pi `ToolDefinition`s, and
 * re-lists tools when a server announces a change. Nothing here is a process
 * singleton: two ghosts in one daemon never share a connection.
 *
 * Errors are redacted: a third-party server's error text, resource URIs, and
 * metadata never reach the model or an HTTP response — only the stable codes
 * `mcp_connection_failed`, `mcp_tool_load_failed`, and `mcp_tool_call_failed`.
 * A failed tool call throws, as every Ghost tool does.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { MCPServerConfig } from "./mcp-config-policy.js";
import { mintMcpToolNames } from "./mcp-tool-names.js";
import { formatMcpContent, mcpConnectionErrorCode, mcpToolCallErrorCode, type McpErrorCode } from "./mcp-tool-policy.js";

export type { McpErrorCode } from "./mcp-tool-policy.js";
export type McpConnectionStatus = "connected" | "connecting" | "disconnected";

export interface McpToolDetails {
  serverName: string;
  mcpToolName: string;
  rawContent: CallToolResult["content"];
  mcpMeta?: Record<string, unknown>;
}

/** A pi tool definition that remembers which server it stands for. */
export type McpToolDefinition = ToolDefinition<TSchema, McpToolDetails> & {
  readonly mcpServerName: string;
};

export interface McpConnectResult {
  connectedServers: string[];
  errors: Map<string, McpErrorCode>;
  tools: McpToolDefinition[];
}

export interface McpManagerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface McpManagerOptions {
  logger?: McpManagerLogger;
  /** Host adapter: build a transport for one validated server row. */
  transportFactory: (name: string, config: MCPServerConfig) => Transport | Promise<Transport>;
  /** Optional SDK client factory; hosted Workers inject the CF schema validator. */
  clientFactory?: () => Client;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class McpToolCallError extends Error {
  readonly code = mcpToolCallErrorCode();
  readonly outcome: "server_error" | "uncertain";
  constructor(cause?: unknown, outcome: "server_error" | "uncertain" = "uncertain") {
    super(mcpToolCallErrorCode(), cause === undefined ? undefined : { cause });
    this.name = "McpToolCallError";
    this.outcome = outcome;
  }
}

class McpToolLoadError extends Error {
  constructor(cause: unknown) {
    super("MCP tool list could not be loaded", { cause });
    this.name = "McpToolLoadError";
  }
}

interface ServerState {
  config: MCPServerConfig;
  /** Set while connecting; the client is closable before the handshake ends. */
  pending?: { client: Client; done: Promise<void> };
  /** Serial tool-list notifications already received from this connection. */
  toolRefresh?: Promise<void>;
  client?: Client;
  tools: McpToolDefinition[];
}

export class GhostMcpManagerCore {
  private readonly logger: McpManagerLogger | undefined;
  private readonly transportFactory: McpManagerOptions["transportFactory"];
  private readonly clientFactory: () => Client;
  private readonly servers = new Map<string, ServerState>();
  private readonly invokers = new WeakMap<McpToolDefinition, (params: Record<string, unknown>, signal?: AbortSignal) => Promise<Awaited<ReturnType<McpToolDefinition["execute"]>>>>();
  private onToolsChanged: ((tools: McpToolDefinition[]) => void | Promise<void>) | undefined;
  private connectedRefresh?: Promise<void>;
  private closed = false;

  constructor(options: McpManagerOptions) {
    this.logger = options.logger;
    this.transportFactory = options.transportFactory;
    this.clientFactory = options.clientFactory ?? (() => new Client({ name: "ghost", version: "0.1.0" }, { capabilities: {} }));
  }

  setOnToolsChanged(handler: ((tools: McpToolDefinition[]) => void | Promise<void>) | undefined): void {
    this.onToolsChanged = handler;
  }

  getTools(): McpToolDefinition[] {
    return [...this.servers.values()].flatMap((server) => server.tools);
  }

  /** Wait for tool-list notifications already received, without relaunching servers. */
  async waitForToolRefreshes(): Promise<void> {
    while (true) {
      const pending = [...this.servers.values()].map((server) => server.toolRefresh);
      await Promise.all(pending);
      if ([...this.servers.values()].every((server, index) => server.toolRefresh === pending[index])) return;
    }
  }

  /** Re-list connected servers at a model-turn boundary; never restarts a server. */
  async refreshConnectedTools(): Promise<void> {
    if (this.connectedRefresh) return this.connectedRefresh;
    const refresh = Promise.all([...this.servers.entries()].map(async ([name, server]) => {
      const client = server.client;
      if (client) await this.enqueueToolRefresh(name, server, client, true);
    })).then(() => undefined);
    this.connectedRefresh = refresh;
    try { await refresh; }
    finally { if (this.connectedRefresh === refresh) this.connectedRefresh = undefined; }
  }

  /** Invoke a currently advertised tool without manufacturing a Pi extension context. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Awaited<ReturnType<McpToolDefinition["execute"]>>> {
    const tool = this.getTools().find((candidate) => candidate.name === name);
    const invoke = tool && this.invokers.get(tool);
    if (!invoke) throw new McpToolCallError(new Error("tool unavailable"));
    return invoke(args, signal);
  }

  getConnectionStatus(name: string): McpConnectionStatus {
    const server = this.servers.get(name);
    if (server?.client) return "connected";
    if (server?.pending) return "connecting";
    return "disconnected";
  }

  getAllServerNames(): string[] {
    return [...this.servers.keys()];
  }

  getServerConfig(name: string): MCPServerConfig | undefined {
    return this.servers.get(name)?.config;
  }

  /** Connect every server; the input is validated `mcp.json` rows with secrets resolved. */
  async connectServers(configs: Record<string, MCPServerConfig>): Promise<McpConnectResult> {
    const errors = new Map<string, McpErrorCode>();
    const connectedServers: string[] = [];
    await Promise.all(Object.entries(configs).map(async ([name, config]) => {
      const server = this.servers.get(name) ?? { config, tools: [] };
      server.config = config;
      this.servers.set(name, server);
      try {
        await this.connect(name, server);
        connectedServers.push(name);
      } catch (error) {
        const code = mcpConnectionErrorCode(error instanceof McpToolLoadError);
        this.logger?.warn("MCP server failed to connect", { server: name, code });
        errors.set(name, code);
      }
    }));
    return { connectedServers, errors, tools: this.getTools() };
  }

  async reconnectServer(name: string): Promise<boolean> {
    const server = this.servers.get(name);
    if (!server) return false;
    await this.disconnectServer(name);
    try {
      await this.connect(name, server);
      return true;
    } catch {
      this.logger?.warn("MCP server failed to reconnect", { server: name, code: "mcp_connection_failed" });
      return false;
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    const pending = server.pending;
    if (pending) {
      await pending.client.close().catch(() => {});
      await pending.done.catch(() => undefined);
    }
    const client = server.client;
    server.client = undefined;
    server.tools = [];
    await client?.close().catch(() => {});
  }

  async disconnectAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.servers.keys()].map((name) => this.disconnectServer(name)));
  }

  private async connect(name: string, server: ServerState): Promise<void> {
    if (server.client) return;
    if (server.pending) return server.pending.done;
    if (this.closed) throw new Error("manager closed");
    if (server.config.auth) {
      // Ghost keeps MCP credentials as literal headers and env in the private
      // mcp.json; a separate OAuth/API-key login flow for MCP servers is not offered.
      throw new Error("MCP server auth configuration is not supported");
    }
    const client = this.clientFactory();
    const done = this.open(name, server, client).finally(() => {
      if (server.pending?.client === client) server.pending = undefined;
    });
    server.pending = { client, done };
    return done;
  }

  private async open(name: string, server: ServerState, client: Client): Promise<void> {
    const timeout = server.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const transport = await this.transportFactory(name, server.config);
    try {
      await client.connect(transport, { timeout });
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    let tools: McpToolDefinition[];
    try {
      tools = await this.loadTools(name, server, client);
    } catch (error) {
      await client.close().catch(() => {});
      throw new McpToolLoadError(error);
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.enqueueToolRefresh(name, server, client, false));
    client.onclose = () => {
      if (server.client !== client) return;
      server.client = undefined;
      server.tools = [];
    };
    server.client = client;
    server.tools = tools;
  }

  private enqueueToolRefresh(name: string, server: ServerState, client: Client, required: boolean): Promise<void> {
    const prior = server.toolRefresh;
    const refresh = (prior ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (server.client !== client) {
        if (required) throw new McpToolLoadError(new Error("MCP connection changed"));
        return;
      }
      let tools: McpToolDefinition[];
      try { tools = await this.loadTools(name, server, client); }
      catch (error) {
        this.logger?.warn("MCP tool list refresh failed", { server: name, code: "mcp_tool_load_failed" });
        if (required) throw new McpToolLoadError(error);
        return;
      }
      if (server.client !== client) {
        if (required) throw new McpToolLoadError(new Error("MCP connection changed"));
        return;
      }
      server.tools = tools;
      await this.onToolsChanged?.(this.getTools());
    });
    server.toolRefresh = refresh;
    return refresh;
  }

  private async loadTools(name: string, server: ServerState, client: Client): Promise<McpToolDefinition[]> {
    const timeout = server.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const minted = mintMcpToolNames(name, tools);
    for (const collision of minted.collisions) {
      this.logger?.warn("MCP tool name collision", { server: name, tool: collision, code: "mcp_tool_load_failed" });
    }
    return minted.named.map(({ tool, name: toolName }) => this.toolDefinition(name, tool, toolName, timeout));
  }

  private toolDefinition(serverName: string, tool: Tool, name: string, timeout: number): McpToolDefinition {
    const mcpToolName = tool.name;
    const invoke = async (params: Record<string, unknown>, signal?: AbortSignal) => {
      const client = this.servers.get(serverName)?.client;
      if (!client) throw new McpToolCallError(new Error("server disconnected"));
      let result: CallToolResult;
      try {
        result = await client.callTool(
          { name: mcpToolName, arguments: params },
          undefined,
          { timeout, ...(signal ? { signal } : {}) },
        ) as CallToolResult;
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new McpToolCallError(error);
      }
      if (result.isError) throw new McpToolCallError(undefined, "server_error");
      const rawContent = Array.isArray(result.content) ? result.content : [];
      return {
        content: formatMcpContent(rawContent),
        details: {
          serverName,
          mcpToolName,
          rawContent,
          ...(result._meta ? { mcpMeta: result._meta } : {}),
        },
      };
    };
    const definition: McpToolDefinition = {
      name,
      label: `${serverName}: ${mcpToolName}`,
      description: tool.description ?? `MCP tool ${mcpToolName} from ${serverName}`,
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as TSchema,
      mcpServerName: serverName,
      execute: async (_toolCallId, params, signal) => invoke((params ?? {}) as Record<string, unknown>, signal),
    };
    this.invokers.set(definition, invoke);
    return definition;
  }
}
