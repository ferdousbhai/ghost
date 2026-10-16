import { expandEnvVarsDeep, type MCPHttpServerConfig, type MCPServerConfig, type MCPSseServerConfig, type MCPStdioServerConfig } from "./mcp-config-policy.js";
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
