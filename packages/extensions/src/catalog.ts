/**
 * The per-session doc catalog and the single visibility rule everything else
 * defers to.
 *
 * Like the memory index, the catalog is derived on every session start and never
 * stored. A stored catalog is a second source of truth about what is published,
 * and the one thing that must not go stale is what a visitor is allowed to see.
 */
import { CREATOR_SCOPE, isVisitorScope, type GhostScope } from "./scope.js";
import type { DocCatalog, DocMeta } from "./types.js";

/** Injection budget for the per-session doc catalog, in characters. */
export const DOC_CATALOG_BUDGET_CHARS = 4_000;

/**
 * The visibility rule. A visitor sees a doc only when it is explicitly
 * published and not archived; the creator sees everything.
 *
 * Archived docs stay out of the visitor's view deliberately: the creator
 * archived them, and an archived-but-public doc is a doc whose publication was
 * an earlier decision than its archival.
 */
export function isDocVisible(doc: DocMeta, scope: GhostScope): boolean {
  if (!isVisitorScope(scope)) return true;
  return doc.public && !doc.archived;
}

export function visibleDocs(
  docs: readonly DocMeta[],
  scope: GhostScope,
): DocMeta[] {
  return docs.filter((doc) => isDocVisible(doc, scope));
}

function catalogLine(doc: DocMeta, scope: GhostScope): string {
  const title = doc.title ?? doc.path.replace(/\.md$/, "");
  const flags: string[] = [];
  // A visitor's catalog is public by construction, so the flag would be noise;
  // for the creator it is the whole point — it is how the ghost knows what it
  // may repeat to a visitor.
  if (!isVisitorScope(scope)) {
    flags.push(doc.public ? "public" : "private");
    if (doc.archived) flags.push("archived");
  }
  if (doc.tags.length > 0) flags.push(`tags: ${doc.tags.join(", ")}`);
  const suffix = flags.length > 0 ? ` (${flags.join("; ")})` : "";
  return `- ${doc.path}: ${title}${suffix}`;
}

/**
 * One line per doc the scope can see, in stable path order, cut off at the
 * injection budget.
 */
export function deriveDocCatalog(
  docs: readonly DocMeta[],
  scope: GhostScope = CREATOR_SCOPE,
): DocCatalog {
  const visible = visibleDocs(docs, scope)
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  const lines: string[] = [];
  let chars = 0;
  for (const doc of visible) {
    const line = catalogLine(doc, scope);
    if (chars + line.length + 1 > DOC_CATALOG_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return {
    lines,
    chars,
    omitted: visible.length - lines.length,
    total: visible.length,
    publicCount: visible.filter((doc) => doc.public).length,
  };
}
