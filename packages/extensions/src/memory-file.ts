/**
 * The atomic memory-file format, ported from the hosted repo's
 * `src/lib/memory/memory-file-format.ts`. The limits, the slug rules, the
 * frontmatter shape, and the derived-index line format are all deliberately
 * unchanged: an archive exported by the hosted app must read back here without
 * a migration step.
 *
 * One file, one fact. The index over them is derived per session and never
 * written to disk.
 *
 * There is deliberately no type/category field in the frontmatter. A taxonomy
 * (owner/feedback/project/reference and the like) was considered and rejected:
 * the owner's testing found model-assigned type labels unreliable, so nothing
 * downstream may depend on one. Whatever classification matters goes in the
 * description line, in words. Do not reintroduce a type field.
 */
import { MemoryFileFormatError } from "./errors.js";
import { parseYamlStringScalar, yamlScalar } from "./frontmatter.js";

export const MAX_MEMORY_FILE_CONTENT_LENGTH = 2_000;
export const MAX_MEMORY_FILE_DESCRIPTION_LENGTH = 200;
export const MAX_MEMORY_FILE_SLUG_LENGTH = 64;
export const MAX_MEMORY_FILES_PER_SCOPE = 500;
/** Injection budget for the per-session memory index, in characters. */
export const MEMORY_INDEX_BUDGET_CHARS = 4_000;

const MEMORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_FENCE = "---";

export interface ParsedMemoryFile {
  readonly description: string;
  readonly content: string;
  /** The `updated:` line as written. Advisory — the writer's clock is authoritative. */
  readonly updated: string | undefined;
}

export interface MemoryFileMeta {
  readonly slug: string;
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

export function serializeMemoryFile(input: {
  readonly description: string;
  readonly updatedAt: Date;
  readonly content: string;
}): string {
  const updated = input.updatedAt.toISOString().slice(0, 10);
  return [
    FRONTMATTER_FENCE,
    `description: ${yamlScalar(input.description)}`,
    `updated: ${updated}`,
    FRONTMATTER_FENCE,
    "",
    input.content,
    "",
  ].join("\n");
}

const FORMAT_GUIDANCE =
  "A memory file starts with frontmatter: a --- line, `description: <one line for the index>`, "
  + "and a closing --- line, followed by the body.";

/**
 * Parse a memory file the model wrote. `updated` is returned but never trusted —
 * the writer stamps the real timestamp.
 */
export function parseMemoryFile(markdown: string): ParsedMemoryFile {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    throw new MemoryFileFormatError(`Missing frontmatter. ${FORMAT_GUIDANCE}`);
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE,
  );
  if (closingIndex < 0) {
    throw new MemoryFileFormatError(`Unterminated frontmatter. ${FORMAT_GUIDANCE}`);
  }

  let description: string | undefined;
  let updated: string | undefined;
  for (const line of lines.slice(1, closingIndex)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) {
      throw new MemoryFileFormatError(
        `Invalid frontmatter line "${trimmed}". ${FORMAT_GUIDANCE}`,
      );
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = parseYamlStringScalar(trimmed.slice(separator + 1));
    if (key === "description") description = value;
    if (key === "updated") updated = value;
    // Other keys (including the retired `type`) are tolerated so files written
    // before the taxonomy was dropped still round-trip.
  }

  if (!description) {
    throw new MemoryFileFormatError(
      "Frontmatter must include a non-empty description; it becomes this memory's line in the index.",
    );
  }
  if (description.length > MAX_MEMORY_FILE_DESCRIPTION_LENGTH) {
    throw new MemoryFileFormatError(
      `description must be ${MAX_MEMORY_FILE_DESCRIPTION_LENGTH} characters or fewer.`,
    );
  }

  const content = lines.slice(closingIndex + 1).join("\n").trim();
  if (content.length > MAX_MEMORY_FILE_CONTENT_LENGTH) {
    throw new MemoryFileFormatError(
      `Memory file bodies must be ${MAX_MEMORY_FILE_CONTENT_LENGTH} characters or fewer. Split unrelated facts into separate files.`,
    );
  }

  return { description, content, updated };
}

/** Validate a memory file the model is about to write, before it hits disk. */
export function assertWritableMemory(description: string, content: string): void {
  const normalizedDescription = description.trim();
  if (normalizedDescription.length === 0) {
    throw new MemoryFileFormatError(
      "description must be a non-empty one-liner; it becomes this memory's line in the index.",
    );
  }
  if (normalizedDescription.length > MAX_MEMORY_FILE_DESCRIPTION_LENGTH) {
    throw new MemoryFileFormatError(
      `description must be ${MAX_MEMORY_FILE_DESCRIPTION_LENGTH} characters or fewer.`,
    );
  }
  if (/[\r\n\u2028\u2029]/u.test(description)) {
    throw new MemoryFileFormatError("description must be a single line.");
  }
  if (content.length > MAX_MEMORY_FILE_CONTENT_LENGTH) {
    throw new MemoryFileFormatError(
      `Memory file bodies must be ${MAX_MEMORY_FILE_CONTENT_LENGTH} characters or fewer. Split unrelated facts into separate files.`,
    );
  }
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
 * at the injection budget. Derived on every session start and **never written to
 * disk** — a stored index is a second source of truth that goes stale.
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
