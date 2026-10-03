import { readFileSync } from "node:fs";
import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { preferredSessionId, resolveGhost, resolveTarget, sessionPath } from "./common.js";
import { emit } from "./output.js";
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




/** `ghost remote [status|on|off]`: the Tailscale Serve viewer. */
export async function boardCommand(_parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const body = (await ctx.client.request("GET", "/api/board")).body;
  emit(ctx, body, (result) => {
    const board = result as {
      path: string;
      exists: boolean;
      title: string | null;
      columns: Array<{ title: string; cards: Array<{ text: string; done?: boolean; notes: string[] }> }>;
      truncated: boolean;
    };
    if (!board.exists) return `no board yet: create ${board.path} with ## columns and - cards\n`;
    const lines: string[] = [];
    if (board.title) lines.push(board.title);
    for (const column of board.columns) {
      lines.push(`## ${column.title} (${column.cards.length})`);
      for (const card of column.cards) {
        const box = card.done === undefined ? "" : card.done ? "[x] " : "[ ] ";
        lines.push(`  ${box}${card.text}`);
        for (const note of card.notes) lines.push(`      ${note}`);
      }
    }
    if (board.truncated) lines.push("(board truncated)");
    return `${lines.join("\n")}\n`;
  });
  return 0;
}

export async function browserCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "status", code] = parsed.positionals;
  let body: unknown;
  if (action === "status") body = (await ctx.client.request("GET", "/api/relay/status")).body;
  else if (action === "allow" || action === "deny") {
    if (!code) throw new ArgsError(`ghost browser ${action} needs the code the extension shows.`);
    body = (await ctx.client.request("POST", "/api/relay/pair", {
      code: code.replace(/\s+/g, ""),
      allow: action === "allow",
    })).body;
  } else throw new ArgsError(`ghost browser does not know "${action}"; use status, allow, or deny.`);
  emit(ctx, body, (result) => {
    const status = result as {
      enabled?: boolean;
      connected?: boolean;
      peer?: string | null;
      pairing?: { code: string } | null;
      outcome?: string;
    };
    if (status.outcome) return `${status.outcome}\n`;
    if (status.enabled === false) return "off\n";
    if (status.connected) return `connected${status.peer ? ` ${status.peer}` : ""}\n`;
    if (status.pairing) return `pairing requested: code ${status.pairing.code} (ghost browser allow ${status.pairing.code})\n`;
    return "not connected\n";
  });
  return 0;
}

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

interface HarnessChoicesBody {
  harnesses: Array<{ id: string; eligible: boolean; reason: string | null }>;
  ghostDefault: string | null;
  omarchyDefault: string | null;
}

function harnessChoicesText(name: string, body: HarnessChoicesBody): string {
  const preferred = body.ghostDefault
    ?? (body.omarchyDefault ? `automatic (Omarchy default: ${body.omarchyDefault})` : "automatic");
  const rows = body.harnesses.map((harness) =>
    `  ${harness.id}${harness.eligible ? "" : ` (no room: ${harness.reason})`}`);
  return `${name} runs on ${preferred}\n${rows.join("\n")}\n`;
}

/** `ghost harness [<id>|--none]`: show or set the agent a ghost prefers. */
export async function harnessCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const id = parsed.positionals[0];
  if (id && flagBoolean(parsed, "none")) throw new ArgsError("ghost harness takes an agent or --none, not both");
  const body = id || flagBoolean(parsed, "none")
    ? (await ctx.client.request("PUT", ghostPath(name, "/harness"), { harness: id ?? null })).body
    : (await ctx.client.request("GET", ghostPath(name, "/harness"))).body;
  emit(ctx, body, (result) => harnessChoicesText(name, result as HarnessChoicesBody));
  return 0;
}

/** `ghost switch <id>`: run this conversation's next turn on another agent. */
export async function switchCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const id = parsed.positionals[0];
  if (!id) throw new ArgsError("ghost switch needs the agent to switch to");
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  // A conversation not listed yet (no message landed) is addressed as given.
  const requested = preferredSessionId(ctx.runtime, flagString(parsed, "session"));
  const path = requested
    ? sessionPath(name, requested)
    : (await resolveTarget(ctx.client, ctx, parsed)).path;
  const body = (await ctx.client.request("PUT", `${path}/harness`, { harness: id })).body as { id: string; harness: string };
  emit(ctx, body, () => `Conversation ${body.id} now runs on ${body.harness}.\n`);
  return 0;
}
