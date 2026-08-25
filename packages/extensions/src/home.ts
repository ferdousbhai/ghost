/**
 * The ghost-home/v2 reader/writer and one-time v1 document migrator.
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
 * Mutations use a path-keyed in-process queue plus descriptor locks and atomic
 * rename: OMP runs tool calls in parallel, and ghostd import can be a separate
 * process, so neither shared quotas nor file publication may rely on one event
 * loop.
 */
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isSafe } from "redos-detector";
import { migrateDoc, parseDoc } from "./doc-format.js";
import { GhostError } from "./errors.js";
import {
  parseDocument,
  readString,
  renderDocument,
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
import {
  descriptorPath,
  openConfinedDirectory,
  openConfinedFile,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
  withDescriptorLock,
} from "./linux-fs.js";
import { GHOST_HOME_FORMAT } from "./types.js";
import type {
  CharacterFile,
  MemoryRecord,
  DocFile,
  DocMeta,
} from "./types.js";

export const DOCS_DIRNAME = "docs";
const LEGACY_NOTES_DIRNAME = "notes";
const LEGACY_GHOST_HOME_FORMAT = "ghost-home/v1";
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
  /** Complete canonical ghost-home/v2 Markdown, written byte-for-byte. */
  readonly body: string;
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
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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

async function readConfinedText(
  homeDir: string,
  path: string,
  label: string,
): Promise<string | null> {
  const file = await openConfinedFile(homeDir, path, label);
  if (!file) return null;
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function existingFileMode(
  directory: FileHandle,
  name: string,
  label: string,
): Promise<number | null> {
  let file: FileHandle;
  try {
    file = await openRegularFileNoFollow(
      descriptorPath(directory, name),
      label,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await file.stat();
    return stats.mode & 0o777;
  } finally {
    await file.close();
  }
}

async function atomicWriteFile(
  homeDir: string,
  path: string,
  content: string | Uint8Array,
  lockedDirectory?: FileHandle,
): Promise<void> {
  const ownedDirectory = lockedDirectory === undefined;
  const directory = lockedDirectory ?? await openConfinedDirectory(
    homeDir,
    dirname(path),
    { create: true, label: "Write path" },
  );
  const name = basename(path);
  const temporaryName = `.${name}.write-${process.pid}-${randomUUID()}`;
  let handle: FileHandle | undefined;
  const publish = async (): Promise<void> => {
    const existingMode = await existingFileMode(directory, name, "Write path");
    const mode = existingMode ?? 0o666;
    const temporary = descriptorPath(directory, temporaryName);
    const target = descriptorPath(directory, name);
    try {
      handle = await open(
        temporary,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        mode,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await directory.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
  try {
    if (ownedDirectory) await withDescriptorLock(directory, publish);
    else await publish();
  } finally {
    if (ownedDirectory) await directory.close();
  }
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

async function migrateDocFile(
  homeDir: string,
  directory: FileHandle,
  name: string,
  fullPath: string,
  docPath: string,
): Promise<void> {
  await withFileMutationQueue(fullPath, async () => {
    await withDescriptorLock(directory, async () => {
      const text = await readEntryText(directory, name, "Document path");
      if (text === null) return;
      const migrated = migrateDoc(text, docPath);
      if (migrated === text) return;
      await atomicWriteFile(homeDir, fullPath, migrated, directory);
    });
  });
}

async function migrateDocTree(
  homeDir: string,
  directory: FileHandle,
  lexicalDir: string,
  prefix = "",
): Promise<void> {
  for (const entry of await readdir(descriptorPath(directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const docPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(lexicalDir, entry.name);
    if (entry.isDirectory()) {
      const child = await openDirectoryNoFollow(
        descriptorPath(directory, entry.name),
        "Document path",
      );
      try {
        await migrateDocTree(homeDir, child, fullPath, docPath);
      } finally {
        await child.close();
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      await migrateDocFile(homeDir, directory, entry.name, fullPath, docPath);
    }
  }
}

async function readEntryText(
  directory: FileHandle,
  name: string,
  label: string,
): Promise<string | null> {
  let file: FileHandle;
  try {
    file = await openRegularFileNoFollow(
      descriptorPath(directory, name),
      label,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function openOrCreateChildDirectory(
  parent: FileHandle,
  name: string,
  label: string,
): Promise<FileHandle> {
  const child = descriptorPath(parent, name);
  try {
    await mkdir(child);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openDirectoryNoFollow(child, label);
}

async function openChildDirectoryIfPresent(
  parent: FileHandle,
  name: string,
  label: string,
): Promise<FileHandle | null> {
  try {
    return await openDirectoryNoFollow(descriptorPath(parent, name), label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseExportManifest(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new GhostError(
      "invalid_format",
      `${EXPORT_MANIFEST_FILENAME} is not readable JSON: ${message(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GhostError(
      "invalid_format",
      `${EXPORT_MANIFEST_FILENAME} must contain a JSON object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

async function migrateExportManifest(
  dir: string,
  directory: FileHandle,
): Promise<void> {
  const fullPath = join(dir, EXPORT_MANIFEST_FILENAME);
  await withFileMutationQueue(fullPath, async () => {
    const text = await readEntryText(
      directory,
      EXPORT_MANIFEST_FILENAME,
      "Manifest path",
    );
    if (text === null) return;

    const manifest = parseExportManifest(text);
    if (manifest.format === GHOST_HOME_FORMAT) return;
    if (manifest.format !== LEGACY_GHOST_HOME_FORMAT) {
      throw new GhostError(
        "invalid_format",
        `Unsupported home format ${JSON.stringify(manifest.format)}; expected `
        + `${JSON.stringify(GHOST_HOME_FORMAT)}.`,
        { format: manifest.format },
      );
    }

    await atomicWriteFile(
      dir,
      fullPath,
      `${JSON.stringify({ ...manifest, format: GHOST_HOME_FORMAT }, null, 2)}\n`,
      directory,
    );
  });
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
    await withFileMutationQueue(this.dir, async () => {
      await mkdir(this.dir, { recursive: true });
      const directory = await openConfinedDirectory(this.dir, this.dir, {
        label: "Ghost home",
      });
      try {
        await withDescriptorLock(directory, async () => {
          const legacyNotesDir = join(this.dir, LEGACY_NOTES_DIRNAME);
          let docs = await openChildDirectoryIfPresent(
            directory,
            DOCS_DIRNAME,
            "Documents path",
          );
          let legacyNotes: FileHandle | null = null;
          try {
            legacyNotes = await openChildDirectoryIfPresent(
              directory,
              LEGACY_NOTES_DIRNAME,
              "Legacy notes path",
            );
            if (docs && legacyNotes) {
              throw new GhostError(
                "conflict",
                `Both ${DOCS_DIRNAME}/ and the legacy ${LEGACY_NOTES_DIRNAME}/ directory exist in `
                + `${this.dir}. Merge them into ${DOCS_DIRNAME}/ before opening this ghost.`,
                { docs: this.docsDir, legacyNotes: legacyNotesDir },
              );
            }
            if (legacyNotes) {
              await legacyNotes.close();
              legacyNotes = null;
              await rename(
                descriptorPath(directory, LEGACY_NOTES_DIRNAME),
                descriptorPath(directory, DOCS_DIRNAME),
              );
              docs = await openDirectoryNoFollow(
                descriptorPath(directory, DOCS_DIRNAME),
                "Documents path",
              );
            }
            docs ??= await openOrCreateChildDirectory(
              directory,
              DOCS_DIRNAME,
              "Documents path",
            );
            await migrateDocTree(this.dir, docs, this.docsDir);
          } finally {
            await docs?.close().catch(() => undefined);
            await legacyNotes?.close().catch(() => undefined);
          }
          await migrateExportManifest(this.dir, directory);

          const memory = await openOrCreateChildDirectory(
            directory,
            MEMORY_DIRNAME,
            "Memory path",
          );
          await memory.close();
          const conversations = await openOrCreateChildDirectory(
            directory,
            CONVERSATIONS_DIRNAME,
            "Conversations path",
          );
          await conversations.close();
        });
      } finally {
        await directory.close();
      }
    });
  }

  // ---------------------------------------------------------------- character

  async readCharacter(): Promise<CharacterFile | null> {
    const text = await readConfinedText(this.dir, this.characterPath, "Character path");
    if (text === null) return null;
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
      await atomicWriteFile(this.dir, this.characterPath, text);
    });
  }

  // -------------------------------------------------------------------- docs

  /** Every `.md` under `docs/`, recursively. Hidden files and dirs are skipped. */
  async listDocs(): Promise<DocListing> {
    const docs: DocMeta[] = [];
    const skipped: SkippedFile[] = [];

    if (!(await exists(this.docsDir))) return { docs, skipped };
    const root = await openConfinedDirectory(this.dir, this.docsDir, {
      label: "Documents path",
    });

    const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
      for (const entry of await readdir(descriptorPath(directory), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".")) continue;
        const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          let child: FileHandle;
          try {
            child = await openDirectoryNoFollow(
              descriptorPath(directory, entry.name),
              "Document path",
            );
          } catch (error) {
            skipped.push({
              path: `${DOCS_DIRNAME}/${childPath}`,
              reason: message(error),
            });
            continue;
          }
          try {
            await walk(child, childPath);
          } finally {
            await child.close();
          }
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        try {
          const text = await readEntryText(directory, entry.name, "Document path");
          if (text === null) continue;
          docs.push({ ...parseDoc(text), path: childPath });
        } catch (error) {
          skipped.push({
            path: `${DOCS_DIRNAME}/${childPath}`,
            reason: message(error),
          });
        }
      }
    };

    try {
      await walk(root, "");
    } finally {
      await root.close();
    }
    docs.sort((left, right) => left.path.localeCompare(right.path));
    return { docs, skipped };
  }

  async readDoc(path: string): Promise<DocFile> {
    const docPath = normalizeDocPath(path);
    const full = resolveWithin(this.docsDir, docPath, "Document path");
    const text = await readConfinedText(this.dir, full, "Document path");
    if (text === null) {
      throw new GhostError("not_found", `No document at ${docPath}.`, { path: docPath });
    }
    const parsed = parseDoc(text);
    return { meta: { ...parsed, path: docPath }, body: text };
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
    const parsed = parseDoc(input.body);
    await withFileMutationQueue(full, async () => {
      await atomicWriteFile(this.dir, full, input.body);
    });
    return { ...parsed, path: docPath };
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
      if (pattern.test(meta.title)) {
        if (!collect({ path: doc.path, line: 0, text: `title: ${meta.title}` })) break;
      }
      const lines = body.split("\n");
      let overflowed = false;
      // The complete v2 body includes the title heading; it was already
      // represented by the stable synthetic line 0 above.
      for (let index = 1; index < lines.length; index += 1) {
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
    if (!(await exists(dir))) return { files, skipped };
    const directory = await openConfinedDirectory(this.dir, dir, { label: "Memory path" });
    try {
      await this.listMemoryFromDirectory(directory, files, skipped);
    } finally {
      await directory.close();
    }
    files.sort((left, right) => left.slug.localeCompare(right.slug));
    return { files, skipped };
  }

  private async listMemoryFromDirectory(
    directory: FileHandle,
    files: MemoryRecord[],
    skipped: SkippedFile[],
  ): Promise<void> {
    for (const entry of await readdir(descriptorPath(directory), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
      const relativePath = `${MEMORY_DIRNAME}/${entry.name}`;
      try {
        const text = await readEntryText(directory, entry.name, "Memory file");
        if (text === null) continue;
        const parsed = parseMemoryFile(text);
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
  }

  async readMemory(name: string): Promise<MemoryRecord> {
    const slug = coerceMemorySlug(name);
    const dir = this.memoryDir;
    const full = resolveWithin(dir, memoryFileName(slug), "Memory file");
    const text = await readConfinedText(this.dir, full, "Memory file");
    if (text === null) {
      throw new GhostError(
        "not_found",
        `No memory file named ${memoryFileName(slug)}.`,
        { name: memoryFileName(slug) },
      );
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

    // The quota spans the directory, so new names must share one queue. A
    // per-file queue lets parallel creates all observe the same free slot.
    return withFileMutationQueue(dir, async () => {
      const directory = await openConfinedDirectory(this.dir, dir, {
        create: true,
        label: "Memory path",
      });
      try {
        return await withDescriptorLock(directory, async () => {
          const created = await existingFileMode(
            directory,
            memoryFileName(slug),
            "Memory file",
          ) === null;
          if (created) {
            const files: MemoryRecord[] = [];
            const skipped: SkippedFile[] = [];
            await this.listMemoryFromDirectory(directory, files, skipped);
            if (files.length >= MAX_MEMORY_FILES) {
              throw new GhostError(
                "limit_exceeded",
                `Memory already holds ${MAX_MEMORY_FILES} files. `
                + "Rewrite an existing memory instead of adding another.",
                { limit: MAX_MEMORY_FILES },
              );
            }
          }
          await atomicWriteFile(this.dir, full, text, directory);
          return { slug, path: this.relative(full), created };
        });
      } finally {
        await directory.close();
      }
    });
  }

  // ------------------------------------------------------- conversations/meta

  /** Imported transcript file names, without the `.json`. */
  async listConversations(): Promise<string[]> {
    if (!(await exists(this.conversationsDir))) return [];
    const directory = await openConfinedDirectory(this.dir, this.conversationsDir, {
      label: "Conversations path",
    });
    try {
      const conversations: string[] = [];
      for (const entry of await readdir(descriptorPath(directory), {
        withFileTypes: true,
      })) {
        if (!entry.name.endsWith(".json")) continue;
        let file: FileHandle | undefined;
        try {
          file = await openRegularFileNoFollow(
            descriptorPath(directory, entry.name),
            "Conversation path",
          );
          conversations.push(entry.name.slice(0, -".json".length));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code !== "ENOENT"
            && !(error instanceof GhostError && error.code === "invalid_path")
          ) throw error;
        } finally {
          await file?.close();
        }
      }
      return conversations.sort((left, right) => left.localeCompare(right));
    } finally {
      await directory.close();
    }
  }

  /** The v2 `export-manifest.json` of the archive this home was imported from. */
  async readExportManifest(): Promise<Record<string, unknown> | null> {
    const fullPath = join(this.dir, EXPORT_MANIFEST_FILENAME);
    const text = await readConfinedText(this.dir, fullPath, "Manifest path");
    if (text === null) return null;
    const manifest = parseExportManifest(text);
    if (manifest.format !== GHOST_HOME_FORMAT) {
      throw new GhostError(
        "invalid_format",
        `Unsupported home format ${JSON.stringify(manifest.format)}; expected `
        + `${JSON.stringify(GHOST_HOME_FORMAT)}.`,
        { format: manifest.format },
      );
    }
    return manifest;
  }
}

export function openGhostHome(dir: string): GhostHome {
  return new GhostHome(dir);
}
