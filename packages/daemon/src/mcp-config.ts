/**
 * MCP server configuration as Ghost stores it: the `mcp.json` row shape, its
 * validation, `${VAR}` expansion, and the locked read-modify-write of the
 * file. The shape is the one Oh My Pi established (MIT, can1357/oh-my-pi
 * `src/mcp/{types,config,config-writer}.ts`), kept so existing homes keep
 * loading; the implementation is Ghost's.
 */
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PrivateReadError,
  readPrivateFileText,
  recoverPrivateJsonAtomicCas,
  type PrivateReadProbe,
  writePrivateJsonAtomic,
} from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";
import { acquireWriterLock, releaseWriterLock } from "./writer-lock.js";

import { expandEnvVars as expandEnvVarsWithEnvironment, expandEnvVarsDeep as expandEnvVarsDeepWithEnvironment } from "@ghost/runtime/mcp-config-policy";
export { validateServerName, validateServerConfig } from "@ghost/runtime/mcp-config-policy";
export type { MCPAuthConfig, MCPRequestIdFormat, MCPServerConfig, MCPStdioServerConfig, MCPHttpServerConfig, MCPSseServerConfig } from "@ghost/runtime/mcp-config-policy";
import { validateServerName, validateServerConfig, type MCPServerConfig } from "@ghost/runtime/mcp-config-policy";

/** The file: `mcpServers` is what Ghost reads; other keys pass through untouched. */
export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

/** Local adapter supplies ambient values; portable policy never reads process.env. */
export function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
  return expandEnvVarsWithEnvironment(value, { ...process.env, ...extraEnv });
}
export function expandEnvVarsDeep<T>(value: T, extraEnv?: Record<string, string>): T {
  return expandEnvVarsDeepWithEnvironment(value, { ...process.env, ...extraEnv });
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

const fileLocks = new Map<string, Promise<unknown>>();
const MCP_WRITER_LOCK_WAIT_MS = 500;
const MCP_WRITER_LOCK_POLL_MS = 10;

function acquireMCPWriterLock(filePath: string): () => void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const lease = acquireWriterLock(lockPath, {
    waitMs: MCP_WRITER_LOCK_WAIT_MS,
    pollMs: MCP_WRITER_LOCK_POLL_MS,
  });
  return () => releaseWriterLock(lease);
}

async function withAsyncMCPConfigWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const release = acquireMCPWriterLock(filePath);
  try {
    recoverPrivateJsonAtomicCas(filePath);
    return await operation();
  } finally {
    release();
  }
}

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
  return serializeByKey(fileLocks, filePath, () => withAsyncMCPConfigWriteLock(filePath, async () => {
    const existing = readMCPConfigFile(filePath, options.readProbe);
    if (mustBeNew && Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" already exists in ${filePath}`);
    }
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: { ...existing.mcpServers, [name]: config } });
  }));
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
  return serializeByKey(fileLocks, filePath, () => withAsyncMCPConfigWriteLock(filePath, async () => {
    const existing = readMCPConfigFile(filePath, options.readProbe);
    if (!Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" not found in ${filePath}`);
    }
    const remaining = { ...existing.mcpServers };
    delete remaining[name];
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: remaining });
  }));
}
