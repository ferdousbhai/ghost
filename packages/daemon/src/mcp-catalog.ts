import { isAbsolute, join, resolve } from "node:path";
import { GhostError, type GhostRegistry } from "./ghosts.js";
import { addMCPServer, removeMCPServer, updateMCPServer } from "./mcp-config.js";
import type { MCPServerConfig, MCPStdioServerConfig } from "./mcp-config-policy.js";
import { isRecord } from "@ghost/extensions";
import { mcpServerValidationErrors } from "./mcp-config-policy.js";
import {
  isMissingPrivateFile,
  PrivateReadError,
  readPrivateFileText,
  type PrivateReadProbe,
} from "./private-file.js";

import { sanitizeMcpServerConfig } from "./mcp-catalog-policy.js";
import type { McpServerConfigView } from "./mcp-catalog-policy.js";
export interface McpServerView {
  name: string;
  enabled: boolean;
  source: "canonical";
  path: "mcp.json";
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

/** One `mcp.json` row; `errors` is empty for a usable one. */
export interface McpServerRow {
  name: string;
  config: unknown;
  errors: string[];
}

interface McpFileRead {
  rows: McpServerRow[];
  skipped: McpCatalogSkipped[];
}

const MCP_FILE = "mcp.json";

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

function unreadable(reason: string): McpFileRead {
  return { rows: [], skipped: [{ path: MCP_FILE, reason }] };
}

/** Read and parse the ghost's `mcp.json`; a missing file has no rows. */
function readMcpFile(home: string, probe?: PrivateReadProbe): McpFileRead {
  let text: string;
  try {
    text = readPrivateFileText(join(home, MCP_FILE), probe);
  } catch (error) {
    if (isMissingPrivateFile(error)) return { rows: [], skipped: [] };
    return unreadable(error instanceof PrivateReadError && error.refusal === "too_large"
      ? "MCP config exceeds the 1 MiB limit"
      : error instanceof PrivateReadError && error.refusal === "encoding"
        ? "MCP config is not valid UTF-8"
        : "MCP config could not be read or parsed.");
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return unreadable("MCP config could not be read or parsed.");
  }
  if (!isRecord(document)) return unreadable("MCP config must be a JSON object");
  if (document.mcpServers === undefined) return { rows: [], skipped: [] };
  if (!isRecord(document.mcpServers)) return unreadable('"mcpServers" must be a JSON object');
  const rows = Object.entries(document.mcpServers)
    .map(([name, config]) => ({ name, config, errors: mcpServerValidationErrors(name, config) }));
  const skipped = rows.filter((row) => row.errors.length > 0)
    .map((row) => ({ path: `${MCP_FILE}#mcpServers.${row.name}`, reason: row.errors.join("; ") }));
  return { rows, skipped };
}

/** The rows a turn loads: valid, and not turned off. */
export function readEnabledMcp(home: string): McpServerRow[] {
  return readMcpFile(home).rows
    .filter((row) => row.errors.length === 0 && (row.config as MCPServerConfig).enabled !== false);
}

/**
 * CRUD and sanitized discovery for the ghost's `mcp.json`. Every method
 * expects the caller to hold the ghost home's identity lease.
 *
 * No method discovers MCP configuration outside the ghost home. That negative
 * guarantee is the sovereignty boundary of this class.
 */
export class McpCatalog {
  private readonly registry: GhostRegistry;
  private readonly writer: McpCatalogWriter;
  private readonly readProbe: NonNullable<McpCatalogOptions["readProbe"]>;
  private readonly privateReadProbe: McpCatalogOptions["privateReadProbe"];

  constructor(options: McpCatalogOptions) {
    this.registry = options.registry;
    this.writer = { ...defaultWriter, ...options.writer };
    this.readProbe = options.readProbe ?? (() => {});
    this.privateReadProbe = options.privateReadProbe;
  }

  private async read(ghostName: string): Promise<McpFileRead & { path: string }> {
    const home = this.registry.get(ghostName).dir;
    await this.readProbe(home);
    return { ...readMcpFile(home, this.privateReadProbe), path: join(home, MCP_FILE) };
  }

  private async row(ghostName: string, name: string): Promise<{ row: McpServerRow; path: string }> {
    const { rows, path } = await this.read(ghostName);
    const row = rows.find((candidate) => candidate.name === name);
    if (!row) throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
    return { row, path };
  }

  async listLeased(ghostName: string): Promise<McpCatalogSnapshot> {
    const { rows, skipped } = await this.read(ghostName);
    const servers: McpServerView[] = rows.filter((row) => row.errors.length === 0).map((row) => {
      const config = row.config as MCPServerConfig;
      return { name: row.name, enabled: config.enabled !== false, source: "canonical", path: MCP_FILE, config: sanitizeMcpServerConfig(config) };
    });
    servers.sort((left, right) => left.name.localeCompare(right.name));
    skipped.sort((left, right) => left.path.localeCompare(right.path));
    return { servers, skipped };
  }

  async addLeased(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    // A new server costs context the moment it connects, so it starts off
    // unless the row says otherwise; `enable` is the deliberate step.
    const stored = "enabled" in config ? config : { ...config, enabled: false };
    const { path } = await this.read(ghostName);
    await this.writer.add(path, name, stored);
    return this.listLeased(ghostName);
  }

  async updateLeased(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    const { path } = await this.row(ghostName, name);
    await this.writer.update(path, name, config);
    return this.listLeased(ghostName);
  }

  async setEnabledLeased(ghostName: string, name: string, enabled: boolean): Promise<McpCatalogSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new GhostError("invalid_request", '"enabled" must be a boolean.', 400);
    }
    const { row, path } = await this.row(ghostName, name);
    validateMutation(name, row.config);
    await this.writer.update(path, name, { ...row.config, enabled });
    return this.listLeased(ghostName);
  }

  async removeLeased(ghostName: string, name: string): Promise<McpCatalogSnapshot> {
    const { path } = await this.row(ghostName, name);
    await this.writer.remove(path, name);
    return this.listLeased(ghostName);
  }
}
