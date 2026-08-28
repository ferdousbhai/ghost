import type { MCPServerConfig } from "./mcp-config.js";
import type { GhostProviderConfig } from "./models.js";
import { visitMcpSecretFields, visitProviderSecretFields } from "./secret-migration.js";
import { SECRET_REFERENCE_PREFIX } from "./secret-reference.js";

export interface SecretResolver {
  resolve(reference: string): string;
}

function resolveValue(value: string, resolver: SecretResolver): string {
  // A malformed reference is resolved too, so the resolver reports why instead
  // of the value reaching a provider or MCP server as a literal.
  return value.startsWith(SECRET_REFERENCE_PREFIX) ? resolver.resolve(value) : value;
}

export function resolveProviderSecrets(
  config: GhostProviderConfig,
  resolver: SecretResolver,
): GhostProviderConfig {
  const resolved = structuredClone(config);
  visitProviderSecretFields(resolved, (value) => resolveValue(value, resolver));
  return resolved;
}

export function resolveMcpServerSecrets(
  input: MCPServerConfig,
  resolver: SecretResolver,
): MCPServerConfig {
  const config = structuredClone(input) as MCPServerConfig & Record<string, unknown>;
  visitMcpSecretFields(config, (value) => resolveValue(value, resolver));
  return config;
}
