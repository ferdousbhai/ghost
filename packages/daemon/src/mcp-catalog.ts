import { isAbsolute, join, resolve } from "node:path";
import { GhostError, type GhostRegistry } from "./ghosts.js";
import { addMCPServer, removeMCPServer, updateMCPServer, type MCPConfigFile } from "./mcp-config.js";
import type { MCPServerConfig, MCPStdioServerConfig } from "@ghost/runtime/mcp-config-policy";
import { silentLogger, type Logger } from "./log.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import { isRecord, mcpServerValidationErrors } from "@ghost/runtime/mcp-config-policy";
import {
  PrivateReadError,
  readPrivateFileText,
  type PrivateReadProbe,
} from "./private-file.js";

export type McpConfigSource = "canonical" | "legacy";
import { expandMcpServerConfig as expandMcpServerConfigWithEnvironment, sanitizeMcpServerConfig } from "@ghost/runtime/mcp-catalog-policy";
import type { McpServerConfigView } from "@ghost/runtime/mcp-catalog-policy";
export interface McpServerView {
  name: string;
  enabled: boolean;
  source: McpConfigSource;
  path: "mcp.json" | ".omp/mcp.json" | ".omp/.mcp.json";
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

export interface McpCatalogOptions {
  registry: GhostRegistry;
  homeOperations?: HomeOperationCoordinator;
  logger?: Logger;
  /** Test seam after home resolution and before catalog bytes are read. */
  readProbe?: (home: string) => void | Promise<void>;
  /** Synchronous adversarial seam inside the pinned private-file read. */
  privateReadProbe?: PrivateReadProbe;
  /** Test seam around the locked atomic config writer. */
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

export interface McpFileSource {
  kind: McpConfigSource;
  absolutePath: string;
  relativePath: McpServerView["path"];
}

export interface EffectiveMcpServer {
  name: string;
  source: McpFileSource;
  config: unknown;
  errors: string[];
}

export interface EffectiveMcpDisabled {
  name: string;
  source: McpFileSource;
}

export interface EffectiveMcpRead {
  claimedNames: string[];
  /** Optional because released Pi snapshots predate disabled-row diagnostics. */
  disabled?: EffectiveMcpDisabled[];
  servers: EffectiveMcpServer[];
  skipped: McpCatalogSkipped[];
}

export interface EffectiveMcpInput {
  source: McpFileSource;
  content?: string;
  error?: string;
}

interface ParsedMcpInputs {
  effective: EffectiveMcpRead;
  configured: EffectiveMcpServer[];
}

export function normalizeMcpStdioCwd(
  config: MCPServerConfig,
  sourceRoot: string,
): MCPServerConfig {
  const type = config.type ?? "stdio";
  if (type !== "stdio") return config;
  const stdio = config as MCPStdioServerConfig;
  const cwd = stdio.cwd;
  return {
    ...stdio,
    cwd: cwd === undefined ? sourceRoot : isAbsolute(cwd) ? resolve(cwd) : resolve(sourceRoot, cwd),
  };
}

/** Local environment adapter for the portable expansion policy. */
export function expandMcpServerConfig(config: MCPServerConfig): MCPServerConfig {
  return expandMcpServerConfigWithEnvironment(config, process.env);
}


function validateMutation(name: string, value: unknown): asserts value is MCPServerConfig {
  const errors = mcpServerValidationErrors(name, value);
  if (errors.length > 0) {
    throw new GhostError(
      "invalid_mcp_server",
      `Invalid MCP server ${JSON.stringify(name)}: ${errors.join("; ")}`,
      400,
    );
  }
}

function ghostMcpSource(home: string): McpFileSource {
  return {
    kind: "canonical",
    absolutePath: join(home, "mcp.json"),
    relativePath: "mcp.json",
  };
}

/**
 * Parse already-read MCP bytes without reopening their source paths.
 *
 * The caller owns descriptor confinement and byte limits, so the same parser
 * serves the catalog and the per-session admission read.
 */
function parseMcpInputs(
  inputs: readonly EffectiveMcpInput[],
): ParsedMcpInputs {
  const claimed = new Set<string>();
  const claimedNames: string[] = [];
  const configured: EffectiveMcpServer[] = [];
  const disabled: EffectiveMcpDisabled[] = [];
  const servers: EffectiveMcpServer[] = [];
  const skipped: McpCatalogSkipped[] = [];

  for (const input of inputs) {
    if (input.error !== undefined) {
      skipped.push({ path: input.source.relativePath, reason: input.error });
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(input.content ?? "") as MCPConfigFile;
    } catch {
      skipped.push({
        path: input.source.relativePath,
        reason: "MCP config could not be read or parsed.",
      });
      continue;
    }
    if (!isRecord(document)) {
      skipped.push({ path: input.source.relativePath, reason: "MCP config must be a JSON object" });
      continue;
    }
    const rawServers = document.mcpServers;
    if (rawServers === undefined) continue;
    if (!isRecord(rawServers)) {
      skipped.push({ path: input.source.relativePath, reason: '"mcpServers" must be a JSON object' });
      continue;
    }
    for (const [name, config] of Object.entries(rawServers)) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      claimedNames.push(name);
      const server = {
        name,
        source: input.source,
        config,
        errors: mcpServerValidationErrors(name, config),
      };
      configured.push(server);
      if (server.errors.length > 0) {
        skipped.push({
          path: `${input.source.relativePath}#mcpServers.${name}`,
          reason: server.errors.join("; "),
        });
        continue;
      }
      if ((config as MCPServerConfig).enabled === false) {
        disabled.push({ name, source: input.source });
        continue;
      }
      servers.push(server);
    }
  }

