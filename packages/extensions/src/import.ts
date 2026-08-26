/**
 * Import a hosted ghost-home archive into a local ghost home.
 *
 * Every source is snapshotted into a hidden transaction directory while a
 * process-shared lock is held on the ghosts root. The validated home is then
 * published by same-filesystem rename; an overwritten home is retained under
 * the root's recoverable `.trash/` directory.
 */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { GhostError } from "./errors.js";
import { sanitizePathSegment } from "./frontmatter.js";
import { DOCS_DIRNAME, EXPORT_MANIFEST_FILENAME, GhostHome } from "./home.js";
import {
  descriptorPath,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
  withDescriptorLock,
} from "./linux-fs.js";
import { GHOST_HOME_FORMAT } from "./types.js";

const LEGACY_GHOST_HOME_FORMAT = "ghost-home/v1";
const LEGACY_NOTES_PREFIX = "notes/";
const IMPORT_TRANSACTION_PREFIX = ".ghost-import-";
const IMPORT_TRASH_DIRNAME = ".trash";
const COPY_BUFFER_BYTES = 64 * 1024;
const IMPORT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;

const MEBIBYTE = 1024 * 1024;
export const MAX_IMPORT_COMPRESSED_BYTES = 256 * MEBIBYTE;
export const MAX_IMPORT_UNCOMPRESSED_BYTES = 512 * MEBIBYTE;
export const MAX_IMPORT_FILE_BYTES = 128 * MEBIBYTE;
export const MAX_IMPORT_ENTRIES = 10_000;
/** Compatibility name retained for callers of the first bounded importer. */
export const MAX_IMPORT_FILES = MAX_IMPORT_ENTRIES;
export const MAX_IMPORT_DEPTH = 32;

export interface GhostArchiveManifest {
  readonly format: string;
  readonly ghostname?: string;
  readonly exportedAt?: string;
  readonly appVersion?: string;
  readonly source?: string;
  readonly counts?: Record<string, number>;
  readonly pathRewrites?: Record<string, string>;
  readonly notIncluded?: unknown[];
  readonly [key: string]: unknown;
}

export interface ImportGhostArchiveOptions {
  /** Override the ghost home directory name. Defaults to the archive's ghost name. */
  readonly name?: string;
  /**
   * Cleanly replace an existing ghost home. Off by default. The daemon must
   * quiesce that home first: this filesystem-only package cannot close its
   * live sessions or prevent a non-cooperating writer from retaining an fd.
   */
  readonly overwrite?: boolean;
}

export interface ImportGhostArchiveResult {
  readonly home: GhostHome;
  readonly ghostName: string;
  readonly dir: string;
  readonly manifest: GhostArchiveManifest;
  readonly filesWritten: number;
  /** Archive entries deliberately not written (zip noise, directory entries). */
  readonly ignored: readonly string[];
  /** Recoverable previous home retained under `<ghostsRoot>/.trash/`. */
  readonly replaced?: string;
}

interface ArchiveEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly snapshot?: string;
}

interface ImportLimitState {
  entries: number;
  declaredBytes: number;
  actualBytes: number;
}

interface ImportTransaction {
  readonly version: 1;
  readonly phase: "prepared" | "published" | "committed";
  readonly target: string;
  readonly staging: string;
  readonly backup: string | null;
  readonly previousIdentity: PathIdentity | null;
  readonly stagingIdentity: PathIdentity;
}

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
}

export type ImportFaultPoint =
  | "after_transaction_open"
  | "after_staged_tree_sync"
  | "after_prepared"
  | "after_backup_rename"
  | "after_target_rename"
  | "after_published"
  | "after_committed";

let importFaultInjector: ((point: ImportFaultPoint) => void | Promise<void>) | null = null;

/** Private test seam; not re-exported from the package entry point. */
export function setImportFaultInjectorForTest(
  injector: ((point: ImportFaultPoint) => void | Promise<void>) | null,
): void {
  importFaultInjector = injector;
}

async function injectImportFault(point: ImportFaultPoint): Promise<void> {
  await importFaultInjector?.(point);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArchiveNoise(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => segment === "__MACOSX" || segment === ".DS_Store")
    || segments.some((segment) => segment.startsWith("._"));
}

function validateArchivePath(path: string): void {
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = withoutTrailingSlash.split("/");
  if (
    !withoutTrailingSlash
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new GhostError(
      "invalid_path",
      `Archive entry ${JSON.stringify(path)} is not a confined relative path.`,
      { entry: path },
    );
  }
  if (segments.length > MAX_IMPORT_DEPTH) {
    throw new GhostError(
      "limit_exceeded",
      `Archive entry ${JSON.stringify(path)} exceeds the ${MAX_IMPORT_DEPTH}-level depth limit.`,
      { entry: path, limit: MAX_IMPORT_DEPTH },
    );
  }
}

