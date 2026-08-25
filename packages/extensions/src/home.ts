/**
 * The ghost-home/v1 reader/writer.
 *
 * A ghost is a directory (CONTRACTS.md):
 *
 *     <ghostsRoot>/<name>/
 *       character.md
 *       docs/**\/*.md
 *       memory/*.md
 *       conversations/*.json
 *       export-manifest.json      (only in imported archives)
 *
 * Two rules run through everything here:
 *
 * 1. **Bodies are bytes.** A doc read and written back unchanged is
 *    byte-identical. No trimming, no newline normalization, no "tidying".
 * 2. **Nothing derived is stored.** The memory index and the doc catalog are
 *    computed per session (`deriveMemoryIndex`, `deriveDocCatalog`). There is no
 *    MEMORY.md and no catalog file, by contract.
 *
 * Every mutation goes through a path-keyed queue: OMP runs tool calls in
 * parallel by default, so two `ghost_memory_write` calls in one batch can
 * otherwise interleave on the same file.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isSafe } from "redos-detector";
import { GhostError } from "./errors.js";
import {
  parseDocument,
  readBoolean,
  readString,
  readStringList,
  renderDocument,
  yamlFlowList,
  yamlScalar,
} from "./frontmatter.js";
import {
  assertWritableMemory,
  coerceMemorySlug,
  MAX_MEMORY_FILES,
  memoryFileName,
  memorySlugForText,
  parseMemoryFile,
  serializeMemoryFile,
} from "./memory-file.js";
import type {
  CharacterFile,
  MemoryRecord,
  DocFile,
  DocFrontmatter,
  DocMeta,
} from "./types.js";

export const DOCS_DIRNAME = "docs";
const LEGACY_NOTES_DIRNAME = "notes";
export const MEMORY_DIRNAME = "memory";
export const CONVERSATIONS_DIRNAME = "conversations";
export const CHARACTER_FILENAME = "character.md";
export const EXPORT_MANIFEST_FILENAME = "export-manifest.json";

export interface SkippedFile {
  /** Path relative to the ghost home. */
  readonly path: string;
  readonly reason: string;
}

export interface DocListing {
  readonly docs: readonly DocMeta[];
  /**
   * Files under `docs/` that could not be parsed. They are excluded from the
   * catalog rather than guessed at, but are reported rather than dropped silently.
   */
  readonly skipped: readonly SkippedFile[];
}

export interface MemoryListing {
  readonly files: readonly MemoryRecord[];
  readonly skipped: readonly SkippedFile[];
}

export interface DocWriteInput {
  readonly body: string;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly archived?: boolean;
  /** Pre-sanitization app path, preserved from an imported archive. */
  readonly appPath?: string;
}

export interface MemoryWriteInput {
  /** `preferred-tone` or `preferred-tone.md`. Derived from the description when omitted. */
  readonly name?: string;
  readonly description: string;
  readonly content: string;
  readonly updatedAt?: Date;
}

export interface MemoryWriteResult {
  readonly slug: string;
  /** Path relative to the ghost home, e.g. `memory/preferred-tone.md`. */
  readonly path: string;
  readonly created: boolean;
}

export interface DocSearchOptions {
  /** Treat the query as a JavaScript regular expression. */
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
  readonly includeArchived?: boolean;
}

export interface DocSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface DocSearchResult {
  readonly matches: readonly DocSearchMatch[];
  readonly truncated: boolean;
  readonly docsSearched: number;
}

const DEFAULT_SEARCH_RESULTS = 50;

/** Serialize mutations to the same file while allowing unrelated files to proceed. */
const fileMutationQueues = new Map<string, Promise<unknown>>();

async function withFileMutationQueue<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(path) ?? Promise.resolve();
  const running = previous.catch(() => undefined).then(mutate);
  fileMutationQueues.set(path, running);
  try {
    return await running;
  } finally {
    if (fileMutationQueues.get(path) === running) fileMutationQueues.delete(path);
  }
}

/**
 * ReDoS defence for `searchDocs` with `regex: true`. The query is model- or
 * page-supplied (a ghost greps text it just read off the web), and it is compiled
 * and `.test()`ed against every line. Without a guard, a pattern like `(a+)+$`
 * against one long line backtracks catastrophically and pins the daemon's single
 * event loop, taking the HTTP API and every ghost session down with it.
 *
 * The guarantee has three parts:
 *   1. Cap the pattern length, so the analysis below always gets a small input.
 *   2. Prove the pattern cannot backtrack super-linearly, with `redos-detector`
 *      (a static, linear-time analysis; no native binding, unlike RE2, which
 *      would need a workspace-root build-script allowlist). The analysis itself
 *      is wall-time bounded and fails closed — a timeout counts as unsafe.
 *   3. Cap the characters of any one line handed to the matcher, so even a
 *      proven-linear pattern does bounded work per line.
 * A literal (non-regex) query is escaped before compiling and is always linear,
 * so it skips this gate entirely.
 */