  return {
    effective: { claimedNames, disabled, servers, skipped },
    configured,
  };
}

/** Read and parse the ghost's visible `mcp.json`. */
async function readGhostMcpFile(
  home: string,
  probe?: PrivateReadProbe,
): Promise<ParsedMcpInputs> {
  const inputs: EffectiveMcpInput[] = [];
  const source = ghostMcpSource(home);
  try {
    inputs.push({ source, content: readPrivateFileText(source.absolutePath, probe) });
  } catch (error) {
    if (error instanceof PrivateReadError
      && error.refusal === "open"
      && (error.cause as NodeJS.ErrnoException).code === "ENOENT") {
      return parseMcpInputs(inputs);
    }
    const reason = error instanceof PrivateReadError && error.refusal === "too_large"
      ? "MCP config exceeds the 1 MiB limit"
      : error instanceof PrivateReadError && error.refusal === "encoding"
        ? "MCP config is not valid UTF-8"
        : "MCP config could not be read or parsed.";
    inputs.push({ source, error: reason });
  }

  return parseMcpInputs(inputs);
}

export async function readEffectiveMcp(home: string): Promise<EffectiveMcpRead> {
  return (await readGhostMcpFile(home)).effective;
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
 * No method discovers MCP configuration outside the ghost home. That negative
 * guarantee is the sovereignty boundary of this class.
 */
export class McpCatalog {
  private readonly registry: GhostRegistry;
  private readonly homeOperations: HomeOperationCoordinator;
  private readonly writer: McpCatalogWriter;
  private readonly logger: Logger;
  private readonly readProbe: NonNullable<McpCatalogOptions["readProbe"]>;
  private readonly privateReadProbe: McpCatalogOptions["privateReadProbe"];

  constructor(options: McpCatalogOptions) {
    this.registry = options.registry;
    this.homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
    this.writer = { ...defaultWriter, ...options.writer };
    this.logger = options.logger ?? silentLogger;
    this.readProbe = options.readProbe ?? (() => {});
    this.privateReadProbe = options.privateReadProbe;
  }

  private withHomeLease<T>(ghostName: string, operation: () => Promise<T>): Promise<T> {
    return this.homeOperations.withLease(ghostName, operation);
  }

  private sources(
    ghostName: string,
  ): [McpFileSource] {
    return [ghostMcpSource(this.registry.get(ghostName).dir)];
  }

  private async effective(ghostName: string): Promise<ParsedMcpInputs> {
    const home = this.registry.get(ghostName).dir;
    await this.readProbe(home);
    return readGhostMcpFile(home, this.privateReadProbe);
  }

  async list(ghostName: string): Promise<McpCatalogSnapshot> {
    return this.withHomeLease(ghostName, () => this.listLeased(ghostName));
  }

  /** The caller already owns this ghost home's identity lease. */
  async listLeased(ghostName: string): Promise<McpCatalogSnapshot> {
    const { effective, configured } = await this.effective(ghostName);
    const servers: McpServerView[] = [];
    const skipped = [...effective.skipped];
    for (const server of configured) {
      if (server.errors.length > 0) continue;
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

  private async writeServer(
    mutation: "add" | "update",
    absolutePath: string,
    name: string,
    config: unknown,
  ): Promise<void> {
    try {
      await this.writer[mutation](absolutePath, name, config as MCPServerConfig);
    } catch (error) {
      translateWriterError(error, name);
    }
  }

  async add(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.withHomeLease(ghostName, () => this.addValidatedLeased(ghostName, name, config));
  }

  /** The caller already owns this ghost home's identity lease. */
  async addLeased(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.addValidatedLeased(ghostName, name, config);
  }

  private async addValidatedLeased(
    ghostName: string,
    name: string,
    config: unknown,
  ): Promise<McpCatalogSnapshot> {
    const { effective } = await this.effective(ghostName);
    if (effective.claimedNames.includes(name)) {
      throw new GhostError("mcp_server_exists", `MCP server ${JSON.stringify(name)} already exists.`, 409);
    }
    const [canonical] = this.sources(ghostName);
    // A new server costs context the moment it connects, so it starts off
    // unless the row says otherwise; `enable` is the deliberate step.
    const row = config as Record<string, unknown>;
    const stored = "enabled" in row ? config : { ...row, enabled: false };
    await this.writeServer("add", canonical.absolutePath, name, stored);
    return this.listLeased(ghostName);
  }

  async update(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.withHomeLease(ghostName, () =>
      this.updateValidatedLeased(ghostName, name, config)
    );
  }

  /** The caller already owns this ghost home's identity lease. */
  async updateLeased(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.updateValidatedLeased(ghostName, name, config);
  }

  private async updateValidatedLeased(
    ghostName: string,
    name: string,
    config: unknown,
  ): Promise<McpCatalogSnapshot> {
    const server = (await this.effective(ghostName)).configured
      .find((candidate) => candidate.name === name);
    if (!server) {
      throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
    }
    await this.writeServer("update", server.source.absolutePath, name, config);
    return this.listLeased(ghostName);
  }

  async setEnabled(ghostName: string, name: string, enabled: boolean): Promise<McpCatalogSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new GhostError("invalid_request", '"enabled" must be a boolean.', 400);
    }
    return this.withHomeLease(ghostName, () =>
      this.setEnabledValidatedLeased(ghostName, name, enabled)
    );
  }

  /** The caller already owns this ghost home's identity lease. */
  async setEnabledLeased(
    ghostName: string,
    name: string,
    enabled: boolean,
  ): Promise<McpCatalogSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new GhostError("invalid_request", '"enabled" must be a boolean.', 400);
    }
    return this.setEnabledValidatedLeased(ghostName, name, enabled);
  }

  private async setEnabledValidatedLeased(
    ghostName: string,
    name: string,
    enabled: boolean,
  ): Promise<McpCatalogSnapshot> {
    const server = (await this.effective(ghostName)).configured
      .find((candidate) => candidate.name === name);
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
    return this.listLeased(ghostName);
  }

  async remove(ghostName: string, name: string): Promise<McpCatalogSnapshot> {
    return this.withHomeLease(ghostName, () => this.removeLeased(ghostName, name));
  }

  /** The caller already owns this ghost home's identity lease. */
  async removeLeased(ghostName: string, name: string): Promise<McpCatalogSnapshot> {
    const server = (await this.effective(ghostName)).configured
      .find((candidate) => candidate.name === name);
    if (!server) {
      throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
    }
    try {
      await this.writer.remove(server.source.absolutePath, name);
    } catch (error) {
      translateWriterError(error, name);
    }
    return this.listLeased(ghostName);
  }
}
