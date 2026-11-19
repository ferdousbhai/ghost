/**
 * The owner's own data, one adapter per product (CONTRACTS.md "Sources").
 * Each product keeps its own sign-in, sync, local copy, and CLI; an adapter
 * only lists, reads, and searches what that product already has, through
 * its JSON output or its documented folder. Ghost copies nothing and syncs
 * nothing. File-backed sources share one meaning index, Recall's, and a hit
 * is labelled with the source whose folder holds it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { GhostError } from "./errors.js";
import { which } from "./harnesses.js";
import { resolveDocumentsDirectory, xdgBaseDir } from "./xdg-user-dirs.js";

export const SOURCE_IDS = ["files", "notes", "reminders", "whatsapp", "drive", "mail", "contacts", "calendar", "photos", "lastbook"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** What a source returns for one thing: enough to show it in a list and to read it. */
export interface SourceItem {
  readonly source: SourceId;
  /** Stable within the source; `read` takes it. */
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  /** Milliseconds since the epoch, or null when the source keeps no time. */
  readonly at: number | null;
  /** The local file, when the item is one. */
  readonly path?: string;
  /** A search hit's PDF page or matching line. */
  readonly page?: number;
  readonly line?: number;
}

/** A hit as `read` needs it: the item's locators, and Recall's passage for a file. */
export interface SourceRef {
  readonly source: SourceId;
  readonly id: string;
  readonly page?: number;
  readonly line?: number;
  /** Recall's segment id; valid until Recall reindexes, so never on the wire. */
  readonly segment?: number;
}

/** One item read: its text and which part of it that is. */
export interface SourceDocument {
  readonly title: string;
  readonly text: string;
  /** `whole`, `passage`, `start`, `lines 12-91`, `page 3`, `latest`. */
  readonly part: string;
  readonly path?: string;
}

export interface SourceContext {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface SourcePage {
  readonly items: readonly SourceItem[];
  /** Pass back as `cursor` for the next page; null on the last. */
  readonly next: string | null;
}

interface Source {
  readonly id: SourceId;
  readonly label: string;
  available(context: SourceContext): boolean;
  list?(context: SourceContext, limit: number, cursor: string | null): Promise<SourcePage>;
  read?(context: SourceContext, ref: SourceRef): Promise<SourceDocument>;
  search?(context: SourceContext, query: string, limit: number): Promise<SourceItem[]>;
}

/** The most text one read returns; a model's result is cut far shorter. */
const READ_CHARS = 256 * 1024;

// ── Helpers ────────────────────────────────────────────────────────────

export function runCommand(command: string, args: string[], context: SourceContext, input?: string): Promise<{ out: string; error: string | null }> {
  return new Promise((done) => {
    const child = execFile(command, args, { env: context.env, signal: context.signal, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ out: String(stdout), error: error ? (String(stderr).trim() || error.message) : null });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** A product CLI's `--quiet` data, or the 502 that names the product's own error. */
async function cliData(command: string, args: string[], context: SourceContext): Promise<unknown> {
  const { out, error } = await runCommand(command, args, context);
  const data = json(out);
  if (error && data === null) throw new GhostError("source_failed", `${command} failed: ${oneLine(error, 300)}`, 502);
  return data;
}

export const oneLine = (text: unknown, limit: number) => String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);

export function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null) : [];

const ms = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Newest first, from before a time cursor, one page of `limit`. */
function timePage(items: SourceItem[], limit: number, cursor: string | null): SourcePage {
  const before = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
  const sorted = items.filter((item) => (item.at ?? 0) < before).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const page = sorted.slice(0, limit);
  const last = page.at(-1);
  return { items: page, next: sorted.length > limit && last ? String(last.at ?? 0) : null };
}

/** An offset page, for sources with no time order. */
function offsetPage(items: SourceItem[], limit: number, cursor: string | null): SourcePage {
  const from = cursor === null ? 0 : Math.max(0, Number(cursor) || 0);
  return { items: items.slice(from, from + limit), next: from + limit < items.length ? String(from + limit) : null };
}

const inside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !rel.split(sep).includes("..");
};

async function fileText(path: string): Promise<{ text: string; whole: boolean } | null> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(READ_CHARS + 1);
    const { bytesRead } = await file.read(buffer, 0, READ_CHARS + 1, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, READ_CHARS));
    return bytes.includes(0) ? null : { text: bytes.toString("utf8"), whole: bytesRead <= READ_CHARS };
  } finally {
    await file.close();
  }
}