const MAX_GREP_PATTERN_CHARS = 1_000;
const REDOS_ANALYSIS_TIMEOUT_MS = 50;
const MAX_GREP_LINE_SCAN_CHARS = 10_000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readDirEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject anything that would leave the ghost home, however it was spelled. */
function resolveWithin(base: string, relativePath: string, label: string): string {
  const full = resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new GhostError(
      "invalid_path",
      `${label} ${JSON.stringify(relativePath)} escapes the ghost home.`,
      { path: relativePath },
    );
  }
  return full;
}

/** `craft/paper` and `craft/paper.md` both mean `craft/paper.md`. */
export function normalizeDocPath(input: string): string {
  const segments = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new GhostError("invalid_path", "A document path is required.");
  }
  if (segments.some((segment) => segment === "..")) {
    throw new GhostError(
      "invalid_path",
      `Document path ${JSON.stringify(input)} escapes the docs directory.`,
      { path: input },
    );
  }
  const last = segments[segments.length - 1] as string;
  segments[segments.length - 1] = last.endsWith(".md") ? last : `${last}.md`;
  return segments.join("/");
}

function docFrontmatterFrom(text: string): { meta: DocFrontmatter; body: string } {
  const parsed = parseDocument(text);
  return {
    meta: {
      title: readString(parsed.frontmatter, "title"),
      tags: readStringList(parsed.frontmatter, "tags"),
      archived: readBoolean(parsed.frontmatter, "archived"),
      appPath: readString(parsed.frontmatter, "path"),
    },
    body: parsed.body,
  };
}

/** Frontmatter lines in the order the hosted export writes them. */
function docFrontmatterLines(meta: DocFrontmatter, path: string): string[] {
  const lines: string[] = [];
  const filename = basename(path, ".md");
  if (meta.title !== undefined && meta.title !== filename) {
    lines.push(`title: ${yamlScalar(meta.title)}`);
  }
  if (meta.tags.length > 0) lines.push(`tags: ${yamlFlowList([...meta.tags])}`);
  if (meta.archived) lines.push("archived: true");
  if (meta.appPath !== undefined) lines.push(`path: ${yamlScalar(meta.appPath)}`);
  return lines;
}

