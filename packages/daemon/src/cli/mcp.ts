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
  const [action = "list", name = "", file = ""] = parsed.positionals;
  if (!["list", "add", "set", "rm", "enable", "disable"].includes(action)) {
    throw new ArgsError(`ghost mcp does not know "${action}"; use list, add, set, rm, enable, or disable.`);
  }
  if (action !== "list" && !name) throw new ArgsError(`ghost mcp ${action} needs a server name`);
  if ((action === "add" || action === "set") && !file) throw new ArgsError(`ghost mcp ${action} needs a JSON config file path`);
  const base = ghostPath(await resolveGhost(ctx), "/mcp");
  const server = `${base}/${encodeURIComponent(name)}`;
  const config = (): unknown => JSON.parse(readFileSync(file, "utf8"));
  let body: unknown;
  if (action === "list") body = await ctx.client.request("GET", base);
  else if (action === "add") body = await ctx.client.request("POST", base, { name, config: config() });
  else if (action === "set") body = await ctx.client.request("PUT", server, { config: config() });
  else if (action === "rm") body = await ctx.client.request("DELETE", server);
  else body = await ctx.client.request("PUT", `${server}/enabled`, { enabled: action === "enable" });
  emit(ctx, body, renderSnapshot);
  return 0;
}
