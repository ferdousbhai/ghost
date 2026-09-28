import { expandEnvVarsDeep, isRecord, type MCPAuthConfig, type MCPHttpServerConfig, type MCPRequestIdFormat, type MCPServerConfig, type MCPSseServerConfig, type MCPStdioServerConfig } from "./mcp-config-policy.js";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpConfiguredKeysView {
  keys: string[];
  configured: true;
}

export interface McpAuthView {
  type: MCPAuthConfig["type"];
  configured: boolean;
}

export interface McpOAuthView {
  configured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
}

interface McpServerConfigViewBase {
  type: McpTransport;
  timeout?: number;
  requestIdFormat?: MCPRequestIdFormat;
  auth?: McpAuthView;
  oauth?: McpOAuthView;
}

export interface McpStdioServerConfigView extends McpServerConfigViewBase {
  type: "stdio";
  command: string;
  cwd?: string;
  envPolicy?: "literal";
  argumentCount: number;
  environment?: McpConfiguredKeysView;
}

export interface McpRemoteServerConfigView extends McpServerConfigViewBase {
  type: "http" | "sse";
  /** Userinfo/fragments are removed; query values are marked; malformed URLs fail closed. */
  url: string;
  headerPolicy?: "origin-locked";
  headers?: McpConfiguredKeysView;
}

export type McpServerConfigView = McpStdioServerConfigView | McpRemoteServerConfigView;

/**
 * Apply ordinary environment interpolation without pre-expanding maps whose
 * transport policy makes their values opaque; the manager receives those
 * literal protected values.
 */
export function expandMcpServerConfig(config: MCPServerConfig, environment: Readonly<Record<string, string | undefined>>): MCPServerConfig {
  const type = config.type ?? "stdio";
  const stdio = config as MCPStdioServerConfig;
  if (type === "stdio" && stdio.envPolicy === "literal") {
    const { env, ...ordinary } = stdio;
    return {
      ...expandEnvVarsDeep(ordinary, environment),
      ...(env === undefined ? {} : { env: Object.fromEntries(Object.entries(env)) }),
    } as MCPServerConfig;
  }
  const remote = config as MCPHttpServerConfig | MCPSseServerConfig;
  if ((type === "http" || type === "sse")
    && remote.headerPolicy === "origin-locked") {
    const { headers, ...ordinary } = remote;
    return {
      ...expandEnvVarsDeep(ordinary, environment),
      ...(headers === undefined
        ? {}
        : { headers: Object.fromEntries(Object.entries(headers)) }),
    } as MCPServerConfig;
  }
  return expandEnvVarsDeep(config, environment);
}

function configuredKeys(value: unknown): McpConfiguredKeysView | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return keys.length > 0 ? { keys, configured: true } : undefined;
}

function sanitizeRemoteUrl(value: string): string {
  const lower = value.toLowerCase();
  if (value.includes("${")
    || (!lower.startsWith("http://") && !lower.startsWith("https://"))) {
    return "[configured]";
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return "[configured]";
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.delete(key);
      url.searchParams.append(key, "[configured]");
    }
    return url.toString();
  } catch {
    // A templated URL may not parse until it is expanded. The opaque input can
    // carry credentials anywhere, so no part of it is safe to return.
    return "[configured]";
  }
}

function sanitizeAuth(auth: MCPServerConfig["auth"]): McpAuthView | undefined {
  if (!auth) return undefined;
  return { type: auth.type, configured: Boolean(auth.credentialId) };
}

function sanitizeOAuth(oauth: MCPServerConfig["oauth"]): McpOAuthView | undefined {
  if (!oauth) return undefined;
  return {
    configured: Object.keys(oauth).length > 0,
    clientIdConfigured: Boolean(oauth.clientId),
    clientSecretConfigured: Boolean(oauth.clientSecret),
  };
}

export function sanitizeMcpServerConfig(config: MCPServerConfig): McpServerConfigView {
  const type = config.type ?? "stdio";
  const auth = sanitizeAuth(config.auth);
  const oauth = sanitizeOAuth(config.oauth);
  const shared = {
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
    ...(config.requestIdFormat === "string" || config.requestIdFormat === "number"
      ? { requestIdFormat: config.requestIdFormat }
      : {}),
    ...(auth ? { auth } : {}),
    ...(oauth ? { oauth } : {}),
  };
  if (type === "http" || type === "sse") {
    const remote = config as MCPHttpServerConfig | MCPSseServerConfig;
    const headers = configuredKeys(remote.headers);
    return {
      ...shared,
      type,
      url: sanitizeRemoteUrl(remote.url),
      ...(remote.headerPolicy === "origin-locked"
        ? { headerPolicy: remote.headerPolicy }
        : {}),
      ...(headers ? { headers } : {}),
    };
  }
  const stdio = config as MCPStdioServerConfig;
  const environment = configuredKeys(stdio.env);
  return {
    ...shared,
    type: "stdio",
    command: stdio.command,
    ...(typeof stdio.cwd === "string" ? { cwd: stdio.cwd } : {}),
    ...(stdio.envPolicy === "literal" ? { envPolicy: stdio.envPolicy } : {}),
    argumentCount: Array.isArray(stdio.args) ? stdio.args.length : 0,
    ...(environment ? { environment } : {}),
  };
}

