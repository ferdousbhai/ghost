/**
 * Confined reads and durable metadata writes for ghost-home files that hold, or
 * once held, a secret.
 *
 * One implementation, because it is one rule: a private file is read through a
 * descriptor whose identity cannot change under the reader, capped, and decoded
 * fatally. Callers translate a refusal into their own typed error rather than
 * restating the rule.
 */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";

export const MAX_PRIVATE_FILE_BYTES = 1_048_576;

export type PrivateReadRefusal = "open" | "unsafe" | "too_large" | "changed" | "encoding";

export class PrivateReadError extends Error {
  readonly refusal: PrivateReadRefusal;

  constructor(refusal: PrivateReadRefusal, cause?: unknown) {
    super(`Private file read refused: ${refusal}.`, cause === undefined ? {} : { cause });
    this.name = "PrivateReadError";
    this.refusal = refusal;
  }
}

export type PrivateReadProbe = (stage: "opened" | "read", path: string) => void;

function validPrivateDescriptor(stats: BigIntStats): boolean {
  return stats.isFile() && stats.nlink === 1n && stats.size >= 0n;
}

function samePrivateFileState(left: BigIntStats, right: BigIntStats): boolean {
  return validPrivateDescriptor(left)
    && validPrivateDescriptor(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

export function readPrivateFileText(path: string, probe?: PrivateReadProbe): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new PrivateReadError("open", error);
  }
  let bytes: Buffer;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!validPrivateDescriptor(before)) throw new PrivateReadError("unsafe");
    if (before.size > BigInt(MAX_PRIVATE_FILE_BYTES)) throw new PrivateReadError("too_large");
    probe?.("opened", path);

    const admittedSize = Number(before.size);
    bytes = Buffer.allocUnsafe(admittedSize);
    let offset = 0;
    while (offset < admittedSize) {
      const count = readSync(fd, bytes, offset, admittedSize - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    const grew = readSync(fd, overflow, 0, 1, offset) !== 0;
    probe?.("read", path);

    const after = fstatSync(fd, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch (error) {
      throw new PrivateReadError("changed", error);
    }
    if (offset !== admittedSize
      || grew
      || !samePrivateFileState(before, after)
      || !samePrivateFileState(after, current)) {
      throw new PrivateReadError("changed");
    }
  } finally {
    closeSync(fd);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PrivateReadError("encoding", error);
  }
}

/** Flush a file or a directory so a preceding write, rename, or unlink is durable. */
export function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace `path` with `value` as pretty JSON, private (0600), through a
 * per-writer temporary file and one rename, so a reader never sees a torn
 * file and two concurrent writers never share a temporary name.
 */
export async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
