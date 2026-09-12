/**
 * `history` for a Claude Code conversation: the same search-then-read tool a
 * pi ghost has over its JSONL, read from Claude Code's own transcript files.
 * Ghost only reads here; the files are the SDK's, located by resume id
 * (`claude-sdk-files.ts`). Entries are the user and assistant messages; tool
 * calls and results appear as one-line summaries so a search for what a tool
 * returned still lands.
 */
import { readFile } from "node:fs/promises";
import * as z from "zod";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAgentSdkModule } from "./claude-agent-sdk-loader.js";

export const CLAUDE_HISTORY_TOOL_NAME = "ghost_history";
export const HISTORY_SEARCH_LIMIT = 50;
export const HISTORY_PAGE_CHARS = 12_000;
const EXCERPT_BEFORE = 120;
const EXCERPT_LENGTH = 320;
const TOOL_SUMMARY_CHARS = 200;

export interface ClaudeHistoryFile {
  readonly path: string;
  /** Shown before each hit from a file other than the current conversation's. */
  readonly label: string;
}

export interface ClaudeHistoryEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly label: string;
}

interface TranscriptLine {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  message?: { role?: unknown; content?: unknown };
}

function partText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case "text":
      return typeof p.text === "string" ? p.text : "";
    case "tool_use":
      return `[tool ${String(p.name ?? "?")}] ${JSON.stringify(p.input ?? {}).slice(0, TOOL_SUMMARY_CHARS)}`;
    case "tool_result": {
      const content = p.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((inner) => partText(inner)).filter(Boolean).join("\n")
          : "";
      return text ? `[tool result] ${text.slice(0, TOOL_SUMMARY_CHARS)}` : "";
    }
    default:
      return "";
  }
}

function entryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(partText).filter(Boolean).join("\n");
}

/** The readable entries of one transcript, in file order. */
export async function readClaudeHistoryEntries(file: ClaudeHistoryFile): Promise<ClaudeHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file.path, "utf8");
  } catch {
    return [];
  }
  const entries: ClaudeHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const role = parsed.type;
    if ((role !== "user" && role !== "assistant") || parsed.isSidechain === true) continue;
    if (typeof parsed.uuid !== "string" || parsed.uuid === "") continue;
    const text = entryText(parsed.message?.content).trim();
    if (text === "") continue;
    entries.push({
      id: parsed.uuid,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      role,
      text,
      label: file.label,
    });
  }
  return entries;
}

function excerptAround(text: string, index: number): string {
  const start = Math.max(0, index - EXCERPT_BEFORE);
  const end = Math.min(text.length, start + EXCERPT_LENGTH);
  const one = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${one}${end < text.length ? "…" : ""}`;
}

function describe(entry: ClaudeHistoryEntry, body: string): string {
  return `${entry.label ? `${entry.label} ` : ""}${entry.timestamp} [${entry.id}] [${entry.role}] ${body}`;
}

/** Newest hits first, the current conversation's file before the others. */
export async function searchClaudeHistory(
  files: readonly ClaudeHistoryFile[],
  query: string,
  limit: number,
): Promise<string[]> {
  const needle = query.toLowerCase();
  const hits: string[] = [];
  for (const file of files) {
    const entries = await readClaudeHistoryEntries(file);
    for (const entry of entries.reverse()) {
      const at = entry.text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      hits.push(describe(entry, excerptAround(entry.text, at)));
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export async function readClaudeHistoryEntry(
  files: readonly ClaudeHistoryFile[],
  id: string,
  offset: number,
): Promise<string> {
  for (const file of files) {
    const entry = (await readClaudeHistoryEntries(file)).find((candidate) => candidate.id === id);
    if (!entry) continue;
    if (offset >= entry.text.length) {
      throw new Error(`Offset ${offset} is past the end of history entry "${id}" (${entry.text.length} chars).`);
    }
    const end = Math.min(entry.text.length, offset + HISTORY_PAGE_CHARS);
    const more = end < entry.text.length
      ? `\nMore remains; call history read with id "${id}" and offset ${end}.`
      : "";
    return describe(entry, `[chars ${offset}-${end} of ${entry.text.length}]\n${entry.text.slice(offset, end)}${more}`);
  }
  throw new Error(`No history entry with id "${id}".`);
}

/**
 * The tool as Claude sees it. `resolveFiles` runs per call so a conversation
 * whose transcript did not exist at the first prompt is searchable later.
 */
export function createClaudeHistoryTool(
  sdk: ClaudeAgentSdkModule,
  resolveFiles: (all: boolean) => Promise<ClaudeHistoryFile[]>,
): SdkMcpToolDefinition {
  return sdk.tool(
    CLAUDE_HISTORY_TOOL_NAME,
    "Search or read this ghost's conversation history, including turns no longer in context: "
      + "search with a query, then read by a returned entry id; all=true searches every conversation of this ghost.",
    {
      op: z.enum(["search", "read"]).describe("Operation to perform"),
      query: z.string().optional().describe("Case-insensitive text to find (search)"),
      id: z.string().optional().describe("Entry id returned by search (read)"),
      all: z.boolean().optional().describe("Search every conversation of this ghost instead of the current one"),
      limit: z.number().int().min(1).max(HISTORY_SEARCH_LIMIT).optional()
        .describe("Maximum results (default 10, max 50)"),
      offset: z.number().int().min(0).optional().describe("Character offset for read (default 0)"),
    },
    async (args) => {
      try {
        const files = await resolveFiles(args.all === true);
        if (args.op === "search") {
          const query = (args.query ?? "").trim();
          if (query === "") throw new Error('"query" is required for op "search".');
          const results = await searchClaudeHistory(files, query, args.limit ?? 10);
          return {
            content: [{
              type: "text",
              text: results.length ? results.join("\n") : `No history matches "${query}".`,
            }],
          };
        }
        const id = (args.id ?? "").trim();
        if (id === "") throw new Error('"id" is required for op "read".');
        return {
          content: [{ type: "text", text: await readClaudeHistoryEntry(files, id, args.offset ?? 0) }],
        };
      } catch (cause) {
        return {
          isError: true,
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        };
      }
    },
    { alwaysLoad: true },
    // The bridge holds tools by the SDK's unparameterised definition type.
  ) as unknown as SdkMcpToolDefinition;
}
