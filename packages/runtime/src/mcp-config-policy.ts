/** Pure MCP row policy; hosts supply environment and storage. */
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
export function expandEnvVars(value: string, environment: Readonly<Record<string, string | undefined>>): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) =>
    environment[name] ?? fallback ?? "");
}

export function expandEnvVarsDeep<T>(value: T, environment: Readonly<Record<string, string | undefined>>): T {
  if (typeof value === "string") return expandEnvVars(value, environment) as T;
  if (Array.isArray(value)) return value.map((item) => expandEnvVarsDeep(item, environment)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvVarsDeep(entry, environment)]),
    ) as T;
  }
  return value;
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MCP_BASE_FIELDS = new Set([
  "enabled",
  "timeout",
  "requestIdFormat",
  "auth",
  "oauth",
]);
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
const MCP_AUTH_FIELDS = new Set([
  "type",
  "credentialId",
  "tokenUrl",
  "clientId",
  "clientSecret",
  "resource",
]);
const MCP_OAUTH_FIELDS = new Set([
  "clientId",
  "clientSecret",
  "redirectUri",
  "callbackPort",
  "callbackPath",
  "prompt",
]);

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Validate Ghost's owned MCP boundary before the MCP manager or an HTTP sanitizer sees a
 * value.
 */
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
  if (value.timeout !== undefined
    && (typeof value.timeout !== "number"
      || !Number.isFinite(value.timeout)
      || value.timeout < 0)) {
    return ['MCP server "timeout" must be a finite non-negative number.'];
  }
  if (value.requestIdFormat !== undefined
    && value.requestIdFormat !== "string"
    && value.requestIdFormat !== "number") {
    return ['MCP server "requestIdFormat" must be "string" or "number".'];
  }
  if (value.auth !== undefined) {
    if (!isRecord(value.auth)
      || !hasOnlyFields(value.auth, MCP_AUTH_FIELDS)
      || (value.auth.type !== "oauth" && value.auth.type !== "apikey")
      || Object.entries(value.auth).some(([key, entry]) =>
        key !== "type" && typeof entry !== "string")) {
      return ["MCP server auth configuration is invalid."];
    }
  }
  if (value.oauth !== undefined) {
    if (!isRecord(value.oauth) || !hasOnlyFields(value.oauth, MCP_OAUTH_FIELDS)) {
      return ["MCP server OAuth configuration is invalid."];
    }
    for (const [key, entry] of Object.entries(value.oauth)) {
      if (key === "callbackPort") {
        if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1 || entry > 65_535) {
          return ["MCP server OAuth callbackPort is invalid."];
        }
      } else if (typeof entry !== "string") {
        return ["MCP server OAuth configuration is invalid."];
      }
    }
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
  const ownedErrors = ownedMcpValidationErrors(value);
  if (ownedErrors.length > 0) return ownedErrors;
  return validateServerConfig(name, value as unknown as MCPServerConfig);
}
