import { readFileSync } from "node:fs";
import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { resolveGhost, resolveTarget } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

const ghostPath = (name: string, suffix = ""): string => `/api/ghosts/${encodeURIComponent(name)}${suffix}`;

/** `ghost rename <new-name>`: move the whole ghost home under the new spelling. */
export async function renameCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const next = parsed.positionals[0];
  if (!next) throw new ArgsError("ghost rename needs the new name");
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const body = (await ctx.client.request("PUT", ghostPath(name, "/name"), { name: next })).body;
  emit(ctx, body, () => `Renamed ${name} to ${next}.\n`);
  return 0;
}

/** `ghost character [set <file>]`: print or replace `character.md` through the daemon's validating writer. */
export async function characterCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "show", file] = parsed.positionals;
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  if (action === "show") {
    const body = (await ctx.client.request<{ body: string }>("GET", ghostPath(name, "/character"))).body;
    emit(ctx, body, (result) => (result as { body: string }).body);
    return 0;
  }
  if (action !== "set" || !file) throw new ArgsError("ghost character takes `show` or `set <file>`");
  const body = (await ctx.client.request("PUT", ghostPath(name, "/character"), { body: readFileSync(file, "utf8") })).body;
  emit(ctx, body, () => `Character replaced for ${name}.\n`);
  return 0;
}

/** `ghost greeting`: the smol model's opening line, as the HUD asks for it. */
export async function greetingCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const body = (await ctx.client.request("POST", ghostPath(name, "/greeting"), {})).body;
  emit(ctx, body, (result) => `${(result as { greeting: string | null }).greeting ?? "(no greeting)"}\n`);
  return 0;
}

/** `ghost delete --yes -s <id>`: move one conversation and its sidecars to Trash. */
export async function deleteSessionCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  if (!flagBoolean(parsed, "yes")) throw new ArgsError("ghost delete moves a conversation to Trash; pass --yes");
  const { path, session } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request("DELETE", path)).body;
  emit(ctx, body, () => `Moved ${session.id} to Trash.\n`);
  return 0;
}

/** `ghost read -s <id>`: mark a conversation read, as opening it in the HUD does. */
export async function readCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { path, session } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request("PUT", `${path}/read`, {})).body;
  emit(ctx, body, () => `Marked ${session.id} read.\n`);
  return 0;
}

/** `ghost reanswer <entryId> -s <id>`: reopen a historical ask and resume that branch. */
export async function reanswerCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const entryId = parsed.positionals[0];
  if (!entryId) throw new ArgsError("ghost reanswer needs the ask entry id");
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request("POST", `${path}/reanswer`, { entryId })).body;
  emit(ctx, body);
  return 0;
}

/** `ghost resources -s <id>`: the session's admitted skill and MCP snapshot. */
export async function resourcesCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request("GET", `${path}/resources`)).body;
  emit(ctx, body, (result) => {
    const view = result as { skills?: Array<{ name: string; source: string; status: string }>; mcpServers?: Array<{ name: string; status: string }> };
    const lines = [
      table((view.skills ?? []).map((skill) => [skill.name, skill.source, skill.status]), ["SKILL", "SOURCE", "STATUS"]),
      table((view.mcpServers ?? []).map((server) => [server.name, server.status]), ["MCP", "STATUS"]),
    ];
    return `${lines.join("\n\n")}\n`;
  });
  return 0;
}

/** `ghost commands -s <id>`: the pi slash commands this conversation accepts. */
export async function commandsCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request("GET", `${path}/commands`)).body;
  emit(ctx, body, (result) => {
    const rows = (result as { commands?: Array<{ name: string; description?: string }> }).commands ?? [];
    return rows.length > 0
      ? `${table(rows.map((row) => [`/${row.name}`, row.description ?? ""]), ["COMMAND", "DESCRIPTION"])}\n`
      : "No slash commands.\n";
  });
  return 0;
}

/** `ghost remote [status|on|off]`: the Tailscale Serve viewer. */
export async function remoteCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "status"] = parsed.positionals;
  let body: unknown;
  if (action === "status") body = (await ctx.client.request("GET", "/api/remote")).body;
  else if (action === "on" || action === "off") {
    body = (await ctx.client.request("POST", "/api/remote", { enabled: action === "on" })).body;
  } else throw new ArgsError(`ghost remote does not know "${action}"; use status, on, or off.`);
  emit(ctx, body, (result) => {
    const status = result as { enabled: boolean; url?: string | null; problem?: string | null };
    return `${status.enabled ? "on" : "off"}${status.url ? ` ${status.url}` : ""}${status.problem ? ` (${status.problem})` : ""}\n`;
  });
  return 0;
}
