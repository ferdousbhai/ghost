import { readFileSync } from "node:fs";
import { ArgsError, flagBoolean, flagString } from "./args.js";
import { readArgumentFile, stdinText, ghostPath, preferredSessionId, resolveGhost, resolveSession, resolveTarget, sessionPath } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";
import type { Routine } from "../schedules.js";
import type { RemoteStatus } from "../remote-serve.js";
import type { Board } from "../board.js";
import { acceptedEventLine } from "../external-events.js";
import type { HarnessChoices } from "../session-host.js";


/** `ghost rename <new-name>`: move the whole ghost home under the new spelling. */
export async function renameCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const next = parsed.positionals[0];
  if (!next) throw new ArgsError("ghost rename needs the new name");
  const name = await resolveGhost(ctx);
  const body = await ctx.client.request("PUT", ghostPath(name, "/name"), { name: next });
  emit(ctx, body, () => `Renamed ${name} to ${next}.\n`);
  return 0;
}

/** `ghost character [set <file>]`: print or replace `character.md` through the daemon's validating writer. */
export async function characterCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [action = "show", file] = parsed.positionals;
  if (action === "show") {
    const body = await ctx.client.request<{ body: string }>("GET", ghostPath(await resolveGhost(ctx), "/character"));
    emit(ctx, body, (result) => result.body);
    return 0;
  }
  if (action !== "set" || !file) throw new ArgsError("ghost character takes `show` or `set <file>`");
  const text = readArgumentFile(file);
  const name = await resolveGhost(ctx);
  const body = await ctx.client.request("PUT", ghostPath(name, "/character"), { body: text });
  emit(ctx, body, () => `Character replaced for ${name}.\n`);
  return 0;
}


/** `ghost read -s <id>`: mark a conversation read, as opening it in the HUD does. */
export async function readCommand(ctx: CliContext): Promise<number> {
  const { path, session } = await resolveTarget(ctx);
  const body = await ctx.client.request("PUT", `${path}/read`, {});
  emit(ctx, body, () => `Marked ${session.id} read.\n`);
  return 0;
}

/** `ghost board`: the owner's board, read through the daemon. */
export async function boardCommand(ctx: CliContext): Promise<number> {
  const body = await ctx.client.request("GET", "/api/board");
  emit(ctx, body, (result) => {
    const board = result as Board;
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

export async function remoteCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [action = "status"] = parsed.positionals;
  let body: unknown;
  if (action === "status") body = await ctx.client.request("GET", "/api/remote");
  else if (action === "on" || action === "off") {
    body = await ctx.client.request("POST", "/api/remote", { enabled: action === "on" });
  } else throw new ArgsError(`ghost remote does not know "${action}"; use status, on, or off.`);
  emit(ctx, body, (result) => {
    const status = result as Pick<RemoteStatus, "enabled" | "url" | "problem">;
    return `${status.enabled ? "on" : "off"}${status.url ? ` ${status.url}` : ""}${status.problem ? ` (${status.problem.message})` : ""}\n`;
  });
  return 0;
}

type HarnessChoicesBody = Pick<HarnessChoices, "ghostDefault" | "omarchyDefault"> & Partial<Pick<HarnessChoices, "harnesses">>;

/**
 * The preference, and any agent a recent failure keeps at the back;
 * `ghost harnesses` lists installed agents and usage.
 */
function harnessChoicesText(name: string, body: HarnessChoicesBody): string {
  const preferred = body.ghostDefault
    ?? (body.omarchyDefault ? `automatic (Omarchy default: ${body.omarchyDefault})` : "automatic");
  const resting = (body.harnesses ?? []).flatMap((harness) => harness.resting
    ? [`${harness.id} is tried last until ${new Date(harness.resting.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${harness.resting.reason}\n`]
    : []);
  return `${name} runs on ${preferred}\n${resting.join("")}`;
}

/** `ghost harness [<id>|--none]`: show or set the agent a ghost prefers. */
export async function harnessCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const id = parsed.positionals[0];
  if (id && flagBoolean(parsed, "none")) throw new ArgsError("ghost harness takes an agent or --none, not both");
  const name = await resolveGhost(ctx);
  const body = id || flagBoolean(parsed, "none")
    ? await ctx.client.request("PUT", ghostPath(name, "/harness"), { harness: id ?? null })
    : await ctx.client.request("GET", ghostPath(name, "/harness"));
  emit(ctx, body, (result) => harnessChoicesText(name, result as HarnessChoicesBody));
  return 0;
}

/** `ghost switch <id>`: run this conversation's next turn on another agent. */
export async function switchCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const id = parsed.positionals[0];
  if (!id) throw new ArgsError("ghost switch needs the agent to switch to");
  const name = await resolveGhost(ctx);
  // A conversation not listed yet (no message landed) is addressed as given.
  const requested = preferredSessionId(ctx);
  const path = requested
    ? sessionPath(name, requested)
    : sessionPath(name, (await resolveSession(ctx.client, name, undefined)).id);
  const body = await ctx.client.request<{ id: string; harness: string }>("PUT", `${path}/harness`, { harness: id });
  emit(ctx, body, () => `Conversation ${body.id} now runs on ${body.harness}.\n`);
  return 0;
}

