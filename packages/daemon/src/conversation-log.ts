/**
 * A conversation's own record, `sessions/<id>/.conversation.jsonl` in the
 * ghost home: what
 * the owner said, what the ghost answered, the tools it ran, the owner's `!`
 * commands, and which harness carried each stretch. Each harness keeps its
 * own transcript for resume; this log is what the HUD, `ghost show`, and a
 * harness switch read, so it is the one history that outlives any harness.
 */
import { appendFile, mkdir, open, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { BoundedCache } from "./bounded-cache.js";
import { GhostError } from "./ghosts.js";
import { snapshotSummary, type RunResourceSnapshot } from "./run-resources.js";

export const LOG_VERSION = 1;
/** A stored text is cut here; the transcript marks a cut owner or hook message `contentTruncated`. */
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
  | ({ readonly type: "resources" } & RunResourceSnapshot)
  | { readonly type: "conversation"; readonly v: number; readonly id: string; readonly createdAt: string }
  /** `origin` is absent for an owner message; `auto` marks historical next-work prompts. */
  | { readonly type: "user"; readonly at: string; readonly text: string; readonly origin?: "follow_up" | "hook" | "auto" }
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
  | { readonly type: "title"; readonly at: string; readonly title: string | null }
  /** The idle handoff pass: its one-line reply, or why it failed. */
  | { readonly type: "handoff"; readonly at: string; readonly harness: string; readonly text: string; readonly error?: string };

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
  const path = logPath(sessionDir, id);
  const indexed = logIndexes.get(path);
  const before = indexed ? await stat(path).catch(() => null) : null;
  await appendFile(path, lines, { mode: 0o600 });
  if (indexed && before) {
    const after = await stat(path).catch(() => null);
    const expected = indexed.appended?.to ?? indexed.info;
    if (after && sameSnapshot(before, expected) && sameFile(before, after) && after.size === before.size + Buffer.byteLength(lines)) {
      indexed.appended = { from: indexed.appended?.from ?? before, to: after };
    } else {
      logIndexes.delete(path);
    }
  }
}

/** Every well-formed entry; a torn last line from a crash is skipped. */
export async function readLog(sessionDir: string, id: string): Promise<LogEntry[] | null> {
  let file: FileHandle;
  try {
    file = await open(logPath(sessionDir, id), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const entries: LogEntry[] = [];
  try {
    for await (const line of file.readLines({ autoClose: false })) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as LogEntry;
        if (entry && typeof entry === "object" && typeof entry.type === "string") entries.push(entry);
      } catch {
        // A partial line is what a crash mid-append leaves; the rest stands.
      }
    }
  } finally {
    await file.close();
  }
  return entries;
}

export function newConversationEntry(id: string, now: Date): LogEntry {
  return { type: "conversation", v: LOG_VERSION, id, createdAt: now.toISOString() };
}

export interface LogState {
  /** The owner's title, else one derived from the first owner message. */
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
  /** When the owner or the ghost last added to the conversation; a handoff or harness record is not that. */
  readonly activeAt: string | null;
}

/** The owner's words without attachment markers: an imported `[Attachment: …]` or an attached image's line. */
function ownerWords(text: string): string {
  return text.replace(/\[Attachment:[^\]]*\]|^!\[[^\]]*\]\(attachments\/[^)\s]+\)$/gmu, " ").trim();
}

function firstLine(text: string): string | null {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  return line.length > PREVIEW_MAX ? line.slice(0, PREVIEW_MAX).trimEnd() : line;
}

