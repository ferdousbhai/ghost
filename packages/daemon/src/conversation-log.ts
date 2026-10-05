/**
 * A conversation's own record, `sessions/<id>/.conversation.jsonl` in the
 * ghost home: what
 * the owner said, what the ghost answered, the tools it ran, the owner's `!`
 * commands, and which harness carried each stretch. Each harness keeps its
 * own transcript for resume; this log is what the HUD, `ghost show`, and a
 * harness switch read, so it is the one history that outlives any harness.
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { GhostError } from "./ghosts.js";

export const LOG_VERSION = 1;
/** A stored text is cut here; the transcript marks it `contentTruncated`. */
export const MAX_LOG_TEXT = 200_000;
const PREVIEW_MAX = 120;
/** How much of the earlier conversation a newly bound harness is handed. */
export const HANDOFF_CONTEXT_CHARS = 24_000;

export interface ToolCallPart {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly failed?: true;
}
export type AssistantPart = { readonly type: "text"; readonly text: string } | ToolCallPart;

export type LogEntry =
  | { readonly type: "conversation"; readonly v: number; readonly id: string; readonly createdAt: string }
  /** `origin` is absent for an owner message. */
  | { readonly type: "user"; readonly at: string; readonly text: string; readonly origin?: "follow_up" | "hook" }
  | {
    readonly type: "assistant";
    readonly at: string;
    readonly harness: string;
    readonly content: readonly AssistantPart[];
    readonly error?: string;
    /** The model, its provider, and the reasoning effort, as far as the harness said. */
    readonly model?: string;
    readonly provider?: string;
    readonly effort?: string;
  }
  | { readonly type: "command"; readonly at: string; readonly command: string; readonly output: string; readonly exitCode: number | null; readonly excluded: boolean }
  /**
   * A harness took over the conversation in `dir`; `session` is its own id
   * when it reports one. A home rename moves `dir`, which the harness's own
   * session store does not follow.
   */
  | { readonly type: "harness"; readonly at: string; readonly harness: string; readonly session: string | null; readonly dir?: string }
  | { readonly type: "title"; readonly at: string; readonly title: string | null };

const CONVERSATION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;

/** Conversation ids are file stems: letters, digits, `.`, `_`, `-`; at most 128. */
export function isValidConversationId(id: string): boolean {
  return CONVERSATION_ID.test(id);
}

export function requireConversationId(id: string): string {
  if (isValidConversationId(id)) return id;
  throw new GhostError("invalid_conversation_id", "Conversation ids are 1-128 letters, digits, '.', '_' or '-'.", 400);
}

/**
 * The conversation's directory: its harness runs there, and its log lives
 * there, so one rename moves or trashes the whole conversation.
 */
export function conversationDir(sessionDir: string, id: string): string {
  return join(sessionDir, id);
}

export const LOG_FILENAME = ".conversation.jsonl";

export function logPath(sessionDir: string, id: string): string {
  return join(conversationDir(sessionDir, id), LOG_FILENAME);
}

function bounded(text: string): string {
  return text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) : text;
}

function boundedEntry(entry: LogEntry): LogEntry {
  switch (entry.type) {
    case "user":
      return { ...entry, text: bounded(entry.text) };
    case "command":
      return { ...entry, output: bounded(entry.output) };
    case "assistant":
      return { ...entry, content: entry.content.map((part) => part.type === "text" ? { ...part, text: bounded(part.text) } : part) };
    default:
      return entry;
  }
}

export async function appendLog(sessionDir: string, id: string, entries: readonly LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(conversationDir(sessionDir, id), { recursive: true, mode: 0o700 });
  const lines = entries.map((entry) => `${JSON.stringify(boundedEntry(entry))}\n`).join("");
  await appendFile(logPath(sessionDir, id), lines, { mode: 0o600 });
}