async function fileTail(path: string, chars: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, chars);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await file.close();
  }
}

async function pdfPage(path: string, page: number, context: SourceContext): Promise<SourceDocument> {
  const { out, error } = await runCommand("pdftotext", ["-layout", "-f", String(page), "-l", String(page), path, "-"], context);
  if (error) throw new GhostError("source_failed", `Cannot read page ${page} of ${path}: ${oneLine(error, 300)}`, 502);
  // Layout mode keeps a table's rows together; its column padding is collapsed, which halves an invoice page.
  return { title: basename(path), path, part: `page ${page}`, text: out.replace(/[ \t]{2,}/gu, "  ").trim() || "(no text on this page)" };
}

// ── Folders ────────────────────────────────────────────────────────────

/** The products' documented folders, so a file hit is labelled with its source. */
function folders(context: SourceContext): Array<{ source: SourceId; root: string }> {
  const documents = resolveDocumentsDirectory(context.env, context.home);
  return [
    { source: "notes", root: join(documents, "Notes") },
    { source: "reminders", root: join(documents, "Reminders") },
    { source: "whatsapp", root: join(context.home, "WhatsApp") },
    { source: "drive", root: join(context.home, "iCloud Drive") },
  ];
}

function sourceOfPath(path: string, context: SourceContext): SourceId {
  return folders(context).find((folder) => inside(folder.root, path))?.source ?? "files";
}

function folderOf(source: SourceId, context: SourceContext): string {
  return folders(context).find((folder) => folder.source === source)?.root ?? context.home;
}

/** Recall's folders and exclusions, so the keyword search covers what Recall would; home alone without Recall. */
async function recallFolders(context: SourceContext): Promise<{ roots: string[]; excluded: string[] }> {
  if (!which("recall", context.env)) return { roots: [context.home], excluded: [] };
  const config = json((await runCommand("recall", ["config"], context)).out) as { roots?: unknown; excluded_folders?: unknown } | null;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const roots = strings(config?.roots);
  return { roots: roots.length ? roots : [context.home], excluded: strings(config?.excluded_folders) };
}

/** A path the files source may read: inside Recall's folders and outside its exclusions. */
async function readablePath(path: string, context: SourceContext): Promise<boolean> {
  const { roots, excluded } = await recallFolders(context);
  return roots.some((root) => inside(root, path)) && !excluded.some((folder) => inside(folder, path) || resolve(folder) === resolve(path));
}

// ── Files: Recall, ripgrep, fd ─────────────────────────────────────────

/**
 * Files whose names match, typos forgiven: fd lists the files and fzf ranks
 * their names (Omarchy's `ff`); fd's plain substring match without fzf.
 */
async function matchNames(pattern: string, roots: string[], names: string[], context: SourceContext): Promise<string[]> {
  if (!which("fd", context.env)) return [];
  const skip = names.flatMap((name) => ["--exclude", name]);
  if (!which("fzf", context.env)) {
    return (await runCommand("fd", ["-i", "-F", "--max-results", "5", ...skip, "--", pattern, ...roots], context)).out.split("\n").filter(Boolean);
  }
  const files = await runCommand("fd", ["-t", "f", ...skip, ".", ...roots], context);
  const ranked = await runCommand("fzf", ["--filter", pattern, "--delimiter", "/", "--nth", "-1"], context, files.out);
  return ranked.out.split("\n").filter(Boolean).slice(0, 5);
}

