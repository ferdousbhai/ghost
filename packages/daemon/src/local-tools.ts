/**
 * The local model's tools (CONTRACTS.md "Local model"). Every tool but
 * `run_command` only reads; `run_command` runs nothing itself, it asks the
 * owner, and the command runs at the start of the next turn only if they
 * approve it (`local-turn.ts`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { which } from "./harnesses.js";
import { expandHome, xdgBaseDir } from "./xdg-user-dirs.js";

/** The characters of one tool result the model is given. */
export const TOOL_RESULT_CHARS = 8_000;

export interface ToolSpec {
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

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export function lastbookSearchDb(env: NodeJS.ProcessEnv, home: string): string {
  return join(xdgBaseDir(env, "XDG_DATA_HOME", home), "Lastbook", "LastbookData", "library-data", "search.sqlite");
}

/** The tools this machine can serve: Recall and Lastbook only when installed. */
export function localToolSpecs(context: Pick<ToolContext, "env" | "home">): ToolSpec[] {
  return [
    ...(which("recall", context.env) ? [spec("search_content",
      "Search the owner's indexed files by meaning and keywords: documents, notes, WhatsApp chats, mail, screenshots, photos, audio and video. Start here for any question about the owner's own life or content.",
      { query: str("What to look for, in plain words."), limit: int("Results, 1-15 (default 8).") }, ["query"])] : []),
    spec("grep_files", "Find exact text or a regular expression in text files under a folder (default the home folder).",
      { pattern: str("Text or regular expression, case-insensitive."), folder: str("Folder to search, e.g. ~/Work.") }, ["pattern"]),
    spec("find_files", "Find files or folders by part of their name.",
      { name: str("Part of the name, case-insensitive."), folder: str("Folder to search (default home).") }, ["name"]),
    spec("list_folder", "List a folder's entries with sizes and dates.", { folder: str("The folder.") }, ["folder"]),
    spec("read_file", "Read a text file or PDF. Long files come in parts: pass `part` to continue.",
      { path: str("The file."), page: int("For a PDF, the page to read."), part: int("Which part of a long file, from 1.") }, ["path"]),
    ...(existsSync(lastbookSearchDb(context.env, context.home)) ? [spec("search_lastbook",
      "Search the Lastbook offline library (survival, medical, repair and reference books and videos). Returns titles, pages and excerpts; read a page with read_file and its page number.",
      { query: str("Keywords to look for.") }, ["query"])] : []),
    spec("run_command",
      "Propose a shell command that changes something or reaches beyond reading (sending a message, moving files, network). It does NOT run now: the owner is asked, and it runs only if they approve.",
      { command: str("The bash command."), reason: str("One sentence on why, for the owner.") }, ["command", "reason"]),
  ];
}

function run(command: string, args: string[], context: ToolContext, cwd?: string): Promise<{ out: string; error: string | null }> {
  return new Promise((done) => {
    execFile(command, args, { cwd, env: context.env, signal: context.signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      // rg and grep exit 1 for "no match", which is an answer, not a failure.
      const code = (error as { code?: unknown } | null)?.code;
      done({ out: String(stdout), error: error && code !== 1 ? (String(stderr).trim() || error.message) : null });
    });
  });
}

function clip(text: string): string {
  return text.length <= TOOL_RESULT_CHARS ? text : `${text.slice(0, TOOL_RESULT_CHARS)}\n… (cut at ${TOOL_RESULT_CHARS} characters)`;
}

function arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function num(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = Number(args[key]);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
}

function place(raw: string, context: ToolContext): string {
  return resolve(context.home, expandHome(raw || "~", context.home));
}

async function searchContent(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const query = arg(args, "query");
  if (!query) return { text: "A query is needed.", isError: true };
  const { out, error } = await run("recall", ["search", query, "--limit", String(num(args, "limit", 8, 15))], context);
  if (error) return { text: `Recall failed: ${error}`, isError: true };
  let hits: Array<Record<string, unknown>>;
  try {
    hits = (JSON.parse(out) as { hits?: Array<Record<string, unknown>> }).hits ?? [];
  } catch {
    return { text: "Recall answered with something other than JSON.", isError: true };
  }
  if (hits.length === 0) return { text: "No matches.", isError: false };
  return {
    text: clip(hits.map((hit, index) => [
      `[${index + 1}] ${String(hit.path)}${hit.location ? ` (${String(hit.location)})` : ""}`,
      `    ${String(hit.excerpt ?? "").replace(/\s+/gu, " ").slice(0, 600)}`,
    ].join("\n")).join("\n")),
    isError: false,
  };
}

async function grepFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const pattern = arg(args, "pattern");
  if (!pattern) return { text: "A pattern is needed.", isError: true };
  const { out, error } = await run("rg", ["-n", "-i", "--max-count", "3", "--max-columns", "300", "--max-filesize", "5M", "-e", pattern, place(arg(args, "folder"), context)], context);
  if (error) return { text: `Search failed: ${error}`, isError: true };
  const lines = out.split("\n").filter(Boolean);
  return { text: lines.length ? clip(lines.slice(0, 80).join("\n")) : "No matches.", isError: false };
}