function countArchiveEntry(
  path: string,
  size: number | undefined,
  limits: ImportLimitState,
): void {
  validateArchivePath(path);
  limits.entries += 1;
  if (limits.entries > MAX_IMPORT_ENTRIES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive contains more than ${MAX_IMPORT_ENTRIES} entries.`,
      { limit: MAX_IMPORT_ENTRIES },
    );
  }
  if (size === undefined) return;
  if (size > MAX_IMPORT_FILE_BYTES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive entry ${JSON.stringify(path)} exceeds the ${MAX_IMPORT_FILE_BYTES}-byte limit.`,
      { entry: path, limit: MAX_IMPORT_FILE_BYTES },
    );
  }
  limits.declaredBytes += size;
  if (limits.declaredBytes > MAX_IMPORT_UNCOMPRESSED_BYTES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive expands beyond the ${MAX_IMPORT_UNCOMPRESSED_BYTES}-byte limit.`,
      { limit: MAX_IMPORT_UNCOMPRESSED_BYTES },
    );
  }
}

function countActualBytes(
  path: string,
  entryBytes: number,
  chunkBytes: number,
  limits: ImportLimitState,
): void {
  if (entryBytes > MAX_IMPORT_FILE_BYTES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive entry ${JSON.stringify(path)} exceeds the ${MAX_IMPORT_FILE_BYTES}-byte limit.`,
      { entry: path, limit: MAX_IMPORT_FILE_BYTES },
    );
  }
  if (limits.actualBytes + chunkBytes > MAX_IMPORT_UNCOMPRESSED_BYTES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive expands beyond the ${MAX_IMPORT_UNCOMPRESSED_BYTES}-byte limit.`,
      { limit: MAX_IMPORT_UNCOMPRESSED_BYTES },
    );
  }
}

function nextSnapshotPath(rawDir: string, index: number): string {
  return join(rawDir, `entry-${index.toString().padStart(6, "0")}`);
}

async function readExactly(
  source: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await source.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new GhostError("invalid_format", "Zip archive ended unexpectedly.");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

/** Check central-directory sizes and paths without allocating entry contents. */
async function preflightZip(source: FileHandle, compressedSize: number): Promise<void> {
  if (compressedSize < ZIP_EOCD_MIN_BYTES) {
    throw new GhostError("invalid_format", "Not a readable zip archive: missing directory.");
  }
  const tailLength = Math.min(
    compressedSize,
    ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES,
  );
  const tailOffset = compressedSize - tailLength;
  const tail = await readExactly(source, tailLength, tailOffset);
  let eocd = -1;
  for (let offset = tail.length - ZIP_EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE
      && offset + ZIP_EOCD_MIN_BYTES + tail.readUInt16LE(offset + 20) === tail.length
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new GhostError("invalid_format", "Not a readable zip archive: missing directory.");
  }

  const disk = tail.readUInt16LE(eocd + 4);
  const centralDisk = tail.readUInt16LE(eocd + 6);
  const diskEntries = tail.readUInt16LE(eocd + 8);
  const totalEntries = tail.readUInt16LE(eocd + 10);
  const centralBytes = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries === 0xffff
    || centralBytes === 0xffff_ffff
    || centralOffset === 0xffff_ffff
  ) {
    throw new GhostError(
      "invalid_format",
      "Multi-disk and ZIP64 archives are not supported by this bounded importer.",
    );
  }
  if (totalEntries > MAX_IMPORT_ENTRIES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive contains more than ${MAX_IMPORT_ENTRIES} entries.`,
      { limit: MAX_IMPORT_ENTRIES },
    );
  }
  if (
    centralOffset > compressedSize
    || centralBytes > compressedSize - centralOffset
    || centralOffset + centralBytes > tailOffset + eocd
  ) {
    throw new GhostError("invalid_format", "Zip central directory is outside the archive.");
  }

  const limits: ImportLimitState = { entries: 0, declaredBytes: 0, actualBytes: 0 };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const header = await readExactly(source, ZIP_CENTRAL_HEADER_BYTES, position);
    if (header.readUInt32LE(0) !== ZIP_CENTRAL_SIGNATURE) {
      throw new GhostError("invalid_format", "Zip central directory is malformed.");
    }
    const uncompressedBytes = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const entryLength = ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (
      nameLength === 0
      || position + entryLength > centralOffset + centralBytes
      || uncompressedBytes === 0xffff_ffff
    ) {
      throw new GhostError("invalid_format", "Zip central directory entry is malformed.");
    }
    const nameBytes = await readExactly(
      source,
      nameLength,
      position + ZIP_CENTRAL_HEADER_BYTES,
    );
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      throw new GhostError("invalid_format", "Zip entry name is not valid UTF-8.");
    }
    countArchiveEntry(name, uncompressedBytes, limits);
    position += entryLength;
  }
  if (position !== centralOffset + centralBytes) {
    throw new GhostError("invalid_format", "Zip central directory length is inconsistent.");
  }
}

