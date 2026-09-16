import { constants } from "node:fs";
import { lstat, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { GhostError } from "../errors.js";
import {
  descriptorPath,
  openConfinedDirectory,
  openConfinedFile,
  openDirectoryNoFollow,
  withDescriptorLock,
} from "../linux-fs.js";
import { expandHome, resolveUserDirectory } from "../xdg-user-dirs.js";

/**
 * Ghost's captures land where the desktop's own screenshots land.
 *
 * A ghost taking a picture of the screen is doing what the owner does with
 * SUPER+SHIFT+S, so the pictures belong in the same drawer rather than in a
 * private one the owner would have to be told about. The precedence matches
 * Omarchy's `omarchy-capture-screenshot` exactly, `user-dirs.dirs` included,
 * because a systemd user unit inherits none of the XDG desktop variables.
 */
export function resolveScreenshotDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.OMARCHY_SCREENSHOT_DIR?.trim();
  if (configured) return resolve(expandHome(configured, home));
  return resolveUserDirectory("XDG_PICTURES_DIR", "Pictures", env, home);
}

/**
 * What a ghost's captures are called, and the only files retention will ever
 * delete. The owner's own screenshots share the directory, so the prefix names
 * the ghost that took the picture and nothing else in the drawer matches it.
 */
export function ghostScreenshotName(
  ghostName: string,
  producer: ScreenshotProducer,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return `ghost-${ghostName}-${producer}-${stamp}.png`;
}

export type ScreenshotProducer = "screen" | "browser";

export function ghostScreenshotMatcher(
  ghostName: string,
  producer: ScreenshotProducer,
): (name: string) => boolean {
  const pattern = new RegExp(
    `^ghost-${escapeForPattern(ghostName)}-${producer}-${GENERATED_TIMESTAMP}(?:-\\d+)?\\.png$`,
  );
  return (name) => pattern.test(name);
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const DEFAULT_SCREENSHOT_RETENTION = 20;

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const MAX_SCREENSHOT_COLLISIONS = 10_000;
const CREATE_SCREENSHOT_FLAGS = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | constants.O_NOFOLLOW;
const GENERATED_TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}";

function screenshotLimitError(label: string, bytes: number): GhostError {
  return new GhostError(
    "limit_exceeded",
    `${label} is ${bytes} bytes; screenshots are limited to ${MAX_SCREENSHOT_BYTES} bytes.`,
    { bytes, maxBytes: MAX_SCREENSHOT_BYTES },
  );
}

export function assertScreenshotBase64WithinLimit(data: string, label: string): void {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(Math.floor(data.length * 3 / 4) - padding, 0);
  if (decodedBytes > MAX_SCREENSHOT_BYTES) {
    throw screenshotLimitError(label, decodedBytes);
  }
}

export function assertScreenshotBytesWithinLimit(bytes: number, label: string): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_SCREENSHOT_BYTES) {
    throw screenshotLimitError(label, bytes);
  }
}

function collisionName(baseName: string, attempt: number): string {
  if (attempt === 0) return baseName;
  const extension = extname(baseName);
  return `${baseName.slice(0, -extension.length)}-${attempt}${extension}`;
}

