/**
 * Import a hosted ghost-home archive into a local ghost home.
 *
 * Legacy ghost-home/v1 archives are admitted only at this boundary. Their
 * `notes/` paths and documents are migrated before the returned home becomes
 * live; the landed manifest always records ghost-home/v2.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { GhostError } from "./errors.js";
import { sanitizePathSegment } from "./frontmatter.js";
import { DOCS_DIRNAME, EXPORT_MANIFEST_FILENAME, GhostHome } from "./home.js";
import { GHOST_HOME_FORMAT } from "./types.js";

const LEGACY_GHOST_HOME_FORMAT = "ghost-home/v1";

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
  /** Write into an existing, non-empty ghost home. Off by default. */
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
}

/** macOS zip cruft; never part of the ghost. */
function isArchiveNoise(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => segment === "__MACOSX" || segment === ".DS_Store")
    || segments.some((segment) => segment.startsWith("._"));
}

type ArchiveEntries = Map<string, Uint8Array>;

const LEGACY_NOTES_PREFIX = "notes/";

function canonicalArchivePath(path: string): string {
  return path.startsWith(LEGACY_NOTES_PREFIX)
    ? `${DOCS_DIRNAME}/${path.slice(LEGACY_NOTES_PREFIX.length)}`
    : path;
}

async function readDirectoryEntries(dir: string): Promise<ArchiveEntries> {
  const entries: ArchiveEntries = new Map();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), path);
      } else if (entry.isFile()) {
        entries.set(path, await readFile(join(current, entry.name)));
      }
    }
  };
  await walk(dir, "");
  return entries;
}

function readZipEntries(bytes: Uint8Array): ArchiveEntries {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (error) {
    throw new GhostError(
      "invalid_format",
      `Not a readable zip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries: ArchiveEntries = new Map();
  for (const [path, content] of Object.entries(unzipped)) {
    // fflate represents directories as zero-length entries ending in "/".
    if (path.endsWith("/")) continue;
    entries.set(path, content);
  }
  return entries;
}

/**
 * The archive root is the single directory the export wraps everything in. An
 * already-extracted directory may be that root itself.
 */
function findRoot(entries: ArchiveEntries): string {
  if (entries.has(EXPORT_MANIFEST_FILENAME)) return "";
  const roots = new Set<string>();
  for (const path of entries.keys()) {
    if (isArchiveNoise(path)) continue;
    const slash = path.indexOf("/");
    if (slash > 0) roots.add(path.slice(0, slash));
  }
  for (const root of roots) {
    if (entries.has(`${root}/${EXPORT_MANIFEST_FILENAME}`)) return root;
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
      `${EXPORT_MANIFEST_FILENAME} is not valid JSON: `
      + (error instanceof Error ? error.message : String(error)),
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

async function isNonEmptyDirectory(dir: string): Promise<boolean> {
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return true;
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Import a current or legacy archive into `<ghostsRoot>/<name>/`.
 */
export async function importGhostArchive(
  source: string,
  ghostsRoot: string,
  options: ImportGhostArchiveOptions = {},
): Promise<ImportGhostArchiveResult> {
  const sourcePath = resolve(source);
  let sourceStats: Awaited<ReturnType<typeof stat>>;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new GhostError("not_found", `No archive at ${sourcePath}.`, { source: sourcePath });
  }

  const entries = sourceStats.isDirectory()
    ? await readDirectoryEntries(sourcePath)
    : readZipEntries(await readFile(sourcePath));

  const root = findRoot(entries);
  const prefix = root ? `${root}/` : "";
  const manifestBytes = entries.get(`${prefix}${EXPORT_MANIFEST_FILENAME}`);
  if (!manifestBytes) {
    throw new GhostError("invalid_format", `Missing ${EXPORT_MANIFEST_FILENAME}.`);
  }
  const sourceManifest = parseManifest(manifestBytes);
  const manifest: GhostArchiveManifest = {
    ...sourceManifest,
    format: GHOST_HOME_FORMAT,
  };
  const migratedManifestBytes = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const ghostName = sanitizePathSegment(
    options.name ?? manifest.ghostname ?? root ?? "ghost",
  );
  const dir = resolve(join(ghostsRoot, ghostName));
  if (!options.overwrite && (await isNonEmptyDirectory(dir))) {
    throw new GhostError(
      "conflict",
      `${dir} already exists and is not empty. Pass overwrite to import into it anyway.`,
      { dir },
    );
  }

  const ignored: string[] = [];
  const targets = new Set<string>();
  let filesWritten = 0;
  for (const [path, content] of entries) {
    if (root !== "" && !path.startsWith(prefix)) {
      ignored.push(path);
      continue;
    }
    const archivePath = path.slice(prefix.length);
    if (!archivePath || isArchiveNoise(archivePath)) {
      ignored.push(path);
      continue;
    }
    const relativePath = canonicalArchivePath(archivePath);
    if (targets.has(relativePath)) {
      throw new GhostError(
        "invalid_format",
        `Archive entries collide at canonical path ${JSON.stringify(relativePath)}.`,
        { entry: path, path: relativePath },
      );
    }
    targets.add(relativePath);
    // Zip-slip guard: an archive is untrusted input even when we wrote it.
    const target = resolve(dir, relativePath);
    if (target !== dir && !target.startsWith(dir + sep)) {
      throw new GhostError(
        "invalid_path",
        `Archive entry ${JSON.stringify(path)} escapes the ghost home.`,
        { entry: path },
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      archivePath === EXPORT_MANIFEST_FILENAME ? migratedManifestBytes : content,
    );
    filesWritten += 1;
  }

  const home = new GhostHome(dir);
  await home.ensure();
  return { home, ghostName, dir, manifest, filesWritten, ignored };
}