/**
 * ripgrep for the words in files and fd for them in names, both shipped with
 * Omarchy, over Recall's folders: exact words and files Recall has not indexed
 * yet, and everything when Recall is missing or failing. A short query is one
 * phrase, a longer one its two longest words.
 */
async function searchKeywords(query: string, context: SourceContext): Promise<Array<{ path: string; line?: number; text: string }>> {
  const words = query.match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) ?? [];
  if (words.length === 0) return [];
  const patterns = words.length <= 3 ? [words.join(" ")] : [...words].sort((a, b) => b.length - a.length).slice(0, 2);
  const { roots, excluded } = await recallFolders(context);
  const names = excluded.map((folder) => folder.split("/").at(-1) as string);
  const [grep, find] = await Promise.all([
    which("rg", context.env)
      ? runCommand("rg", ["-i", "-F", "-n", "--max-count", "1", "--max-columns", "300", "--max-filesize", "10M",
        ...names.flatMap((name) => ["--glob", `!${name}/**`]), ...patterns.flatMap((pattern) => ["-e", pattern]), ...roots], context)
      : null,
    matchNames(patterns.join(" "), roots, names, context),
  ]);
  const matches = (grep?.out ?? "").split("\n").flatMap((match) => {
    const at = /^(.*?):(\d+):(.*)$/u.exec(match);
    return at ? [{ path: at[1] as string, line: Number(at[2]), text: oneLine(at[3], 300) }] : [];
  });
  return [...matches, ...find.map((path) => ({ path, text: "(name matches)" }))];
}

/** A WhatsApp hit is titled by its chat, not `_chat.txt`. */
function fileTitle(path: string, source: SourceId): string {
  if (source === "whatsapp") return basename(dirname(path)).replace(/^WhatsApp Chat - /u, "");
  return basename(path);
}

/** Recall's hits by meaning and keywords, then ripgrep's and fd's that Recall did not return; a ref per hit for `read`. */
export async function searchFiles(query: string, context: SourceContext, limit: number): Promise<Array<{ item: SourceItem; ref: SourceRef }>> {
  const [recall, keywords] = await Promise.all([
    which("recall", context.env) ? runCommand("recall", ["search", "--limit", String(limit), "--", query], context) : null,
    searchKeywords(query, context),
  ]);
  const found = !recall || recall.error ? [] : records((json(recall.out) as { hits?: unknown } | null)?.hits);
  const results = found.map((hit) => {
    const path = String(hit.path);
    const location = String(hit.location ?? "");
    const page = /^(?:page|p\.)\s*(\d+)/u.exec(location)?.[1];
    const source = sourceOfPath(path, context);
    const item: SourceItem = {
      source, id: path, path, title: fileTitle(path, source),
      snippet: `${location ? `(${location}) ` : ""}${oneLine(hit.excerpt, 500)}`,
      at: typeof hit.modified === "number" ? hit.modified * 1000 : null,
      ...(page ? { page: Number(page) } : {}),
    };
    return { item, ref: { source, id: path, ...(page ? { page: Number(page) } : {}), ...(typeof hit.segment_id === "number" ? { segment: hit.segment_id } : {}) } };
  });
  const seen = new Set(found.map((hit) => String(hit.path)));
  for (const match of keywords) {
    if (seen.has(match.path) || results.length >= found.length + 6) continue;
    seen.add(match.path);
    const source = sourceOfPath(match.path, context);
    const line = match.line === undefined ? {} : { line: match.line };
    results.push({
      item: { source, id: match.path, path: match.path, title: fileTitle(match.path, source), snippet: match.line ? `(line ${match.line}) ${match.text}` : match.text, at: null, ...line },
      ref: { source, id: match.path, ...line },
    });
  }
  return results;
}

/**
 * Read a file: a PDF's page, the lines around a match, the whole file when
 * it fits `chars`, else Recall's passage, else (a file Recall has not
 * indexed) its start.
 */
