/**
 * Carry conversations the embedded pi runtime wrote (`sessions/<id>.jsonl`,
 * pi's own tree of entries) into conversation logs, once, at daemon start.
 * The active branch becomes the log; the original transcript moves into the
 * conversation's directory as `pi-transcript.jsonl`, so nothing is lost and
 * a second run finds nothing to do. Pins and read marks keyed `pi:<id>` are
 * rekeyed to the bare id.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  appendLog,
  conversationDir,
  isValidConversationId,
  logPath,
  newConversationEntry,
  type AssistantPart,
  type LogEntry,
} from "./conversation-log.js";
import type { Logger } from "./log.js";
import { readPinState, writePins } from "./pins.js";
import { readReadState, writeReads } from "./reads.js";

export const PI_TRANSCRIPT_FILENAME = "pi-transcript.jsonl";
const STOP_HOOK_PREFIX = "Stop hook feedback:\n";

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  name?: string;
  customType?: string;
  content?: unknown;
  data?: { conversationId?: unknown };
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    command?: string;
    output?: string;
    exitCode?: number;
    excludeFromContext?: boolean;
    toolCallId?: string;
    isError?: boolean;
  };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const block = part as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function at(entry: PiEntry, fallback: string): string {
  if (typeof entry.message?.timestamp === "number") return new Date(entry.message.timestamp).toISOString();
  return entry.timestamp ?? fallback;
}

/** The entries on pi's active branch: from the last entry back to the root. */
function activeBranch(entries: readonly PiEntry[]): PiEntry[] {
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
  const branch: PiEntry[] = [];
  let cursor: PiEntry | undefined = entries.at(-1);
  const seen = new Set<string>();
  while (cursor && !(cursor.id && seen.has(cursor.id))) {
    if (cursor.id) seen.add(cursor.id);
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return branch.reverse();
}

/** One pi transcript as conversation-log entries, or null when it holds no conversation. */
export function convertPiTranscript(id: string, raw: string, fallbackAt: string): LogEntry[] | null {
  const entries: PiEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PiEntry);
    } catch {
      // A torn line; pi skips it too.
    }
  }
  const header = entries.find((entry) => entry.type === "session");
  if (!header) return null;
  const failed = new Set(entries.flatMap((entry) =>
    entry.message?.role === "toolResult" && entry.message.isError && entry.message.toolCallId ? [entry.message.toolCallId] : []));
  const out: LogEntry[] = [newConversationEntry(id, new Date(header.timestamp ?? fallbackAt))];
  let messages = 0;
  for (const entry of activeBranch(entries)) {
    const when = at(entry, fallbackAt);
    const message = entry.message;
    if (entry.type === "session_info" && typeof entry.name === "string") {
      out.push({ type: "title", at: when, title: entry.name });
    } else if (entry.type === "custom_message" && entry.customType === "session-stop-continuation") {
      const body = text(entry.content);
      out.push({ type: "user", at: when, text: body.startsWith(STOP_HOOK_PREFIX) ? body.slice(STOP_HOOK_PREFIX.length) : body, origin: "hook" });
    } else if (entry.type === "message" && message?.role === "user") {
      const body = text(message.content).trim();
      if (body) {
        out.push({ type: "user", at: when, text: body });
        messages += 1;
      }
    } else if (entry.type === "message" && message?.role === "assistant" && Array.isArray(message.content)) {
      const content: AssistantPart[] = [];
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string" && part.text) content.push({ type: "text", text: part.text });
        if (part.type === "toolCall" && typeof part.id === "string") {
          content.push({
            type: "toolCall",
            id: part.id,
            name: String(part.name ?? "tool"),
            arguments: part.arguments ?? {},
            ...(failed.has(part.id) ? { failed: true as const } : {}),
          });
        }
      }
      if (content.length > 0) {
        out.push({ type: "assistant", at: when, harness: "pi", content });
        messages += 1;
      }
    } else if (entry.type === "message" && message?.role === "bashExecution" && typeof message.command === "string") {
      out.push({
        type: "command",
        at: when,
        command: message.command,
        output: message.output ?? "",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : null,
        excluded: message.excludeFromContext === true,
      });
    }
  }
  return messages > 0 || out.some((entry) => entry.type === "title") ? out : null;
}

function idFor(file: string, raw: string): string | null {
  const stem = file.slice(0, -".jsonl".length);
  if (isValidConversationId(stem)) return stem;
  // Ids that could not be file names were hashed, with the id inside.
  for (const line of raw.split("\n").slice(0, 64)) {
    try {
      const entry = JSON.parse(line) as PiEntry;
      const id = entry.customType === "ghost_conversation_identity" ? entry.data?.conversationId : undefined;
      if (typeof id === "string" && isValidConversationId(id)) return id;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/** Import every pi transcript in one ghost's `sessions/`; returns how many became conversations. */
export async function importPiConversations(sessionDir: string, logger: Logger): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  let imported = 0;
  for (const file of files) {
    const path = join(sessionDir, file);
    try {
      const raw = await readFile(path, "utf8");
      if (!raw.startsWith('{"type":"session"')) continue;
      const id = idFor(file, raw);
      if (!id || existsSync(logPath(sessionDir, id))) continue;
      const entries = convertPiTranscript(id, raw, (await stat(path)).mtime.toISOString());
      await mkdir(conversationDir(sessionDir, id), { recursive: true, mode: 0o700 });
      if (entries) {
        await appendLog(sessionDir, id, entries);
        imported += 1;
      }
      await rename(path, join(conversationDir(sessionDir, id), PI_TRANSCRIPT_FILENAME));
    } catch (error) {
      logger.warn("pi transcript not imported", { file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const pins = await readPinState(sessionDir);
  if (pins.pinned.some((pin) => pin.startsWith("pi:"))) {
    await writePins(sessionDir, pins.pinned.map((pin) => pin.replace(/^pi:/u, "")));
  }
  const reads = await readReadState(sessionDir);
  if (Object.keys(reads.reads).some((key) => key.startsWith("pi:"))) {
    await writeReads(sessionDir, Object.fromEntries(Object.entries(reads.reads).map(([key, value]) => [key.replace(/^pi:/u, ""), value])));
  }
  return imported;
}
