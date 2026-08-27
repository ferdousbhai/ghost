/** In-memory expansion of portable keyring references at connection time. */
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { GhostProviderConfig } from "./models.js";
import { isSecretReference, SECRET_REFERENCE_PREFIX } from "./secret-reference.js";

export interface SecretResolver {
  resolve(reference: string): string;
}

function resolveValue(value: string, resolver: SecretResolver): string {
  if (isSecretReference(value)) return resolver.resolve(value);
  if (value.startsWith(SECRET_REFERENCE_PREFIX)) {
    // Resolve parses again to surface the precise malformed-reference error.
    return resolver.resolve(value);
  }
  return value;
}

export function resolveProviderSecrets(
  config: GhostProviderConfig,
  resolver: SecretResolver,
): GhostProviderConfig {
  const resolved = structuredClone(config);
  if (typeof resolved.apiKey === "string") resolved.apiKey = resolveValue(resolved.apiKey, resolver);
  if (resolved.headers) {
    for (const [name, value] of Object.entries(resolved.headers)) {
      resolved.headers[name] = resolveValue(value, resolver);
    }
  }
  return resolved;
}

export function resolveMcpServerSecrets(
  input: MCPServerConfig,
  resolver: SecretResolver,
): MCPServerConfig {
  const config = structuredClone(input) as MCPServerConfig & Record<string, unknown>;
  const type = config.type ?? "stdio";
  if (type === "stdio") {
    const stdio = config as MCPServerConfig & { args?: string[]; env?: Record<string, string> };
    if (stdio.args) stdio.args = stdio.args.map((value) => resolveValue(value, resolver));
    if (stdio.env) {
      for (const [key, value] of Object.entries(stdio.env)) {
        stdio.env[key] = resolveValue(value, resolver);
      }
    }
  } else {
    const remote = config as MCPServerConfig & { url: string; headers?: Record<string, string> };
    remote.url = resolveValue(remote.url, resolver);
    if (remote.headers) {
      for (const [key, value] of Object.entries(remote.headers)) {
        remote.headers[key] = resolveValue(value, resolver);
      }
    }
  }
  const auth = config.auth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof auth?.clientSecret === "string") {
    auth.clientSecret = resolveValue(auth.clientSecret, resolver);
  }
  const oauth = config.oauth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof oauth?.clientSecret === "string") {
    oauth.clientSecret = resolveValue(oauth.clientSecret, resolver);
  }
  return config;
}
