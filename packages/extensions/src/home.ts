/**
 * The ghost-home/v1 reader/writer.
 *
 * A ghost is a directory (CONTRACTS.md):
 *
 *     <ghostsRoot>/<name>/
 *       character.md
 *       notes/**\/*.md
 *       memory/*.md
 *       memory/.visitors/<id>/*.md
 *       conversations/*.json
 *       export-manifest.json      (only in imported archives)
 *
 * Two rules run through everything here:
 *
 * 1. **Bodies are bytes.** A note read and written back unchanged is
 *    byte-identical. No trimming, no newline normalization, no "tidying".
 * 2. **Nothing derived is stored.** The memory index and the note catalog are
 *    computed per session (`deriveMemoryIndex`, `deriveNoteCatalog`). There is no
 *    MEMORY.md and no catalog file, by contract.
 *
 * Every mutation goes through pi's `withFileMutationQueue`, keyed on the target
 * path: pi runs tool calls in parallel by default, so two `ghost_memory_write`
 * calls in one batch can otherwise interleave on the same file.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isNoteVisible } from "./catalog.js";
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
  MAX_MEMORY_FILES_PER_SCOPE,
  memoryFileName,
  memorySlugForText,
  parseMemoryFile,
  serializeMemoryFile,
} from "./memory-file.js";
import { CREATOR_SCOPE, isVisitorScope, type GhostScope } from "./scope.js";
import type {
  CharacterFile,
  MemoryRecord,
  NoteFile,
  NoteFrontmatter,
  NoteMeta,
} from "./types.js";

export const NOTES_DIRNAME = "notes";
export const MEMORY_DIRNAME = "memory";
/** Dot-folder: out of the creator's default view, but inspectable. */
export const VISITORS_DIRNAME = ".visitors";
export const CONVERSATIONS_DIRNAME = "conversations";
export const CHARACTER_FILENAME = "character.md";
export const EXPORT_MANIFEST_FILENAME = "export-manifest.json";

export interface SkippedFile {
  /** Path relative to the ghost home. */
  readonly path: string;
  readonly reason: string;
}

export interface NoteListing {
  readonly notes: readonly NoteMeta[];
  /**
   * Files under `notes/` that could not be parsed. They are excluded from the
   * catalog — and therefore invisible to visitors — rather than guessed at, but
   * they are reported rather than dropped silently.
   */
  readonly skipped: readonly SkippedFile[];
}

export interface MemoryListing {
  readonly files: readonly MemoryRecord[];
  readonly skipped: readonly SkippedFile[];
}

export interface NoteWriteInput {
  readonly body: string;
  /** Omitted on an existing note keeps its current value; new notes default to private. */
  readonly public?: boolean;
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
  /** Path relative to the ghost home, e.g. `memory/.visitors/v1/preferred-tone.md`. */
  readonly path: string;
  readonly created: boolean;
}

export interface NoteSearchOptions {
  readonly scope?: GhostScope;
  /** Treat the query as a JavaScript regular expression. */
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
  readonly includeArchived?: boolean;
}

export interface NoteSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface NoteSearchResult {
  readonly matches: readonly NoteSearchMatch[];
  readonly truncated: boolean;
  readonly notesSearched: number;
}

const DEFAULT_SEARCH_RESULTS = 50;

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
export function normalizeNotePath(input: string): string {
  const segments = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new GhostError("invalid_path", "A note path is required.");
  }
  if (segments.some((segment) => segment === "..")) {
    throw new GhostError(
      "invalid_path",
      `Note path ${JSON.stringify(input)} escapes the notes directory.`,
      { path: input },
    );
  }
  const last = segments[segments.length - 1] as string;
  segments[segments.length - 1] = last.endsWith(".md") ? last : `${last}.md`;
  return segments.join("/");
}

function noteFrontmatterFrom(text: string): { meta: NoteFrontmatter; body: string } {
  const parsed = parseDocument(text);
  return {
    meta: {
      public: readBoolean(parsed.frontmatter, "public"),
      title: readString(parsed.frontmatter, "title"),
      tags: readStringList(parsed.frontmatter, "tags"),
      archived: readBoolean(parsed.frontmatter, "archived"),
      appPath: readString(parsed.frontmatter, "path"),
    },
    body: parsed.body,
  };
}

