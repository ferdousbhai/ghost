/**
 * Confined reads and durable metadata writes for ghost-home files that hold, or
 * once held, a secret.
 *
 * One implementation, because it is one rule: a private file is read through a
 * descriptor whose identity cannot change under the reader, capped, and decoded
 * fatally. Callers translate a refusal into their own typed error rather than
 * restating the rule.
 */
import { createHash, randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
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

export interface PrivateFileIdentity {
  device: bigint;
  inode: bigint;
}

export interface PrivateFileRead {
  text: string;
  identity: PrivateFileIdentity;
}

export interface PinnedPrivateFileRead extends PrivateFileRead {
  /** SHA-256 of the exact bytes admitted through this descriptor. */
  sha256: string;
  /** Release the descriptor that keeps this exact inode alive. Idempotent. */
  release(): void;
}

export class PrivateWriteConflictError extends Error {
  readonly code = "private_write_conflict";

  constructor(readonly path: string) {
    super(`${path} changed before its private migration could be committed; retry it.`);
    this.name = "PrivateWriteConflictError";
  }
}

function validPrivateDescriptor(stats: BigIntStats, links = 1n): boolean {
  return stats.isFile() && stats.nlink === links && stats.size >= 0n;
}

function samePrivateFileState(left: BigIntStats, right: BigIntStats, links = 1n): boolean {
  return validPrivateDescriptor(left, links)
    && validPrivateDescriptor(right, links)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

/** Read one stable private pathname while retaining its admitted descriptor. */
export function readPrivateFilePinned(
  path: string,
  options: { links?: bigint; probe?: PrivateReadProbe } = {},
): PinnedPrivateFileRead {
  const links = options.links ?? 1n;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new PrivateReadError("open", error);
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!validPrivateDescriptor(before, links)) throw new PrivateReadError("unsafe");
    if (before.size > BigInt(MAX_PRIVATE_FILE_BYTES)) throw new PrivateReadError("too_large");
    options.probe?.("opened", path);

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
    options.probe?.("read", path);

    const after = fstatSync(fd, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch (error) {
      throw new PrivateReadError("changed", error);
    }
    if (offset !== admittedSize
      || grew
      || !samePrivateFileState(before, after, links)
      || !samePrivateFileState(after, current, links)) {
      throw new PrivateReadError("changed");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new PrivateReadError("encoding", error);
    }
    let released = false;
    return {
      text,
      identity: { device: after.dev, inode: after.ino },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      release: () => {
        if (released) return;
        released = true;
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readPrivateFile(path: string, probe?: PrivateReadProbe): PrivateFileRead {
  const source = readPrivateFilePinned(path, { ...(probe ? { probe } : {}) });
  try {
    return { text: source.text, identity: source.identity };
  } finally {
    source.release();
  }
}

export function readPrivateFileText(path: string, probe?: PrivateReadProbe): string {
  return readPrivateFile(path, probe).text;
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

/** Render one complete private JSON file and admit its exact published bytes. */
export function renderPrivateJson(path: string, value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError(`${path} cannot be represented as JSON.`);
  const rendered = `${json}\n`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_PRIVATE_FILE_BYTES) {
    throw new RangeError(`${path} would exceed the 1 MiB private-file limit.`);
  }
  return rendered;
}

function samePrivateIdentity(stats: BigIntStats, identity: PrivateFileIdentity): boolean {
  return validPrivateDescriptor(stats)
    && stats.dev === identity.device
    && stats.ino === identity.inode;
}

function restoreCasClaim(claim: string, path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    try {
      linkSync(claim, path);
      unlinkSync(claim);
      fsyncPath(dirname(path));
    } catch {
      // Preserve the claim when the public path cannot safely be restored.
    }
  }
}

const PRIVATE_CAS_CLAIM_SUFFIX = ".ghost-migration-cas";
const PRIVATE_CAS_NEXT_SUFFIX = ".ghost-migration-next";

function recoverPrivateCasCandidate(path: string): void {
  const candidate = `${path}${PRIVATE_CAS_NEXT_SUFFIX}`;
  let stats: BigIntStats;
  try {
    stats = lstatSync(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let safe = stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n;
  if (!safe && stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 2n) {
    try {
      const published = lstatSync(path, { bigint: true });
      safe = published.dev === stats.dev && published.ino === stats.ino;
    } catch {
      safe = false;
    }
  }
  if (!safe) throw new PrivateWriteConflictError(path);
  unlinkSync(candidate);
  fsyncPath(dirname(path));
}

/** Finish the last durable private migration publication before rereading it. */
export function recoverPrivateJsonAtomicCas(path: string): void {
  const claim = `${path}${PRIVATE_CAS_CLAIM_SUFFIX}`;
  let claimed: BigIntStats;
  try {
    claimed = lstatSync(claim, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      recoverPrivateCasCandidate(path);
      return;
    }
    throw error;
  }
  if (claimed.isFile() && !claimed.isSymbolicLink() && claimed.nlink === 2n) {
    let published: BigIntStats | undefined;
    try {
      published = lstatSync(path, { bigint: true });
    } catch {
      // The ordinary invalid/recovery states below remain fail-closed.
    }
    if (published?.isFile()
      && !published.isSymbolicLink()
      && published.nlink === 2n
      && published.dev === claimed.dev
      && published.ino === claimed.ino) {
      // Restore stopped after link(claim, path), before unlink(claim). The
      // public path already owns the exact source inode; finish that operation.
      unlinkSync(claim);
      fsyncPath(dirname(path));
      recoverPrivateCasCandidate(path);
      return;
    }
  }
  if (!validPrivateDescriptor(claimed)) {
    throw new PrivateWriteConflictError(path);
  }
  if (missingPrivatePath(path)) restoreCasClaim(claim, path);
  else {
    unlinkSync(claim);
    fsyncPath(dirname(path));
  }
  recoverPrivateCasCandidate(path);
}

/** Publish private JSON only if the admitted source identity still owns `path`. */
export function writePrivateJsonAtomicCas(
  path: string,
  value: unknown,
  expected: PrivateFileIdentity | null,
): void {
  recoverPrivateJsonAtomicCas(path);
  const rendered = renderPrivateJson(path, value);
  const temporary = `${path}${PRIVATE_CAS_NEXT_SUFFIX}`;
  const claim = `${path}${PRIVATE_CAS_CLAIM_SUFFIX}`;
  try {
    writeFileSync(temporary, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    fsyncPath(temporary);
    if (expected === null) {
      try {
        linkSync(temporary, path);
      } catch {
        throw new PrivateWriteConflictError(path);
      }
      unlinkSync(temporary);
      fsyncPath(dirname(path));
      return;
    }

    try {
      renameSync(path, claim);
    } catch {
      throw new PrivateWriteConflictError(path);
    }
    fsyncPath(dirname(path));
    let claimed: BigIntStats;
    try {
      claimed = lstatSync(claim, { bigint: true });
    } catch {
      throw new PrivateWriteConflictError(path);
    }
    if (!samePrivateIdentity(claimed, expected)) {
      restoreCasClaim(claim, path);
      throw new PrivateWriteConflictError(path);
    }
    try {
      linkSync(temporary, path);
    } catch {
      if (missingPrivatePath(path)) restoreCasClaim(claim, path);
      else rmSync(claim, { force: true });
      throw new PrivateWriteConflictError(path);
    }
    fsyncPath(dirname(path));
    unlinkSync(temporary);
    unlinkSync(claim);
    fsyncPath(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function missingPrivatePath(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Replace `path` with `value` as pretty JSON, private (0600), through a
 * per-writer temporary file and one rename, so a reader never sees a torn
 * file and two concurrent writers never share a temporary name.
 */
export async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  const rendered = renderPrivateJson(path, value);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    fsyncPath(temporary);
    await rename(temporary, path);
    fsyncPath(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
