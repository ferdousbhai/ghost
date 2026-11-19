/**
 * The local model's tools (CONTRACTS.md "Local model"): `search` over the
 * owner's sources, `read` of one search hit by its id, `save_note` and
 * `add_reminder`, which write only Ghost's own Notes and Reminders folders,
 * and `delegate`, which the turn hands to a harness. Like Lastbook's, the tools take ids, never
 * paths: the model reads only what a search returned. Searching and reading
 * are the sources' own ("Sources"); this file numbers the hits and shapes
 * the text the model sees.
 */
import type { SourceHit } from "./turn-events.js";
import { addReminder, listSources, readFileRef, readSource, saveNote, searchFiles, searchSources, type SourceContext, type SourceItem, type SourceRef } from "./sources.js";

/** The characters of one tool result the model is given. */
export const TOOL_RESULT_CHARS = 8_000;

interface ToolSpec {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };
}

export type ToolContext = SourceContext;

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/** Sources whose hits are files, read straight from disk. */
const FILE_SOURCES = new Set(["files", "notes", "reminders", "whatsapp", "drive", "lastbook"]);

/** One pass's search hits, keyed `S1`, `S2`, …; a pass's ids mean nothing in the next. */
export class Hits {
  private readonly byId = new Map<string, SourceRef>();
  private fresh: SourceHit[] = [];
  add(ref: SourceRef, item?: SourceItem): string {
    const id = `S${this.byId.size + 1}`;
    this.byId.set(id, ref);
    if (item) {
      this.fresh.push({
        key: id, source: item.source, id: item.id, title: item.title,
        ...(item.path ? { path: item.path } : {}), ...(item.page ? { page: item.page } : {}), ...(item.line ? { line: item.line } : {}),
      });
    }
    return id;
  }
  /** The hits added since the last call, for the turn's `sources` event. */
  takeFresh(): SourceHit[] {
    const fresh = this.fresh;
    this.fresh = [];
    return fresh;
  }
  /** The ids of the first `count` hits that are files or library pages, in search order. */
  documents(count: number): string[] {
    return [...this.byId].filter(([, ref]) => FILE_SOURCES.has(ref.source)).slice(0, count).map(([id]) => id);
  }
  get(id: string): SourceRef | undefined {
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
  spec("read", "Read one search hit, by its id (S1, S2, …): a short file whole, else its passage or opening.",
    { id: { type: "string", description: "The hit's id." }, page: { type: "integer", description: "For a PDF, a page other than the hit's." } }, ["id"]),
  spec("save_note", "Keep something for later conversations (a fact about the owner, a decision, a plan): a new note, or more text at the end of the note with that title.",
    { title: { type: "string", description: "The note's title; reuse an existing note's title to add to it." }, text: { type: "string", description: "What to keep, as Markdown." } }, ["title", "text"]),
  spec("add_reminder", "Add a reminder to one of the owner's lists.",
    { text: { type: "string", description: "What to be reminded of, one line." }, list: { type: "string", description: "The list's name; Reminders when unsure." }, due: { type: "string", description: "When it is due: YYYY-MM-DD, or YYYY-MM-DD HH:MM." } }, ["text"]),
  spec("delegate",
    "Hand a task you cannot do with search and read (acting, sending, changing, anything on the web or in code) to a cloud agent on this computer, which has full access. It answers with what it did. The task leaves this computer: include only what it needs.",
    { task: { type: "string", description: "The whole task, self-contained." } }, ["task"]),
];

function clip(text: string, limit = TOOL_RESULT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (cut at ${limit} characters)`;
}

/** A hit as one line or two: where it is, so the answer can name it, then its excerpt. */
function hitText(item: SourceItem): string {
  const day = item.at === null ? "" : ` ${new Date(item.at).toISOString().slice(0, 10)}`;
  switch (item.source) {
    case "mail": return `Mail${day}: ${item.title}\n    ${item.snippet}`;
    case "contacts": return `Contact: ${item.title}${item.snippet ? `, ${item.snippet}` : ""}`;
    case "lastbook": return `Lastbook: ${item.title}\n    ${item.snippet}`;
    case "whatsapp": return `WhatsApp chat "${item.title}": ${item.path}\n    ${item.snippet}`;
    default: return `${item.path ?? item.title}\n    ${item.snippet}`;
  }
}

/**
 * Every searchable source at once. `everything` adds mail and contacts,
 * whose keyword search suits a model's query, not the owner's whole sentence.
 */
export async function search(query: string, hits: Hits, context: ToolContext, everything = true): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { text: "A query is needed.", isError: true };
  const sources = ["files", "lastbook", ...(everything ? ["mail", "contacts"] : [])];
  const { searchItems, failed } = await searchWithRefs(q, context, sources);
  // Numbered in source order, not finishing order, so S1 is the best file hit.
  const lines = [
    ...searchItems.map(({ item, ref }) => `[${hits.add(ref, item)}] ${hitText(item)}`),
    ...failed.map((failure) => `(${failure.source} search failed: ${failure.message})`),
  ];
  return { text: lines.length ? clip(lines.join("\n")) : "Nothing found.", isError: false };
}

/** The sources' hits with the refs `read` needs; Recall's passage ids ride along for file hits. */
async function searchWithRefs(query: string, context: ToolContext, sources: readonly string[]) {
  const ready = new Set(listSources(context).filter((summary) => summary.available).map((summary) => summary.id as string));
  const [fileHits, rest] = await Promise.all([
    searchFiles(query, context, 8),
    searchSources(query, context, { sources: sources.filter((id) => id !== "files" && ready.has(id)), limit: 5 }),
  ]);
  const searchItems = [
    ...fileHits,
    ...rest.items.map((item) => ({ item, ref: { source: item.source, id: item.id, ...(item.page ? { page: item.page } : {}) } as SourceRef })),
  ];
  return { searchItems, failed: rest.failed };
}

/** Write a note or a reminder; the result says where it went. */
export async function write(name: "save_note" | "add_reminder", args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const text = (key: string) => typeof args[key] === "string" ? (args[key] as string) : "";
  try {
    if (name === "save_note") {
      const saved = await saveNote(context, text("title"), text("text"));
      return { text: `${saved.created ? "Saved a new note" : "Added to the note"}: ${saved.path}`, isError: false };
    }
    const added = await addReminder(context, text("text"), text("list").trim() || undefined, text("due").trim() || undefined);
    return { text: `Added to ${added.path}: ${added.line}`, isError: false };
  } catch (error) {
    return { text: (error as Error).message, isError: true };
  }
}

/** Open one hit, cut to one tool result: a file whole only when it fits. */
export async function read(id: string, page: number | null, hits: Hits, context: ToolContext): Promise<ToolResult> {
  const hit = hits.get(id);
  if (!hit) return { text: `There is no hit ${id} in this turn; search first.`, isError: true };
  const ref: SourceRef = page === null ? hit : { ...hit, page };
  try {
    if (FILE_SOURCES.has(ref.source)) {
      const document = await readFileRef(ref, context, TOOL_RESULT_CHARS);
      const where = document.part === "passage" ? " (one passage)" : document.part.startsWith("lines") ? `, ${document.part}` : "";
      return { text: document.part.startsWith("page") ? clip(document.text) : `${document.path}${where}\n\n${clip(document.text)}`, isError: false };
    }
    return { text: clip((await readSource(ref, context)).text), isError: false };
  } catch (error) {
    return { text: `Cannot read ${id}: ${(error as Error).message}`, isError: true };
  }
}
