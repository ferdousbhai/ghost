/**
 * MCP server configuration as Ghost stores it: the `mcp.json` row shape, its
 * validation, `${VAR}` expansion, and the locked read-modify-write of the
 * file. The shape is the one Oh My Pi established (MIT, can1357/oh-my-pi
 * `src/mcp/{types,config,config-writer}.ts`), kept so existing homes keep
 * loading; the implementation is Ghost's.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writePrivateJsonAtomic } from "./private-file.js";
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

export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as MCPConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw error;
  }
}

export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(filePath, config);
}

const fileLocks = new Map<string, Promise<unknown>>();

async function putServer(filePath: string, name: string, config: MCPServerConfig, mustBeNew: boolean): Promise<void> {
  const nameError = validateServerName(name);
  if (nameError) throw new Error(nameError);
  const errors = validateServerConfig(name, config);
  if (errors.length > 0) throw new Error(`Invalid server config: ${errors.join("; ")}`);
  return serializeByKey(fileLocks, filePath, async () => {
    const existing = await readMCPConfigFile(filePath);
    if (mustBeNew && Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" already exists in ${filePath}`);
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
    const existing = await readMCPConfigFile(filePath);
    if (!Object.hasOwn(existing.mcpServers ?? {}, name)) {
      throw new Error(`Server "${name}" not found in ${filePath}`);
    }
    const remaining = { ...existing.mcpServers };
    delete remaining[name];
    await writeMCPConfigFile(filePath, { ...existing, mcpServers: remaining });
  });
}
