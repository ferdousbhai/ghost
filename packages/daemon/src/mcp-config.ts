/**
 * MCP server configuration as Ghost stores it: the `mcp.json` row shape, its
 * validation, `${VAR}` expansion, and the serialized read-modify-write of the
 * file. The `mcpServers` shape is the Claude Code dialect most harnesses read.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PrivateReadError,
  readPrivateFileText,
  type PrivateReadProbe,
  writePrivateJsonAtomic,
} from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";
import { validateServerName, validateServerConfig, type MCPServerConfig } from "./mcp-config-policy.js";

export { validateServerName };

/** The file: `mcpServers` is what Ghost reads; other keys pass through untouched. */
export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

export function readMCPConfigFile(
  filePath: string,
  probe?: PrivateReadProbe,
): MCPConfigFile {
  let text: string;
  try {
    text = readPrivateFileText(filePath, probe);
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

export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(filePath, config);
}

/** The single ghostd systemd unit keeps one daemon on every ghost home, so serializing per file in-process is the whole lock. */
const fileLocks = new Map<string, Promise<unknown>>();

export interface MCPConfigMutationOptions {
  readProbe?: PrivateReadProbe;
}

async function putServer(
  filePath: string,
  name: string,
  config: MCPServerConfig,
  mustBeNew: boolean,
  options: MCPConfigMutationOptions,
): Promise<void> {
  const nameError = validateServerName(name);
  if (nameError) throw new Error(nameError);
  const errors = validateServerConfig(name, config);
  if (errors.length > 0) throw new Error(`Invalid server config: ${errors.join("; ")}`);
  return serializeByKey(fileLocks, filePath, async () => {
    const existing = readMCPConfigFile(filePath, options.readProbe);
    if (mustBeNew && Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" already exists in ${filePath}`);
    }
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: { ...existing.mcpServers, [name]: config } });
  });
}

export function addMCPServer(
  filePath: string,
  name: string,
  config: MCPServerConfig,
  options: MCPConfigMutationOptions = {},
): Promise<void> {
  return putServer(filePath, name, config, true, options);
}

export function updateMCPServer(
  filePath: string,
  name: string,
  config: MCPServerConfig,
  options: MCPConfigMutationOptions = {},
): Promise<void> {
  return putServer(filePath, name, config, false, options);
}

export function removeMCPServer(
  filePath: string,
  name: string,
  options: MCPConfigMutationOptions = {},
): Promise<void> {
  return serializeByKey(fileLocks, filePath, async () => {
    const existing = readMCPConfigFile(filePath, options.readProbe);
    if (!Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" not found in ${filePath}`);
    }
    const remaining = { ...existing.mcpServers };
    delete remaining[name];
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: remaining });
  });
}
