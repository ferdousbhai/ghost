/** Pure MCP row policy; hosts supply environment and storage. */
import { isRecord } from "./record.js";
interface MCPServerConfigBase {
  enabled?: boolean;
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
  /** Pass `headers` values verbatim, without `${VAR}` expansion. */
  headerPolicy?: "origin-locked";
}

export interface MCPSseServerConfig extends MCPServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  headerPolicy?: "origin-locked";
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

/**
 * Expand `${VAR}` throughout a row, except the `env` (stdio, `envPolicy:
 * "literal"`) or `headers` (remote, `headerPolicy: "origin-locked"`) map its
 * policy keeps verbatim.
 */
export function expandMcpServerConfig(config: MCPServerConfig, environment: Readonly<Record<string, string | undefined>>): MCPServerConfig {
  const literal = (config.type ?? "stdio") === "stdio"
    ? ((config as MCPStdioServerConfig).envPolicy === "literal" ? "env" : null)
    : ((config as MCPHttpServerConfig | MCPSseServerConfig).headerPolicy === "origin-locked" ? "headers" : null);
  if (literal === null) return expandEnvVarsDeep(config, environment);
  const { [literal]: kept, ...ordinary } = config as unknown as Record<string, unknown>;
  return { ...expandEnvVarsDeep(ordinary, environment), ...(kept === undefined ? {} : { [literal]: kept }) } as unknown as MCPServerConfig;
}

function validateServerName(name: string): string | undefined {
  if (!name) return "Server name cannot be empty";
  if (name.length > 100) return "Server name is too long (max 100 characters)";
  if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
    return "Server name can only contain letters, numbers, dash, underscore, dot, and colon";
  }
  return undefined;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Expand `${VAR}` and `${VAR:-default}` from `environment`. */
function expandEnvVars(value: string, environment: Readonly<Record<string, string | undefined>>): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) =>
    environment[name] ?? fallback ?? "");
}

function expandEnvVarsDeep<T>(value: T, environment: Readonly<Record<string, string | undefined>>): T {
  if (typeof value === "string") return expandEnvVars(value, environment) as T;
  if (Array.isArray(value)) return value.map((item) => expandEnvVarsDeep(item, environment)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvVarsDeep(entry, environment)]),
    ) as T;
  }
  return value;
}



const MCP_BASE_FIELDS = new Set(["enabled"]);
const MCP_STDIO_FIELDS = new Set([
  ...MCP_BASE_FIELDS,
  "type",
  "command",
  "args",
  "env",
  "envPolicy",
  "cwd",
]);
const MCP_REMOTE_FIELDS = new Set([
  ...MCP_BASE_FIELDS,
  "type",
  "url",
  "headers",
  "headerPolicy",
]);

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** Validate a row against the fields some harness dialect can carry. */
function ownedMcpValidationErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["MCP server configuration must be a JSON object."];
  const type = value.type === undefined ? "stdio" : value.type;
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    return ['MCP server "type" must be "stdio", "http", or "sse".'];
  }
  const allowed = type === "stdio" ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;
  if (!hasOnlyFields(value, allowed)) {
    return ["MCP server configuration contains unsupported fields."];
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return ['MCP server "enabled" must be a boolean.'];
  }
  if (type === "stdio") {
    if (typeof value.command !== "string" || value.command.length === 0) {
      return ['MCP stdio "command" must be a non-empty string.'];
    }
    if (value.args !== undefined
      && (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
      return ['MCP stdio "args" must be an array of strings.'];
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return ['MCP stdio "env" must contain only string values.'];
    }
    if (value.envPolicy !== undefined && value.envPolicy !== "literal") {
      return ['MCP stdio "envPolicy" must be "literal".'];
    }
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) {
      return ['MCP stdio "cwd" must be a non-empty string.'];
    }
  } else {
    if (typeof value.url !== "string" || value.url.length === 0) {
      return ['MCP remote "url" must be a non-empty string.'];
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return ['MCP remote "headers" must contain only string values.'];
    }
    if (value.headerPolicy !== undefined && value.headerPolicy !== "origin-locked") {
      return ['MCP remote "headerPolicy" must be "origin-locked".'];
    }
  }
  return [];
}

export function mcpServerValidationErrors(name: string, value: unknown): string[] {
  const nameError = validateServerName(name);
  if (nameError) return [nameError];
  return ownedMcpValidationErrors(value);
}
