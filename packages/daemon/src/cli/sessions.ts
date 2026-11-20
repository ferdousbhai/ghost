import type { Transcript } from "../session-host.js";
import { ArgsError, flagBoolean, flagString } from "./args.js";
import { listSessions, resolveGhost, resolveTarget } from "./common.js";
import { emit, relativeTime, table, truncate } from "./output.js";
import type { CliContext } from "./types.js";

export async function sessionsCommand(ctx: CliContext): Promise<number> {
  const name = await resolveGhost(ctx);
  const sessions = await listSessions(ctx.client, name);
  emit(ctx, { sessions }, () => {
    const rows = sessions.map((session) => [
      session.id,
      truncate(session.title ?? session.preview ?? "—", 42),
      relativeTime(session.updatedAt),
      String(session.messageCount),
      [session.question ? "asking" : "", session.running ? "running" : "", session.unread ? "unread" : "", session.pinned ? "pinned" : ""].filter(Boolean).join(","),
    ]);
    return {
      human: rows.length > 0 ? `${table(rows, ["ID", "TITLE", "UPDATED", "MESSAGES", "STATE"])}\n` : "No conversations.\n",
      quiet: sessions.map((session) => session.id).join("\n") + (sessions.length ? "\n" : ""),
    };
  });
  return 0;
}

function transcriptMarkdown(body: Transcript, ghost: string): string {
  return body.messages.map((message) => {
    const heading = message.role === "user" ? "you"
      : message.role === "hook" ? "Stop hook"
      : message.role === "compacted" ? "Context compacted"
      : ghost;
    const lines = message.content.map((part) => part.type === "toolCall"
      ? `> ⚙ ${part.name}(${truncate(JSON.stringify(part.arguments ?? {}), 120)})`
      : part.text).filter(Boolean);
    return `**${heading}:**\n\n${lines.join("\n")}`;
  }).join("\n\n");
}

/**
 * Without --offset, the newest page: the daemon pages from the oldest, so a
 * conversation longer than one page is fetched again from its last page.
 */
export async function showCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const { name, path } = await resolveTarget(ctx);
  const limit = flagString(parsed, "limit");
  const offset = flagString(parsed, "offset");
  const page = (from: string | undefined) => {
    const query = new URLSearchParams();
    if (limit) query.set("limit", limit);
    if (from) query.set("offset", from);
    return ctx.client.request<Transcript>("GET", `${path}/transcript${query.size ? `?${query}` : ""}`);
  };
  let response = await page(offset);
  let first = offset ? Number(offset) : 0;
  if (!offset && response.truncated) {
    first = Math.max(0, response.total - response.messages.length);
    response = await page(String(first));
  }
  emit(ctx, response, (body) => {
    const markdown = transcriptMarkdown(body, name);
    if (body.total === 0) return { human: "No messages.\n", quiet: "" };
    if (body.messages.length === 0) return { human: `(no messages from ${first + 1}; ${body.total} in all)\n`, quiet: "" };
    const trailer = body.truncated
      ? `(messages ${first + 1}–${first + body.messages.length} of ${body.total}; --offset/--limit for others)\n`
      : "";
    const quiet = `${markdown}\n`;
    return { human: `${quiet}${trailer ? "\n" : ""}${trailer}`, quiet };
  });
  return 0;
}

/** Stop a conversation's running turn, whichever client started it. */
export async function stopCommand(ctx: CliContext): Promise<number> {
  const { path, session } = await resolveTarget(ctx);
  const body = await ctx.client.request("POST", `${path}/stop`, {});
  emit(ctx, body, () => `Stopped ${session.id}.\n`);
  return 0;
}

/**
 * Ask the owner something in a conversation and wait for their next message
 * there: the question, then up to six suggested answers. `--clear` withdraws
 * an open question unanswered. In a ghost's own shell `$GHOST_SESSION` names
 * the conversation.
 */
export async function askCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const clear = flagBoolean(parsed, "clear");
  const [text, ...options] = parsed.positionals;
  if (clear && text !== undefined) throw new ArgsError("ask --clear takes no question.");
  if (!clear && text === undefined) throw new ArgsError("ask needs a question.");
  const { path, session } = await resolveTarget(ctx);
  if (clear) {
    const body = await ctx.client.request("DELETE", `${path}/question`);
    emit(ctx, body, () => `Cleared the question in ${session.id}.\n`);
    return 0;
  }
  const body = await ctx.client.request("PUT", `${path}/question`, { text, options });
  emit(ctx, body, () => `Asked in ${session.id}; the owner's next message there is the answer.\n`);
  return 0;
}

export async function sessionActionCommand(verb: "title" | "pin" | "unpin", ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const { path, session } = await resolveTarget(ctx);
  let body: unknown;
  if (verb === "title") {
    body = await ctx.client.request("PUT", `${path}/title`, {
      title: parsed.positionals[0],
    });
  } else {
    body = await ctx.client.request("PUT", `${path}/pin`, {
      pinned: verb === "pin",
    });
  }
  emit(ctx, body, () => {
    if (verb === "title") return `Conversation ${session.id} is now titled ${JSON.stringify((body as { title?: string }).title ?? parsed.positionals[0])}.\n`;
    return `${verb === "pin" ? "Pinned" : "Unpinned"} ${session.id}.\n`;
  });
  return 0;
}

/** `ghost rm -s <id> --yes`: move one conversation to recoverable Trash. */
export async function removeCommand(ctx: CliContext): Promise<number> {
  if (!flagBoolean(ctx.parsed, "yes")) throw new ArgsError("ghost rm requires --yes");
  if (!flagString(ctx.parsed, "session")) throw new ArgsError("ghost rm needs -s <id>");
  const { path, session } = await resolveTarget(ctx);
  const response = await ctx.client.request("DELETE", path);
  emit(ctx, response, () => `Trashed ${session.id}.\n`);
  return 0;
}
