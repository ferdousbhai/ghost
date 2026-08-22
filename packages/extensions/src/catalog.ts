/**
 * The per-session note catalog and the single visibility rule everything else
 * defers to.
 *
 * Like the memory index, the catalog is derived on every session start and never
 * stored. A stored catalog is a second source of truth about what is published,
 * and the one thing that must not go stale is what a visitor is allowed to see.
 */
import { CREATOR_SCOPE, isVisitorScope, type GhostScope } from "./scope.js";
import type { NoteCatalog, NoteMeta } from "./types.js";

/** Injection budget for the per-session note catalog, in characters. */
export const NOTE_CATALOG_BUDGET_CHARS = 4_000;

/**
 * The visibility rule. A visitor sees a note only when it is explicitly
 * published and not archived; the creator sees everything.
 *
 * Archived notes stay out of the visitor's view deliberately: the creator
 * archived them, and an archived-but-public note is a note whose publication was
 * an earlier decision than its archival.
 */
export function isNoteVisible(note: NoteMeta, scope: GhostScope): boolean {
  if (!isVisitorScope(scope)) return true;
  return note.public && !note.archived;
}

export function visibleNotes(
  notes: readonly NoteMeta[],
  scope: GhostScope,
): NoteMeta[] {
  return notes.filter((note) => isNoteVisible(note, scope));
}

function catalogLine(note: NoteMeta, scope: GhostScope): string {
  const title = note.title ?? note.path.replace(/\.md$/, "");
  const flags: string[] = [];
  // A visitor's catalog is public by construction, so the flag would be noise;
  // for the creator it is the whole point — it is how the ghost knows what it
  // may repeat to a visitor.
  if (!isVisitorScope(scope)) {
    flags.push(note.public ? "public" : "private");
    if (note.archived) flags.push("archived");
  }
  if (note.tags.length > 0) flags.push(`tags: ${note.tags.join(", ")}`);
  const suffix = flags.length > 0 ? ` (${flags.join("; ")})` : "";
  return `- ${note.path}: ${title}${suffix}`;
}

/**
 * One line per note the scope can see, in stable path order, cut off at the
 * injection budget.
 */
export function deriveNoteCatalog(
  notes: readonly NoteMeta[],
  scope: GhostScope = CREATOR_SCOPE,
): NoteCatalog {
  const visible = visibleNotes(notes, scope)
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  const lines: string[] = [];
  let chars = 0;
  for (const note of visible) {
    const line = catalogLine(note, scope);
    if (chars + line.length + 1 > NOTE_CATALOG_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return {
    lines,
    chars,
    omitted: visible.length - lines.length,
    total: visible.length,
    publicCount: visible.filter((note) => note.public).length,
  };
}
