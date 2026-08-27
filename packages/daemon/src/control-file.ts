/** Bounded reads for daemon-owned recovery and conversation control files. */
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { openRegularFileNoFollow } from "@ghost/extensions";

const CONTROL_MODE = 0o600n;

function invalid(path: string, reason: string): Error {
  return new Error(`Daemon control file ${JSON.stringify(path)} ${reason}.`);
}

function validateDescriptor(path: string, stats: BigIntStats): void {
  if (!stats.isFile()) throw invalid(path, "is not a regular file");
  if (stats.nlink !== 1n) throw invalid(path, "does not have exactly one link");
  if ((stats.mode & 0o777n) !== CONTROL_MODE) {
    throw invalid(path, "does not have mode 0600");
  }
  if (stats.size < 0n) throw invalid(path, "has an invalid size");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

function checkedLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Daemon control-file limit must be a positive safe integer.");
  }
  return maxBytes;
}

async function readPinned(
  path: string,
  maxBytes: number,
  complete: boolean,
  probe?: (stage: "opened" | "read", path: string) => void | Promise<void>,
): Promise<{ bytes: Uint8Array; before: BigIntStats }> {
  const limit = checkedLimit(maxBytes);
  const file = await openRegularFileNoFollow(path, "Daemon control file");
  try {
    const before = await file.stat({ bigint: true });
    validateDescriptor(path, before);
    if (complete && before.size > BigInt(limit)) {
      throw invalid(path, `exceeds its ${limit}-byte limit`);
    }
    await probe?.("opened", path);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    await probe?.("read", path);
    if (complete && (length > limit || BigInt(length) !== before.size)) {
      throw invalid(path, `exceeds or changed across its ${limit}-byte read`);
    }
    const after = await file.stat({ bigint: true });
    validateDescriptor(path, after);
    let live: BigIntStats;
    try {
      live = await lstat(path, { bigint: true });
    } catch {
      // Only initial-open ENOENT means "absent" to callers. Once a descriptor
      // was admitted, disappearance is an identity failure, not a fallback.
      throw invalid(path, "changed while it was read");
    }
    validateDescriptor(path, live);
    if (!sameIdentity(before, after) || !sameIdentity(after, live)) {
      throw invalid(path, "changed while it was read");
    }
    return { bytes: bytes.subarray(0, length), before };
  } finally {
    await file.close().catch(() => {});
  }
}

function strictUtf8(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid(path, "is not valid UTF-8");
  }
}

/** Read one complete small daemon-owned file through a stable pinned descriptor. */
export async function readDaemonControlFile(
  path: string,
  maxBytes: number,
  probe?: (stage: "opened" | "read", path: string) => void | Promise<void>,
): Promise<string> {
  const { bytes } = await readPinned(path, maxBytes, true, probe);
  return strictUtf8(path, bytes);
}

/**
 * Read one newline-terminated first line without rejecting a large append-only
 * transcript. The first newline itself must occur within `maxLineBytes`.
 */
export async function readDaemonControlLine(
  path: string,
  maxLineBytes: number,
  probe?: (stage: "opened" | "read", path: string) => void | Promise<void>,
): Promise<string> {
  const { bytes } = await readPinned(path, maxLineBytes, false, probe);
  const newline = bytes.subarray(0, maxLineBytes).indexOf(0x0a);
  if (newline < 0) {
    throw invalid(path, `has no first-line terminator within ${maxLineBytes} bytes`);
  }
  return strictUtf8(path, bytes.subarray(0, newline));
}

/**
 * Return only complete newline-terminated records from one bounded prefix.
 * This supports OMP's optional title slot followed by its session header while
 * never allocating the append-only transcript remainder.
 */
export async function readDaemonControlPrefix(
  path: string,
  maxBytes: number,
  probe?: (stage: "opened" | "read", path: string) => void | Promise<void>,
): Promise<string> {
  const { bytes } = await readPinned(path, maxBytes, false, probe);
  const newline = bytes.subarray(0, maxBytes).lastIndexOf(0x0a);
  if (newline < 0) {
    throw invalid(path, `has no complete record within ${maxBytes} bytes`);
  }
  return strictUtf8(path, bytes.subarray(0, newline + 1));
}

/** Atomically publish one bounded daemon-owned mode-0600 control file. */
export async function writeDaemonControlFile(
  path: string,
  content: string,
  maxBytes: number,
): Promise<void> {
  const limit = checkedLimit(maxBytes);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > limit) {
    throw invalid(path, `exceeds its ${limit}-byte limit`);
  }
  const parent = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // The owning workflow creates and confines the parent. Background writers
    // must never recreate a moved/deleted sessions directory.
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}
