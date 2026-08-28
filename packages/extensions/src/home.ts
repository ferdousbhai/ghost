/**
 * Mutations pair the path-keyed in-process queue with descriptor locks and
 * atomic rename because `ghostd import` mutates a home from a separate process:
 * neither shared quotas nor file publication may rely on one event loop.
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
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { migrateDoc } from "./doc-format.js";
import { GhostError, MemoryFileFormatError } from "./errors.js";
import {
  assertWritableMemory,
  coerceMemorySlug,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILES,
  memoryFileName,
  memorySlugForText,
  parseMemoryFile,
  redactMemorySecrets,
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
} from "./types.js";

export const DOCS_DIRNAME = "docs";
const LEGACY_NOTES_DIRNAME = "notes";
const LEGACY_GHOST_HOME_FORMAT = "ghost-home/v1";
export const MEMORY_DIRNAME = "memory";
export const MEMORY_TRASH_DIRNAME = ".trash";
export const CONVERSATIONS_DIRNAME = "conversations";
export const CHARACTER_FILENAME = "character.md";
export const MAX_CHARACTER_BODY_LENGTH = 20_000;
export const EXPORT_MANIFEST_FILENAME = "export-manifest.json";

const MEMORY_INTENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface MemoryListing {
  readonly files: readonly MemoryRecord[];
  readonly skipped: readonly SkippedFile[];
}

export interface MemoryWriteInput {
  readonly name?: string;
  readonly content: string;
}

export interface MemoryWriteResult {
  readonly slug: string;
  readonly path: string;
  readonly created: boolean;
}

export interface MemoryWriteIntent {
  readonly id: string;
  readonly path: `memory/${string}.md`;
  readonly before: string | null;
  /** Exact serialized Markdown that will be atomically published. */
  readonly after: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
}

export interface MemoryWriteReceipt extends MemoryWriteIntent {
  readonly operation: "created" | "updated";
}

export interface MemoryWriteWithReceiptResult {
  readonly written: MemoryWriteResult;
  readonly receipt: MemoryWriteReceipt;
}

export interface MemoryDeleteResult {
  readonly slug: string;
  readonly path: `memory/${string}.md`;
  readonly trash: `.trash/${string}.md`;
}

export interface MemoryDeleteIntent {
  readonly id: string;
  readonly path: `memory/${string}.md`;
  readonly before: string;
  readonly beforeSha256: string;
  readonly trash: `.trash/${string}.md`;
}

export interface MemoryDeleteReceipt extends MemoryDeleteIntent {
  readonly operation: "deleted";
}

export interface MemoryDeleteWithReceiptResult {
  readonly deleted: MemoryDeleteResult;
  readonly receipt: MemoryDeleteReceipt;
}

export type MemoryReadStage = "opened" | "read";

