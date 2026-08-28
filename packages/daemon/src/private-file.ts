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
  readFileSync,
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

export function readPrivateFileText(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new PrivateReadError("open", error);
  }
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new PrivateReadError("unsafe");
    if (before.size > MAX_PRIVATE_FILE_BYTES) throw new PrivateReadError("too_large");
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.dev !== after.dev || current.ino !== after.ino
      || current.isSymbolicLink() || current.nlink !== 1) {
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
