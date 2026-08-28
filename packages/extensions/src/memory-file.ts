/**
 * The atomic memory-file format.
 *
 * One file is one concise fact, stored as plain Markdown with no metadata.
 * The per-session index preview is derived from the fact each time and never
 * written to disk.
 */
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
export const MEMORY_INDEX_PREVIEW_CHARS = 32;
export const MEMORY_INDEX_BUDGET_CHARS = 4_000;
export const REDACTED_MEMORY_SECRET = "[REDACTED_SECRET]";

const MEMORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedMemoryFile {
  readonly content: string;
}

export interface MemoryFileMeta {
  readonly slug: string;
  readonly description: string;
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

/**
 * The per-session memory index: one line per file in newest-first order, with
 * slug as the deterministic tie-break, cut off at the injection budget.
 * Derived on every session start and never stored.
 */
export function deriveMemoryIndex(files: readonly MemoryFileMeta[]): MemoryIndex {
  const sorted = [...files]
    .sort((left, right) =>
      right.updated.localeCompare(left.updated) || left.slug.localeCompare(right.slug))
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