export class GhostHome {
  /** Absolute path to the ghost home directory. */
  readonly dir: string;
  /** Directory name — the ghost's name. */
  readonly name: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
  }

  get characterPath(): string {
    return join(this.dir, CHARACTER_FILENAME);
  }

  get docsDir(): string {
    return join(this.dir, DOCS_DIRNAME);
  }

  get memoryDir(): string {
    return join(this.dir, MEMORY_DIRNAME);
  }

  get conversationsDir(): string {
    return join(this.dir, CONVERSATIONS_DIRNAME);
  }

  /** A path relative to the ghost home, for messages and results. */
  relative(absolutePath: string): string {
    return absolutePath.startsWith(this.dir + sep)
      ? absolutePath.slice(this.dir.length + 1).split(sep).join("/")
      : absolutePath;
  }

  exists(): Promise<boolean> {
    return exists(this.dir);
  }

  /** Create the directory skeleton. Safe to call repeatedly. */
  async ensure(): Promise<void> {
    const legacyNotesDir = join(this.dir, LEGACY_NOTES_DIRNAME);
    const [hasDocs, hasLegacyNotes] = await Promise.all([
      exists(this.docsDir),
      exists(legacyNotesDir),
    ]);
    if (hasDocs && hasLegacyNotes) {
      throw new GhostError(
        "conflict",
        `Both ${DOCS_DIRNAME}/ and the legacy ${LEGACY_NOTES_DIRNAME}/ directory exist in `
        + `${this.dir}. Merge them into ${DOCS_DIRNAME}/ before opening this ghost.`,
        { docs: this.docsDir, legacyNotes: legacyNotesDir },
      );
    }
    if (hasLegacyNotes) await rename(legacyNotesDir, this.docsDir);
    await mkdir(this.docsDir, { recursive: true });
    await mkdir(this.memoryDir, { recursive: true });
    await mkdir(this.conversationsDir, { recursive: true });
  }

  // ---------------------------------------------------------------- character

  async readCharacter(): Promise<CharacterFile | null> {
    let text: string;
    try {
      text = await readFile(this.characterPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseDocument(text);
    return {
      title: readString(parsed.frontmatter, "title"),
      body: parsed.body,
    };
  }

  async writeCharacter(input: {
    body: string;
    title?: string;
  }): Promise<void> {
    const lines: string[] = [];
    if (input.title !== undefined) lines.push(`title: ${yamlScalar(input.title)}`);
    const text = renderDocument(lines, input.body);
    await withFileMutationQueue(this.characterPath, async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.characterPath, text, "utf8");
    });
  }

  // -------------------------------------------------------------------- docs

  /** Every `.md` under `docs/`, recursively. Hidden files and dirs are skipped. */
  async listDocs(): Promise<DocListing> {
    const docs: DocMeta[] = [];
    const skipped: SkippedFile[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readDirEntries(dir)) {
        if (entry.name.startsWith(".")) continue;
        const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), childPath);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        try {
          const text = await readFile(join(dir, entry.name), "utf8");
          docs.push({ ...docFrontmatterFrom(text).meta, path: childPath });
        } catch (error) {
          skipped.push({
            path: `${DOCS_DIRNAME}/${childPath}`,
            reason: message(error),
          });
        }
      }
    };

    await walk(this.docsDir, "");
    docs.sort((left, right) => left.path.localeCompare(right.path));
    return { docs, skipped };
  }

  async readDoc(path: string): Promise<DocFile> {
    const docPath = normalizeDocPath(path);
    const full = resolveWithin(this.docsDir, docPath, "Document path");
    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GhostError("not_found", `No document at ${docPath}.`, { path: docPath });
      }
      throw error;
    }
    const parsed = docFrontmatterFrom(text);
    return { meta: { ...parsed.meta, path: docPath }, body: parsed.body };
  }

  /** Metadata for one doc, or null when it does not exist. */
  async findDoc(path: string): Promise<DocMeta | null> {
    try {
      return (await this.readDoc(path)).meta;
    } catch (error) {
      if (error instanceof GhostError && error.code === "not_found") return null;
      throw error;
    }
  }

  async writeDoc(path: string, input: DocWriteInput): Promise<DocMeta> {
    const docPath = normalizeDocPath(path);
    const full = resolveWithin(this.docsDir, docPath, "Document path");
    const existing = await this.findDoc(docPath);
    const meta: DocMeta = {
      path: docPath,
      title: input.title ?? existing?.title,
      tags: input.tags ?? existing?.tags ?? [],
      archived: input.archived ?? existing?.archived ?? false,
      appPath: input.appPath ?? existing?.appPath,
    };
    const text = renderDocument(docFrontmatterLines(meta, docPath), input.body);
    await withFileMutationQueue(full, async () => {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, "utf8");
    });
    return meta;
  }

  /** Plain substring or regex search over doc bodies and titles. */
  async searchDocs(
    query: string,
    options: DocSearchOptions = {},
  ): Promise<DocSearchResult> {
    const maxResults = Math.max(1, options.maxResults ?? DEFAULT_SEARCH_RESULTS);
    const flags = options.caseSensitive ? "" : "i";
    if (options.regex && query.length > MAX_GREP_PATTERN_CHARS) {
      throw new GhostError(
        "invalid_format",
        `A regular-expression search may be at most ${MAX_GREP_PATTERN_CHARS} characters.`,
        { query },
      );
    }
    let pattern: RegExp;
    try {
      pattern = options.regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (error) {
      throw new GhostError(
        "invalid_format",
        `Invalid search pattern: ${message(error)}`,
        { query },
      );
    }
    // Only a caller-supplied *regex* can be adversarial; the escaped literal above
    // is always linear. See MAX_GREP_PATTERN_CHARS for the full rationale.
    if (options.regex && !isSafe(pattern, { timeout: REDOS_ANALYSIS_TIMEOUT_MS }).safe) {
      throw new GhostError(
        "invalid_format",
        "That regular expression can backtrack catastrophically and could hang the "
        + "daemon, so it was refused. Simplify it — remove nested quantifiers such as "
        + "\"(a+)+\" — or search for a plain phrase instead.",
        { query },
      );
    }

    const { docs } = await this.listDocs();
    // Archived docs are out of the working set by default.
    const candidates = docs.filter((doc) =>
      options.includeArchived === true || !doc.archived
    );
    const matches: DocSearchMatch[] = [];
    let truncated = false;
    let docsSearched = 0;

    // One collector for title and body matches alike. The title push used to
    // bypass maxResults entirely and never set `truncated`, so a corpus of
    // title-matching docs could overrun the cap silently; now every match is
    // gated the same way. Returns false once the cap is reached.
    const collect = (match: DocSearchMatch): boolean => {
      if (matches.length >= maxResults) {
        truncated = true;
        return false;
      }
      matches.push(match);
      return true;
    };

    for (const doc of candidates) {
      docsSearched += 1;
      const { body, meta } = await this.readDoc(doc.path);
      if (meta.title !== undefined && pattern.test(meta.title)) {
        if (!collect({ path: doc.path, line: 0, text: `title: ${meta.title}` })) break;
      }
      const lines = body.split("\n");
      let overflowed = false;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        const scanned = line.length > MAX_GREP_LINE_SCAN_CHARS
          ? line.slice(0, MAX_GREP_LINE_SCAN_CHARS)
          : line;
        if (!pattern.test(scanned)) continue;
        if (!collect({ path: doc.path, line: index + 1, text: line.trim() })) {
          overflowed = true;
          break;
        }
      }
      if (overflowed) break;
    }

    return { matches, truncated, docsSearched };
  }

  // ------------------------------------------------------------------- memory

  async listMemory(): Promise<MemoryListing> {
    const dir = this.memoryDir;
    const files: MemoryRecord[] = [];
    const skipped: SkippedFile[] = [];
    for (const entry of await readDirEntries(dir)) {
      if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) {
        continue;
      }
      const relativePath = this.relative(join(dir, entry.name));
      try {
        const parsed = parseMemoryFile(await readFile(join(dir, entry.name), "utf8"));
        files.push({
          slug: coerceMemorySlug(entry.name),
          description: parsed.description,
          content: parsed.content,
          updated: parsed.updated,
        });
      } catch (error) {
        skipped.push({ path: relativePath, reason: message(error) });
      }
    }
    files.sort((left, right) => left.slug.localeCompare(right.slug));
    return { files, skipped };
  }

  async readMemory(name: string): Promise<MemoryRecord> {
    const slug = coerceMemorySlug(name);
    const dir = this.memoryDir;
    const full = resolveWithin(dir, memoryFileName(slug), "Memory file");
    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GhostError(
          "not_found",
          `No memory file named ${memoryFileName(slug)}.`,
          { name: memoryFileName(slug) },
        );
      }
      throw error;
    }
    const parsed = parseMemoryFile(text);
    return {
      slug,
      description: parsed.description,
      content: parsed.content,
      updated: parsed.updated,
    };
  }

  /** Create or replace exactly one atomic memory file. */
  async writeMemory(
    input: MemoryWriteInput,
  ): Promise<MemoryWriteResult> {
    assertWritableMemory(input.description, input.content);
    const slug = input.name
      ? coerceMemorySlug(input.name)
      : memorySlugForText(input.description);
    const dir = this.memoryDir;
    const full = resolveWithin(dir, memoryFileName(slug), "Memory file");
    const text = serializeMemoryFile({
      description: input.description.trim(),
      content: input.content.trim(),
      updatedAt: input.updatedAt ?? new Date(),
    });

    return withFileMutationQueue(full, async () => {
      const created = !(await exists(full));
      if (created) {
        const { files } = await this.listMemory();
        if (files.length >= MAX_MEMORY_FILES) {
          throw new GhostError(
            "limit_exceeded",
            `Memory already holds ${MAX_MEMORY_FILES} files. `
            + "Rewrite an existing memory instead of adding another.",
            { limit: MAX_MEMORY_FILES },
          );
        }
      }
      await mkdir(dir, { recursive: true });
      await writeFile(full, text, "utf8");
      return { slug, path: this.relative(full), created };
    });
  }

  // ------------------------------------------------------- conversations/meta

  /** Imported transcript file names, without the `.json`. */
  async listConversations(): Promise<string[]> {
    const entries = await readDirEntries(this.conversationsDir);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort((left, right) => left.localeCompare(right));
  }

  /** The `export-manifest.json` of the archive this home was imported from. */
  async readExportManifest(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(
        await readFile(join(this.dir, EXPORT_MANIFEST_FILENAME), "utf8"),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new GhostError(
        "invalid_format",
        `${EXPORT_MANIFEST_FILENAME} is not readable JSON: ${message(error)}`,
      );
    }
  }
}

export function openGhostHome(dir: string): GhostHome {
  return new GhostHome(dir);
}
