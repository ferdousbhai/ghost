/**
 * Project-only MCP configuration for one ghost.
 *
 * OMP normally discovers MCP servers from several user-level and third-party
 * coding-agent locations. Ghost deliberately does not call that discovery
 * path here: the only inputs are the two native files inside the selected
 * ghost home. New servers are written to `.omp/mcp.json`; the older
 * `.omp/.mcp.json` remains readable and editable so existing homes can be
 * managed without an implicit migration.
 *
 * The list view is safe to send to a UI. It never returns header or environment
 * values, command arguments, OAuth client secrets, or URL query values.
 * Mutations use OMP's locked, atomic config writer and its native validation.
 */
import { join } from "node:path";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
  addMCPServer,
  readMCPConfigFile,
  removeMCPServer,
  updateMCPServer,
  validateServerName,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type {
  MCPAuthConfig,
  MCPConfigFile,
  MCPHttpServerConfig,
  MCPServerConfig,
  MCPSseServerConfig,
  MCPStdioServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { GhostError, type GhostRegistry } from "./ghosts.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "./home-operations.js";

export type McpConfigSource = "canonical" | "legacy";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpConfiguredKeysView {
  /** Names are useful for diagnostics; values are intentionally never returned. */
  keys: string[];
  configured: true;
}

export interface McpAuthView {
  type: MCPAuthConfig["type"];
  /** A stored credential reference exists. The reference itself is not returned. */
  configured: boolean;
}

export interface McpOAuthView {
  configured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
}

interface McpServerConfigViewBase {
  type: McpTransport;
  timeout?: number;
  requestIdFormat?: "string" | "number";
  auth?: McpAuthView;
  oauth?: McpOAuthView;
}

export interface McpStdioServerConfigView extends McpServerConfigViewBase {
  type: "stdio";
  command: string;
  cwd?: string;
  envPolicy?: "literal";
  /** Arguments can contain bearer tokens and are therefore summarized. */
  argumentCount: number;
  environment?: McpConfiguredKeysView;
}

export interface McpRemoteServerConfigView extends McpServerConfigViewBase {
  type: "http" | "sse";
  /** Userinfo is removed and every query value is replaced with a marker. */
  url: string;
  headerPolicy?: "origin-locked";
  headers?: McpConfiguredKeysView;
}

export type McpServerConfigView = McpStdioServerConfigView | McpRemoteServerConfigView;

export interface McpServerView {
  name: string;
  enabled: boolean;
  source: McpConfigSource;
  /** Ghost-home-relative, never an ambient or absolute path. */
  path: ".omp/mcp.json" | ".omp/.mcp.json";
  config: McpServerConfigView;
}

export interface McpCatalogSkipped {
  path: string;
  reason: string;
}

export interface McpCatalogSnapshot {
  servers: McpServerView[];
  skipped: McpCatalogSkipped[];
}

/** Sanitized result of an isolated connection probe. */
export interface McpConnectionTest {
  name: string;
  ok: boolean;
  status: "connected" | "failed";
  toolCount: number;
  /** Deliberately generic: transport errors can echo secret-bearing config. */
  message: string;
}

export interface McpCatalogOptions {
  registry: GhostRegistry;
  /** Shared gate for path-bound mutations and whole-home moves. */
  homeOperations?: HomeOperationCoordinator;
  /** Test seam around OMP's locked atomic project-config writer. */
  writer?: Partial<McpCatalogWriter>;
}

export interface McpCatalogWriter {
  add(path: string, name: string, config: MCPServerConfig): Promise<unknown>;
  update(path: string, name: string, config: MCPServerConfig): Promise<unknown>;
  remove(path: string, name: string): Promise<unknown>;
}

const defaultWriter: McpCatalogWriter = {
  add: addMCPServer,
  update: updateMCPServer,
  remove: removeMCPServer,
};

export interface ProjectMcpConfigSource {
  kind: McpConfigSource;
  absolutePath: string;
  relativePath: McpServerView["path"];
}

export interface EffectiveProjectMcpServer {
  name: string;
  source: ProjectMcpConfigSource;
  config: unknown;
  errors: string[];
}

export interface EffectiveProjectMcpRead {
  servers: EffectiveProjectMcpServer[];
  skipped: McpCatalogSkipped[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredKeys(value: unknown): McpConfiguredKeysView | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return keys.length > 0 ? { keys, configured: true } : undefined;
}

function sanitizeRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.delete(key);
      url.searchParams.append(key, "[configured]");
    }
    return url.toString();
  } catch {
    // A templated URL may not parse until OMP expands it. Do not return the
    // opaque input because its query or userinfo could contain a credential.
    return value.replace(/^[^:/?#]+:[^@/?#]*@/, "").replace(/[?#].*$/, "?[configured]");
  }
}

function sanitizeAuth(auth: MCPServerConfig["auth"]): McpAuthView | undefined {
  if (!auth) return undefined;
  return { type: auth.type, configured: Boolean(auth.credentialId) };
}

function sanitizeOAuth(oauth: MCPServerConfig["oauth"]): McpOAuthView | undefined {
  if (!oauth) return undefined;
  return {
    configured: Object.keys(oauth).length > 0,
    clientIdConfigured: Boolean(oauth.clientId),
    clientSecretConfigured: Boolean(oauth.clientSecret),
  };
}

/** Redact every field that can reasonably carry a credential before HTTP sees it. */
export function sanitizeMcpServerConfig(config: MCPServerConfig): McpServerConfigView {
  const type = config.type ?? "stdio";
  const auth = sanitizeAuth(config.auth);
  const oauth = sanitizeOAuth(config.oauth);
  const shared = {
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
    ...(config.requestIdFormat === "string" || config.requestIdFormat === "number"
      ? { requestIdFormat: config.requestIdFormat }
      : {}),
    ...(auth ? { auth } : {}),
    ...(oauth ? { oauth } : {}),
  };
  if (type === "http" || type === "sse") {
    const remote = config as MCPHttpServerConfig | MCPSseServerConfig;
    const headers = configuredKeys(remote.headers);
    return {
      ...shared,
      type,
      url: sanitizeRemoteUrl(remote.url),
      ...(remote.headerPolicy === "origin-locked"
        ? { headerPolicy: remote.headerPolicy }
        : {}),
      ...(headers ? { headers } : {}),
    };
  }
  const stdio = config as MCPStdioServerConfig;
  const environment = configuredKeys(stdio.env);
  return {
    ...shared,
    type: "stdio",
    command: stdio.command,
    ...(typeof stdio.cwd === "string" ? { cwd: stdio.cwd } : {}),
    ...(stdio.envPolicy === "literal" ? { envPolicy: stdio.envPolicy } : {}),
    argumentCount: Array.isArray(stdio.args) ? stdio.args.length : 0,
    ...(environment ? { environment } : {}),
  };
}

function validationErrors(name: string, value: unknown): string[] {
  const nameError = validateServerName(name);
  if (nameError) return [nameError];
  if (!isRecord(value)) return [`Server ${JSON.stringify(name)} must be a JSON object`];
  try {
    return validateServerConfig(name, value as unknown as MCPServerConfig);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function validateMutation(name: string, value: unknown): asserts value is MCPServerConfig {
  const errors = validationErrors(name, value);
  if (errors.length > 0) {
    throw new GhostError(
      "invalid_mcp_server",
      `Invalid MCP server ${JSON.stringify(name)}: ${errors.join("; ")}`,
      400,
    );
  }
}

function projectMcpSources(home: string): [ProjectMcpConfigSource, ProjectMcpConfigSource] {
  return [
    {
      kind: "canonical",
      absolutePath: join(home, ".omp", "mcp.json"),
      relativePath: ".omp/mcp.json",
    },
    {
      kind: "legacy",
      absolutePath: join(home, ".omp", ".mcp.json"),
      relativePath: ".omp/.mcp.json",
    },
  ];
}

/**
 * Resolve the only two MCP sources a sovereign Ghost session may read.
 * Canonical names are claimed before validation or enabled filtering, so a
 * disabled or malformed canonical row cannot reactivate a legacy duplicate.
 */
export async function readEffectiveProjectMcp(home: string): Promise<EffectiveProjectMcpRead> {
  const claimed = new Set<string>();
  const servers: EffectiveProjectMcpServer[] = [];
  const skipped: McpCatalogSkipped[] = [];

  for (const source of projectMcpSources(home)) {
    let document: unknown;
    try {
      document = await readMCPConfigFile(source.absolutePath) as MCPConfigFile;
    } catch (error) {
      skipped.push({
        path: source.relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!isRecord(document)) {
      skipped.push({ path: source.relativePath, reason: "MCP config must be a JSON object" });
      continue;
    }
    const rawServers = document.mcpServers;
    if (rawServers === undefined) continue;
    if (!isRecord(rawServers)) {
      skipped.push({ path: source.relativePath, reason: '"mcpServers" must be a JSON object' });
      continue;
    }
    for (const [name, config] of Object.entries(rawServers)) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      servers.push({ name, source, config, errors: validationErrors(name, config) });
    }
  }

  return { servers, skipped };
}

function translateWriterError(error: unknown, name: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("already exists")) {
    throw new GhostError("mcp_server_exists", `MCP server ${JSON.stringify(name)} already exists.`, 409);
  }
  if (message.includes("not found")) {
    throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
  }
  if (message.includes("Invalid server config") || message.includes("Server name")) {
    throw new GhostError("invalid_mcp_server", message, 400);
  }
  throw error;
}

/**
 * CRUD and sanitized discovery for the MCP files owned by one ghost.
 *
 * No method calls OMP capability discovery or `getMCPConfigPath("user")`.
 * That negative guarantee is the sovereignty boundary of this class.
 */
export class McpCatalog {
  private readonly registry: GhostRegistry;
  private readonly homeOperations: HomeOperationCoordinator;
  private readonly writer: McpCatalogWriter;

  constructor(options: McpCatalogOptions) {
    this.registry = options.registry;
    this.homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
    this.writer = { ...defaultWriter, ...options.writer };
  }

  private withMutation<T>(ghostName: string, operation: () => Promise<T>): Promise<T> {
    return this.homeOperations.withLease(ghostName, operation);
  }

  private sources(ghostName: string): [ProjectMcpConfigSource, ProjectMcpConfigSource] {
    return projectMcpSources(this.registry.get(ghostName).dir);
  }

  private effective(ghostName: string): Promise<EffectiveProjectMcpRead> {
    return readEffectiveProjectMcp(this.registry.get(ghostName).dir);
  }

  async list(ghostName: string): Promise<McpCatalogSnapshot> {
    const effective = await this.effective(ghostName);
    const servers: McpServerView[] = [];
    const skipped = [...effective.skipped];
    for (const server of effective.servers) {
      if (server.errors.length > 0) {
        skipped.push({
          path: `${server.source.relativePath}#mcpServers.${server.name}`,
          reason: server.errors.join("; "),
        });
        continue;
      }
      const config = server.config as MCPServerConfig;
      servers.push({
        name: server.name,
        enabled: config.enabled !== false,
        source: server.source.kind,
        path: server.source.relativePath,
        config: sanitizeMcpServerConfig(config),
      });
    }
    servers.sort((left, right) => left.name.localeCompare(right.name));
    skipped.sort((left, right) => left.path.localeCompare(right.path));
    return { servers, skipped };
  }

  /** Add a new server to the canonical project file. */
  async add(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.withMutation(ghostName, async () => {
      const effective = await this.effective(ghostName);
      if (effective.servers.some((server) => server.name === name)) {
        throw new GhostError("mcp_server_exists", `MCP server ${JSON.stringify(name)} already exists.`, 409);
      }
      const [canonical] = this.sources(ghostName);
      try {
        await this.writer.add(canonical.absolutePath, name, config);
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /** Replace an effective server in the native file that currently owns it. */
  async update(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.withMutation(ghostName, async () => {
      const server = (await this.effective(ghostName)).servers.find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      try {
        await this.writer.update(server.source.absolutePath, name, config);
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /** Toggle an effective, valid server without moving it between native files. */
  async setEnabled(ghostName: string, name: string, enabled: boolean): Promise<McpCatalogSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new GhostError("invalid_request", '"enabled" must be a boolean.', 400);
    }
    return this.withMutation(ghostName, async () => {
      const server = (await this.effective(ghostName)).servers.find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      validateMutation(name, server.config);
      try {
        await this.writer.update(
          server.source.absolutePath,
          name,
          { ...(server.config as MCPServerConfig), enabled },
        );
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /** Remove only the JSON member; OMP deliberately leaves the config file. */
  async remove(ghostName: string, name: string): Promise<McpCatalogSnapshot> {
    return this.withMutation(ghostName, async () => {
      const server = (await this.effective(ghostName)).servers.find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      try {
        await this.writer.remove(server.source.absolutePath, name);
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /**
   * Probe one project-owned server in an isolated manager. GET never calls
   * this; it is an explicit POST action and never opens an AgentSession.
   */
  async test(ghostName: string, name: string): Promise<McpConnectionTest> {
    const server = (await this.effective(ghostName)).servers.find((candidate) => candidate.name === name);
    if (!server) {
      throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
    }
    validateMutation(name, server.config);
    const home = this.registry.get(ghostName).dir;
    const manager = new MCPManager(home, null);
    const source: SourceMeta = {
      provider: "native",
      providerName: "OMP",
      path: server.source.absolutePath,
      level: "project",
    };
    try {
      const result = await manager.connectServers(
        { [name]: expandEnvVarsDeep(server.config as MCPServerConfig) },
        { [name]: source },
      );
      const connected = result.connectedServers.includes(name)
        || manager.getConnectionStatus(name) === "connected";
      return {
        name,
        ok: connected,
        status: connected ? "connected" : "failed",
        toolCount: manager.getTools().filter((tool) => tool.mcpServerName === name).length,
        message: connected ? "Connection succeeded." : "Connection failed; check the server configuration.",
      };
    } catch {
      return {
        name,
        ok: false,
        status: "failed",
        toolCount: 0,
        message: "Connection failed; check the server configuration.",
      };
    } finally {
      await manager.disconnectAll().catch(() => {});
    }
  }
}
