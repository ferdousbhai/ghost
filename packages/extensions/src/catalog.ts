/**
 * The per-turn machine Documents index.
 *
 * Only names and kinds of immediate, non-hidden root children enter a model
 * prompt. File contents and descendants remain on disk until a model explicitly
 * asks a native filesystem tool for them.
 */
import {
  DOCUMENT_INDEX_BUDGET_CHARS,
  DOCUMENT_INDEX_MAX_ENTRIES,
  type DocumentDirectoryEntry,
  type DocumentDirectoryPage,
} from "./documents.js";
import type { DocumentsIndex } from "./types.js";

/** Injection budget for the per-turn Documents index, in characters. */
export const DOC_CATALOG_BUDGET_CHARS = DOCUMENT_INDEX_BUDGET_CHARS;

function catalogLine(entry: DocumentDirectoryEntry): string {
  return `- ${entry.kind}: ${JSON.stringify(entry.name)}`;
}

/**
 * One escaped line per immediate root entry, cut off at both count and prompt
 * budgets. `page.total` keeps truncation truthful even though the caller never
 * asks this automatic path for descendants or later pages.
 */
export function deriveDocumentsIndex(
  page: Pick<DocumentDirectoryPage, "root" | "entries" | "total">,
): DocumentsIndex {
  const available = page.entries.slice(0, DOCUMENT_INDEX_MAX_ENTRIES);
  const lines: string[] = [];
  let chars = 0;
  for (const entry of available) {
    const line = catalogLine(entry);
    if (chars + line.length + 1 > DOC_CATALOG_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return {
    root: page.root,
    lines,
    chars,
    omitted: Math.max(0, page.total - lines.length),
    total: page.total,
  };
}
