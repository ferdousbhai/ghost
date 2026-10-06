import type { Transcript } from "../session-host.js";
import { flagString, type ParsedCliArgs } from "./args.js";
import { listSessions, resolveGhost, resolveTarget } from "./common.js";
import { emit, relativeTime, table, truncate } from "./output.js";
import type { CliContext } from "./types.js";

export async function sessionsCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const name = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const sessions = await listSessions(ctx.client, name);
  emit(ctx, { sessions }, () => {
    const rows = sessions.map((session) => [
      session.id,
      truncate(session.title ?? session.preview ?? "—", 42),
      relativeTime(session.updatedAt),
      String(session.messageCount),
      [session.running ? "running" : "", session.unread ? "unread" : "", session.pinned ? "pinned" : ""].filter(Boolean).join(","),
    ]);
    return {
      human: rows.length > 0 ? `${table(rows, ["ID", "TITLE", "UPDATED", "MESSAGES", "STATE"])}\n` : "",
      quiet: sessions.map((session) => session.id).join("\n") + (sessions.length ? "\n" : ""),
    };
  });
  return 0;
}

function transcriptMarkdown(body: Transcript, ghost: string): string {
  return body.messages.map((message) => {
    const heading = message.role === "user" ? "you"
      : message.role === "hook" ? "Stop hook"
      : ghost;
    const lines = message.content.map((part) => part.type === "toolCall"
      ? `> ⚙ ${part.name}(${truncate(JSON.stringify(part.arguments ?? {}), 120)})`
      : part.text).filter(Boolean);
    return `**${heading}:**\n\n${lines.join("\n")}`;
  }).join("\n\n");
}

export async function showCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const { name, path } = await resolveTarget(ctx.client, ctx, parsed);
  const query = new URLSearchParams();
  const limit = flagString(parsed, "limit");
  const offset = flagString(parsed, "offset");
  if (limit) query.set("limit", limit);
  if (offset) query.set("offset", offset);
  const suffix = query.size ? `?${query}` : "";
  const response = await ctx.client.request<Transcript>("GET", `${path}/transcript${suffix}`);
  emit(ctx, response.body, (body) => {
    const markdown = transcriptMarkdown(body, name);
    return markdown ? `${markdown}\n` : "";
  });
  return 0;
}

/** Stop a conversation's running turn, whichever client started it. */
export async function stopCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { path, session } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request("POST", `${path}/stop`, {})).body;
  emit(ctx, body, () => `stopped ${session.id}\n`);
  return 0;
}

export async function sessionActionCommand(
  verb: "title" | "pin" | "unpin",
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const { path, session } = await resolveTarget(ctx.client, ctx, parsed);
  let body: unknown;
  if (verb === "title") {
    body = (await ctx.client.request("PUT", `${path}/title`, {
      title: parsed.positionals[0],
    })).body;
  } else {
    body = (await ctx.client.request("PUT", `${path}/pin`, {
      pinned: verb === "pin",
    })).body;
  }
  emit(ctx, body, () => {
    if (verb === "title") return `${(body as { title?: string }).title ?? parsed.positionals[0]}\n`;
    return `${verb === "pin" ? "pinned" : "unpinned"} ${session.id}\n`;
  });
  return 0;
}
