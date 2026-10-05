/**
 * MCP server configuration as Ghost stores it: the `mcp.json` row shape, its
 * validation, `${VAR}` expansion, and the serialized read-modify-write of the
 * file. The `mcpServers` shape is the Claude Code dialect most harnesses read.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { GhostError } from "./ghosts.js";
import { PrivateReadError, readPrivateFileText, writePrivateJsonAtomic } from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";
import type { MCPServerConfig } from "./mcp-config-policy.js";

/** The file: `mcpServers` is what Ghost reads; other keys pass through untouched. */
export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

function readMCPConfigFile(filePath: string): MCPConfigFile {
  let text: string;
  try {
    text = readPrivateFileText(filePath);
  } catch (error) {
    if (error instanceof PrivateReadError && error.refusal === "open") {
      const cause = error.cause as NodeJS.ErrnoException;
      if (cause.code === "ENOENT") return { mcpServers: {} };
      throw cause;
    }
    throw error;
  }
  return JSON.parse(text) as MCPConfigFile;
}

async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(filePath, config);
}

/** The single ghostd systemd unit keeps one daemon on every ghost home, so serializing per file in-process is the whole lock. */
const fileLocks = new Map<string, Promise<unknown>>();

/**
 * The writes, each a read-modify-write under the file's lock. The catalog
 * validates a row before it gets here; existence is checked again under the
 * lock, where it cannot race.
 */
async function putServer(filePath: string, name: string, config: MCPServerConfig, mustBeNew: boolean): Promise<void> {
  return serializeByKey(fileLocks, filePath, async () => {
    const existing = readMCPConfigFile(filePath);
    if (mustBeNew && Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new GhostError("mcp_server_exists", `MCP server ${JSON.stringify(name)} already exists.`, 409);
    }
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: { ...existing.mcpServers, [name]: config } });
  });
}

export function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
  return putServer(filePath, name, config, true);
}

export function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
  return putServer(filePath, name, config, false);
}

export function removeMCPServer(filePath: string, name: string): Promise<void> {
  return serializeByKey(fileLocks, filePath, async () => {
    const existing = readMCPConfigFile(filePath);
    if (!Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
    }
    const remaining = { ...existing.mcpServers };
    delete remaining[name];
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: remaining });
  });
}