// Openers that say nothing about the subject: greetings and request frames.
const TITLE_LEAD = /^(?:(?:hey|hi|hello|yo|ok(?:ay)?|so|well|please|pls)\b[\s,!.:-]*|(?:can|could|would|will) you\s+(?:please\s+)?|(?:i(?:'d| would) like (?:you )?to|i (?:want|need) (?:you )?to|help me(?: to)?|let'?s|tell me)\s+)/iu;
const TITLE_TAIL = new Set("a an the to of and or for with in on at from by about as but if that this my your our so then is are be i me".split(" "));
const TITLE_WORDS = 7;

/**
 * A title extracted from the first owner message, with no model: a quoted
 * name the message gives (`called "Coffee Ideas"`), else its first clause
 * without greeting or request frame, cut to a few words that do not end on
 * a filler word. Null when nothing substantive is left (a bare "hey").
 */
export function derivedTitle(text: string): string | null {
  const plain = ownerWords(text);
  const named = plain.match(/\b(?:called|named|titled)\s+["“]([^"”]{2,60})["”]/iu)?.[1]?.replace(/^#+\s*/u, "").trim();
  if (named) return named;
  let clause = plain.split(/(?<=[.?!])\s|\n|;|:\s|\s[-–—]\s|,\s(?:and |but |so |then )?(?:i |can |could |please )/iu)[0] ?? "";
  for (let previous = ""; previous !== clause; ) {
    previous = clause;
    clause = clause.replace(TITLE_LEAD, "").trim();
  }
  const words = clause.replace(/^(?:for )?me\s+/iu, "").replace(/[?!.,:;]+$/u, "").split(/\s+/u).filter(Boolean).slice(0, TITLE_WORDS);
  while (words.length > 1 && TITLE_TAIL.has((words.at(-1) as string).toLowerCase().replace(/[^a-z']/gu, ""))) words.pop();
  if (words.length < 2) return null;
  const title = words.join(" ").replace(/[,:;]+$/u, "");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function logStateAccumulator() {
  let title: string | null = null;
  let preview: string | null = null;
  let derived: string | null = null;
  let ownerWrote = false;
  let messageCount = 0;
  let harness: string | null = null;
  let harnessSession: string | null = null;
  let harnessDir: string | null = null;
  let harnessStarted = false;
  let ran: Pick<LogState, "model" | "provider" | "effort"> = { model: null, provider: null, effort: null };
  let activeAt: string | null = null;
  const append = (entry: LogEntry) => {
    if (entry.type !== "conversation" && entry.type !== "handoff" && entry.type !== "harness" && entry.type !== "resources") activeAt = entry.at;
    switch (entry.type) {
      case "title":
        title = entry.title;
        break;
      case "user":
        messageCount += 1;
        // The first owner message titles the conversation, even after a `!command` previewed it.
        if (!ownerWrote && entry.origin === undefined) {
          ownerWrote = true;
          // A message of attachments alone still says what it was.
          preview ??= firstLine(ownerWords(entry.text)) ?? (entry.text.trim() ? "Photo" : null);
          derived = derivedTitle(entry.text);
        }
        break;
      case "assistant":
        messageCount += 1;
        // A turn that failed before saying or doing anything left nothing to continue.
        if (entry.harness === harness && entry.content.length > 0) harnessStarted = true;
        if (entry.harness === harness && (entry.model ?? entry.effort) !== undefined) {
          ran = { model: entry.model ?? null, provider: entry.provider ?? null, effort: entry.effort ?? null };
        }
        break;
      case "handoff":
        messageCount += 1;
        break;
      case "command":
        // A `!command` the transcript shows is two messages, the owner's words and its output.
        if (entry.excluded) break;
        messageCount += 2;
        preview ??= firstLine(`!${entry.command}`);
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
  };
  return { append, value: (): LogState => ({ title: title ?? derived, preview, messageCount, harness, harnessSession, harnessDir, harnessStarted, ...ran, activeAt }) };
}

export function logState(entries: readonly LogEntry[]): LogState {
  const state = logStateAccumulator();
  for (const entry of entries) state.append(entry);
  return state.value();
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "hook" | "handoff" | "auto";
  content: readonly AssistantPart[];
  entryId: string;
  contentTruncated?: true;
  errorMessage?: string;
}

function commandText(entry: Extract<LogEntry, { type: "command" }>): string {
  const status = entry.exitCode === 0 ? "" : `\n\n(exit ${entry.exitCode ?? "signal"})`;
  // A fence longer than any backtick run inside, so output holding ``` stays code.
  let fenceLength = 3;
  for (const run of entry.output.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1);
  const fence = "`".repeat(fenceLength);
  return `${fence}\n${entry.output.trimEnd()}\n${fence}${status}`;
}

/** The renderable messages, in order; harness and title records are not messages. */
export function transcriptPage(entries: readonly LogEntry[], offset = 0, limit = Infinity): { messages: TranscriptMessage[]; total: number } {
  const messages: TranscriptMessage[] = [];
  let total = 0;
  entries.forEach((entry, index) => {
    const count = messageCount(entry);
    const first = total;
    total += count;
    if (count === 0 || first >= offset + limit || total <= offset) return;
    const entryId = `e${index}`;
    let message: TranscriptMessage | null = null;
    if (entry.type === "user") {
      message = {
        role: entry.origin === "hook" || entry.origin === "auto" ? entry.origin : "user",
        content: [{ type: "text", text: entry.text }],
        entryId,
        ...(entry.text.length >= MAX_LOG_TEXT ? { contentTruncated: true as const } : {}),
      };
    } else if (entry.type === "assistant") {
      message = {
        role: "assistant",
        content: entry.content,
        entryId,
        ...(entry.error ? { errorMessage: entry.error } : {}),
      };
    } else if (entry.type === "handoff") {
      message = {
        role: "handoff",
        content: [{ type: "text", text: entry.error ? `Failed: ${entry.error}` : entry.text }],
        entryId,
      };
    } else if (entry.type === "command" && !entry.excluded) {
      // The owner's `!command`, then its output, as the live turn showed them.
      if (first >= offset) messages.push({ role: "user", content: [{ type: "text", text: `!${entry.command}` }], entryId });
      if (first + 1 >= offset + limit) return;
      message = {
        role: "assistant",
        content: [{ type: "text", text: commandText(entry) }],
        entryId: `${entryId}o`,
      };
    }
    if (message) messages.push(message);
  });
  return { messages, total };
}

function assistantText(content: readonly AssistantPart[]): string {
  return content.map((part) => part.type === "text" ? part.text : `[ran ${part.name}]`).join("\n");
}

/**
 * The earlier conversation as text, for a harness that did not carry it:
 * the newest `HANDOFF_CONTEXT_CHARS`, owner and ghost lines labelled.
 */
export function handoffContext(entries: readonly LogEntry[]): string | null {
  let context = "";
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    let line: string | null = null;
    if (entry.type === "user") line = `${entry.origin === "hook" ? "Hook" : entry.origin === "auto" ? "Ghost" : "Owner"}: ${entry.text}`;
    if (entry.type === "assistant") {
      const text = assistantText(entry.content).trim();
      if (text) line = `You: ${text}`;
    }
    if (entry.type === "command" && !entry.excluded) line = `Owner ran \`${entry.command}\`:\n${entry.output}`;
    if (line === null) continue;
    context = context ? `${line}\n\n${context}` : line;
    if (context.length > HANDOFF_CONTEXT_CHARS) return `…${context.slice(-HANDOFF_CONTEXT_CHARS)}`;
  }
  return context || null;
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

interface IndexedEntry {
  start: number;
  end: number;
  ordinal: number;
  first: number;
  count: number;
}
interface LogIndex {
  info: Stats;
  ordinal: number;
  total: number;
  newlineEnded: boolean;
  summary: ReturnType<typeof logStateAccumulator>;
  resources: ReturnType<typeof resourceAccumulator>;
  appended?: { from: Stats; to: Stats };
}
interface IndexedLogSnapshot {
  info: Stats;
  state: LogState;
  total: number;
  resources: RunResourceSnapshot | null;
  entries: readonly IndexedEntry[] | undefined;
  entryCount: number;
}
// Summaries remain cheap for long lists; only sixteen logs retain historical offsets.
const logIndexes = new BoundedCache<string, LogIndex>();
const offsetIndexes = new BoundedCache<string, { index: LogIndex; entries: IndexedEntry[] }>(16);

function indexSnapshot(index: LogIndex, entries?: IndexedEntry[]): IndexedLogSnapshot {
  return { info: index.info, state: index.summary.value(), total: index.total,
    resources: index.resources.value(), entries, entryCount: entries?.length ?? 0 };
}
const indexing = new Map<string, Promise<IndexedLogSnapshot | null>>();

function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}
function sameSnapshot(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function messageCount(entry: LogEntry): number {
  return entry.type === "command" ? (entry.excluded ? 0 : 2)
    : entry.type === "user" || entry.type === "assistant" || entry.type === "handoff" ? 1 : 0;
}
function parseEntry(bytes: Buffer): LogEntry | null {
  try {
    const entry = JSON.parse(bytes.toString("utf8")) as LogEntry;
    return entry && typeof entry === "object" && typeof entry.type === "string" ? entry : null;
  } catch {
    return null;
  }
}

async function scanIndex(file: FileHandle, index: LogIndex, from: number, entries?: IndexedEntry[]): Promise<void> {
  const buffer = Buffer.alloc(64 * 1024);
  let position = from;
  let lineStart = from;
  const empty = Buffer.alloc(0);
  let tail = empty;
  const accept = (bytes: Buffer, end: number) => {
    const entry = parseEntry(bytes);
    if (!entry) return;
    const count = messageCount(entry);
    if (count) entries?.push({ start: lineStart, end, ordinal: index.ordinal, first: index.total, count });
    index.ordinal += 1;
    index.total += count;
    index.summary.append(entry);
    index.resources.append(entry);
  };
  while (position < index.info.size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, index.info.size - position), position);
    if (!bytesRead) break;
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) break;
      const end = position + newline + 1;
      const part = chunk.subarray(start, newline);
      accept(tail.length ? Buffer.concat([tail, part]) : part, end);
      tail = empty;
      lineStart = end;
      start = newline + 1;
    }
    if (start < bytesRead) tail = Buffer.concat([tail, chunk.subarray(start)]);
    position += bytesRead;
  }
  index.newlineEnded = lineStart === index.info.size;
  if (tail.length) accept(tail, position);
}

async function updateIndex(path: string, needOffsets: boolean): Promise<IndexedLogSnapshot | null> {
  let file: FileHandle;
  try { file = await open(path, "r"); }
  catch (error) {
    logIndexes.delete(path);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await file.stat();
    let index = logIndexes.get(path);
    const cachedOffsets = offsetIndexes.get(path);
    let entries = cachedOffsets && cachedOffsets.index === index ? cachedOffsets.entries : undefined;
    if (index && sameSnapshot(index.info, info) && (!needOffsets || entries)) return indexSnapshot(index, entries);
    const extend = index?.newlineEnded && index.appended && (!needOffsets || entries)
      && sameSnapshot(index.info, index.appended.from) && sameSnapshot(info, index.appended.to);
    const from = extend && index ? index.info.size : 0;
    if (!extend || !index) {
      index = { info, ordinal: 0, total: 0, newlineEnded: true,
        summary: logStateAccumulator(), resources: resourceAccumulator() };
      entries = [];
    }
    index.info = info;
    index.appended = undefined;
    try { await scanIndex(file, index, from, entries); }
    catch (error) { logIndexes.delete(path); offsetIndexes.delete(path); throw error; }
    logIndexes.set(path, index);
    if (entries) offsetIndexes.set(path, { index, entries });
    return indexSnapshot(index, entries);
  } finally { await file.close(); }
}

function indexedLog(path: string, needOffsets = true): Promise<IndexedLogSnapshot | null> {
  const pending = indexing.get(path);
  if (pending) return pending.then((index) => needOffsets && index && !index.entries ? indexedLog(path, true) : index);
  const work = updateIndex(path, needOffsets).finally(() => { indexing.delete(path); });
  indexing.set(path, work);
  return work;
}

/** Seek only the requested messages once the disposable index is current. */
export async function readTranscriptPage(sessionDir: string, id: string, offset: number, limit: number): Promise<{
  messages: TranscriptMessage[]; total: number; resources: RunResourceSnapshot | null;
}> {
  const path = logPath(sessionDir, id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const index = await indexedLog(path);
    if (!index) return { messages: [], total: 0, resources: null };
    let file: FileHandle;
    try { file = await open(path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      logIndexes.delete(path);
      continue;
    }
    try {
      if (!sameSnapshot(index.info, await file.stat())) { logIndexes.delete(path); continue; }
      const messages: TranscriptMessage[] = [];
      const entries = index.entries ?? [];
      let invalid = false;
      let low = 0;
      let high = index.entryCount;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const entry = entries[middle] as IndexedEntry;
        if (entry.first + entry.count <= offset) low = middle + 1;
        else high = middle;
      }
      for (let n = low; n < index.entryCount; n++) {
        const record = entries[n] as IndexedEntry;
        if (record.first >= offset + limit) break;
        const bytes = Buffer.alloc(record.end - record.start);
        let read = 0;
        while (read < bytes.length) {
          const chunk = await file.read(bytes, read, bytes.length - read, record.start + read);
          if (!chunk.bytesRead) break;
          read += chunk.bytesRead;
        }
        const entry = parseEntry(bytes.subarray(0, read));
        if (!entry) { invalid = true; break; }
        const page = transcriptPage([entry], Math.max(0, offset - record.first), offset + limit - Math.max(offset, record.first));
        messages.push(...page.messages.map((message) => ({ ...message, entryId: message.entryId.replace(/^e0/u, `e${record.ordinal}`) })));
      }
      if (invalid || !sameSnapshot(index.info, await file.stat())) { logIndexes.delete(path); continue; }
      return { messages, total: index.total, resources: index.resources };
    } finally { await file.close(); }
  }
  // A continuously changing external writer should not turn a read into an endless retry.
  const entries = (await readLog(sessionDir, id)) ?? [];
  return { ...transcriptPage(entries, offset, limit), resources: latestRunResources(entries) };
}

/** Summary/list reads and transcript pages share one disposable file index. */
export async function listedLog(sessionDir: string, id: string): Promise<{ state: LogState; updatedAt: string } | null> {
  const indexed = await indexedLog(logPath(sessionDir, id), false);
  if (!indexed) return null;
  const state = indexed.state;
  return { state, updatedAt: state.activeAt ?? indexed.info.mtime.toISOString() };
}

/**
 * How a shell command started in a conversation names it: the variables the
 * `ghost` CLI reads in place of `-g` and `-s`. Every harness turn and owner
 * `!` command runs with them.
 */
export function conversationEnvironment(ghostName: string, id: string): { GHOST: string; GHOST_SESSION: string } {
  return { GHOST: ghostName, GHOST_SESSION: id };
}

/** Latest successful pass, including legacy snapshots written before the reply. */
function resourceAccumulator() {
  let latest: RunResourceSnapshot | null = null;
  let pending: Extract<LogEntry, { type: "resources" }> | null = null;
  let previous: Pick<Extract<LogEntry, { type: "assistant" | "handoff" }>, "type" | "harness" | "at" | "error"> | undefined;
  const append = (entry: LogEntry) => {
    if (entry.type === "user" || entry.type === "harness") pending = null;
    if (entry.type === "resources") {
      const adjacent = (previous?.type === "assistant" || previous?.type === "handoff")
        && previous.harness === entry.harness ? previous : null;
      const postReply = entry.supplied !== undefined
        || (adjacent !== null && Date.parse(entry.at) < Date.parse(adjacent.at));
      pending = null;
      if (postReply) {
        if (adjacent && !adjacent.error) latest = entry;
      } else if (entry.supplied === undefined
        && (adjacent === null || Date.parse(entry.at) > Date.parse(adjacent.at))) {
        pending = entry;
      }
    } else if (entry.type === "assistant" || entry.type === "handoff") {
      if (!entry.error) latest = pending?.harness === entry.harness
        && Date.parse(pending.at) <= Date.parse(entry.at) ? pending : null;
      pending = null;
    }
    previous = entry.type === "assistant" || entry.type === "handoff"
      ? { type: entry.type, harness: entry.harness, at: entry.at, error: entry.error } : undefined;
  };
  const value = (): RunResourceSnapshot | null => {
  if (!latest) return null;
  const { run, harness, at, resources, supplied } = latest;
  const snapshot = { run, harness, at, resources, ...(supplied ? { supplied } : {}), summary: "" };
  snapshot.summary = snapshotSummary(snapshot);
  return snapshot;
  };
  return { append, value };
}

export function latestRunResources(entries: readonly LogEntry[]): RunResourceSnapshot | null {
  const resources = resourceAccumulator();
  for (const entry of entries) resources.append(entry);
  return resources.value();
}
