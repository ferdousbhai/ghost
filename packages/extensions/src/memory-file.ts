/**
 * The atomic memory-file format.
 *
 * One file is one concise fact, stored as plain Markdown with no metadata.
 * The per-session index preview is derived from the fact each time and never
 * written to disk.
 */
import { MemoryFileFormatError } from "./errors.js";

export const MAX_MEMORY_FILE_CONTENT_LENGTH = 2_000;
export const MAX_MEMORY_FILE_SLUG_LENGTH = 64;
export const MAX_MEMORY_FILES = 500;
/** Maximum length of one derived index preview, including an ellipsis. */
export const MEMORY_INDEX_PREVIEW_CHARS = 32;
/** Injection budget for the per-session memory index, in characters. */
export const MEMORY_INDEX_BUDGET_CHARS = 4_000;

const MEMORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedMemoryFile {
  readonly content: string;
}

export interface MemoryFileMeta {
  readonly slug: string;
  /** A preview derived from the memory content, never stored separately. */
  readonly description: string;
}

/** Validate `<slug>.md` and return the slug. */
export function parseMemoryFileName(name: string): string {
  if (!name.endsWith(".md")) {
    throw new MemoryFileFormatError("Memory files must use the .md extension.");
  }
  const slug = name.slice(0, -".md".length);
  if (!MEMORY_SLUG_PATTERN.test(slug) || slug.length > MAX_MEMORY_FILE_SLUG_LENGTH) {
    throw new MemoryFileFormatError(
      "Memory file names must be short kebab-case slugs of lowercase letters, digits, and dashes, like preferred-tone.md.",
    );
  }
  return slug;
}

export function memoryFileName(slug: string): string {
  return `${slug}.md`;
}

/** Accept either `preferred-tone` or `preferred-tone.md`; return the slug. */
export function coerceMemorySlug(name: string): string {
  return parseMemoryFileName(name.endsWith(".md") ? name : memoryFileName(name.trim()));
}

export function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Derive a kebab-case slug from fact text, e.g. "prefers-concise-replies".
 * Lives next to MEMORY_SLUG_PATTERN so the output always satisfies it.
 */
export function memorySlugForText(text: string): string {
  const slug = normalizeMemoryText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, MAX_MEMORY_FILE_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

/** The compact index text derived from a memory's normalized content. */
export function memoryIndexPreview(content: string): string {
  const normalized = normalizeMemoryText(content);
  if (normalized.length <= MEMORY_INDEX_PREVIEW_CHARS) return normalized;

  const available = MEMORY_INDEX_PREVIEW_CHARS - "...".length;
  let prefix = normalized.slice(0, available);
  const next = normalized[available];
  if (next !== undefined && !/\s/u.test(next)) {
    const lastSpace = prefix.lastIndexOf(" ");
    if (lastSpace > 0) prefix = prefix.slice(0, lastSpace);
  }
  return `${prefix.trimEnd().replace(/[.,;:!?]+$/u, "")}...`;
}

/** Validate a memory file the model is about to write, before it hits disk. */
export function assertWritableMemory(content: string): void {
  const normalized = content.trim();
  if (normalized.length === 0) {
    throw new MemoryFileFormatError("A memory must contain one concise fact.");
  }
  if (normalized.length > MAX_MEMORY_FILE_CONTENT_LENGTH) {
    throw new MemoryFileFormatError(
      `Memory files must be ${MAX_MEMORY_FILE_CONTENT_LENGTH} characters or fewer. Split unrelated facts into separate files.`,
    );
  }
}

export function serializeMemoryFile(content: string): string {
  assertWritableMemory(content);
  return `${content.trim()}\n`;
}

export function parseMemoryFile(markdown: string): ParsedMemoryFile {
  assertWritableMemory(markdown);
  return { content: markdown.trim() };
}

export interface MemoryIndex {
  /** Budgeted index lines, a contiguous prefix of the slug-sorted index. */
  readonly lines: readonly string[];
  /** Characters the included lines occupy (one newline each). */
  readonly chars: number;
  /** Files omitted because the index budget was exhausted. */
  readonly omitted: number;
  /** Files considered, before the budget cut. */
  readonly total: number;
}

/**
 * The per-session memory index: one line per file in stable slug order, cut off
 * at the injection budget. Derived on every session start and never stored.
 */
export function deriveMemoryIndex(files: readonly MemoryFileMeta[]): MemoryIndex {
  const sorted = [...files]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((file) => `- ${memoryFileName(file.slug)}: ${file.description}`);
  const lines: string[] = [];
  let chars = 0;
  for (const line of sorted) {
    if (chars + line.length + 1 > MEMORY_INDEX_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return { lines, chars, omitted: sorted.length - lines.length, total: sorted.length };
}
