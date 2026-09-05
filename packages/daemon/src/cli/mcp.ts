import { readFileSync } from "node:fs";
import { ArgsError, flagString, type ParsedCliArgs } from "./args.js";
import { resolveGhost } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

type McpRow = { name: string; enabled: boolean; source: string; connectionStatus?: string };
type McpSnapshot = { servers?: McpRow[]; skipped?: Array<{ path: string; reason: string }> };

function renderSnapshot(body: unknown): string {
  const snapshot = body as McpSnapshot;
  const rows = snapshot.servers ?? [];
  const skipped = snapshot.skipped ?? [];
  const lines = [rows.length > 0
    ? table(rows.map((row) => [row.name, row.enabled ? "on" : "off", row.connectionStatus ?? "", row.source]), ["SERVER", "ENABLED", "CONNECTION", "SOURCE"])
    : "No MCP servers configured."];
  for (const skip of skipped) lines.push(`skipped ${skip.path}: ${skip.reason}`);
  return `${lines.join("\n")}\n`;
}

/** `ghost mcp [list|add|rm|enable|disable|test|reconnect] ...` over the ghost's `mcp.json`. */
export async function mcpCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "list", name, file] = parsed.positionals;
  const { name: ghost } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const base = `/api/ghosts/${encodeURIComponent(ghost)}/mcp`;
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
      body = (await ctx.client.request("GET", base)).body;
      break;
    case "add":
      body = (await ctx.client.request("POST", base, { name: server() && name, config: configFrom(file) })).body;
      break;
    case "set":
      body = (await ctx.client.request("PUT", server(), { config: configFrom(file) })).body;
      break;
    case "rm":
      body = (await ctx.client.request("DELETE", server())).body;
      break;
    case "enable":
    case "disable":
      body = (await ctx.client.request("PUT", `${server()}/enabled`, { enabled: action === "enable" })).body;
      break;
    case "test":
    case "reconnect":
      body = (await ctx.client.request("POST", `${server()}/${action}`)).body;
      break;
    default:
      throw new ArgsError(`ghost mcp does not know "${action}"; use list, add, set, rm, enable, disable, test, or reconnect.`);
  }
  emit(ctx, body, (result) => action === "test"
    ? `${(result as { name: string; status: string; message: string }).name}: ${(result as { status: string }).status} — ${(result as { message: string }).message}\n`
    : renderSnapshot(result));
  return 0;
}