async function copyStableFile(
  source: FileHandle,
  target: string,
  archivePath: string,
  limits: ImportLimitState,
): Promise<void> {
  const output = await open(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let entryBytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      countActualBytes(archivePath, entryBytes + bytesRead, bytesRead, limits);
      limits.actualBytes += bytesRead;
      entryBytes += bytesRead;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
    }
    await output.sync();
  } finally {
    await output.close();
  }
}

async function snapshotDirectory(
  source: FileHandle,
  rawDir: string,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const limits: ImportLimitState = { entries: 0, declaredBytes: 0, actualBytes: 0 };

  const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
    const listing = await opendir(descriptorPath(directory));
    try {
      for (;;) {
        const entry = await listing.read();
        if (entry === null) break;
        const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (seen.has(archivePath)) {
          throw new GhostError(
            "invalid_format",
            `Archive directory contains duplicate entry ${JSON.stringify(archivePath)}.`,
            { entry: archivePath },
          );
        }
        seen.add(archivePath);

        if (entry.isDirectory()) {
          countArchiveEntry(`${archivePath}/`, 0, limits);
          const child = await openDirectoryNoFollow(
            descriptorPath(directory, entry.name),
            "Archive directory entry",
          );
          entries.push({ path: `${archivePath}/`, directory: true });
          try {
            await walk(child, archivePath);
          } finally {
            await child.close();
          }
          continue;
        }

        let input: FileHandle;
        try {
          input = await openRegularFileNoFollow(
            descriptorPath(directory, entry.name),
            "Archive directory entry",
          );
        } catch (error) {
          if (error instanceof GhostError && error.code === "invalid_path") {
            throw new GhostError(
              "invalid_path",
              `Archive directory entry ${JSON.stringify(archivePath)} is not a regular file.`,
              { entry: archivePath },
            );
          }
          throw error;
        }
        try {
          const stats = await input.stat();
          countArchiveEntry(archivePath, stats.size, limits);
          const snapshot = nextSnapshotPath(rawDir, entries.length);
          await copyStableFile(input, snapshot, archivePath, limits);
          entries.push({ path: archivePath, directory: false, snapshot });
        } finally {
          await input.close();
        }
      }
    } finally {
      await listing.close();
    }
  };

  await walk(source, "");
  return entries;
}

function writeAllSync(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw new Error("Could not make progress writing archive entry.");
    offset += written;
  }
}