export async function eventCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [source, id, input] = parsed.positionals;
  const instructions = flagString(parsed, "instructions");
  if (!source || !id || !instructions) throw new ArgsError("ghost event needs source, id, and --instructions");
  const payload = input && input !== "-" ? input : await stdinText(ctx.runtime.stdin);
  const ghost = await resolveGhost(ctx);
  const result = await ctx.client.request<{ sessionId: string; duplicate: boolean }>("POST", ghostPath(ghost, "/events"), { source, id, instructions, payload });
  emit(ctx, result, () => `${acceptedEventLine(ghost, result.sessionId, result.duplicate)}\n`);
  return 0;
}

export async function routinesCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const request = <T = unknown>(method: string, path: string, body?: unknown) => ctx.client.request<T>(method, path, body, 120000);
  const [action = "list", slug, file] = parsed.positionals;
  const noArg = ["list", "recoveries"].includes(action), oneArg = ["pause", "resume", "run", "config", "logs", "remove", "restore"].includes(action);
  if ((noArg && slug) || (oneArg && (!slug || file)) || (action === "edit" && (!slug || !file)) || (!noArg && !oneArg && action !== "edit")) {
    throw new ArgsError("ghost routines takes list, pause/resume/run/config/logs/remove <slug>, edit <slug> <file>, recoveries, or restore <id>");
  }
  let config: unknown;
  if (action === "edit") {
    try { config = JSON.parse(file === "-" ? await stdinText(ctx.runtime.stdin) : readFileSync(file as string, "utf8")); }
    catch { throw new ArgsError("Edit expects the JSON from ghost routines config, with timer, service, and revision."); }
  }
  const ghost = await resolveGhost(ctx);
  const path = ghostPath(ghost, "/routines"), target = `${path}/${encodeURIComponent(slug ?? "")}`;
  if (action === "list") {
    const body = await request<{ routines: Routine[] }>("GET", path);
    emit(ctx, body, () => body.routines.length ? body.routines.map((r) =>
      `${r.ghost}/${r.slug} · ${r.enabled || "unknown"} · ${r.active || "unknown"}\n  ${r.schedule || "Schedule unavailable"}\n  Next: ${r.nextRun ?? "unknown"} · Last: ${r.lastRun ?? "never/unknown"}\n  Service: ${r.serviceActive || "unknown"} · Result: ${r.result || "unknown"}\n  ${r.command}\n  ${r.timerPath}\n  ${r.servicePath}\n  Logs: journalctl --user -u ${r.service}\n`).join("\n") : "No routines. See ghost help timers.\n");
  } else if (action === "logs") {
    const result = await request<{ text: string; truncated: boolean; sessions: string[] }>("GET", `${target}/logs`);
    emit(ctx, result, () => `${result.truncated ? "(older log text truncated)\n" : ""}${result.text}\n${result.sessions.map(id => `Conversation: ghost show -g ${ghost} -s ${id}`).join("\n")}\n`);
  } else if (action === "config") {
    const result = await request("GET", `${target}/config`);
    emit(ctx, result, () => `${JSON.stringify(result, null, 2)}\n`);
  } else if (action === "recoveries") {
    const { recoveries } = await request<{ recoveries: Array<{ id: string; slug: string; reason: string; createdAt: string; applicable: boolean }> }>("GET", path), result = { recoveries };
    emit(ctx, result, () => result.recoveries.map(r => `${r.id} ${r.slug} ${r.reason} ${r.createdAt} ${r.applicable ? "restorable" : "source changed"}`).join("\n") + "\n");
  } else {
    let result: unknown;
    if (action === "edit") {
      result = await request("PUT", `${target}/config`, config);
    } else if (action === "remove") {
      const config = await request<{ revision: string }>("GET", `${target}/config`);
      result = await request("DELETE", `${target}?revision=${encodeURIComponent(config.revision)}`);
    } else {
      result = await request("POST", action === "restore" ? `${path}/recoveries/${encodeURIComponent(slug as string)}/restore` : `${target}/${action}`, {});
    }
    emit(ctx, result, () => `${ghost}/${slug}: ${action} accepted.${(result as { recovery?: string }).recovery ? ` Recovery: ${(result as { recovery: string }).recovery}` : ""}\n`);
  }
  return 0;
}