async function reserveScreenshot(
  directory: FileHandle,
  baseName: string,
): Promise<{ file: FileHandle; name: string }> {
  if (basename(baseName) !== baseName || !baseName.endsWith(".png")) {
    throw new GhostError(
      "invalid_path",
      `Screenshot filename ${JSON.stringify(baseName)} is not a plain PNG basename.`,
      { baseName },
    );
  }
  for (let attempt = 0; attempt < MAX_SCREENSHOT_COLLISIONS; attempt += 1) {
    const name = collisionName(baseName, attempt);
    try {
      const file = await open(
        descriptorPath(directory, name),
        CREATE_SCREENSHOT_FLAGS,
        0o600,
      );
      return { file, name };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new GhostError(
    "conflict",
    `Could not reserve a collision-free screenshot name after ${MAX_SCREENSHOT_COLLISIONS} attempts.`,
    { baseName },
  );
}

/**
 * Reserve a no-follow regular file, let a backend write through its pinned
 * descriptor, then enforce the disk ceiling. A failed writer never leaves its
 * partial reservation behind.
 */
export async function writeScreenshotFile<T>(
  directory: FileHandle,
  baseName: string,
  label: string,
  writer: (descriptorFilePath: string) => Promise<T>,
): Promise<{ name: string; bytes: number; value: T }> {
  const reservation = await reserveScreenshot(directory, baseName);
  let result: { name: string; bytes: number; value: T };
  try {
    const value = await writer(descriptorPath(reservation.file));
    const stats = await reservation.file.stat();
    if (!stats.isFile()) {
      throw new GhostError(
        "invalid_path",
        `${label} did not produce a regular file.`,
        { baseName },
      );
    }
    assertScreenshotBytesWithinLimit(stats.size, label);
    result = { name: reservation.name, bytes: stats.size, value };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await reservation.file.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await rm(descriptorPath(directory, reservation.name), { force: true });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `${label} failed and its partial file could not be cleaned up.`);
    }
    throw error;
  }
  await reservation.file.close();
  return result;
}

export async function pruneScreenshotFiles(
  directory: FileHandle,
  retention: number,
  matches: (name: string) => boolean,
): Promise<string[]> {
  const names = await readdir(descriptorPath(directory));
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!matches(name)) continue;
    const path = descriptorPath(directory, name);
    try {
      const entry = await lstat(path);
      if (!entry.isFile()) {
        throw new GhostError(
          "invalid_path",
          `Screenshot entry ${JSON.stringify(name)} is not a regular file; pruning stopped.`,
          { name },
        );
      }
      entries.push({ name, mtimeMs: entry.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  entries.sort((left, right) => {
    const byTime = right.mtimeMs - left.mtimeMs;
    if (byTime !== 0) return byTime;
    return left.name === right.name ? 0 : left.name < right.name ? 1 : -1;
  });
  const keep = Number.isFinite(retention)
    ? Math.max(Math.floor(retention), 0)
    : DEFAULT_SCREENSHOT_RETENTION;
  const doomed = entries.slice(keep);
  for (const entry of doomed) {
    await rm(descriptorPath(directory, entry.name));
  }
  return doomed.map((entry) => entry.name);
}

export async function withScreenshotDirectory<T>(
  screenshotDir: string,
  action: (directory: FileHandle, logicalDir: string) => Promise<T>,
): Promise<T> {
  const logicalDir = resolve(screenshotDir);
  const directory = await openConfinedDirectory(logicalDir, logicalDir, {
    create: true,
    label: "Screenshots path",
  });
  try {
    return await withDescriptorLock(directory, () => action(directory, logicalDir));
  } finally {
    await directory.close();
  }
}

/** The pathname form of `pruneScreenshotFiles`, used only by its tests. */
export async function pruneScreenshotDirectoryPath(
  dir: string,
  retention: number,
  matches: (name: string) => boolean,
): Promise<string[]> {
  const directory = await openDirectoryNoFollow(dir, "Screenshots path");
  try {
    return await withDescriptorLock(
      directory,
      () => pruneScreenshotFiles(directory, retention, matches),
    );
  } finally {
    await directory.close();
  }
}

export async function readScreenshotFile(
  screenshotDir: string,
  path: string,
): Promise<Buffer> {
  const file = await openConfinedFile(resolve(screenshotDir), path, "Screenshot file");
  if (!file) {
    throw new GhostError("not_found", `Screenshot ${JSON.stringify(path)} no longer exists.`, {
      path,
    });
  }
  try {
    const initialSize = (await file.stat()).size;
    assertScreenshotBytesWithinLimit(initialSize, "Screenshot");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const available = MAX_SCREENSHOT_BYTES + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, available));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SCREENSHOT_BYTES) throw screenshotLimitError("Screenshot", total);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}
