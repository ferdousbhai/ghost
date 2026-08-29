/**
 * The single definition of "a valid Ghost-owned MCP server row".
 *
 * Both the visible MCP catalogue and the keyring migration have to agree on
 * this, and for opposite reasons: the catalogue rejects an invalid row so a
 * malformed value never reaches the MCP manager or an HTTP sanitizer, while migration must
 * recognise exactly the same rows in order to leave everything else untouched.
 * Two independent copies of the rule would eventually disagree, and the
 * disagreement would show up as migration refusing a server the catalogue is
 * perfectly willing to describe.
 *
 * Messages name fields but never interpolate their values.
 */
import { validateServerConfig, validateServerName, type MCPServerConfig } from "./mcp-config.js";

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