async function findFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const name = arg(args, "name");
  if (!name) return { text: "A name is needed.", isError: true };
  const { out, error } = await run("fd", ["-i", "-F", "--max-results", "60", name, place(arg(args, "folder"), context)], context);
  if (error) return { text: `Search failed: ${error}`, isError: true };
  return { text: out.trim() ? clip(out.trim()) : "Nothing found.", isError: false };
}

async function listFolder(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const folder = place(arg(args, "folder"), context);
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    const rows = await Promise.all(entries.slice(0, 300).map(async (entry) => {
      const info = await stat(join(folder, entry.name)).catch(() => null);
      const when = info ? info.mtime.toISOString().slice(0, 10) : "?";
      return entry.isDirectory() ? `${entry.name}/  ${when}` : `${entry.name}  ${info?.size ?? "?"} bytes  ${when}`;
    }));
    return { text: rows.length ? clip(rows.join("\n")) : "The folder is empty.", isError: false };
  } catch (error) {
    return { text: `Cannot list ${folder}: ${(error as Error).message}`, isError: true };
  }
}

async function readPath(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const path = place(arg(args, "path"), context);
  const part = num(args, "part", 1, 10_000);
  let text: string;
  if (/\.pdf$/iu.test(path)) {
    const page = num(args, "page", 0, 100_000);
    const range = page ? ["-f", String(page), "-l", String(page)] : [];
    const { out, error } = await run("pdftotext", ["-layout", ...range, path, "-"], context);
    if (error) return { text: `Cannot read ${path}: ${error}`, isError: true };
    text = out;
  } else {
    try {
      const bytes = await readFile(path);
      if (bytes.subarray(0, 8_000).includes(0)) return { text: `${path} is not a text file.`, isError: true };
      text = bytes.toString("utf8");
    } catch (error) {
      return { text: `Cannot read ${path}: ${(error as Error).message}`, isError: true };
    }
  }
  const parts = Math.max(1, Math.ceil(text.length / TOOL_RESULT_CHARS));
  const body = text.slice((part - 1) * TOOL_RESULT_CHARS, part * TOOL_RESULT_CHARS);
  return { text: parts > 1 ? `${body}\n(part ${part} of ${parts})` : body || "(empty)", isError: false };
}

/** FTS5 words, each quoted so punctuation cannot become query syntax. */
function ftsWords(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12).map((word) => `"${word}"`);
}

async function searchLastbook(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const words = ftsWords(arg(args, "query"));
  if (words.length === 0) return { text: "Keywords are needed.", isError: true };
  const path = lastbookSearchDb(context.env, context.home);
  const { Database } = await import("bun:sqlite");
  // The pack's search index is static: immutable means no lock and no write.
  const db = new Database(`file:${path}?immutable=1`, { readonly: true });
  try {
    const query = db.query(
      "SELECT title, page, path, snippet(pages, 6, '', '', '…', 40) AS excerpt FROM pages WHERE pages MATCH ? ORDER BY bm25(pages, 0, 6, 1, 1, 0, 0, 1) LIMIT 8",
    );
    let rows = query.all(words.join(" ")) as Array<{ title: string; page: number; path: string; excerpt: string }>;
    if (rows.length < 3 && words.length > 1) rows = query.all(words.join(" OR ")) as typeof rows;
    if (rows.length === 0) return { text: "Nothing in the Lastbook library matches.", isError: false };
    const root = join(path, "..");
    return {
      text: clip(rows.map((row, index) => `[${index + 1}] ${row.title}, page ${row.page}: ${join(root, row.path)}\n    ${row.excerpt.replace(/\s+/gu, " ")}`).join("\n")),
      isError: false,
    };
  } catch (error) {
    return { text: `Lastbook search failed: ${(error as Error).message}`, isError: true };
  } finally {
    db.close();
  }
}

const READERS: Readonly<Record<string, (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>>> = {
  search_content: searchContent,
  grep_files: grepFiles,
  find_files: findFiles,
  list_folder: listFolder,
  read_file: readPath,
  search_lastbook: searchLastbook,
};

/** Run one read-only tool; `run_command` is handled by the turn, not here. */
export async function runReadTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const reader = READERS[name];
  if (!reader) return { text: `There is no tool named ${name}.`, isError: true };
  try {
    return await reader(args, context);
  } catch (error) {
    return { text: `${name} failed: ${(error as Error).message}`, isError: true };
  }
}

/** Run an approved command in the owner's home; its output, clipped. */
export function runApprovedCommand(command: string, context: ToolContext): Promise<ToolResult> {
  return new Promise((done) => {
    execFile("bash", ["-lc", command], { cwd: context.home, env: context.env, signal: context.signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [String(stdout), String(stderr)].filter((part) => part.trim()).join("\n").trim();
        done({ text: clip(output || (error ? error.message : "(no output)")), isError: error !== null });
      });
  });
}
