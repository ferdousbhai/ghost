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
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return false;
    }
    if (character === '"' || character === "\\") return false;
  }
  return true;
}

function quotedName(name: string): string {
  // JSON escapes C0 newlines, but permits C1 controls and Unicode's remaining
  // rendered line separators literally. Escape them as well so one filesystem
  // entry cannot control the terminal or manufacture another visual line.
  return JSON.stringify(name).replace(/[\u007f-\u009f\u2028\u2029]/gu, (separator) =>
    `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/**
 * One entry per line: the name, with a trailing `/` for a directory. The kind
 * is a single character rather than a repeated `file:`/`directory:` word, and
 * the bullet marker is dropped — inside a fenced block the newline already
 * separates entries.
 */
function catalogLine(entry: DocumentDirectoryEntry): string {
  const name = plainName(entry.name) ? entry.name : quotedName(entry.name);
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