/** Frontmatter lines in the order the hosted export writes them. */
function noteFrontmatterLines(meta: NoteFrontmatter, path: string): string[] {
  const lines = [`public: ${meta.public}`];
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

  get notesDir(): string {
    return join(this.dir, NOTES_DIRNAME);
  }

  get memoryDir(): string {
    return join(this.dir, MEMORY_DIRNAME);
  }

  get visitorsDir(): string {
    return join(this.memoryDir, VISITORS_DIRNAME);
  }

  get conversationsDir(): string {
    return join(this.dir, CONVERSATIONS_DIRNAME);
  }

  /** Where memory lives for a scope. Visitors write under `memory/.visitors/<id>/`. */
  memoryDirFor(scope: GhostScope): string {
    return isVisitorScope(scope) ? join(this.visitorsDir, scope.visitorId) : this.memoryDir;
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
    await mkdir(this.notesDir, { recursive: true });
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
      // character.md is the persona; it is public unless it says otherwise.
      public: parsed.frontmatter["public"] !== false,
      title: readString(parsed.frontmatter, "title"),
      body: parsed.body,
    };
  }

  async writeCharacter(input: {
    body: string;
    title?: string;
    public?: boolean;
  }): Promise<void> {
    const lines = [`public: ${input.public ?? true}`];
    if (input.title !== undefined) lines.push(`title: ${yamlScalar(input.title)}`);
    const text = renderDocument(lines, input.body);
    await withFileMutationQueue(this.characterPath, async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.characterPath, text, "utf8");
    });
  }

  // -------------------------------------------------------------------- notes

  /** Every `.md` under `notes/`, recursively. Hidden files and dirs are skipped. */
  async listNotes(): Promise<NoteListing> {
    const notes: NoteMeta[] = [];
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
          notes.push({ ...noteFrontmatterFrom(text).meta, path: childPath });
        } catch (error) {
          skipped.push({
            path: `${NOTES_DIRNAME}/${childPath}`,
            reason: message(error),
          });
        }
      }
    };

    await walk(this.notesDir, "");
    notes.sort((left, right) => left.path.localeCompare(right.path));
    return { notes, skipped };
  }

  async readNote(path: string): Promise<NoteFile> {
    const notePath = normalizeNotePath(path);
    const full = resolveWithin(this.notesDir, notePath, "Note path");
    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GhostError("not_found", `No note at ${notePath}.`, { path: notePath });
      }
      throw error;
    }
    const parsed = noteFrontmatterFrom(text);
    return { meta: { ...parsed.meta, path: notePath }, body: parsed.body };
  }

  /** Metadata for one note, or null when it does not exist. */
  async findNote(path: string): Promise<NoteMeta | null> {
    try {
      return (await this.readNote(path)).meta;
    } catch (error) {
      if (error instanceof GhostError && error.code === "not_found") return null;
      throw error;
    }
  }

  async writeNote(path: string, input: NoteWriteInput): Promise<NoteMeta> {
    const notePath = normalizeNotePath(path);
    const full = resolveWithin(this.notesDir, notePath, "Note path");
    const existing = await this.findNote(notePath);
    const meta: NoteMeta = {
      path: notePath,
      public: input.public ?? existing?.public ?? false,
      title: input.title ?? existing?.title,
      tags: input.tags ?? existing?.tags ?? [],
      archived: input.archived ?? existing?.archived ?? false,
      appPath: input.appPath ?? existing?.appPath,
    };
    const text = renderDocument(noteFrontmatterLines(meta, notePath), input.body);
    await withFileMutationQueue(full, async () => {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, "utf8");
    });
    return meta;
  }

  /** Plain substring or regex search over note bodies and titles. */
  async searchNotes(
    query: string,
    options: NoteSearchOptions = {},
  ): Promise<NoteSearchResult> {
    const scope = options.scope ?? CREATOR_SCOPE;
    const maxResults = Math.max(1, options.maxResults ?? DEFAULT_SEARCH_RESULTS);
    const flags = options.caseSensitive ? "" : "i";
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

    const { notes } = await this.listNotes();
    // Archived notes are out of the working set by default; a visitor never sees
    // them at all, so `includeArchived` only ever widens a creator search.
    const candidates = notes.filter((note) =>
      isNoteVisible(note, scope) && (options.includeArchived === true || !note.archived)
    );
    const matches: NoteSearchMatch[] = [];
    let truncated = false;
    let notesSearched = 0;

    for (const note of candidates) {
      notesSearched += 1;
      const { body, meta } = await this.readNote(note.path);
      if (meta.title !== undefined && pattern.test(meta.title)) {
        matches.push({ path: note.path, line: 0, text: `title: ${meta.title}` });
      }
      const lines = body.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] as string;
        if (!pattern.test(text)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        matches.push({ path: note.path, line: index + 1, text: text.trim() });
      }
      if (truncated) break;
    }

    return { matches, truncated, notesSearched };
  }

  // ------------------------------------------------------------------- memory

  async listMemory(scope: GhostScope = CREATOR_SCOPE): Promise<MemoryListing> {
    const dir = this.memoryDirFor(scope);
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
          scope,
        });
      } catch (error) {
        skipped.push({ path: relativePath, reason: message(error) });
      }
    }
    files.sort((left, right) => left.slug.localeCompare(right.slug));
    return { files, skipped };
  }

  async readMemory(name: string, scope: GhostScope = CREATOR_SCOPE): Promise<MemoryRecord> {
    const slug = coerceMemorySlug(name);
    const dir = this.memoryDirFor(scope);
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
      scope,
    };
  }

  /** Create or replace exactly one atomic memory file. */
  async writeMemory(
    input: MemoryWriteInput,
    scope: GhostScope = CREATOR_SCOPE,
  ): Promise<MemoryWriteResult> {
    assertWritableMemory(input.description, input.content);
    const slug = input.name
      ? coerceMemorySlug(input.name)
      : memorySlugForText(input.description);
    const dir = this.memoryDirFor(scope);
    const full = resolveWithin(dir, memoryFileName(slug), "Memory file");
    const text = serializeMemoryFile({
      description: input.description.trim(),
      content: input.content.trim(),
      updatedAt: input.updatedAt ?? new Date(),
    });

    return withFileMutationQueue(full, async () => {
      const created = !(await exists(full));
      if (created) {
        const { files } = await this.listMemory(scope);
        if (files.length >= MAX_MEMORY_FILES_PER_SCOPE) {
          throw new GhostError(
            "limit_exceeded",
            `This memory scope already holds ${MAX_MEMORY_FILES_PER_SCOPE} files. `
            + "Rewrite an existing memory instead of adding another.",
            { limit: MAX_MEMORY_FILES_PER_SCOPE },
          );
        }
      }
      await mkdir(dir, { recursive: true });
      await writeFile(full, text, "utf8");
      return { slug, path: this.relative(full), created };
    });
  }

  /** Visitor ids that have memory in this home. */
  async listVisitors(): Promise<string[]> {
    const entries = await readDirEntries(this.visitorsDir);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
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
