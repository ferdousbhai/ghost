import { basename } from "node:path";
import { GhostError } from "./errors.js";
import {
  parseDocument,
  readBoolean,
  readString,
  readStringList,
} from "./frontmatter.js";

const TAG_SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const TAG_SLUG_ONLY = new RegExp(`^${TAG_SLUG}$`);
const TAG_LINE = new RegExp(`^#${TAG_SLUG}(?: #${TAG_SLUG})*$`);
const LEGACY_TAG_LINE = /^\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/;
const H1_LINE = /^# (.*\S.*)$/;

export interface ParsedDoc {
  readonly title: string;
  readonly tags: readonly string[];
  readonly archived: boolean;
}

export interface DocRenderInput {
  readonly title: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly archived?: boolean;
}

function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function tagSlugs(line: string): string[] | null {
  return TAG_LINE.test(line) ? line.split(" ").map((tag) => tag.slice(1)) : null;
}

function legacyTagSlugs(line: string): string[] | null {
  return LEGACY_TAG_LINE.test(line)
    ? line.trim().split(/\s+/).map((tag) => tag.slice(1))
    : null;
}

export function parseDoc(text: string): ParsedDoc {
  const lines = linesOf(text);
  const first = lines[0] ?? "";
  const titleMatch = H1_LINE.exec(first);
  if (!titleMatch) {
    throw new GhostError(
      "invalid_format",
      "A ghost-home/v2 document must start at byte 0 with a non-empty `# Title` heading.",
    );
  }

  let final = lines.length - 1;
  while (final > 0 && (lines[final] ?? "").trim().length === 0) final -= 1;
  const finalLine = lines[final] ?? "";
  const parsedTrailing = tagSlugs(finalLine);
  if (final > 0 && parsedTrailing === null && LEGACY_TAG_LINE.test(finalLine)) {
    throw new GhostError(
      "invalid_format",
      "A document's trailing hashtag line must contain only lowercase hashtag slugs.",
    );
  }
  const trailing = parsedTrailing ?? [];
  const tags = trailing.filter(
    (tag, index) => tag !== "archived" && trailing.indexOf(tag) === index,
  );
  return {
    title: (titleMatch[1] as string).trim(),
    tags,
    archived: trailing.includes("archived"),
  };
}

function assertTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized || normalized.includes("\n") || normalized.includes("\r")) {
    throw new GhostError("invalid_format", "A document title must be non-empty and fit on one line.");
  }
  return normalized;
}

function assertTag(tag: string): void {
  if (!TAG_SLUG_ONLY.test(tag)) {
    throw new GhostError(
      "invalid_format",
      `Document tag ${JSON.stringify(tag)} is not a lowercase hashtag slug.`,
      { tag },
    );
  }
}

export function renderDoc(input: DocRenderInput): string {
  const title = assertTitle(input.title);
  const tags: string[] = [];
  for (const tag of input.tags ?? []) {
    assertTag(tag);
    if (tag === "archived") {
      throw new GhostError(
        "invalid_format",
        "Pass `archived: true` instead of including the reserved `archived` status in tags.",
      );
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (input.archived === true) tags.push("archived");

  const content = (input.content ?? "").replace(/^\s*\n/, "").replace(/\s+$/, "");
  const sections = [`# ${title}`];
  if (content) sections.push(content);
  if (tags.length > 0) sections.push(tags.map((tag) => `#${tag}`).join(" "));
  return `${sections.join("\n\n")}\n`;
}

/** Convert a legacy frontmatter/plain document to canonical v2, or return v2 bytes untouched. */
export function migrateDoc(text: string, path: string): string {
  try {
    parseDoc(text);
    return text;
  } catch {
    // Legacy parsing is deliberately confined to this one-time migration path.
  }

  const legacy = parseDocument(text);
  const lines = linesOf(legacy.body);
  const h1Index = lines.findIndex((line) => H1_LINE.test(line));
  const h1 = h1Index === -1 ? undefined : H1_LINE.exec(lines[h1Index] ?? "")?.[1]?.trim();
  const legacyTitle = readString(legacy.frontmatter, "title")?.trim();
  const title = h1 ?? (legacyTitle || basename(path, ".md"));

  let final = lines.length - 1;
  while (final >= 0 && (lines[final] ?? "").trim().length === 0) final -= 1;
  const trailing = final >= 0 ? legacyTagSlugs(lines[final] ?? "") : null;
  if (trailing) lines.splice(final, 1);
  if (h1Index !== -1) lines.splice(h1Index, 1);

  while (lines.length > 0 && (lines[0] ?? "").trim().length === 0) lines.shift();
  while (lines.length > 0 && (lines.at(-1) ?? "").trim().length === 0) lines.pop();

  const tags: string[] = [];
  let archived = readBoolean(legacy.frontmatter, "archived");
  const add = (tag: string): void => {
    const slug = slugifyDocTag(tag);
    if (!slug) return;
    if (slug === "archived") archived = true;
    else if (!tags.includes(slug)) tags.push(slug);
  };
  for (const tag of readStringList(legacy.frontmatter, "tags")) add(tag);
  for (const tag of trailing ?? []) add(tag);

  return renderDoc({ title, content: lines.join("\n"), tags, archived });
}

/** Normalize a legacy tag to the v2 lowercase-hyphen slug vocabulary. */
export function slugifyDocTag(tag: string): string {
  return tag
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
