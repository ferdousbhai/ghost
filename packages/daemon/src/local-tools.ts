/**
 * The local model's tools (CONTRACTS.md "Local model"): `search` over the
 * owner's content, `read` of one search hit by its id, and `delegate`, which
 * the turn hands to a harness. Like Lastbook's, the tools take ids, never
 * paths: the model reads only what a search returned.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { which } from "./harnesses.js";
import { xdgBaseDir } from "./xdg-user-dirs.js";

/** The characters of one tool result the model is given. */
export const TOOL_RESULT_CHARS = 8_000;
/** A text file this short is read whole rather than as Recall's passage. */
const WHOLE_FILE_CHARS = 8_000;

interface ToolSpec {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };
}

export interface ToolContext {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/** Where a search hit came from, so `read` can open it. */
type Hit =
  | { readonly kind: "file"; readonly path: string; readonly segment: number | null; readonly page: number | null; readonly line?: number }
  | { readonly kind: "lastbook"; readonly path: string; readonly page: number }
  | { readonly kind: "mail"; readonly thread: string }
  | { readonly kind: "contact"; readonly contact: string };

/** One pass's search hits, keyed `S1`, `S2`, …; a pass's ids mean nothing in the next. */
export class Hits {
  private readonly byId = new Map<string, Hit>();
  add(hit: Hit): string {
    const id = `S${this.byId.size + 1}`;
    this.byId.set(id, hit);
    return id;
  }
  /** The ids of the first `count` hits that are files or library pages, in search order. */
  documents(count: number): string[] {
    return [...this.byId].filter(([, hit]) => hit.kind === "file" || hit.kind === "lastbook").slice(0, count).map(([id]) => id);
  }
  get(id: string): Hit | undefined {
    return this.byId.get(id.trim().toUpperCase());
  }
}

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const LOCAL_TOOLS: readonly ToolSpec[] = [
  spec("search",
    "Search the owner's content: notes, reminders, documents, WhatsApp chats, pictures, iCloud Drive and Downloads (by meaning and keywords), mail and contacts (by keywords), and the Lastbook offline library. Each hit has an id for read.",
    { query: { type: "string", description: "What to look for. For mail and contacts, a few keywords or a name work best." } }, ["query"]),
  spec("read", "Read one search hit in full, by its id (S1, S2, …).",
    { id: { type: "string", description: "The hit's id." }, page: { type: "integer", description: "For a PDF, a page other than the hit's." } }, ["id"]),
  spec("delegate",
    "Hand a task you cannot do with search and read (acting, sending, changing, anything on the web or in code) to a cloud agent on this computer, which has full access. It answers with what it did. The task leaves this computer: include only what it needs.",
    { task: { type: "string", description: "The whole task, self-contained." } }, ["task"]),
];

function lastbookSearchDb(env: NodeJS.ProcessEnv, home: string): string {
  return join(xdgBaseDir(env, "XDG_DATA_HOME", home), "Lastbook", "LastbookData", "library-data", "search.sqlite");
}

function run(command: string, args: string[], context: ToolContext, input?: string): Promise<{ out: string; error: string | null }> {
  return new Promise((done) => {
    const child = execFile(command, args, { env: context.env, signal: context.signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ out: String(stdout), error: error ? (String(stderr).trim() || error.message) : null });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/**
 * Files whose names match, typos forgiven: fd lists the files and fzf ranks
 * their names (Omarchy's `ff`); fd's plain substring match without fzf.
 */
async function matchNames(pattern: string, roots: string[], names: string[], context: ToolContext): Promise<string[]> {
  if (!which("fd", context.env)) return [];
  const skip = names.flatMap((name) => ["--exclude", name]);
  if (!which("fzf", context.env)) {
    return (await run("fd", ["-i", "-F", "--max-results", "5", ...skip, pattern, ...roots], context)).out.split("\n").filter(Boolean);
  }
  const files = await run("fd", ["-t", "f", ...skip, ".", ...roots], context);
  const ranked = await run("fzf", ["--filter", pattern, "--delimiter", "/", "--nth", "-1"], context, files.out);
  return ranked.out.split("\n").filter(Boolean).slice(0, 5);
}

function clip(text: string, limit = TOOL_RESULT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (cut at ${limit} characters)`;
}

const oneLine = (text: unknown, limit: number) => String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Recall's folders and exclusions, so the fallback searches what Recall would; home alone without Recall. */
async function recallFolders(context: ToolContext): Promise<{ roots: string[]; excluded: string[] }> {
  if (!which("recall", context.env)) return { roots: [context.home], excluded: [] };
  const config = json((await run("recall", ["config"], context)).out) as { roots?: unknown; excluded_folders?: unknown } | null;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const roots = strings(config?.roots);
  return { roots: roots.length ? roots : [context.home], excluded: strings(config?.excluded_folders) };
}

/**
 * ripgrep for the words in files and fd for them in names, both shipped with
 * Omarchy, over Recall's folders: exact words and files Recall has not indexed
 * yet, and everything when Recall is missing or failing. Keywords only: a
 * short query as one phrase, a longer one as its two longest words. Paths
 * Recall already returned are skipped.
 */
async function searchKeywords(query: string, context: ToolContext): Promise<Array<{ path: string; line?: number; text: string }>> {
  const words = query.match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) ?? [];
  if (words.length === 0) return [];
  const patterns = words.length <= 3 ? [words.join(" ")] : [...words].sort((a, b) => b.length - a.length).slice(0, 2);
  const { roots, excluded } = await recallFolders(context);
  const names = excluded.map((folder) => folder.split("/").at(-1) as string);
  const [grep, find] = await Promise.all([
    which("rg", context.env)
      ? run("rg", ["-i", "-F", "-n", "--max-count", "1", "--max-columns", "300", "--max-filesize", "10M",
        ...names.flatMap((name) => ["--glob", `!${name}/**`]), ...patterns.flatMap((pattern) => ["-e", pattern]), ...roots], context)
      : null,
    matchNames(patterns.join(" "), roots, names, context),
  ]);
  const matches = (grep?.out ?? "").split("\n").flatMap((match) => {
    const at = /^(.*?):(\d+):(.*)$/u.exec(match);
    return at ? [{ path: at[1] as string, line: Number(at[2]), text: `(line ${at[2]})\n    ${oneLine(at[3], 300)}` }] : [];
  });
  const named = find.map((path) => ({ path, text: "(name matches)" }));
  return [...matches, ...named];
}

/** A source's hit before it is numbered, or a note that the source failed. */
type Found = { readonly hit: Hit; readonly text: string } | { readonly note: string };

/** Recall's hits by meaning and keywords, then ripgrep's and fd's, run alongside, that Recall did not return. */
async function searchFiles(query: string, context: ToolContext, limit: number): Promise<Found[]> {
  const [recall, keywords] = await Promise.all([
    which("recall", context.env) ? run("recall", ["search", query, "--limit", String(limit)], context) : null,
    searchKeywords(query, context),
  ]);
  const found = !recall || recall.error ? [] : ((json(recall.out) as { hits?: Array<Record<string, unknown>> } | null)?.hits ?? []);
  const results: Found[] = found.map((hit) => {
    const location = String(hit.location ?? "");
    const page = /^(?:page|p\.)\s*(\d+)/u.exec(location)?.[1];
    return {
      hit: { kind: "file", path: String(hit.path), segment: typeof hit.segment_id === "number" ? hit.segment_id : null, page: page ? Number(page) : null },
      text: `${String(hit.path)}${location ? ` (${location})` : ""}\n    ${oneLine(hit.excerpt, 500)}`,
    };
  });
  const seen = new Set(found.map((hit) => String(hit.path)));
  for (const match of keywords) {
    if (seen.has(match.path) || results.length >= found.length + 6) continue;
    seen.add(match.path);
    results.push({ hit: { kind: "file", path: match.path, segment: null, page: null, ...(match.line ? { line: match.line } : {}) }, text: `${match.path} ${match.text}` });
  }
  return results;
}

/** FTS5 words, each quoted so punctuation cannot become query syntax. */
function ftsWords(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12).map((word) => `"${word}"`);
}

/** Lastbook's library index, opened read-only. */
async function searchLastbook(query: string, context: ToolContext, limit: number): Promise<Found[]> {
  const path = lastbookSearchDb(context.env, context.home);
  const words = ftsWords(query);
  if (words.length === 0 || !existsSync(path)) return [];
  const { Database } = await import("bun:sqlite");
  let db: InstanceType<typeof Database> | null = null;
  try {
    // A pack's index is static; read-only takes no write lock. (Bun opens paths, not `file:` URIs.)
    db = new Database(path, { readonly: true });
    const statement = db.query(
      "SELECT title, page, path, snippet(pages, 6, '', '', '…', 40) AS excerpt FROM pages WHERE pages MATCH ? ORDER BY bm25(pages, 0, 6, 1, 1, 0, 0, 1) LIMIT ?",
    );
    let rows = statement.all(words.join(" "), limit) as Array<{ title: string; page: number; path: string; excerpt: string }>;
    if (rows.length === 0 && words.length > 1) rows = statement.all(words.join(" OR "), limit) as typeof rows;
    return rows.map((row) => ({
      hit: { kind: "lastbook", path: join(path, "..", row.path), page: row.page },
      text: `Lastbook: ${row.title}, page ${row.page}\n    ${oneLine(row.excerpt, 500)}`,
    }));
  } catch (error) {
    return [{ note: `(Lastbook search failed: ${(error as Error).message})` }];
  } finally {
    db?.close();
  }
}

/** Cloudmail matches every word, so a long query falls back to its two longest words. */
async function searchMail(query: string, context: ToolContext): Promise<Found[]> {
  if (!which("cloudmail", context.env)) return [];
  const words = query.match(/[\p{L}\p{N}@.'-]+/gu) ?? [];
  const attempts = [words.join(" "), ...(words.length > 2 ? [[...words].sort((a, b) => b.length - a.length).slice(0, 2).join(" ")] : [])];
  for (const attempt of attempts) {
    if (!attempt) continue;
    const { out, error } = await run("cloudmail", ["search", "--quiet", "-n", "5", ...attempt.split(" ")], context);
    if (error) return [{ note: `(Mail search failed: ${oneLine(error, 200)})` }];
    const threads = json(out);
    if (!Array.isArray(threads) || threads.length === 0) continue;
    return threads.map((thread: Record<string, unknown>): Found => {
      const from = thread.from as { name?: string; email?: string } | undefined;
      const when = typeof thread.last_at === "number" ? new Date(thread.last_at).toISOString().slice(0, 10) : "";
      return { hit: { kind: "mail", thread: String(thread.id) }, text: `Mail ${when} from ${from?.name ?? from?.email ?? "?"}: ${oneLine(thread.subject, 160)}\n    ${oneLine(thread.snippet, 300)}` };
    });
  }
  return [];
}

async function searchContacts(query: string, context: ToolContext): Promise<Found[]> {
  if (!which("icloud-contacts", context.env) || query.split(/\s+/u).length > 3) return [];
  const { out, error } = await run("icloud-contacts", ["list", "--quiet", query], context);
  const contacts = error ? null : json(out);
  if (!Array.isArray(contacts)) return [];
  return contacts.slice(0, 5).map((contact: Record<string, unknown>): Found => ({
    hit: { kind: "contact", contact: String(contact.id) },
    text: `Contact: ${oneLine(contact.name, 120)}${contact.company ? `, ${oneLine(contact.company, 80)}` : ""}`,
  }));
}

/**
 * Every source at once. `everything` adds mail and contacts, whose keyword
 * search suits a model's query, not the owner's whole sentence.
 */
export async function search(query: string, hits: Hits, context: ToolContext, everything = true): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { text: "A query is needed.", isError: true };
  const parts = await Promise.all([
    searchFiles(q, context, 8),
    searchLastbook(q, context, 4),
    ...(everything ? [searchMail(q, context), searchContacts(q, context)] : []),
  ]);
  // Numbered in source order, not finishing order, so S1 is the best file hit.
  const lines = parts.flat().map((found) => "note" in found ? found.note : `[${hits.add(found.hit)}] ${found.text}`);
  return { text: lines.length ? clip(lines.join("\n")) : "Nothing found.", isError: false };
}

async function pdfPage(path: string, page: number, context: ToolContext): Promise<ToolResult> {
  const { out, error } = await run("pdftotext", ["-layout", "-f", String(page), "-l", String(page), path, "-"], context);
  // Layout mode keeps a table's rows together; its column padding is collapsed, which halves an invoice page.
  const text = out.replace(/[ \t]{2,}/gu, "  ").trim();
  return error ? { text: `Cannot read page ${page} of ${path}: ${error}`, isError: true } : { text: clip(text || "(no text on this page)"), isError: false };
}

/** Open one hit: a short text file whole, a PDF's page, else Recall's passage. */
export async function read(id: string, page: number | null, hits: Hits, context: ToolContext): Promise<ToolResult> {
  const hit = hits.get(id);
  if (!hit) return { text: `There is no hit ${id} in this turn; search first.`, isError: true };
  try {
    switch (hit.kind) {
      case "lastbook":
        return await pdfPage(hit.path, page ?? hit.page, context);
      case "mail": {
        const { out, error } = await run("cloudmail", ["thread", "read", "--quiet", hit.thread], context);
        return error ? { text: `Cannot read the mail: ${error}`, isError: true } : { text: clip(out), isError: false };
      }
      case "contact": {
        const { out, error } = await run("icloud-contacts", ["show", "--quiet", hit.contact], context);
        return error ? { text: `Cannot read the contact: ${error}`, isError: true } : { text: clip(out), isError: false };
      }
      case "file": {
        if (/\.pdf$/iu.test(hit.path) && (page ?? hit.page) !== null) return await pdfPage(hit.path, (page ?? hit.page) as number, context);
        if (hit.line !== undefined) {
          const lines = (await readFile(hit.path, "utf8")).split("\n");
          const from = Math.max(0, hit.line - 20);
          return { text: `${hit.path}, lines ${from + 1}-${Math.min(lines.length, from + 80)}\n\n${clip(lines.slice(from, from + 80).join("\n"))}`, isError: false };
        }
        const info = await stat(hit.path).catch(() => null);
        if (info && info.size <= WHOLE_FILE_CHARS * 2) {
          const bytes = await readFile(hit.path);
          if (!bytes.subarray(0, 4_000).includes(0) && bytes.length <= WHOLE_FILE_CHARS * 2) {
            return { text: `${hit.path}\n\n${clip(bytes.toString("utf8"))}`, isError: false };
          }
        }
        if (hit.segment === null) return { text: `${hit.path} cannot be read as text.`, isError: true };
        const { out, error } = await run("recall", ["text", String(hit.segment)], context);
        const text = (json(out) as { text?: string } | null)?.text;
        return error || typeof text !== "string"
          ? { text: `Cannot read ${hit.path}: ${error ?? "Recall returned no text"}`, isError: true }
          : { text: `${hit.path} (one passage)\n\n${clip(text)}`, isError: false };
      }
    }
  } catch (error) {
    return { text: `Cannot read ${id}: ${(error as Error).message}`, isError: true };
  }
}