export async function readFileRef(ref: SourceRef, context: SourceContext, chars = READ_CHARS): Promise<SourceDocument> {
  const path = ref.id;
  const title = fileTitle(path, ref.source);
  if (/\.pdf$/iu.test(path)) return pdfPage(path, ref.page ?? 1, context);
  if (ref.line !== undefined) {
    const lines = (await readFile(path, "utf8")).split("\n");
    const from = Math.max(0, ref.line - 20);
    return { title, path, part: `lines ${from + 1}-${Math.min(lines.length, from + 80)}`, text: lines.slice(from, from + 80).join("\n") };
  }
  const head = await fileText(path).catch(() => null);
  if (head?.whole && head.text.length <= chars) return { title, path, part: "whole", text: head.text };
  if (ref.segment !== undefined) {
    const { out, error } = await runCommand("recall", ["text", String(ref.segment)], context);
    const text = (json(out) as { text?: unknown } | null)?.text;
    if (!error && typeof text === "string") return { title, path, part: "passage", text };
  }
  if (!head) throw new GhostError("source_failed", `${path} cannot be read as text.`, 422);
  return { title, path, part: "start", text: head.text };
}

const files: Source = {
  id: "files",
  label: "Files",
  available: () => true,
  async read(context, ref) {
    if (!(await readablePath(ref.id, context))) throw new GhostError("not_found", "That file is outside the folders Ghost searches.", 404);
    return readFileRef(ref, context);
  },
  async search(context, query, limit) {
    return (await searchFiles(query, context, limit)).map(({ item }) => item);
  },
};

/** A source whose items are files in one product folder, searched through the shared file search. */
function folderSource(id: SourceId, label: string, list: Source["list"], read?: Source["read"]): Source {
  return {
    id,
    label,
    available: (context) => existsSync(folderOf(id, context)),
    ...(list ? { list } : {}),
    async read(context, ref) {
      if (read) return read(context, ref);
      if (!inside(folderOf(id, context), ref.id)) throw new GhostError("not_found", `That is not in ${label}.`, 404);
      return readFileRef(ref, context);
    },
    async search(context, query, limit) {
      return (await searchFiles(query, context, limit * 3)).map(({ item }) => item).filter((item) => item.source === id).slice(0, limit);
    },
  };
}

// ── Notes and reminders: Ghost's own state, as Markdown ────────────────
//
// `Documents/Notes` and `Documents/Reminders` are where a ghost keeps what it
// must know next time, with or without iCloud: icloud-notes and
// icloud-reminders sync these same folders when the owner connects them, in
// these same formats, and nothing here needs either installed.

/** A note's text without the `apple-note-id` header icloud-notes keeps at its top. */
function noteBody(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n+/u, "");
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.filter((entry) => !entry.name.startsWith(".")).map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }));
  return found.flat();
}

