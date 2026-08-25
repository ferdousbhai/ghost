import { constants } from "node:fs";
import { lstat, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { GhostError } from "../errors.js";
import {
  descriptorPath,
  openConfinedDirectory,
  openConfinedFile,
  openDirectoryNoFollow,
  withDescriptorLock,
} from "../linux-fs.js";

/** The one screenshot directory shared by the screen and browser tools. */
export const SCREENSHOTS_DIRNAME = ".screenshots";

/** Each screenshot producer keeps this many of its own captures. */
export const DEFAULT_SCREENSHOT_RETENTION = 20;

/** Hard ceiling for a screenshot on transport, disk, and provider output. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const MAX_SCREENSHOT_COLLISIONS = 10_000;
const CREATE_SCREENSHOT_FLAGS = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | constants.O_NOFOLLOW;
const LEGACY_BROWSER_SCREENSHOT =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.png$/;
const GENERATED_TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}";
const SCREEN_SCREENSHOT = new RegExp(`^screen-${GENERATED_TIMESTAMP}(?:-\\d+)?\\.png$`);
const BROWSER_SCREENSHOT = new RegExp(`^browser-${GENERATED_TIMESTAMP}(?:-\\d+)?\\.png$`);

function screenshotLimitError(label: string, bytes: number): GhostError {
  return new GhostError(
    "limit_exceeded",
    `${label} is ${bytes} bytes; screenshots are limited to ${MAX_SCREENSHOT_BYTES} bytes.`,
    { bytes, maxBytes: MAX_SCREENSHOT_BYTES },
  );
}

/** Refuse an encoded screenshot before allocating its decoded byte buffer. */
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

export function isScreenScreenshot(name: string): boolean {
  return SCREEN_SCREENSHOT.test(name);
}

/**
 * Browser captures gained a prefix when retention was added. Match the former
 * timestamp-only spelling too, so the first new capture also bounds an existing
 * directory rather than abandoning the files that exposed the original leak.
 */
export function isBrowserScreenshot(name: string): boolean {
  return BROWSER_SCREENSHOT.test(name)
    || LEGACY_BROWSER_SCREENSHOT.test(name);
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

/** Keep the newest matching regular files. Other screenshot producers are untouched. */
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

/** Pin and exclusively lock the shared screenshot directory for one mutation. */
export async function withScreenshotDirectory<T>(
  homeDir: string,
  action: (directory: FileHandle, logicalDir: string) => Promise<T>,
): Promise<T> {
  const logicalDir = join(homeDir, SCREENSHOTS_DIRNAME);
  const directory = await openConfinedDirectory(homeDir, logicalDir, {
    create: true,
    label: "Screenshots path",
  });
  try {
    return await withDescriptorLock(directory, () => action(directory, logicalDir));
  } finally {
    await directory.close();
  }
}

/** Compatibility seam for screen retention tests and direct callers. */
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

/** Read a confined screenshot without allocating more than the screenshot cap. */
export async function readScreenshotFile(homeDir: string, path: string): Promise<Buffer> {
  const file = await openConfinedFile(homeDir, path, "Screenshot file");
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