async function snapshotZip(
  source: FileHandle,
  compressedSize: number,
  rawDir: string,
): Promise<ArchiveEntry[]> {
  if (compressedSize > MAX_IMPORT_COMPRESSED_BYTES) {
    throw new GhostError(
      "limit_exceeded",
      `Archive exceeds the ${MAX_IMPORT_COMPRESSED_BYTES}-byte compressed limit.`,
      { limit: MAX_IMPORT_COMPRESSED_BYTES },
    );
  }
  await preflightZip(source, compressedSize);

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const limits: ImportLimitState = { entries: 0, declaredBytes: 0, actualBytes: 0 };
  let failure: unknown;
  const openOutputs = new Set<() => void>();

  const unzip = new Unzip((file) => {
    if (failure) {
      file.terminate();
      return;
    }
    const directory = file.name.endsWith("/");
    try {
      if (seen.has(file.name)) {
        throw new GhostError(
          "invalid_format",
          `Archive contains duplicate entry ${JSON.stringify(file.name)}.`,
          { entry: file.name },
        );
      }
      seen.add(file.name);
      countArchiveEntry(file.name, file.originalSize, limits);
      if (directory) {
        const entry = { path: file.name, directory: true } satisfies ArchiveEntry;
        entries.push(entry);
        let entryBytes = 0;
        file.ondata = (error, data) => {
          if (error && !failure) failure = error;
          if (error || data.byteLength === 0) return;
          try {
            countActualBytes(
              file.name,
              entryBytes + data.byteLength,
              data.byteLength,
              limits,
            );
            limits.actualBytes += data.byteLength;
            entryBytes += data.byteLength;
          } catch (streamError) {
            failure ??= streamError;
            file.terminate();
          }
        };
        file.start();
        return;
      }

      const snapshot = nextSnapshotPath(rawDir, entries.length);
      const output = openSync(
        snapshot,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const entry: ArchiveEntry = {
        path: file.name,
        directory: false,
        snapshot,
      };
      entries.push(entry);
      let entryBytes = 0;
      let closed = false;
      const closeOutput = (): void => {
        if (closed) return;
        closed = true;
        openOutputs.delete(closeOutput);
        closeSync(output);
      };
      openOutputs.add(closeOutput);
      file.ondata = (error, data, final) => {
        if (closed) return;
        if (error) {
          failure ??= error;
          closeOutput();
          return;
        }
        try {
          if (data.byteLength > 0) {
            countActualBytes(
              file.name,
              entryBytes + data.byteLength,
              data.byteLength,
              limits,
            );
            limits.actualBytes += data.byteLength;
            entryBytes += data.byteLength;
            writeAllSync(output, data);
          }
          if (final) {
            fsyncSync(output);
            closeOutput();
          }
        } catch (streamError) {
          failure ??= streamError;
          closeOutput();
          file.terminate();
        }
      };
      file.start();
    } catch (error) {
      failure ??= error;
      file.terminate();
    }
  });
  unzip.register(UnzipInflate);

  const input = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let compressedBytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await source.read(input, 0, input.length, null);
      if (bytesRead === 0) break;
      compressedBytes += bytesRead;
      if (compressedBytes > MAX_IMPORT_COMPRESSED_BYTES) {
        throw new GhostError(
          "limit_exceeded",
          `Archive exceeds the ${MAX_IMPORT_COMPRESSED_BYTES}-byte compressed limit.`,
          { limit: MAX_IMPORT_COMPRESSED_BYTES },
        );
      }
      unzip.push(input.subarray(0, bytesRead));
      if (failure) throw failure;
    }
    unzip.push(new Uint8Array(), true);
    if (failure) throw failure;
    if (openOutputs.size !== 0) {
      throw new GhostError("invalid_format", "Zip archive ended before an entry completed.");
    }
    return entries;
  } catch (error) {
    for (const closeOutput of [...openOutputs]) {
      try {
        closeOutput();
      } catch {
        // Preserve the extraction failure; all known descriptors were attempted.
      }
    }
    openOutputs.clear();
    if (error instanceof GhostError) throw error;
    throw new GhostError("invalid_format", `Not a readable zip archive: ${message(error)}`);
  }
}

async function snapshotSource(source: string, rawDir: string): Promise<ArchiveEntry[]> {
  let descriptor: FileHandle;
  try {
    descriptor = await open(
      source,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GhostError("not_found", `No archive at ${source}.`, { source });
    }
    if (code === "ELOOP") {
      throw new GhostError(
        "invalid_path",
        `Archive source ${JSON.stringify(source)} is a symbolic link.`,
        { source },
      );
    }
    throw error;
  }
  try {
    const stats = await descriptor.stat();
    if (stats.isDirectory()) return await snapshotDirectory(descriptor, rawDir);
    if (stats.isFile()) return await snapshotZip(descriptor, stats.size, rawDir);
    throw new GhostError(
      "invalid_format",
      `${source} is neither a directory nor a regular zip archive.`,
      { source },
    );
  } finally {
    await descriptor.close();
  }
}

function canonicalArchivePath(path: string): string {
  return path.startsWith(LEGACY_NOTES_PREFIX)
    ? `${DOCS_DIRNAME}/${path.slice(LEGACY_NOTES_PREFIX.length)}`
    : path;
}

function findRoot(entries: readonly ArchiveEntry[]): string {
  if (entries.some((entry) => !entry.directory && entry.path === EXPORT_MANIFEST_FILENAME)) {
    return "";
  }
  const roots = new Set<string>();
  for (const entry of entries) {
    if (isArchiveNoise(entry.path)) continue;
    const slash = entry.path.indexOf("/");
    if (slash > 0) roots.add(entry.path.slice(0, slash));
  }
  for (const root of roots) {
    if (entries.some((entry) =>
      !entry.directory && entry.path === `${root}/${EXPORT_MANIFEST_FILENAME}`
    )) return root;
  }
  throw new GhostError(
    "invalid_format",
    `No ${EXPORT_MANIFEST_FILENAME} found in the archive. `
    + `This does not look like a ${GHOST_HOME_FORMAT} export.`,
  );
}