/** The start of a file, enough for a list row's snippet. */
async function fileStart(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

const notes: Source = {
  ...folderSource("notes", "Notes", async (context, limit, cursor) => {
    const root = folderOf("notes", context);
    const items = await Promise.all((await markdownFiles(root)).map(async (path): Promise<SourceItem> => {
      const lines = noteBody(await fileStart(path).catch(() => "")).split("\n").map((line) => line.replace(/^#+\s*/u, "").trim()).filter(Boolean);
      const title = basename(path).replace(/\.md$/u, "");
      return { source: "notes", id: path, path, title, snippet: oneLine(lines.find((line) => line !== title) ?? "", 300), at: (await stat(path)).mtimeMs };
    }));
    return timePage(items, limit, cursor);
  }, async (context, ref) => {
    if (!inside(folderOf("notes", context), ref.id)) throw new GhostError("not_found", "That is not in Notes.", 404);
    const document = await readFileRef(ref, context);
    return document.part === "whole" || document.part === "start" ? { ...document, text: noteBody(document.text) } : document;
  }),
  available: () => true,
};

/** A note's or list's name as a file name: one line, no path separators, not hidden. */
function fileName(name: string, what: string): string {
  const clean = name.replace(/[\\/\p{Cc}]/gu, " ").replace(/\s+/gu, " ").replace(/^[.\s]+/u, "").slice(0, 120).trim();
  if (!clean) throw new GhostError("invalid_request", `${what} needs a name.`, 400);
  return clean;
}

async function appendText(path: string, text: string, opening: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readFile(path, "utf8").catch(() => null);
  await writeFile(path, existing === null ? `${opening}${text}\n` : `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${text}\n`);
  return existing === null;
}

/** Keep something for later: a new note `Notes/<title>.md`, or more text at the end of that note. */
export async function saveNote(context: SourceContext, title: string, text: string): Promise<{ path: string; created: boolean }> {
  const body = text.trim();
  if (!body) throw new GhostError("invalid_request", "A note needs text.", 400);
  const name = fileName(title, "A note");
  const path = join(folderOf("notes", context), `${name}.md`);
  const created = await appendText(path, body, `# ${name}\n\n`);
  return { path, created };
}

/**
 * Add one reminder to `Reminders/<list>.md`, icloud-reminders' own format:
 * a `- [ ]` line, its due date after 📅. The date is absolute, so the line
 * means the same day whenever it is read.
 */
export async function addReminder(context: SourceContext, text: string, list = "Reminders", due?: string): Promise<{ path: string; line: string }> {
  const what = oneLine(text, 500);
  if (!what) throw new GhostError("invalid_request", "A reminder needs text.", 400);
  if (due !== undefined && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/u.test(due)) {
    throw new GhostError("invalid_request", "A due date is YYYY-MM-DD, or YYYY-MM-DD HH:MM.", 400);
  }
  const name = fileName(list, "A reminder list");
  const path = join(folderOf("reminders", context), `${name}.md`);
  const line = `- [ ] ${what}${due ? ` 📅 ${due}` : ""}`;
  await appendText(path, line, `# ${name}\n\n`);
  return { path, line };
}

// ── Reminders: the lists icloud-reminders keeps as Markdown files ──────

const reminders: Source = { ...folderSource("reminders", "Reminders", async (context, limit, cursor) => {
  const root = folderOf("reminders", context);
  const names = (await readdir(root).catch(() => [])).filter((name) => name.endsWith(".md"));
  const items = await Promise.all(names.map(async (name): Promise<SourceItem> => {
    const path = join(root, name);
    const open = (await readFile(path, "utf8").catch(() => "")).split("\n").filter((line) => /^\s*- \[ \]/u.test(line));
    return {
      source: "reminders", id: path, path, title: name.replace(/\.md$/u, ""),
      snippet: `${open.length} open${open[0] ? `: ${oneLine(open[0].replace(/^\s*- \[ \]\s*/u, ""), 200)}` : ""}`,
      at: (await stat(path)).mtimeMs,
    };
  }));
  return timePage(items, limit, cursor);
}), available: () => true };

// ── WhatsApp: wacli's chat folders ─────────────────────────────────────

/**
 * Every chat wacli keeps, as its documented folders
 * (`~/WhatsApp/<account>/WhatsApp Chat - <name>/_chat.txt`), newest first
 * by when the chat last changed. Reading them needs no wacli.
 */
async function whatsappChats(context: SourceContext): Promise<SourceItem[]> {
  const root = folderOf("whatsapp", context);
  const accounts = await readdir(root, { withFileTypes: true }).catch(() => []);
  const chats = await Promise.all(accounts.filter((entry) => entry.isDirectory()).map(async (account) => {
    const dir = join(root, account.name);
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.startsWith("WhatsApp Chat - "));
    return Promise.all(names.map(async (name): Promise<SourceItem | null> => {
      const path = join(dir, name, "_chat.txt");
      const info = await stat(path).catch(() => null);
      return info ? { source: "whatsapp", id: path, path, title: fileTitle(path, "whatsapp"), snippet: account.name, at: info.mtimeMs } : null;
    }));
  }));
  return chats.flat().filter((chat): chat is SourceItem => chat !== null);
}

const whatsapp = folderSource("whatsapp", "WhatsApp", async (context, limit, cursor) => timePage(await whatsappChats(context), limit, cursor),
  async (context, ref) => {
    if (!inside(folderOf("whatsapp", context), ref.id) || !ref.id.endsWith("_chat.txt")) throw new GhostError("not_found", "No such chat.", 404);
    if (ref.line !== undefined || ref.segment !== undefined) return readFileRef(ref, context);
    return { title: fileTitle(ref.id, "whatsapp"), path: ref.id, part: "latest", text: await fileTail(ref.id, READ_CHARS) };
  });

const drive = folderSource("drive", "iCloud Drive", undefined);

// ── Mail: cloudmail ────────────────────────────────────────────────────

function mailItem(thread: Record<string, unknown>): SourceItem {
  const from = thread.from as { name?: string; email?: string } | undefined;
  return {
    source: "mail", id: String(thread.id), title: oneLine(thread.subject, 200) || "(no subject)",
    snippet: `${oneLine(from?.name ?? from?.email ?? "", 80)}: ${oneLine(thread.snippet, 300)}`, at: ms(thread.last_at),
  };
}

const mail: Source = {
  id: "mail",
  label: "Mail",
  available: (context) => which("cloudmail", context.env) !== null,
  async list(context, limit, cursor) {
    const rows = records(await cliData("cloudmail", ["inbox", "--quiet", "-n", String(limit + 1), ...(cursor ? ["--before", cursor] : [])], context));
    const items = rows.slice(0, limit).map(mailItem);
    return { items, next: rows.length > limit ? String(items.at(-1)?.at ?? "") || null : null };
  },
  async read(context, ref) {
    const body = (await cliData("cloudmail", ["thread", "read", "--quiet", "--", ref.id], context)) as { thread?: Record<string, unknown>; messages?: unknown } | null;
    if (!body?.thread) throw new GhostError("not_found", "No such mail thread.", 404);
    const text = records(body.messages).map((message) => {
      const from = message.from as { name?: string; email?: string } | undefined;
      const when = ms(message.date);
      return `From: ${from?.name ?? ""} <${from?.email ?? ""}>${when ? `\nDate: ${new Date(when).toISOString()}` : ""}\n\n${String(message.text ?? "").trim()}`;
    }).join("\n\n---\n\n");
    return { title: oneLine(body.thread.subject, 200), text, part: "whole" };
  },
  /** Cloudmail matches every word, so a long query falls back to its two longest words. */
  async search(context, query, limit) {
    const words = query.match(/[\p{L}\p{N}@.'-]+/gu) ?? [];
    const attempts = [words.join(" "), ...(words.length > 2 ? [[...words].sort((a, b) => b.length - a.length).slice(0, 2).join(" ")] : [])];
    for (const attempt of attempts) {
      if (!attempt) continue;
      const threads = records(await cliData("cloudmail", ["search", "--quiet", "-n", String(limit), "--", ...attempt.split(" ")], context));
      if (threads.length > 0) return threads.map(mailItem);
    }
    return [];
  },
};

// ── Contacts: icloud-contacts, from its last sync ─────────────────────

function contactItem(contact: Record<string, unknown>): SourceItem {
  const first = (value: unknown) => records(value)[0]?.value;
  const detail = [contact.company, first(contact.phones), first(contact.emails)].filter(Boolean).map((value) => oneLine(value, 80)).join(" · ");
  return { source: "contacts", id: String(contact.id), title: oneLine(contact.name, 200) || "(no name)", snippet: detail, at: null };
}

const contacts: Source = {
  id: "contacts",
  label: "Contacts",
  available: (context) => which("icloud-contacts", context.env) !== null,
  async list(context, limit, cursor) {
    return offsetPage(records(await cliData("icloud-contacts", ["list", "--cached", "--quiet"], context)).map(contactItem), limit, cursor);
  },
  async read(context, ref) {
    const contact = (await cliData("icloud-contacts", ["show", "--cached", "--quiet", "--", ref.id], context)) as Record<string, unknown> | null;
    if (!contact || typeof contact !== "object") throw new GhostError("not_found", "No such contact.", 404);
    return { title: oneLine(contact.name, 200), text: JSON.stringify(contact, null, 2), part: "whole" };
  },
  async search(context, query, limit) {
    if (query.split(/\s+/u).length > 3) return [];
    return records(await cliData("icloud-contacts", ["list", "--cached", "--quiet", "--", query], context)).slice(0, limit).map(contactItem);
  },
};

// ── Calendar: cloud-calendar's agenda ──────────────────────────────────

/** Days per calendar page, from today forward; the cursor is the next page's first day. */
const CALENDAR_DAYS = 14;

const calendar: Source = {
  id: "calendar",
  label: "Calendar",
  available: (context) => which("cloud-calendar", context.env) !== null,
  async list(context, limit, cursor) {
    const from = cursor ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(from)) throw new GhostError("invalid_request", "A calendar cursor is a YYYY-MM-DD day.", 400);
    const events = records(await cliData("cloud-calendar", ["agenda", "--from", from, "--days", String(CALENDAR_DAYS), "--quiet"], context));
    const next = new Date(Date.parse(`${from}T00:00:00Z`) + CALENDAR_DAYS * 86_400_000).toISOString().slice(0, 10);
    const items = events.slice(0, limit).map((event): SourceItem => ({
      source: "calendar", id: String(event.id), title: oneLine(event.title, 200) || "(no title)",
      snippet: `${event.all_day ? "all day" : `${String(event.start ?? "")} – ${String(event.end ?? "")}`} · ${oneLine(event.calendar, 80)}`,
      at: ms(event.start),
    }));
    return { items, next };
  },
};

// ── Photos: icloud-photos' catalog ─────────────────────────────────────

/** icloud-photos lists newest first with no offset, so a page is cut from one long listing. */
const PHOTOS_LISTED = 5_000;

const photos: Source = {
  id: "photos",
  label: "Photos",
  available: (context) => which("icloud-photos", context.env) !== null,
  async list(context, limit, cursor) {
    const rows = records(await cliData("icloud-photos", ["list", "--limit", String(PHOTOS_LISTED), "--quiet"], context));
    return timePage(rows.map((row): SourceItem => ({
      source: "photos", id: String(row.id), title: oneLine(row.filename, 200),
      snippet: `${String(row.kind ?? "photo")} · ${Number(row.width ?? 0)}×${Number(row.height ?? 0)}`,
      at: ms(row.created) ?? (typeof row.created_unix === "number" ? row.created_unix * 1000 : null),
      ...(typeof row.local_path === "string" ? { path: row.local_path } : {}),
    })), limit, cursor);
  },
  async read(context, ref) {
    const info = (await cliData("icloud-photos", ["info", "--quiet", "--", ref.id], context)) as Record<string, unknown> | null;
    if (!info || typeof info !== "object") throw new GhostError("not_found", "No such photo.", 404);
    return { title: oneLine(info.filename, 200), text: JSON.stringify(info, null, 2), part: "whole" };
  },
};

// ── Lastbook: its library's search index, read-only ────────────────────

function lastbookDb(context: SourceContext): string {
  return join(xdgBaseDir(context.env, "XDG_DATA_HOME", context.home), "Lastbook", "LastbookData", "library-data", "search.sqlite");
}

/** FTS5 words, each quoted so punctuation cannot become query syntax. */
function ftsWords(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12).map((word) => `"${word}"`);
}

const lastbook: Source = {
  id: "lastbook",
  label: "Lastbook",
  available: (context) => existsSync(lastbookDb(context)),
  async read(context, ref) {
    const library = dirname(lastbookDb(context));
    if (!inside(library, ref.id)) throw new GhostError("not_found", "That is not in the Lastbook library.", 404);
    return pdfPage(ref.id, ref.page ?? 1, context);
  },
  async search(context, query, limit) {
    const path = lastbookDb(context);
    const words = ftsWords(query);
    if (words.length === 0 || !existsSync(path)) return [];
    const { Database } = await import("bun:sqlite");
    // A pack's index is static; read-only takes no write lock. (Bun opens paths, not `file:` URIs.)
    const db = new Database(path, { readonly: true });
    try {
      const statement = db.query(
        "SELECT title, page, path, snippet(pages, 6, '', '', '…', 40) AS excerpt FROM pages WHERE pages MATCH ? ORDER BY bm25(pages, 0, 6, 1, 1, 0, 0, 1) LIMIT ?",
      );
      let rows = statement.all(words.join(" "), limit) as Array<{ title: string; page: number; path: string; excerpt: string }>;
      if (rows.length === 0 && words.length > 1) rows = statement.all(words.join(" OR "), limit) as typeof rows;
      return rows.map((row) => {
        const file = join(dirname(path), row.path);
        return { source: "lastbook", id: file, path: file, page: row.page, title: `${row.title}, page ${row.page}`, snippet: oneLine(row.excerpt, 500), at: null };
      });
    } finally {
      db.close();
    }
  },
};

// ── The registry ───────────────────────────────────────────────────────

const SOURCES: Record<SourceId, Source> = { files, notes, reminders, whatsapp, drive, mail, contacts, calendar, photos, lastbook };

export interface SourceSummary {
  readonly id: SourceId;
  readonly label: string;
  readonly available: boolean;
  readonly list: boolean;
  readonly read: boolean;
  readonly search: boolean;
}

export function listSources(context: SourceContext): SourceSummary[] {
  return SOURCE_IDS.map((id) => {
    const source = SOURCES[id];
    return { id, label: source.label, available: source.available(context), list: Boolean(source.list), read: Boolean(source.read), search: Boolean(source.search) };
  });
}

function source(id: string, context: SourceContext): Source {
  const found = (SOURCE_IDS as readonly string[]).includes(id) ? SOURCES[id as SourceId] : undefined;
  if (!found) throw new GhostError("not_found", `There is no source "${id}".`, 404);
  if (!found.available(context)) throw new GhostError("source_unavailable", `${found.label} is not set up on this computer.`, 409);
  return found;
}

export async function listSource(id: string, context: SourceContext, limit: number, cursor: string | null): Promise<SourcePage> {
  const found = source(id, context);
  if (!found.list) throw new GhostError("not_listable", `${found.label} has no list; search it instead.`, 405);
  return found.list(context, limit, cursor);
}

export async function readSource(ref: SourceRef, context: SourceContext): Promise<SourceDocument> {
  const found = source(ref.source, context);
  if (!found.read) throw new GhostError("not_readable", `${found.label} items are read from its list.`, 405);
  const document = await found.read(context, ref);
  return document.text.length > READ_CHARS ? { ...document, text: document.text.slice(0, READ_CHARS) } : document;
}

/** Search one source, or every searchable one; a failing source is named, not fatal. */
export async function searchSources(
  query: string,
  context: SourceContext,
  options: { sources?: readonly string[]; limit?: number } = {},
): Promise<{ items: SourceItem[]; failed: Array<{ source: SourceId; message: string }> }> {
  const q = query.trim();
  if (!q) throw new GhostError("invalid_request", "A search needs a query.", 400);
  const limit = options.limit ?? 8;
  const wanted = options.sources?.map((id) => source(id, context)) ?? [files, lastbook, mail, contacts].filter((found) => found.available(context));
  const failed: Array<{ source: SourceId; message: string }> = [];
  const parts = await Promise.all(wanted.map(async (found) => {
    try {
      return (await found.search?.(context, q, limit)) ?? [];
    } catch (error) {
      failed.push({ source: found.id, message: (error as Error).message });
      return [];
    }
  }));
  return { items: parts.flat(), failed };
}
