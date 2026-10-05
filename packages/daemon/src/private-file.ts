/**
 * Confined reads and atomic writes for ghost-home files that hold, or once
 * held, a secret.
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

/**
 * The stat fields that must all match for two descriptors to be the same file,
 * unchanged, between an admission check and the read that trusts it.
 * `token-store.ts` spells out the same rule.
 */
function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

function samePrivateFileState(left: BigIntStats, right: BigIntStats): boolean {
  return validPrivateDescriptor(left) && validPrivateDescriptor(right) && sameFileIdentity(left, right);
}

/** Read one stable private pathname: no symlink, one link, at most 1 MiB, UTF-8. */
export function readPrivateFileText(path: string, probe?: PrivateReadProbe): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new PrivateReadError("open", error);
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!validPrivateDescriptor(before)) throw new PrivateReadError("unsafe");
    if (before.size > BigInt(MAX_PRIVATE_FILE_BYTES)) throw new PrivateReadError("too_large");
    probe?.("opened", path);

    const admittedSize = Number(before.size);
    const bytes = Buffer.allocUnsafe(admittedSize);
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
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new PrivateReadError("encoding", error);
    }
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
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError(`${path} cannot be represented as JSON.`);
  const rendered = `${json}\n`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_PRIVATE_FILE_BYTES) {
    throw new RangeError(`${path} would exceed the 1 MiB private-file limit.`);
  }
  await writePrivateTextAtomic(path, rendered);
}

/** Replace `path` with `text`, private (0600), through a temporary file and one rename. */
export async function writePrivateTextAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