function parseManifest(bytes: Uint8Array): GhostArchiveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new GhostError(
      "invalid_format",
      `${EXPORT_MANIFEST_FILENAME} is not valid JSON: ${message(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GhostError("invalid_format", `${EXPORT_MANIFEST_FILENAME} must be an object.`);
  }
  const manifest = parsed as GhostArchiveManifest;
  if (
    manifest.format !== GHOST_HOME_FORMAT
    && manifest.format !== LEGACY_GHOST_HOME_FORMAT
  ) {
    throw new GhostError(
      "invalid_format",
      `Unsupported archive format ${JSON.stringify(manifest.format)}; expected `
      + `${JSON.stringify(GHOST_HOME_FORMAT)} or legacy `
      + `${JSON.stringify(LEGACY_GHOST_HOME_FORMAT)}.`,
      { format: manifest.format },
    );
  }
  return manifest;
}

async function pathExistsAt(directory: FileHandle, name: string): Promise<boolean> {
  try {
    await lstatDescriptorPath(directory, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function lstatDescriptorPath(directory: FileHandle, name: string) {
  return await lstat(descriptorPath(directory, name));
}

async function pathIdentityAt(
  directory: FileHandle,
  name: string,
): Promise<PathIdentity | null> {
  try {
    const stats = await lstatDescriptorPath(directory, name);
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(
  left: PathIdentity | null,
  right: PathIdentity | null,
): boolean {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino;
}

async function syncTree(directory: FileHandle): Promise<void> {
  const listing = await opendir(descriptorPath(directory));
  try {
    for (;;) {
      const entry = await listing.read();
      if (entry === null) break;
      if (entry.isDirectory()) {
        const child = await openDirectoryNoFollow(
          descriptorPath(directory, entry.name),
          "Staged import directory",
        );
        try {
          await syncTree(child);
        } finally {
          await child.close();
        }
        continue;
      }
      const file = await openRegularFileNoFollow(
        descriptorPath(directory, entry.name),
        "Staged import file",
      );
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  } finally {
    await listing.close();
  }
  await directory.sync();
}

async function isNonEmptyDirectoryAt(
  directory: FileHandle,
  name: string,
): Promise<boolean> {
  let child: FileHandle | undefined;
  try {
    const path = descriptorPath(directory, name);
    child = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    return (await readdir(descriptorPath(child))).length > 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code === "ENOTDIR" || code === "ELOOP") return true;
    throw error;
  } finally {
    await child?.close().catch(() => undefined);
  }
}

async function openOrCreateDirectoryAt(
  directory: FileHandle,
  name: string,
  label: string,
): Promise<FileHandle> {
  const path = descriptorPath(directory, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return await openDirectoryNoFollow(path, label);
}

async function writeTransaction(
  transactionDirectory: FileHandle,
  transaction: ImportTransaction,
): Promise<void> {
  const name = "transaction.json";
  const temporaryName = `${name}.${randomUUID()}.tmp`;
  const temporary = descriptorPath(transactionDirectory, temporaryName);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(transaction)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, descriptorPath(transactionDirectory, name));
    await transactionDirectory.sync();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function validateTransaction(
  root: string,
  transactionDir: string,
  value: unknown,
): ImportTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GhostError("invalid_format", `Invalid import transaction in ${transactionDir}.`);
  }
  const row = value as Partial<ImportTransaction>;
  const expectedStaging = join(transactionDir, "home");
  const targetValid = typeof row.target === "string"
    && dirname(row.target) === root
    && !basename(row.target).startsWith(".");
  const backupValid = row.backup === null || (
    typeof row.backup === "string"
    && dirname(row.backup) === join(root, IMPORT_TRASH_DIRNAME)
    && !basename(row.backup).startsWith(".")
  );
  const identityValid = (identity: unknown): identity is PathIdentity => {
    if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
      return false;
    }
    const candidate = identity as Partial<PathIdentity>;
    return Number.isSafeInteger(candidate.dev)
      && (candidate.dev as number) >= 0
      && Number.isSafeInteger(candidate.ino)
      && (candidate.ino as number) > 0;
  };
  if (
    row.version !== 1
    || !["prepared", "published", "committed"].includes(row.phase as string)
    || !targetValid
    || row.staging !== expectedStaging
    || !backupValid
    || (row.previousIdentity !== null && !identityValid(row.previousIdentity))
    || !identityValid(row.stagingIdentity)
  ) {
    throw new GhostError("invalid_format", `Unsafe import transaction in ${transactionDir}.`);
  }
  return row as ImportTransaction;
}

async function recoverTransaction(
  root: string,
  rootDirectory: FileHandle,
  transactionName: string,
  forceRollback = false,
): Promise<void> {
  const transactionDir = join(root, transactionName);
  const transactionDirectory = await openDirectoryNoFollow(
    descriptorPath(rootDirectory, transactionName),
    "Import transaction",
  );
  let transaction: ImportTransaction | null = null;
  try {
    let journal: FileHandle | undefined;
    try {
      journal = await openRegularFileNoFollow(
        descriptorPath(transactionDirectory, "transaction.json"),
        "Import transaction journal",
      );
      transaction = validateTransaction(
        root,
        transactionDir,
        JSON.parse(await journal.readFile("utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await journal?.close().catch(() => undefined);
    }

    if (transaction) {
      const targetName = basename(transaction.target);
      const targetIdentity = await pathIdentityAt(rootDirectory, targetName);
      const targetIsStaging = sameIdentity(targetIdentity, transaction.stagingIdentity);
      const targetIsPrevious = sameIdentity(targetIdentity, transaction.previousIdentity);
      let trashDirectory: FileHandle | undefined;
      let backupIdentity: PathIdentity | null = null;
      const backupName = transaction.backup ? basename(transaction.backup) : null;
      try {
        if (backupName) {
          try {
            trashDirectory = await openDirectoryNoFollow(
              descriptorPath(rootDirectory, IMPORT_TRASH_DIRNAME),
              "Import trash directory",
            );
            backupIdentity = await pathIdentityAt(trashDirectory, backupName);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const backupIsPrevious = sameIdentity(
          backupIdentity,
          transaction.previousIdentity,
        );

        if (transaction.phase === "committed" && !forceRollback) {
          if (targetIsStaging) {
            if (
              transaction.previousIdentity !== null
              && !backupIsPrevious
            ) {
              throw new GhostError(
                "conflict",
                `Committed import backup for ${JSON.stringify(targetName)} changed unexpectedly; `
                + `recovery metadata was retained at ${transactionDir}.`,
              );
            }
          } else {
            if (
              targetIdentity === null
              && transaction.previousIdentity !== null
              && backupIsPrevious
              && trashDirectory
              && backupName
            ) {
              await rename(
                descriptorPath(trashDirectory, backupName),
                descriptorPath(rootDirectory, targetName),
              );
              await trashDirectory.sync();
              await rootDirectory.sync();
            } else if (!targetIsPrevious) {
              throw new GhostError(
                "conflict",
                `Committed import target ${JSON.stringify(targetName)} changed unexpectedly; `
                + `recovery metadata was retained at ${transactionDir}.`,
              );
            }
          }
        } else {
          if (targetIsStaging) {
            if (await pathExistsAt(transactionDirectory, "home")) {
              throw new GhostError(
                "conflict",
                `Import staging path for ${JSON.stringify(targetName)} exists twice; `
                + `recovery metadata was retained at ${transactionDir}.`,
              );
            }
            await rename(
              descriptorPath(rootDirectory, targetName),
              descriptorPath(transactionDirectory, "home"),
            );
            await rootDirectory.sync();
            await transactionDirectory.sync();
          } else if (targetIdentity !== null && !targetIsPrevious) {
            throw new GhostError(
              "conflict",
              `Import target ${JSON.stringify(targetName)} changed during recovery; `
              + `metadata was retained at ${transactionDir}.`,
            );
          }

          if (transaction.previousIdentity !== null && !targetIsPrevious) {
            if (!backupIsPrevious || !trashDirectory || !backupName) {
              throw new GhostError(
                "conflict",
                `The previous ${JSON.stringify(targetName)} home could not be identified; `
                + `recovery metadata was retained at ${transactionDir}.`,
              );
            }
            await rename(
              descriptorPath(trashDirectory, backupName),
              descriptorPath(rootDirectory, targetName),
            );
            await trashDirectory.sync();
            await rootDirectory.sync();
          } else if (transaction.previousIdentity === null && backupIdentity !== null) {
            throw new GhostError(
              "conflict",
              `Unexpected import backup ${JSON.stringify(backupName)} was not removed; `
              + `recovery metadata was retained at ${transactionDir}.`,
            );
          }
        }
      } finally {
        await trashDirectory?.close().catch(() => undefined);
      }
    }
  } finally {
    await transactionDirectory.close();
  }
  await rm(descriptorPath(rootDirectory, transactionName), { recursive: true, force: true });
  await rootDirectory.sync();
}

async function recoverStaleTransactions(root: string, rootDirectory: FileHandle): Promise<void> {
  for (const entry of await readdir(descriptorPath(rootDirectory), { withFileTypes: true })) {
    if (!/^\.ghost-import-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(entry.name)) continue;
    if (!entry.isDirectory()) {
      throw new GhostError(
        "conflict",
        `Import transaction path ${JSON.stringify(entry.name)} is not a directory.`,
      );
    }
    await recoverTransaction(root, rootDirectory, entry.name);
  }
}

function backupName(ghostName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${ghostName}-import-overwrite-${stamp}-${randomUUID()}`;
}

