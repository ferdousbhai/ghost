/**
 * How an MCP server's tools are named for the model.
 *
 * `mcp__<server>_<tool>`, lowercase, at most 64 characters (the strictest
 * provider limit). Two tools of one server that mint the same name collide;
 * the first keeps it. The naming rule matches Oh My Pi's so tool names in
 * existing transcripts still resolve, except that an overlong name's hash
 * suffix is Ghost's own (sha256, hex) and differs from OMP's.
 */
import { createHash } from "node:crypto";

const MAX_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_HASH_LENGTH = 8;

function sanitizePart(value: string, fallback: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

export function createMCPToolName(serverName: string, toolName: string): string {
  const server = sanitizePart(serverName, "server");
  const tool = sanitizePart(toolName, "tool");
  const normalized = tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool;
  const name = `mcp__${server}_${normalized}`;
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, TOOL_NAME_HASH_LENGTH);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

export interface MintedToolNames<T> {
  named: Array<{ tool: T; name: string }>;
  /** Original tool names that lost a collision and were dropped. */
  collisions: string[];
}

export function mintMcpToolNames<T extends { name: string }>(
  serverName: string,
  tools: readonly T[],
): MintedToolNames<T> {
  const seen = new Set<string>();
  const named: Array<{ tool: T; name: string }> = [];
  const collisions: string[] = [];
  for (const tool of tools) {
    const name = createMCPToolName(serverName, tool.name);
    if (seen.has(name)) {
      collisions.push(tool.name);
      continue;
    }
    seen.add(name);
    named.push({ tool, name });
  }
  return { named, collisions };
}