/** Every well-formed entry; a torn last line from a crash is skipped. */
export async function readLog(sessionDir: string, id: string): Promise<LogEntry[] | null> {
  let text: string;
  try {
    text = await readFile(logPath(sessionDir, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (entry && typeof entry === "object" && typeof entry.type === "string") entries.push(entry);
    } catch {
      // A partial line is what a crash mid-append leaves; the rest stands.
    }
  }
  return entries;
}

export function newConversationEntry(id: string, now: Date): LogEntry {
  return { type: "conversation", v: LOG_VERSION, id, createdAt: now.toISOString() };
}

export interface LogState {
  readonly createdAt: string | null;
  readonly title: string | null;
  readonly preview: string | null;
  readonly messageCount: number;
  /** The harness bound by the last `harness` entry, its session id, and where it ran. */
  readonly harness: string | null;
  readonly harnessSession: string | null;
  readonly harnessDir: string | null;
  /** Whether that harness has run a turn in the conversation directory yet. */
  readonly harnessStarted: boolean;
  /** What the bound harness's latest pass ran on; null once another harness binds. */
  readonly model: string | null;
  readonly provider: string | null;
  readonly effort: string | null;
}

function firstLine(text: string): string | null {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  return line.length > PREVIEW_MAX ? line.slice(0, PREVIEW_MAX).trimEnd() : line;
}

export function logState(entries: readonly LogEntry[]): LogState {
  let createdAt: string | null = null;
  let title: string | null = null;
  let preview: string | null = null;
  let messageCount = 0;
  let harness: string | null = null;
  let harnessSession: string | null = null;
  let harnessDir: string | null = null;
  let harnessStarted = false;
  let ran: Pick<LogState, "model" | "provider" | "effort"> = { model: null, provider: null, effort: null };
  for (const entry of entries) {
    switch (entry.type) {
      case "conversation":
        createdAt = entry.createdAt;
        break;
      case "title":
        title = entry.title;
        break;
      case "user":
        messageCount += 1;
        if (preview === null && entry.origin === undefined) preview = firstLine(entry.text);
        break;
      case "assistant":
        messageCount += 1;
        // A turn that failed before saying or doing anything left nothing to continue.
        if (entry.harness === harness && entry.content.length > 0) harnessStarted = true;
        if (entry.harness === harness && (entry.model ?? entry.effort) !== undefined) {
          ran = { model: entry.model ?? null, provider: entry.provider ?? null, effort: entry.effort ?? null };
        }
        break;
      case "harness":
        if (entry.harness !== harness || (entry.dir !== undefined && entry.dir !== harnessDir)) {
          harnessStarted = false;
          harnessSession = null;
        }
        if (entry.harness !== harness) ran = { model: null, provider: null, effort: null };
        harness = entry.harness;
        harnessSession = entry.session ?? harnessSession;
        harnessDir = entry.dir ?? harnessDir;
        break;
      default:
        break;
    }
  }
  return { createdAt, title, preview, messageCount, harness, harnessSession, harnessDir, harnessStarted, ...ran };
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "hook";
  content: unknown;
  timestamp?: number;
  entryId: string;
  contentTruncated?: true;
  errorMessage?: string;
}

function commandText(entry: Extract<LogEntry, { type: "command" }>): string {
  const status = entry.exitCode === 0 ? "" : `\n\n(exit ${entry.exitCode ?? "signal"})`;
  return `\`$ ${entry.command}\`\n\n\`\`\`\n${entry.output}\n\`\`\`${status}`;
}

/** The renderable messages, in order; harness and title records are not messages. */
export function transcriptMessages(entries: readonly LogEntry[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  entries.forEach((entry, index) => {
    const entryId = `e${index}`;
    let message: TranscriptMessage | null = null;
    if (entry.type === "user") {
      message = {
        role: entry.origin === "hook" ? "hook" : "user",
        content: [{ type: "text", text: entry.text }],
        timestamp: Date.parse(entry.at),
        entryId,
        ...(entry.text.length >= MAX_LOG_TEXT ? { contentTruncated: true as const } : {}),
      };
    } else if (entry.type === "assistant") {
      message = {
        role: "assistant",
        content: entry.content,
        timestamp: Date.parse(entry.at),
        entryId,
        ...(entry.error ? { errorMessage: entry.error } : {}),
      };
    } else if (entry.type === "command" && !entry.excluded) {
      message = {
        role: "assistant",
        content: [{ type: "text", text: commandText(entry) }],
        timestamp: Date.parse(entry.at),
        entryId,
      };
    }
    if (message) messages.push(message);
  });
  return messages;
}

function assistantText(content: readonly AssistantPart[]): string {
  return content.map((part) => part.type === "text" ? part.text : `[ran ${part.name}]`).join("\n");
}

/**
 * The earlier conversation as text, for a harness that did not carry it:
 * the newest `HANDOFF_CONTEXT_CHARS`, owner and ghost lines labelled.
 */
export function handoffContext(entries: readonly LogEntry[]): string | null {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "user") lines.push(`${entry.origin === "hook" ? "Hook" : "Owner"}: ${entry.text}`);
    if (entry.type === "assistant") {
      const text = assistantText(entry.content).trim();
      if (text) lines.push(`You: ${text}`);
    }
    if (entry.type === "command" && !entry.excluded) lines.push(`Owner ran \`${entry.command}\`:\n${entry.output}`);
  }
  if (lines.length === 0) return null;
  let text = lines.join("\n\n");
  if (text.length > HANDOFF_CONTEXT_CHARS) text = `…${text.slice(-HANDOFF_CONTEXT_CHARS)}`;
  return text;
}

/** Owner `!` commands since the harness last ran, which it has not seen. */
export function unseenCommands(entries: readonly LogEntry[]): string | null {
  const commands: string[] = [];
  for (const entry of entries) {
    if (entry.type === "assistant") commands.length = 0;
    if (entry.type === "command" && !entry.excluded) commands.push(`Owner ran \`${entry.command}\` (exit ${entry.exitCode ?? "signal"}):\n${entry.output}`);
  }
  return commands.length > 0 ? commands.join("\n\n") : null;
}

export async function logUpdatedAt(sessionDir: string, id: string): Promise<string | null> {
  try {
    return (await stat(logPath(sessionDir, id))).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * How a shell command started in a conversation names it: the variables the
 * `ghost` CLI reads in place of `-g` and `-s`. Every harness turn and owner
 * `!` command runs with them.
 */
export function conversationEnvironment(ghostName: string, id: string): { GHOST: string; GHOST_SESSION: string } {
  return { GHOST: ghostName, GHOST_SESSION: id };
}