export interface GhostHomeOptions {
  /** Deterministic descriptor-race injection for filesystem-boundary tests. */
  readonly memoryReadProbe?: (
    stage: MemoryReadStage,
    path: string,
  ) => void | Promise<void>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function memoryIntentName(intent: MemoryWriteIntent): { name: string; slug: string } {
  const prefix = `${MEMORY_DIRNAME}/`;
  if (!intent.path.startsWith(prefix)) {
    throw new GhostError("invalid_format", "A memory replay intent has an invalid path.");
  }
  const name = intent.path.slice(prefix.length);
  const slug = coerceMemorySlug(name);
  if (intent.before !== null) assertAdmittedMemorySource(intent.before, intent.path);
  assertAdmittedMemorySource(intent.after, intent.path);
  if (intent.path !== `${prefix}${memoryFileName(slug)}`
    || !MEMORY_INTENT_UUID.test(intent.id)
    || intent.afterSha256 !== sha256(intent.after)
    || intent.beforeSha256 !== (intent.before === null ? null : sha256(intent.before))
    || serializeMemoryFile(parseMemoryFile(intent.after).content) !== intent.after) {
    throw new GhostError("invalid_format", "A memory replay intent failed exact validation.");
  }
  return { name, slug };
}

function parseMemoryTrashFileName(name: string): string {
  if (!name.endsWith(".md")) {
    throw new GhostError("invalid_format", "A memory trash entry must use the .md extension.");
  }
  const slug = name.slice(0, -".md".length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 240) {
    throw new GhostError("invalid_format", "A memory trash entry has an invalid name.");
  }
  return slug;
}

function validMemoryTrashSlug(slug: string, trashSlug: string): boolean {
  if (trashSlug === slug) return true;
  if (!trashSlug.startsWith(`${slug}-`)) return false;
  const suffixText = trashSlug.slice(slug.length + 1);
  const suffix = Number(suffixText);
  return Number.isSafeInteger(suffix) && suffix >= 2 && String(suffix) === suffixText;
}

function assertValidMemoryDeleteIntent(intent: MemoryDeleteIntent): void {
  const prefix = `${MEMORY_DIRNAME}/`;
  const trashPrefix = `${MEMORY_TRASH_DIRNAME}/`;
  if (!intent.path.startsWith(prefix) || !intent.trash.startsWith(trashPrefix)) {
    throw new GhostError("invalid_format", "A memory delete intent has an invalid path.");
  }
  const slug = coerceMemorySlug(intent.path.slice(prefix.length));
  const trashSlug = parseMemoryTrashFileName(intent.trash.slice(trashPrefix.length));
  assertAdmittedMemorySource(intent.before, intent.path);
  if (intent.path !== `${prefix}${memoryFileName(slug)}`
    || !validMemoryTrashSlug(slug, trashSlug)
    || !MEMORY_INTENT_UUID.test(intent.id)
    || intent.beforeSha256 !== sha256(intent.before)) {
    throw new GhostError("invalid_format", "A memory delete intent failed exact validation.");
  }
}

async function collisionFreeMemoryTrashName(
  trashDirectory: FileHandle,
  slug: string,
): Promise<string> {
  const entries = new Set(await readdir(descriptorPath(trashDirectory)));
  // One more candidate than existing entries always leaves a free name.
  for (let suffix = 1; suffix <= entries.size + 1; suffix += 1) {
    const name = memoryFileName(suffix === 1 ? slug : `${slug}-${suffix}`);
    if (!entries.has(name)) return name;
  }
  throw new GhostError(
    "limit_exceeded",
    `Memory trash already holds too many entries for ${memoryFileName(slug)}.`,
  );
}

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
  const source = await readConfinedTextFile(homeDir, path, label);
  return source?.text ?? null;
}

