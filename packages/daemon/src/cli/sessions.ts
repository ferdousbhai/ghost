import type { SessionSummary } from "../session-host.js";
import { flagString, type ParsedCliArgs } from "./args.js";
import { listSessions, resolveGhost, resolveTarget } from "./common.js";
import { emit, relativeTime, table, textContent, truncate } from "./output.js";
import type { CliContext } from "./types.js";

function displaySessionId(session: SessionSummary): string {
  return session.conversationId;
}

export async function sessionsCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const sessions = await listSessions(ctx.client, name);
  emit(ctx, { sessions }, () => {
    const rows = sessions.map((session) => [
      displaySessionId(session),
      truncate(session.title ?? "—", 42),
      relativeTime(session.updatedAt),
      String(session.messageCount),
      [session.unread ? "unread" : "", session.pinned ? "pinned" : ""].filter(Boolean).join(","),
    ]);
    return {
      human: rows.length > 0 ? `${table(rows, ["ID", "TITLE", "UPDATED", "MESSAGES", "STATE"])}\n` : "",
      quiet: sessions.map(displaySessionId).join("\n") + (sessions.length ? "\n" : ""),
    };
  });
  return 0;
}

interface TranscriptBody {
  id: string;
  conversationId: string;
  title: string | null;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  total: number;
  truncated: boolean;
}

function toolLine(part: Record<string, unknown>): string | undefined {
  if (part.type !== "toolCall") return undefined;
  const name = typeof part.name === "string" ? part.name : "tool";
  const args = JSON.stringify(part.arguments ?? {});
  return `> ⚙ ${name}(${truncate(args, 120)})`;
}

function transcriptMarkdown(body: TranscriptBody, ghost: string): string {
  return body.messages.map((message) => {
    const heading = message.role === "user" ? "you" : ghost;
    const lines: string[] = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const tool = toolLine(part as Record<string, unknown>);
        if (tool) lines.push(tool);
        else {
          const text = textContent([part]);
          if (text) lines.push(text);
        }
      }
    } else {
      const text = textContent(message.content);
      if (text) lines.push(text);
    }
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
  const response = await ctx.client.request<TranscriptBody>("GET", `${path}/transcript${suffix}`);
  emit(ctx, response.body, (body) => {
    const markdown = transcriptMarkdown(body, name);
    return markdown ? `${markdown}\n` : "";
  });
  return 0;
}

export async function sessionActionCommand(
  verb: "title" | "fork" | "pin" | "unpin",
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const { path, session } = await resolveTarget(ctx.client, ctx, parsed);
  let body: unknown;
  if (verb === "title") {
    body = (await ctx.client.request("PUT", `${path}/title`, {
      title: parsed.positionals[0],
    })).body;
  } else if (verb === "fork") {
    body = (await ctx.client.request("POST", `${path}/branch`, {
      action: "fork",
      entryId: parsed.positionals[0],
    })).body;
  } else {
    body = (await ctx.client.request("PUT", `${path}/pin`, {
      pinned: verb === "pin",
    })).body;
  }
  emit(ctx, body, () => {
    if (verb === "fork") {
      const result = body as { id?: unknown; draft?: unknown };
      return `${typeof result.id === "string" ? result.id : "forked"}\n`
        + (typeof result.draft === "string" && result.draft ? `${result.draft}\n` : "");
    }
    if (verb === "title") return `${(body as { title?: string }).title ?? parsed.positionals[0]}\n`;
    return `${verb === "pin" ? "pinned" : "unpinned"} ${session.id}\n`;
  });
  return 0;
}
