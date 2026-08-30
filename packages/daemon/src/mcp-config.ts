/**
 * MCP server configuration as Ghost stores it: the `mcp.json` row shape, its
 * validation, `${VAR}` expansion, and the locked read-modify-write of the
 * file. The shape is the one Oh My Pi established (MIT, can1357/oh-my-pi
 * `src/mcp/{types,config,config-writer}.ts`), kept so existing homes keep
 * loading; the implementation is Ghost's.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PrivateReadError,
  readPrivateFileText,
  type PrivateReadProbe,
  writePrivateJsonAtomic,
} from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";

export interface MCPAuthConfig {
  type: "oauth" | "apikey";
  credentialId?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  resource?: string;
}

export type MCPRequestIdFormat = "string" | "number";

interface MCPServerConfigBase {
  enabled?: boolean;
  timeout?: number;
  requestIdFormat?: MCPRequestIdFormat;
  auth?: MCPAuthConfig;
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    callbackPort?: number;
    callbackPath?: string;
    prompt?: string;
  };
}

export interface MCPStdioServerConfig extends MCPServerConfigBase {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Pass `env` values verbatim, without `${VAR}` expansion. */
  envPolicy?: "literal";
  cwd?: string;
}

export interface MCPHttpServerConfig extends MCPServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /** Send `headers` only to the configured origin, never across a redirect. */
  headerPolicy?: "origin-locked";
}

export interface MCPSseServerConfig extends MCPServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  headerPolicy?: "origin-locked";
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

/** The file: `mcpServers` is what Ghost reads; other keys pass through untouched. */
export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

export function validateServerName(name: string): string | undefined {
  if (!name) return "Server name cannot be empty";
  if (name.length > 100) return "Server name is too long (max 100 characters)";
  if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
    return "Server name can only contain letters, numbers, dash, underscore, dot, and colon";
  }
  return undefined;
}

/** Transport-level consistency, after Ghost's own field validation. */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
  const errors: string[] = [];
  const type = config.type ?? "stdio";
  const hasCommand = "command" in config && Boolean(config.command);
  const hasUrl = "url" in config && Boolean(config.url);
  if (hasCommand && hasUrl) {
    errors.push(`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`);
  }
  if (type === "stdio") {
    if (!hasCommand) errors.push(`Server "${name}": stdio server requires "command" field`);
  } else if (type === "http" || type === "sse") {
    if (!hasUrl) errors.push(`Server "${name}": ${type} server requires "url" field`);
  } else {
    errors.push(`Server "${name}": unknown server type "${String(type)}"`);
  }
  return errors;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Expand `${VAR}` and `${VAR:-default}` from the process environment. */
export function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) =>
    extraEnv?.[name] ?? process.env[name] ?? fallback ?? "");
}

export function expandEnvVarsDeep<T>(value: T, extraEnv?: Record<string, string>): T {
  if (typeof value === "string") return expandEnvVars(value, extraEnv) as T;
  if (Array.isArray(value)) return value.map((item) => expandEnvVarsDeep(item, extraEnv)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvVarsDeep(entry, extraEnv)]),
    ) as T;
  }
  return value;
}

export async function readMCPConfigFile(
  filePath: string,
  probe?: PrivateReadProbe,
): Promise<MCPConfigFile> {
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
const mcpLockSleep = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface MCPWriterLockOwner {
  token: string;
  pid: number;
}

function readMCPWriterLock(path: string): MCPWriterLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MCPWriterLockOwner>;
    return typeof parsed.token === "string"
      && typeof parsed.pid === "number"
      && Number.isSafeInteger(parsed.pid)
      ? parsed as MCPWriterLockOwner
      : null;
  } catch {
    return null;
  }
}

function acquireMCPWriterLock(filePath: string): () => void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const owner: MCPWriterLockOwner = { token: randomUUID(), pid: process.pid };
  const deadline = Date.now() + MCP_WRITER_LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(lockPath, 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readMCPWriterLock(lockPath);
      if (current?.pid === process.pid) {
        throw new Error(`${filePath} has a re-entrant MCP writer.`);
      }
      if (Date.now() >= deadline) throw new Error(`${filePath} is locked by another MCP writer; retry.`);
      Atomics.wait(mcpLockSleep, 0, 0, MCP_WRITER_LOCK_POLL_MS);
    }
  }
  return () => {
    const current = readMCPWriterLock(lockPath);
    if (current?.token !== owner.token) throw new Error(`${filePath} MCP writer lock ownership was lost.`);
    unlinkSync(lockPath);
  };
}

export function withMCPConfigWriteLock<T>(filePath: string, operation: () => T): T {
  const release = acquireMCPWriterLock(filePath);
  try {
    return operation();
  } finally {
    release();
  }
}

async function withAsyncMCPConfigWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const release = acquireMCPWriterLock(filePath);
  try {
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
    const existing = await readMCPConfigFile(filePath, options.readProbe);
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
    const existing = await readMCPConfigFile(filePath, options.readProbe);
    if (!Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" not found in ${filePath}`);
    }
    const remaining = { ...existing.mcpServers };
    delete remaining[name];
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: remaining });
  }));
}