interface ReadTextFile {
  readonly text: string;
  readonly modified: Date;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function invalidMemoryBytes(path: string, reason: string): MemoryFileFormatError {
  return new MemoryFileFormatError(
    `Memory file ${JSON.stringify(path)} ${reason}.`,
    { path, limit: MAX_MEMORY_FILE_BYTES },
  );
}

function normalizeMemoryReadError(error: unknown, path: string): never {
  if (error instanceof GhostError) throw error;
  throw invalidMemoryBytes(path, `could not be read safely: ${message(error)}`);
}

function memoryChanged(path: string): GhostError {
  return new GhostError(
    "conflict",
    `Memory file ${JSON.stringify(path)} changed while it was being read.`,
    { path },
  );
}

function assertAdmittedMemorySource(text: string, path: string): void {
  if (Buffer.byteLength(text) > MAX_MEMORY_FILE_BYTES) {
    throw invalidMemoryBytes(path, `exceeds its ${MAX_MEMORY_FILE_BYTES}-byte limit`);
  }
  parseMemoryFile(text);
}

/**
 * Read one complete memory through its pinned directory entry. The initial
 * descriptor size is admitted before allocating or decoding any file data.
 */
async function readPinnedMemoryTextFile(
  directory: FileHandle,
  name: string,
  path: string,
  probe?: GhostHomeOptions["memoryReadProbe"],
): Promise<ReadTextFile | null> {
  let file: FileHandle;
  try {
    file = await openRegularFileNoFollow(
      descriptorPath(directory, name),
      "Memory file",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return normalizeMemoryReadError(error, path);
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw invalidMemoryBytes(path, "is not a regular file");
    if (before.size < 0n || before.size > BigInt(MAX_MEMORY_FILE_BYTES)) {
      throw invalidMemoryBytes(path, `exceeds its ${MAX_MEMORY_FILE_BYTES}-byte limit`);
    }
    await probe?.("opened", path);

    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    await probe?.("read", path);

    const after = await file.stat({ bigint: true });
    if (length > MAX_MEMORY_FILE_BYTES || after.size > BigInt(MAX_MEMORY_FILE_BYTES)) {
      throw invalidMemoryBytes(path, `exceeds its ${MAX_MEMORY_FILE_BYTES}-byte limit`);
    }
    if (BigInt(length) !== before.size || !sameFileIdentity(before, after)) {
      throw memoryChanged(path);
    }

    let live: BigIntStats;
    try {
      live = await lstat(descriptorPath(directory, name), { bigint: true });
    } catch {
      throw memoryChanged(path);
    }
    if (!sameFileIdentity(after, live)) {
      throw memoryChanged(path);
    }

    try {
      // Preserve an admitted UTF-8 BOM as U+FEFF so receipt comparisons and
      // hashes round-trip the exact owner-authored bytes.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(0, length));
      return { text, modified: after.mtime };
    } catch {
      throw invalidMemoryBytes(path, "is not valid UTF-8");
    }
  } catch (error) {
    return normalizeMemoryReadError(error, path);
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function readConfinedTextFile(
  homeDir: string,
  path: string,
  label: string,
): Promise<ReadTextFile | null> {
  const file = await openConfinedFile(homeDir, path, label);
  if (!file) return null;
  try {
    const text = await file.readFile("utf8");
    const stats = await file.stat();
    return { text, modified: stats.mtime };
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
  const source = await readEntryTextFile(directory, name, label);
  return source?.text ?? null;
}

async function readEntryTextFile(
  directory: FileHandle,
  name: string,
  label: string,
): Promise<ReadTextFile | null> {
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
    const text = await file.readFile("utf8");
    const stats = await file.stat();
    return { text, modified: stats.mtime };
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
  readonly dir: string;
  readonly name: string;
  readonly #memoryReadProbe?: GhostHomeOptions["memoryReadProbe"];

  constructor(dir: string, options: GhostHomeOptions = {}) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
    this.#memoryReadProbe = options.memoryReadProbe;
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

  get memoryTrashDir(): string {
    return join(this.dir, MEMORY_TRASH_DIRNAME);
  }

  get conversationsDir(): string {
    return join(this.dir, CONVERSATIONS_DIRNAME);
  }

  relative(absolutePath: string): string {
    return absolutePath.startsWith(this.dir + sep)
      ? absolutePath.slice(this.dir.length + 1).split(sep).join("/")
      : absolutePath;
  }

  exists(): Promise<boolean> {
    return exists(this.dir);
  }

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
            // `docs/` is a legacy/import input now. New homes use the shared
            // XDG Documents directory and do not recreate an empty per-ghost
            // directory after the owner's one-time move.
            if (docs) await migrateDocTree(this.dir, docs, this.docsDir);
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


  private characterTitle(body: string): string | undefined {
    const firstContentLine = body
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .find((line) => line.trim().length > 0);
    if (firstContentLine === undefined) return undefined;
    const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/.exec(firstContentLine);
    if (!match) return undefined;
    const title = (match[1] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    return title || undefined;
  }

  async readCharacter(): Promise<CharacterFile | null> {
    const body = await readConfinedText(this.dir, this.characterPath, "Character path");
    if (body === null) return null;
    if (body.length > MAX_CHARACTER_BODY_LENGTH) {
      throw new GhostError(
        "limit_exceeded",
        `${CHARACTER_FILENAME} may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
        + `it contains ${body.length}. Shorten the file before starting a session.`,
        { length: body.length, limit: MAX_CHARACTER_BODY_LENGTH },
      );
    }
    return {
      title: this.characterTitle(body),
      body,
    };
  }

  async writeCharacter(input: { body: string }): Promise<void> {
    if (input.body.length > MAX_CHARACTER_BODY_LENGTH) {
      throw new GhostError(
        "limit_exceeded",
        `${CHARACTER_FILENAME} may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
        + `that body is ${input.body.length}. Nothing was written.`,
        { length: input.body.length, limit: MAX_CHARACTER_BODY_LENGTH },
      );
    }
    await withFileMutationQueue(this.characterPath, async () => {
      await atomicWriteFile(this.dir, this.characterPath, input.body);
    });
  }


  async listMemory(): Promise<MemoryListing> {
    const dir = this.memoryDir;
    const files: MemoryRecord[] = [];
    const skipped: SkippedFile[] = [];
    let directory: FileHandle;
    try {
      directory = await openConfinedDirectory(this.dir, dir, { label: "Memory path" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files, skipped };
      throw error;
    }
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
        const source = await readPinnedMemoryTextFile(
          directory,
          entry.name,
          relativePath,
          this.#memoryReadProbe,
        );
        if (source === null) continue;
        const parsed = parseMemoryFile(source.text);
        files.push({
          slug: coerceMemorySlug(entry.name),
          content: parsed.content,
          updated: source.modified.toISOString(),
        });
      } catch (error) {
        skipped.push({ path: relativePath, reason: message(error) });
      }
    }
  }

  async readMemory(name: string): Promise<MemoryRecord> {
    const slug = coerceMemorySlug(name);
    const fileName = memoryFileName(slug);
    const path = `${MEMORY_DIRNAME}/${fileName}`;
    const source = await this.readMemoryEntry(fileName, path);
    if (source === null) {
      throw new GhostError(
        "not_found",
        `No memory file named ${fileName}.`,
        { name: fileName },
      );
    }
    const parsed = parseMemoryFile(source.text);
    return {
      slug,
      content: parsed.content,
      updated: source.modified.toISOString(),
    };
  }

  /**
   * Exact serialized bytes for a memory receipt/recovery comparison.
   * Presentation fields are derived and therefore cannot be used to
   * reconstruct owner-authored whitespace byte-for-byte.
   */
  async readMemorySource(name: string): Promise<string> {
    const slug = coerceMemorySlug(name);
    const fileName = memoryFileName(slug);
    const source = await this.readMemoryEntry(
      fileName,
      `${MEMORY_DIRNAME}/${fileName}`,
    );
    if (source === null) {
      throw new GhostError(
        "not_found",
        `No memory file named ${fileName}.`,
        { name: fileName },
      );
    }
    assertAdmittedMemorySource(source.text, `${MEMORY_DIRNAME}/${fileName}`);
    return source.text;
  }

  private async readMemoryEntry(name: string, path: string): Promise<ReadTextFile | null> {
    let directory: FileHandle;
    try {
      directory = await openConfinedDirectory(this.dir, this.memoryDir, {
        label: "Memory path",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return normalizeMemoryReadError(error, path);
    }
    try {
      return await readPinnedMemoryTextFile(
        directory,
        name,
        path,
        this.#memoryReadProbe,
      );
    } finally {
      await directory.close();
    }
  }

  /** Create or replace exactly one atomic memory file. */
  async writeMemory(
    input: MemoryWriteInput,
  ): Promise<MemoryWriteResult> {
    return (await this.writeMemoryWithReceipt(input, async () => {})).written;
  }

  /**
   * Publish one memory write with an exact, pre-publication receipt boundary.
   * The callback runs under the memory mutation queue and descriptor lock, so
   * durable callers can journal the precise before/after bytes before rename.
   */
  async writeMemoryWithReceipt(
    input: MemoryWriteInput,
    beforePublish: (intent: MemoryWriteIntent) => Promise<void>,
  ): Promise<MemoryWriteWithReceiptResult> {
    const content = redactMemorySecrets(input.content);
    assertWritableMemory(content);
    const slug = input.name
      ? coerceMemorySlug(input.name)
      : memorySlugForText(content);
    const dir = this.memoryDir;
    const full = resolveWithin(dir, memoryFileName(slug), "Memory file");
    const text = serializeMemoryFile(content);

    // The quota spans the directory, so new names must share one queue. A
    // per-file queue lets parallel creates all observe the same free slot.
    return withFileMutationQueue(dir, async () => {
      const directory = await openConfinedDirectory(this.dir, dir, {
        create: true,
        label: "Memory path",
      });
      try {
        return await withDescriptorLock(directory, async () => {
          const name = memoryFileName(slug);
          const before = (await readPinnedMemoryTextFile(
            directory,
            name,
            `${MEMORY_DIRNAME}/${name}`,
            this.#memoryReadProbe,
          ))?.text ?? null;
          if (before !== null) {
            assertAdmittedMemorySource(before, `${MEMORY_DIRNAME}/${name}`);
          }
          const created = before === null;
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
          const intent: MemoryWriteIntent = {
            id: randomUUID(),
            path: `${MEMORY_DIRNAME}/${name}` as `memory/${string}.md`,
            before,
            after: text,
            beforeSha256: before === null ? null : sha256(before),
            afterSha256: sha256(text),
          };
          await beforePublish(intent);
          await atomicWriteFile(this.dir, full, text, directory);
          const written = { slug, path: this.relative(full), created };
          return {
            written,
            receipt: {
              ...intent,
              operation: created ? "created" : "updated",
            },
          };
        });
      } finally {
        await directory.close();
      }
    });
  }

  /**
   * Replay one already-journaled exact memory publication without consulting a
   * model. The durable intent owns the exact before/after boundary: replay is
   * allowed only while the descriptor-pinned current bytes still equal before.
   */
  async replayMemoryWriteIntent(intent: MemoryWriteIntent): Promise<MemoryWriteReceipt> {
    const { name } = memoryIntentName(intent);
    const dir = this.memoryDir;
    const full = resolveWithin(dir, name, "Memory file");
    return withFileMutationQueue(dir, async () => {
      const directory = await openConfinedDirectory(this.dir, dir, {
        create: true,
        label: "Memory path",
      });
      try {
        return await withDescriptorLock(directory, async () => {
          const current = (await readPinnedMemoryTextFile(
            directory,
            name,
            `${MEMORY_DIRNAME}/${name}`,
            this.#memoryReadProbe,
          ))?.text ?? null;
          if (current !== null) {
            assertAdmittedMemorySource(current, `${MEMORY_DIRNAME}/${name}`);
          }
          const currentSha256 = current === null ? null : sha256(current);
          if (current !== intent.before || currentSha256 !== intent.beforeSha256) {
            throw new GhostError(
              "conflict",
              "The journaled memory write no longer matches the current file bytes.",
              { path: intent.path },
            );
          }
          await atomicWriteFile(this.dir, full, intent.after, directory);
          return {
            ...intent,
            operation: intent.before === null ? "created" : "updated",
          };
        });
      } finally {
        await directory.close();
      }
    });
  }

  async deleteMemory(name: string): Promise<MemoryDeleteResult> {
    return (await this.deleteMemoryWithReceipt(name, async () => {})).deleted;
  }

  /**
   * Move one admitted memory with an exact pre-rename journal boundary. The
   * callback and rename share the write path's directory queue and lock.
   */
  async deleteMemoryWithReceipt(
    inputName: string,
    beforeDelete: (intent: MemoryDeleteIntent) => Promise<void>,
  ): Promise<MemoryDeleteWithReceiptResult> {
    const slug = coerceMemorySlug(inputName);
    const name = memoryFileName(slug);
    const dir = this.memoryDir;
    resolveWithin(dir, name, "Memory file");
    return withFileMutationQueue(dir, async () => {
      const directory = await openConfinedDirectory(this.dir, dir, {
        label: "Memory path",
      });
      const trashDirectory = await openConfinedDirectory(this.dir, this.memoryTrashDir, {
        create: true,
        label: "Memory trash path",
      });
      try {
        return await withDescriptorLock(directory, async () => {
          const path = `${MEMORY_DIRNAME}/${name}` as `memory/${string}.md`;
          const before = (await readPinnedMemoryTextFile(
            directory,
            name,
            path,
            this.#memoryReadProbe,
          ))?.text;
          if (before === undefined) {
            throw new GhostError(
              "not_found",
              `No memory file named ${name}.`,
              { name },
            );
          }
          assertAdmittedMemorySource(before, path);
          const trashName = await collisionFreeMemoryTrashName(trashDirectory, slug);
          const trash = `${MEMORY_TRASH_DIRNAME}/${trashName}` as `.trash/${string}.md`;
          const intent: MemoryDeleteIntent = {
            id: randomUUID(),
            path,
            before,
            beforeSha256: sha256(before),
            trash,
          };
          await beforeDelete(intent);
          await rename(
            descriptorPath(directory, name),
            descriptorPath(trashDirectory, trashName),
          );
          await directory.sync();
          await trashDirectory.sync();
          return {
            deleted: { slug, path, trash },
            receipt: { ...intent, operation: "deleted" },
          };
        });
      } finally {
        await directory.close();
        await trashDirectory.close();
      }
    });
  }

  async readTrashedMemorySource(trashPath: string): Promise<string> {
    const prefix = `${MEMORY_TRASH_DIRNAME}/`;
    if (!trashPath.startsWith(prefix)) {
      throw new GhostError("invalid_path", "Expected a path under memory trash.");
    }
    const name = trashPath.slice(prefix.length);
    parseMemoryTrashFileName(name);
    resolveWithin(this.memoryTrashDir, name, "Memory trash file");
    let directory: FileHandle;
    try {
      directory = await openConfinedDirectory(this.dir, this.memoryTrashDir, {
        label: "Memory trash path",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GhostError("not_found", `No trashed memory file named ${name}.`, { name });
      }
      throw error;
    }
    try {
      const source = await readPinnedMemoryTextFile(
        directory,
        name,
        trashPath,
        this.#memoryReadProbe,
      );
      if (source === null) {
        throw new GhostError("not_found", `No trashed memory file named ${name}.`, { name });
      }
      assertAdmittedMemorySource(source.text, trashPath);
      return source.text;
    } finally {
      await directory.close();
    }
  }

  validateMemoryDeleteIntent(intent: MemoryDeleteIntent): void {
    assertValidMemoryDeleteIntent(intent);
  }


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

export function openGhostHome(dir: string, options: GhostHomeOptions = {}): GhostHome {
  return new GhostHome(dir, options);
}
