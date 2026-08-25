/**
 * The per-session doc catalog.
 *
 * Like the memory index, the catalog is derived on every session start and never
 * stored. A stored catalog would become a second source of truth and drift from
 * files edited outside Ghost.
 */
import type { DocCatalog, DocMeta } from "./types.js";

/** Injection budget for the per-session doc catalog, in characters. */
export const DOC_CATALOG_BUDGET_CHARS = 4_000;

function catalogLine(doc: DocMeta): string {
  const title = doc.title ?? doc.path.replace(/\.md$/, "");
  const flags: string[] = [];
  if (doc.archived) flags.push("archived");
  if (doc.tags.length > 0) flags.push(`tags: ${doc.tags.join(", ")}`);
  const suffix = flags.length > 0 ? ` (${flags.join("; ")})` : "";
  return `- ${doc.path}: ${title}${suffix}`;
}

/**
 * One line per doc, in stable path order, cut off at the injection budget.
 */
export function deriveDocCatalog(
  docs: readonly DocMeta[],
): DocCatalog {
  const ordered = docs.slice().sort((left, right) => left.path.localeCompare(right.path));
  const lines: string[] = [];
  let chars = 0;
  for (const doc of ordered) {
    const line = catalogLine(doc);
    if (chars + line.length + 1 > DOC_CATALOG_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return {
    lines,
    chars,
    omitted: ordered.length - lines.length,
    total: ordered.length,
  };
}
