import { readFileSync } from "node:fs";
import { ArgsError } from "./args.js";
import { ghostPath, resolveGhost } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

type McpRow = { name: string; enabled: boolean };
type McpSnapshot = { servers?: McpRow[]; skipped?: Array<{ path: string; reason: string }> };

function renderSnapshot(body: unknown): string {
  const snapshot = body as McpSnapshot;
  const rows = snapshot.servers ?? [];
  const skipped = snapshot.skipped ?? [];
  const lines = [rows.length > 0
    ? table(rows.map((row) => [row.name, row.enabled ? "on" : "off"]), ["SERVER", "ENABLED"])
    : "No MCP servers configured."];
  for (const skip of skipped) lines.push(`skipped ${skip.path}: ${skip.reason}`);
  return `${lines.join("\n")}\n`;
}

/** `ghost mcp [list|add|set|rm|enable|disable] ...` over the ghost's `mcp.json`. */
export async function mcpCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [action = "list", name, file] = parsed.positionals;
  const ghost = await resolveGhost(ctx);
  const base = ghostPath(ghost, "/mcp");
  const server = (): string => {
    if (!name) throw new ArgsError(`ghost mcp ${action} needs a server name`);
    return `${base}/${encodeURIComponent(name)}`;
  };
  const configFrom = (path: string | undefined): unknown => {
    if (!path) throw new ArgsError(`ghost mcp ${action} needs a JSON config file path`);
    return JSON.parse(readFileSync(path, "utf8"));
  };
  let body: unknown;
  switch (action) {
    case "list":
      body = await ctx.client.request("GET", base);
      break;
    case "add":
      body = await ctx.client.request("POST", base, { name: server() && name, config: configFrom(file) });
      break;
    case "set":
      body = await ctx.client.request("PUT", server(), { config: configFrom(file) });
      break;
    case "rm":
      body = await ctx.client.request("DELETE", server());
      break;
    case "enable":
    case "disable":
      body = await ctx.client.request("PUT", `${server()}/enabled`, { enabled: action === "enable" });
      break;
    default:
      throw new ArgsError(`ghost mcp does not know "${action}"; use list, add, set, rm, enable, or disable.`);
  }
  emit(ctx, body, renderSnapshot);
  return 0;
}
