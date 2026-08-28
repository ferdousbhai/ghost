/** Explicit, source-preserving placement of one legacy docs tree into Documents. */
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  descriptorPath,
  openConfinedDirectory,
  openDirectoryNoFollow,
} from "@ghost/extensions";

const COPY_BUFFER_BYTES = 64 * 1024;
export const LEGACY_DOCUMENTS_MAX_ENTRIES = 10_000;

export type LegacyDocumentsPlacementStage =
  | "after-preflight"
  | "before-copy"
  | "before-publish"
  | "after-publish";

export interface LegacyDocumentsPlacementEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly mode: number;
  readonly modifiedAt: string;
}

export interface LegacyDocumentsPlacementResult {
  readonly dryRun: boolean;
  readonly sourceRoot: string;
  readonly documentsRoot: string;
  readonly entries: readonly LegacyDocumentsPlacementEntry[];
  readonly placed: number;
}

export interface LegacyDocumentsPlacementOptions {
  readonly sourceRoot: string;
  readonly documentsRoot: string;
  readonly dryRun?: boolean;
  /** Deterministic race/failure seam used only by automated tests. */
  readonly probe?: (
    stage: LegacyDocumentsPlacementStage,
    relativePath?: string,
  ) => void | Promise<void>;
}

export class LegacyDocumentsPlacementError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyDocumentsPlacementError";
    this.code = code;
  }
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PlannedEntry extends LegacyDocumentsPlacementEntry {
  readonly segments: readonly string[];
  readonly identity: Identity;
  readonly sizeBytes: bigint;
  readonly atimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

interface PublishedEntry {
  readonly parent: FileHandle;
  readonly name: string;
  readonly relativePath: string;
  readonly identity: Identity;
}

interface CreatedDirectory {
  readonly parent: FileHandle;
  readonly name: string;
  readonly relativePath: string;
  readonly identity: Identity;
}

function placementError(code: string, message: string, cause?: unknown): LegacyDocumentsPlacementError {
  return new LegacyDocumentsPlacementError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function identity(stats: { dev: bigint; ino: bigint }): Identity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function contains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function openAbsoluteDirectory(path: string, label: string): Promise<FileHandle> {
  if (!isAbsolute(path)) {
    throw placementError("invalid_path", `${label} must be an absolute path: ${JSON.stringify(path)}.`);
  }
  try {
    return await openConfinedDirectory("/", resolve(path), { label });
  } catch (error) {
    throw placementError(
      "invalid_path",
      `${label} must exist as a real directory with no symbolic-link path component.`,
      error,
    );
  }
}

async function descriptorRealpath(directory: FileHandle, label: string): Promise<string> {
  try {
    return await realpath(descriptorPath(directory));
  } catch (error) {
    throw placementError("path_changed", `${label} moved or became unreachable.`, error);
  }
}

async function assertConfiguredRoot(
  pinned: FileHandle,
  configuredPath: string,
  label: string,
): Promise<void> {
  const current = await openAbsoluteDirectory(configuredPath, label);
  try {
    const [pinnedStats, currentStats] = await Promise.all([
      pinned.stat({ bigint: true }),
      current.stat({ bigint: true }),
    ]);
    if (!sameIdentity(identity(pinnedStats), identity(currentStats))) {
      throw placementError("path_changed", `${label} was replaced during placement.`);
    }
  } finally {
    await current.close();
  }
}

async function assertDestinationContained(
  root: FileHandle,
  configuredRoot: string,
  directory: FileHandle,
): Promise<void> {
  await assertConfiguredRoot(root, configuredRoot, "Documents root");
  const [rootPath, directoryPath] = await Promise.all([
    descriptorRealpath(root, "Documents root"),
    descriptorRealpath(directory, "Documents destination directory"),
  ]);
  if (!contains(rootPath, directoryPath)) {
    throw placementError(
      "destination_escaped",
      "A Documents destination directory moved outside the pinned Documents root.",
    );
  }
}

interface ExactDestinationDirectory {
  readonly directory: FileHandle;
  readonly opened: readonly FileHandle[];
}

async function openExactDestinationDirectory(
  root: FileHandle,
  configuredRoot: string,
  segments: readonly string[],
  retainedDirectories: ReadonlyMap<string, FileHandle>,
): Promise<ExactDestinationDirectory> {
  await assertConfiguredRoot(root, configuredRoot, "Documents root");
  const opened: FileHandle[] = [];
  let current = root;
  let key = "";
  try {
    for (const segment of segments) {
      key = key ? `${key}/${segment}` : segment;
      const retained = retainedDirectories.get(key);
      if (!retained) {
        throw placementError(
          "destination_changed",
          `Documents destination ${JSON.stringify(key)} was not retained from its planned path.`,
        );
      }
      const path = descriptorPath(current, segment);
      const before = await lstat(path, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw placementError(
          "destination_changed",
          `Documents destination ${JSON.stringify(key)} is no longer a real directory.`,
        );
      }
      const next = await openDirectoryNoFollow(path, "Documents destination directory");
      opened.push(next);
      const [openedStats, retainedStats] = await Promise.all([
        next.stat({ bigint: true }),
        retained.stat({ bigint: true }),
      ]);
      if (!sameIdentity(identity(before), identity(openedStats))
        || !sameIdentity(identity(openedStats), identity(retainedStats))) {
        throw placementError(
          "destination_changed",
          `Documents destination ${JSON.stringify(key)} changed logical identity.`,
        );
      }
      current = next;
    }
    return { directory: current, opened };
  } catch (error) {
    for (const directory of opened.reverse()) await directory.close().catch(() => undefined);
    if (error instanceof LegacyDocumentsPlacementError) throw error;
    throw placementError(
      "destination_changed",
      `Documents destination ${JSON.stringify(segments.join("/"))} changed logical path.`,
      error,
    );
  }
}

async function closeExactDestinationDirectory(
  exact: ExactDestinationDirectory,
): Promise<void> {
  for (const directory of [...exact.opened].reverse()) {
    await directory.close().catch(() => undefined);
  }
}

async function assertExactDestinationDirectory(
  root: FileHandle,
  configuredRoot: string,
  segments: readonly string[],
  retainedDirectories: ReadonlyMap<string, FileHandle>,
): Promise<void> {
  const exact = await openExactDestinationDirectory(
    root,
    configuredRoot,
    segments,
    retainedDirectories,
  );
  await closeExactDestinationDirectory(exact);
}

async function openSourceRegular(path: string): Promise<FileHandle> {
  const baseFlags = constants.O_RDONLY
    | constants.O_NONBLOCK
    | constants.O_NOFOLLOW;
  let file: FileHandle | undefined;
  try {
    file = await open(path, baseFlags | constants.O_NOATIME);
    if (!(await file.stat()).isFile()) {
      throw placementError("invalid_source", "Legacy Documents sources must be regular files.");
    }
    return file;
  } catch (error) {
    await file?.close().catch(() => undefined);
    throw placementError("invalid_source", "A legacy source is not a stable regular file.", error);
  }
}

async function scanSource(
  root: FileHandle,
): Promise<PlannedEntry[]> {
  const planned: PlannedEntry[] = [];
  let entriesSeen = 0;

  const walk = async (directory: FileHandle, segments: readonly string[]): Promise<void> => {
    const listing = await opendir(descriptorPath(directory));
    const names: string[] = [];
    try {
      for (;;) {
        const entry = await listing.read();
        if (entry === null) break;
        names.push(entry.name);
      }
    } finally {
      await listing.close();
    }
    names.sort(compareNames);

    for (const name of names) {
      entriesSeen += 1;
      if (entriesSeen > LEGACY_DOCUMENTS_MAX_ENTRIES) {
        throw placementError(
          "limit_exceeded",
          `Legacy Documents placement is limited to ${LEGACY_DOCUMENTS_MAX_ENTRIES} entries.`,
        );
      }
      const path = descriptorPath(directory, name);
      const before = await lstat(path, { bigint: true });
      if (before.isSymbolicLink()) {
        throw placementError(
          "invalid_source",
          `Legacy source ${JSON.stringify([...segments, name].join("/"))} is a symbolic link.`,
        );
      }
      if (before.isDirectory()) {
        let child: FileHandle | undefined;
        try {
          child = await openDirectoryNoFollow(path, "Legacy Documents source directory");
          const opened = await child.stat({ bigint: true });
          if (!sameIdentity(identity(before), identity(opened))) {
            throw placementError("source_changed", "A legacy source directory changed during the scan.");
          }
          await walk(child, [...segments, name]);
        } finally {
          await child?.close().catch(() => undefined);
        }
        continue;
      }
      if (!before.isFile()) {
        throw placementError(
          "invalid_source",
          `Legacy source ${JSON.stringify([...segments, name].join("/"))} is not a regular file.`,
        );
      }
      const file = await openSourceRegular(path);
      try {
        const opened = await file.stat({ bigint: true });
        if (!sameIdentity(identity(before), identity(opened))) {
          throw placementError("source_changed", "A legacy source file changed during the scan.");
        }
        if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw placementError("limit_exceeded", "A legacy source file is too large to place safely.");
        }
        planned.push({
          relativePath: [...segments, name].join("/"),
          segments: [...segments, name],
          identity: identity(opened),
          sizeBytes: opened.size,
          size: Number(opened.size),
          mode: Number(opened.mode & 0o7777n),
          atimeNs: opened.atimeNs,
          ctimeNs: opened.ctimeNs,
          mtimeNs: opened.mtimeNs,
          modifiedAt: new Date(Number(opened.mtimeNs / 1_000_000n)).toISOString(),
        });
      } finally {
        await file.close();
      }
    }
  };

  await walk(root, []);
  return planned;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function preflightDestination(
  root: FileHandle,
  planned: readonly PlannedEntry[],
): Promise<void> {
  for (const entry of planned) {
    let current = root;
    const opened: FileHandle[] = [];
    let missingParent = false;
    try {
      for (const segment of entry.segments.slice(0, -1)) {
        const stats = await lstatOrNull(descriptorPath(current, segment));
        if (stats === null) {
          missingParent = true;
          break;
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw placementError(
            "invalid_destination",
            `Documents parent ${JSON.stringify(segment)} is not a real directory.`,
          );
        }
        const next = await openDirectoryNoFollow(
          descriptorPath(current, segment),
          "Documents destination directory",
        );
        const openedStats = await next.stat({ bigint: true });
        if (!sameIdentity(identity(stats), identity(openedStats))) {
          await next.close();
          throw placementError("destination_changed", "A Documents parent changed during preflight.");
        }
        opened.push(next);
        current = next;
      }
      if (missingParent) continue;
      const name = entry.segments.at(-1) as string;
      if (await lstatOrNull(descriptorPath(current, name))) {
        throw placementError(
          "collision",
          `Documents already contains ${JSON.stringify(entry.relativePath)}.`,
        );
      }
    } finally {
      for (const directory of opened.reverse()) await directory.close().catch(() => undefined);
    }
  }
}

async function openRelativeDirectory(
  root: FileHandle,
  segments: readonly string[],
  label: string,
): Promise<FileHandle[]> {
  const opened: FileHandle[] = [];
  let current = root;
  try {
    for (const segment of segments) {
      const next = await openDirectoryNoFollow(descriptorPath(current, segment), label);
      opened.push(next);
      current = next;
    }
    return opened;
  } catch (error) {
    for (const directory of opened.reverse()) await directory.close().catch(() => undefined);
    throw error;
  }
}

async function copyFileContents(source: FileHandle, destination: FileHandle): Promise<bigint> {
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        offset + written,
      );
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
  return BigInt(offset);
}

function entryUnchanged(entry: PlannedEntry, stats: BigIntStats): boolean {
  return sameIdentity(entry.identity, identity(stats))
    && stats.size === entry.sizeBytes
    && stats.ctimeNs === entry.ctimeNs
    && stats.mtimeNs === entry.mtimeNs
    && Number(stats.mode & 0o7777n) === entry.mode;
}

async function rollback(
  published: readonly PublishedEntry[],
  createdDirectories: readonly CreatedDirectory[],
): Promise<void> {
  const failures: string[] = [];
  for (const entry of [...published].reverse()) {
    try {
      const path = descriptorPath(entry.parent, entry.name);
      const stats = await lstat(path, { bigint: true });
      if (!sameIdentity(entry.identity, identity(stats))) {
        throw new Error("published inode was replaced");
      }
      await unlink(path);
      await entry.parent.sync();
    } catch (error) {
      failures.push(`${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const entry of [...createdDirectories].reverse()) {
    try {
      const path = descriptorPath(entry.parent, entry.name);
      const stats = await lstat(path, { bigint: true });
      if (!stats.isDirectory() || !sameIdentity(entry.identity, identity(stats))) {
        throw new Error("created directory was replaced");
      }
      await rmdir(path);
      await entry.parent.sync();
    } catch (error) {
      failures.push(`${entry.relativePath}/: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw placementError(
      "rollback_failed",
      `Legacy Documents rollback needs manual recovery: ${failures.join("; ")}`,
    );
  }
}

/**
 * Copy one explicitly chosen legacy tree into one explicitly chosen Documents
 * root. Dry-run is the default; apply never removes or overwrites a source.
 */
export async function placeLegacyDocuments(
  options: LegacyDocumentsPlacementOptions,
): Promise<LegacyDocumentsPlacementResult> {
  if (!isAbsolute(options.sourceRoot) || !isAbsolute(options.documentsRoot)) {
    throw placementError(
      "invalid_path",
      "Legacy source root and Documents root must both be absolute paths.",
    );
  }
  const sourceRoot = resolve(options.sourceRoot);
  const documentsRoot = resolve(options.documentsRoot);
  const source = await openAbsoluteDirectory(sourceRoot, "Legacy source root");
  let documents: FileHandle | undefined;
  const destinationDirectories = new Map<string, FileHandle>();
  const createdDirectories: CreatedDirectory[] = [];
  const published: PublishedEntry[] = [];
  try {
    documents = await openAbsoluteDirectory(documentsRoot, "Documents root");
    destinationDirectories.set("", documents);
    const [sourcePath, documentsPath] = await Promise.all([
      descriptorRealpath(source, "Legacy source root"),
      descriptorRealpath(documents, "Documents root"),
    ]);
    if (contains(sourcePath, documentsPath) || contains(documentsPath, sourcePath)) {
      throw placementError(
        "overlapping_roots",
        "The legacy source and Documents destination must not contain one another.",
      );
    }

    const planned = await scanSource(source);
    const entries = planned.map((entry): LegacyDocumentsPlacementEntry => ({
      relativePath: entry.relativePath,
      size: entry.size,
      mode: entry.mode,
      modifiedAt: entry.modifiedAt,
    }));
    await assertConfiguredRoot(source, sourceRoot, "Legacy source root");
    await assertDestinationContained(documents, documentsRoot, documents);
    await preflightDestination(documents, planned);
    await options.probe?.("after-preflight");
    if (options.dryRun !== false) {
      return {
        dryRun: true,
        sourceRoot: sourcePath,
        documentsRoot: documentsPath,
        entries,
        placed: 0,
      };
    }

    const getDestinationDirectory = async (segments: readonly string[]): Promise<FileHandle> => {
      let current = documents as FileHandle;
      let key = "";
      const traversed: string[] = [];
      for (const segment of segments) {
        await assertExactDestinationDirectory(
          documents as FileHandle,
          documentsRoot,
          traversed,
          destinationDirectories,
        );
        key = key ? `${key}/${segment}` : segment;
        const retained = destinationDirectories.get(key);
        if (retained) {
          current = retained;
          traversed.push(segment);
          await assertExactDestinationDirectory(
            documents as FileHandle,
            documentsRoot,
            traversed,
            destinationDirectories,
          );
          continue;
        }
        const path = descriptorPath(current, segment);
        let created = false;
        try {
          await mkdir(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        if (created) {
          const stats = await lstat(path, { bigint: true });
          if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw placementError("destination_changed", "A new Documents directory was replaced.");
          }
          createdDirectories.push({
            parent: current,
            name: segment,
            relativePath: key,
            identity: identity(stats),
          });
        }
        const next = await openDirectoryNoFollow(path, "Documents destination directory");
        if (created) {
          const expected = createdDirectories.at(-1) as CreatedDirectory;
          const opened = await next.stat({ bigint: true });
          if (!sameIdentity(expected.identity, identity(opened))) {
            await next.close();
            throw placementError("destination_changed", "A new Documents directory changed.");
          }
        }
        destinationDirectories.set(key, next);
        current = next;
        traversed.push(segment);
        await assertDestinationContained(documents as FileHandle, documentsRoot, current);
        await assertExactDestinationDirectory(
          documents as FileHandle,
          documentsRoot,
          traversed,
          destinationDirectories,
        );
      }
      return current;
    };

    try {
      for (const entry of planned) {
        await options.probe?.("before-copy", entry.relativePath);
        const parentSegments = entry.segments.slice(0, -1);
        const name = entry.segments.at(-1) as string;
        const destinationParent = await getDestinationDirectory(parentSegments);
        await assertDestinationContained(documents, documentsRoot, destinationParent);
        await assertExactDestinationDirectory(
          documents,
          documentsRoot,
          parentSegments,
          destinationDirectories,
        );
        const sourceDirectories = await openRelativeDirectory(
          source,
          parentSegments,
          "Legacy Documents source directory",
        );
        const sourceParent = sourceDirectories.at(-1) ?? source;
        let sourceFile: FileHandle | undefined;
        let temporaryFile: FileHandle | undefined;
        const temporaryName = `.ghost-place-${randomUUID()}.tmp`;
        const temporaryPath = descriptorPath(destinationParent, temporaryName);
        try {
          sourceFile = await openSourceRegular(descriptorPath(sourceParent, name));
          const before = await sourceFile.stat({ bigint: true });
          if (!entryUnchanged(entry, before)) {
            throw placementError("source_changed", `${entry.relativePath} changed after preflight.`);
          }
          if (await lstatOrNull(descriptorPath(destinationParent, name))) {
            throw placementError("collision", `Documents gained ${JSON.stringify(entry.relativePath)}.`);
          }
          temporaryFile = await open(
            temporaryPath,
            constants.O_CREAT
              | constants.O_EXCL
              | constants.O_WRONLY
              | constants.O_NOFOLLOW,
            0o600,
          );
          const copied = await copyFileContents(sourceFile, temporaryFile);
          const after = await sourceFile.stat({ bigint: true });
          if (!entryUnchanged(entry, after) || copied !== entry.sizeBytes) {
            throw placementError("source_changed", `${entry.relativePath} changed while it was copied.`);
          }
          await temporaryFile.chmod(entry.mode);
          await temporaryFile.utimes(
            Number(entry.atimeNs) / 1_000_000_000,
            Number(entry.mtimeNs) / 1_000_000_000,
          );
          await temporaryFile.sync();
          const temporaryStats = await temporaryFile.stat({ bigint: true });
          const publishedIdentity = identity(temporaryStats);
          await assertDestinationContained(documents, documentsRoot, destinationParent);
          await options.probe?.("before-publish", entry.relativePath);
          await assertDestinationContained(documents, documentsRoot, destinationParent);
          const exactParent = await openExactDestinationDirectory(
            documents,
            documentsRoot,
            parentSegments,
            destinationDirectories,
          );
          try {
            await link(temporaryPath, descriptorPath(exactParent.directory, name));
          } catch (error) {
            if (errorCode(error) === "EEXIST") {
              throw placementError("collision", `Documents gained ${JSON.stringify(entry.relativePath)}.`);
            }
            throw error;
          } finally {
            await closeExactDestinationDirectory(exactParent);
          }
          published.push({
            parent: destinationParent,
            name,
            relativePath: entry.relativePath,
            identity: publishedIdentity,
          });
          await options.probe?.("after-publish", entry.relativePath);
          const destinationStats = await lstat(
            descriptorPath(destinationParent, name),
            { bigint: true },
          );
          if (!sameIdentity(publishedIdentity, identity(destinationStats))
            || !destinationStats.isFile()
            || destinationStats.size !== entry.sizeBytes
            || Number(destinationStats.mode & 0o7777n) !== entry.mode) {
            throw placementError("verification_failed", `${entry.relativePath} failed verification.`);
          }
          await assertDestinationContained(documents, documentsRoot, destinationParent);
          await assertExactDestinationDirectory(
            documents,
            documentsRoot,
            parentSegments,
            destinationDirectories,
          );
          await unlink(temporaryPath);
          await destinationParent.sync();
        } finally {
          await temporaryFile?.close().catch(() => undefined);
          await sourceFile?.close().catch(() => undefined);
          await unlink(temporaryPath).catch(() => undefined);
          for (const directory of sourceDirectories.reverse()) {
            await directory.close().catch(() => undefined);
          }
        }
      }
    } catch (error) {
      try {
        await rollback(published, createdDirectories);
      } catch (rollbackError) {
        throw placementError(
          "rollback_failed",
          `${error instanceof Error ? error.message : String(error)} ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          error,
        );
      }
      throw error;
    }

    return {
      dryRun: false,
      sourceRoot: sourcePath,
      documentsRoot: documentsPath,
      entries,
      placed: planned.length,
    };
  } finally {
    const uniqueDirectories = [...new Set(destinationDirectories.values())].reverse();
    for (const directory of uniqueDirectories) await directory.close().catch(() => undefined);
    await source.close();
  }
}

interface PlacementCommandIO {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
}

const PLACEMENT_USAGE = `Usage:
  ghostd place-legacy-documents --source <legacy-docs> --documents-root <root> [--apply]

Defaults to a read-only dry run. --apply copies regular files without overwrite
and leaves every legacy source in place.
`;

export async function legacyDocumentsPlacementCommand(
  argv: readonly string[],
  io: PlacementCommandIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let sourceRoot: string | undefined;
  let documentsRoot: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      io.stdout.write(PLACEMENT_USAGE);
      return 0;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--source" || arg === "--documents-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        io.stderr.write(`${arg} requires an absolute path.\n\n${PLACEMENT_USAGE}`);
        return 2;
      }
      if (arg === "--source") sourceRoot = value;
      else documentsRoot = value;
      index += 1;
      continue;
    }
    io.stderr.write(`Unknown placement option: ${arg}\n\n${PLACEMENT_USAGE}`);
    return 2;
  }
  if (!sourceRoot || !documentsRoot) {
    io.stderr.write(`--source and --documents-root are required.\n\n${PLACEMENT_USAGE}`);
    return 2;
  }
  try {
    const result = await placeLegacyDocuments({
      sourceRoot,
      documentsRoot,
      dryRun: !apply,
    });
    for (const entry of result.entries) {
      io.stdout.write(`${result.dryRun ? "would place" : "placed"} ${JSON.stringify(entry.relativePath)}\n`);
    }
    io.stdout.write(result.dryRun
      ? `Dry run clean: ${result.entries.length} regular file(s); no destination changes.\n`
      : `Placed ${result.placed} regular file(s); every legacy source remains in place.\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Placement refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
