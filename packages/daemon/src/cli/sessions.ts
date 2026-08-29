import { flagBoolean, flagString, parseArgs, requirePositionals } from "./args.js";
import type { DaemonClient } from "./client.js";
import { listSessions, resolveGhost, resolveSession, sessionPath, type SessionRow } from "./common.js";
import { relativeTime, table, textContent, truncate, writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

function displaySessionId(session: SessionRow): string {
  return session.runtime === "pi" ? session.conversationId : session.id;
}

export async function sessionsCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, { value: ["ghost"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("sessions"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost sessions [-g <name>] [--json] [-q]");
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const sessions = await listSessions(client, name);
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, { sessions });
  else if (flagBoolean(parsed, "quiet")) {
    runtime.stdout.write(sessions.map(displaySessionId).join("\n") + (sessions.length ? "\n" : ""));
  } else if (sessions.length > 0) {
    const rows = sessions.map((session) => [
      displaySessionId(session),
      truncate(session.title ?? "—", 42),
      relativeTime(session.updatedAt),
      String(session.messageCount),
      [session.unread ? "unread" : "", session.pinned ? "pinned" : ""].filter(Boolean).join(","),
    ]);
    runtime.stdout.write(`${table(rows, ["ID", "TITLE", "UPDATED", "MESSAGES", "STATE"])}\n`);
  }
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
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, { value: ["ghost", "session", "limit", "offset"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("show"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost show [-g <name>] [-s <id>] [--limit <n>] [--offset <n>]");
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const { session } = await resolveSession(client, name, flagString(parsed, "session"));
  const query = new URLSearchParams();
  const limit = flagString(parsed, "limit");
  const offset = flagString(parsed, "offset");
  if (limit) query.set("limit", limit);
  if (offset) query.set("offset", offset);
  const suffix = query.size ? `?${query}` : "";
  const response = await client.request<TranscriptBody>("GET", sessionPath(name, session.id, `/transcript${suffix}`));
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, response.body);
  else {
    const markdown = transcriptMarkdown(response.body, name);
    if (markdown) runtime.stdout.write(`${markdown}\n`);
  }
  return 0;
}

export async function sessionActionCommand(
  verb: "title" | "fork" | "pin" | "unpin",
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, { value: ["ghost", "session"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp(verb));
    return 0;
  }
  requirePositionals(parsed, verb === "pin" || verb === "unpin" ? 0 : 1, verb === "pin" || verb === "unpin" ? 0 : 1, `ghost ${verb}`);
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const { session } = await resolveSession(client, name, flagString(parsed, "session"));
  let body: unknown;
  if (verb === "title") {
    body = (await client.request("PUT", sessionPath(name, session.id, "/title"), {
      title: parsed.positionals[0],
    })).body;
  } else if (verb === "fork") {
    body = (await client.request("POST", sessionPath(name, session.id, "/branch"), {
      action: "fork",
      entryId: parsed.positionals[0],
    })).body;
  } else {
    body = (await client.request("PUT", sessionPath(name, session.id, "/pin"), {
      pinned: verb === "pin",
    })).body;
  }
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, body);
  else if (!flagBoolean(parsed, "quiet")) {
    if (verb === "fork") {
      const result = body as { id?: unknown; draft?: unknown };
      runtime.stdout.write(`${typeof result.id === "string" ? result.id : "forked"}\n`);
      if (typeof result.draft === "string" && result.draft) runtime.stdout.write(`${result.draft}\n`);
    } else if (verb === "title") {
      runtime.stdout.write(`${(body as { title?: string }).title ?? parsed.positionals[0]}\n`);
    } else runtime.stdout.write(`${verb === "pin" ? "pinned" : "unpinned"} ${session.id}\n`);
  }
  return 0;
}
