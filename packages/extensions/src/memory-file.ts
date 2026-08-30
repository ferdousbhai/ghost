import { MemoryFileFormatError } from "./errors.js";

export const MAX_MEMORY_FILE_CONTENT_LENGTH = 2_000;
/**
 * Inclusive on-disk boundary for one memory. JavaScript's 2,000 UTF-16-unit
 * content limit can occupy at most three UTF-8 bytes per unit, followed by the
 * writer's canonical newline.
 */
export const MAX_MEMORY_FILE_BYTES = MAX_MEMORY_FILE_CONTENT_LENGTH * 3 + 1;
export const MAX_MEMORY_FILE_SLUG_LENGTH = 64;
export const MAX_MEMORY_FILES = 500;
export const MEMORY_INDEX_BUDGET_CHARS = 4_000;
export const MEMORY_INDEX_MAX_ENTRIES = 50;
export const REDACTED_MEMORY_SECRET = "[REDACTED_SECRET]";

const MEMORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedMemoryFile {
  readonly content: string;
}

export interface MemoryFileMeta {
  readonly slug: string;
  readonly updated: string;
}

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

export function coerceMemorySlug(name: string): string {
  return parseMemoryFileName(name.endsWith(".md") ? name : memoryFileName(name.trim()));
}

export function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function redactMemorySecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gu,
      REDACTED_MEMORY_SECRET,
    )
    .replace(
      /\bBearer[ \t]+[A-Za-z0-9._~+/-]+={0,2}\b/giu,
      `Bearer ${REDACTED_MEMORY_SECRET}`,
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[po]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu,
      REDACTED_MEMORY_SECRET,
    )
    .replace(
      /(\b(?:api[_-]?key|token|secret|password)\b[ \t]*[:=][ \t]*)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/giu,
      `$1${REDACTED_MEMORY_SECRET}`,
    );
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
  const utf8 = new TextEncoder().encode(normalized);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(utf8) !== normalized) {
    throw new MemoryFileFormatError("A memory must contain valid Unicode text.");
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
  readonly lines: readonly string[];
  readonly chars: number;
  readonly omitted: number;
  readonly total: number;
}

/** Newest first, slug as the deterministic tie-break: the order memory is shown in. */
export function compareMemoryNewestFirst(left: MemoryFileMeta, right: MemoryFileMeta): number {
  return right.updated.localeCompare(left.updated) || left.slug.localeCompare(right.slug);
}

/**
 * The per-session memory index: one file name per line in newest-first order,
 * cut off at whichever of `MEMORY_INDEX_MAX_ENTRIES` and the injection budget
 * bites first. The slug alone says what a fact is about, so no preview of the
 * content rides along. Derived on every session start and never stored;
 * `omitted` still counts every memory the cut-off left out.
 */
export function deriveMemoryIndex(files: readonly MemoryFileMeta[]): MemoryIndex {
  const ordered = [...files].sort(compareMemoryNewestFirst);
  // The slug alone. A validated slug never needs quoting, the `.md` extension
  // is the only one memory files have, and a bullet marker in a fenced block
  // says nothing the newline does not — each is dead weight repeated per entry.
  const sorted = ordered
    .slice(0, MEMORY_INDEX_MAX_ENTRIES)
    .map((file) => file.slug);
  const lines: string[] = [];
  let chars = 0;
  for (const line of sorted) {
    if (chars + line.length + 1 > MEMORY_INDEX_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return { lines, chars, omitted: ordered.length - lines.length, total: ordered.length };
}
