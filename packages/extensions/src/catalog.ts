import {
  DOCUMENT_INDEX_BUDGET_CHARS,
  DOCUMENT_INDEX_MAX_ENTRIES,
  type DocumentDirectoryEntry,
  type DocumentDirectoryPage,
} from "./documents.js";
import type { DocumentsIndex } from "./types.js";

export const DOC_CATALOG_BUDGET_CHARS = DOCUMENT_INDEX_BUDGET_CHARS;

/**
 * A file name is unremarkable when it cannot forge an index line or hide its
 * own edges: no control character (a newline would split one entry into two),
 * no quote or backslash, and no leading or trailing whitespace. Those names are
 * written bare; anything else keeps JSON quoting, which is both the escape and
 * the signal that the name is odd.
 */
function plainName(name: string): boolean {
  if (name.length === 0) return false;
  if (name !== name.trim()) return false;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (character === '"' || character === "\\") return false;
  }
  return true;
}

/**
 * One entry per line: the name, with a trailing `/` for a directory. The kind
 * is a single character rather than a repeated `file:`/`directory:` word, and
 * the bullet marker is dropped — inside a fenced block the newline already
 * separates entries.
 */
function catalogLine(entry: DocumentDirectoryEntry): string {
  const name = plainName(entry.name) ? entry.name : JSON.stringify(entry.name);
  return entry.kind === "directory" ? `${name}/` : name;
}

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