/** Import a current or legacy archive into `<ghostsRoot>/<name>/`. */
export async function importGhostArchive(
  source: string,
  ghostsRoot: string,
  options: ImportGhostArchiveOptions = {},
): Promise<ImportGhostArchiveResult> {
  const sourcePath = resolve(source);
  const root = resolve(ghostsRoot);
  await mkdir(root, { recursive: true });
  const rootDirectory = await openDirectoryNoFollow(root, "ghosts root");
  try {
    return await withDescriptorLock(rootDirectory, async () => {
      await recoverStaleTransactions(root, rootDirectory);

      const transactionName = `${IMPORT_TRANSACTION_PREFIX}${process.pid}-${randomUUID()}`;
      const transactionDir = join(root, transactionName);
      const stagingDir = join(transactionDir, "home");
      await mkdir(descriptorPath(rootDirectory, transactionName), { mode: 0o700 });
      let transactionDirectory: FileHandle;
      try {
        transactionDirectory = await openDirectoryNoFollow(
          descriptorPath(rootDirectory, transactionName),
          "Import transaction",
        );
      } catch (error) {
        await rm(descriptorPath(rootDirectory, transactionName), {
          recursive: true,
          force: true,
        });
        await rootDirectory.sync();
        throw error;
      }
      let keepTransaction = false;
      try {
        await injectImportFault("after_transaction_open");
        await mkdir(descriptorPath(transactionDirectory, "raw"), { mode: 0o700 });
        await mkdir(descriptorPath(transactionDirectory, "home"), { mode: 0o700 });
        const pinnedRawDir = descriptorPath(transactionDirectory, "raw");
        const pinnedStagingDir = descriptorPath(transactionDirectory, "home");

        const entries = await snapshotSource(sourcePath, pinnedRawDir);
        const archiveRoot = findRoot(entries);
        const prefix = archiveRoot ? `${archiveRoot}/` : "";
        const manifestEntry = entries.find((entry) =>
          !entry.directory && entry.path === `${prefix}${EXPORT_MANIFEST_FILENAME}`
        );
        if (!manifestEntry?.snapshot) {
          throw new GhostError("invalid_format", `Missing ${EXPORT_MANIFEST_FILENAME}.`);
        }
        const sourceManifest = parseManifest(await readFile(manifestEntry.snapshot));
        const manifest: GhostArchiveManifest = {
          ...sourceManifest,
          format: GHOST_HOME_FORMAT,
        };
        const migratedManifestBytes = new TextEncoder().encode(
          `${JSON.stringify(manifest, null, 2)}\n`,
        );

        const ghostName = sanitizePathSegment(
          options.name ?? manifest.ghostname ?? archiveRoot ?? "ghost",
        );
        const dir = resolve(join(root, ghostName));
        if (dirname(dir) !== root) {
          throw new GhostError("invalid_path", `Ghost name ${JSON.stringify(ghostName)} escapes.`);
        }
        if (!options.overwrite && (await isNonEmptyDirectoryAt(rootDirectory, ghostName))) {
          throw new GhostError(
            "conflict",
            `${dir} already exists and is not empty. Pass overwrite to replace it.`,
            { dir },
          );
        }

        const ignored: string[] = [];
        const targets = new Set<string>();
        const writes: Array<{ relativePath: string; snapshot?: string; content?: Uint8Array }> = [];
        for (const entry of entries) {
          if (entry.directory) {
            ignored.push(entry.path);
            continue;
          }
          if (archiveRoot !== "" && !entry.path.startsWith(prefix)) {
            ignored.push(entry.path);
            continue;
          }
          const archivePath = entry.path.slice(prefix.length);
          if (!archivePath || isArchiveNoise(archivePath)) {
            ignored.push(entry.path);
            continue;
          }
          const relativePath = canonicalArchivePath(archivePath);
          if (targets.has(relativePath)) {
            throw new GhostError(
              "invalid_format",
              `Archive entries collide at canonical path ${JSON.stringify(relativePath)}.`,
              { entry: entry.path, path: relativePath },
            );
          }
          targets.add(relativePath);
          const target = resolve(pinnedStagingDir, relativePath);
          if (target === pinnedStagingDir || !target.startsWith(pinnedStagingDir + sep)) {
            throw new GhostError(
              "invalid_path",
              `Archive entry ${JSON.stringify(entry.path)} escapes the ghost home.`,
              { entry: entry.path },
            );
          }
          if (archivePath === EXPORT_MANIFEST_FILENAME) {
            writes.push({ relativePath, content: migratedManifestBytes });
          } else {
            if (!entry.snapshot) {
              throw new GhostError(
                "invalid_format",
                `Archive entry ${JSON.stringify(entry.path)} has no staged bytes.`,
              );
            }
            writes.push({ relativePath, snapshot: entry.snapshot });
          }
        }

        for (const write of writes) {
          const target = join(pinnedStagingDir, write.relativePath);
          await mkdir(dirname(target), { recursive: true });
          if (write.content) await writeFile(target, write.content, { flag: "wx" });
          else if (write.snapshot) await copyFile(write.snapshot, target, constants.COPYFILE_EXCL);
          else throw new Error(`Import entry ${write.relativePath} has no staged bytes.`);
        }

        await new GhostHome(pinnedStagingDir).ensure();
        const stagingDirectory = await openDirectoryNoFollow(
          descriptorPath(transactionDirectory, "home"),
          "Staged import home",
        );
        let stagingIdentity: PathIdentity;
        try {
          await syncTree(stagingDirectory);
          const stagingStats = await stagingDirectory.stat();
          stagingIdentity = { dev: stagingStats.dev, ino: stagingStats.ino };
        } finally {
          await stagingDirectory.close();
        }
        await injectImportFault("after_staged_tree_sync");
        if (!options.overwrite && (await isNonEmptyDirectoryAt(rootDirectory, ghostName))) {
          throw new GhostError(
            "conflict",
            `${dir} became non-empty while the import was being staged.`,
            { dir },
          );
        }

        const previousIdentity = await pathIdentityAt(rootDirectory, ghostName);
        const backupEntry = previousIdentity ? backupName(ghostName) : null;
        const backup = backupEntry
          ? join(root, IMPORT_TRASH_DIRNAME, backupEntry)
          : null;
        let trashDirectory: FileHandle | undefined;
        let transaction: ImportTransaction = {
          version: 1,
          phase: "prepared",
          target: dir,
          staging: stagingDir,
          backup,
          previousIdentity,
          stagingIdentity,
        };

        try {
          await writeTransaction(transactionDirectory, transaction);
          await injectImportFault("after_prepared");
          if (backupEntry && previousIdentity) {
            trashDirectory = await openOrCreateDirectoryAt(
              rootDirectory,
              IMPORT_TRASH_DIRNAME,
              "Import trash directory",
            );
            await rootDirectory.sync();
            if (!sameIdentity(
              await pathIdentityAt(rootDirectory, ghostName),
              previousIdentity,
            )) {
              throw new GhostError(
                "conflict",
                `${dir} changed while the import was being staged.`,
                { dir },
              );
            }
            await rename(
              descriptorPath(rootDirectory, ghostName),
              descriptorPath(trashDirectory, backupEntry),
            );
            await injectImportFault("after_backup_rename");
            if (!sameIdentity(
              await pathIdentityAt(trashDirectory, backupEntry),
              previousIdentity,
            )) {
              throw new GhostError(
                "conflict",
                `${dir} changed while its recoverable backup was being published.`,
                { dir },
              );
            }
            await trashDirectory.sync();
            await rootDirectory.sync();
          }
          await rename(
            descriptorPath(transactionDirectory, "home"),
            descriptorPath(rootDirectory, ghostName),
          );
          await injectImportFault("after_target_rename");
          if (!sameIdentity(
            await pathIdentityAt(rootDirectory, ghostName),
            stagingIdentity,
          )) {
            throw new GhostError(
              "conflict",
              `${dir} changed while the staged import was being published.`,
              { dir },
            );
          }
          await rootDirectory.sync();
          transaction = { ...transaction, phase: "published" };
          await writeTransaction(transactionDirectory, transaction);
          await injectImportFault("after_published");
          transaction = { ...transaction, phase: "committed" };
          await writeTransaction(transactionDirectory, transaction);
        } catch (error) {
          try {
            await recoverTransaction(root, rootDirectory, transactionName, true);
          } catch (recoveryError) {
            keepTransaction = true;
            throw new AggregateError(
              [error, recoveryError],
              `Import failed and recovery metadata was retained at ${transactionDir}.`,
            );
          }
          throw error;
        } finally {
          await trashDirectory?.close().catch(() => undefined);
        }
        await injectImportFault("after_committed");

        await rm(descriptorPath(rootDirectory, transactionName), {
          recursive: true,
          force: true,
        });
        await rootDirectory.sync();
        return {
          home: new GhostHome(dir),
          ghostName,
          dir,
          manifest,
          filesWritten: writes.length,
          ignored,
          ...(backup ? { replaced: backup } : {}),
        };
      } finally {
        await transactionDirectory.close().catch(() => undefined);
        if (!keepTransaction && await pathExistsAt(rootDirectory, transactionName)) {
          await rm(descriptorPath(rootDirectory, transactionName), {
            recursive: true,
            force: true,
          });
          await rootDirectory.sync();
        }
      }
    }, IMPORT_LOCK_TIMEOUT_MS);
  } finally {
    await rootDirectory.close();
  }
}
