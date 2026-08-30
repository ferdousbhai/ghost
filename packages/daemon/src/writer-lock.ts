import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  fsyncPath,
  type PrivateFileIdentity,
  PrivateReadError,
  readPrivateFile,
} from "./private-file.js";

export interface WriterLockOwner {
  token: string;
  pid: number;
  startTicks: string;
}

export interface WriterLockLease {
  path: string;
  owner: WriterLockOwner;
}

export class WriterLockBusyError extends Error {
  constructor(
    readonly path: string,
    readonly ownerPid: number,
    readonly reentrant: boolean,
  ) {
    super(reentrant
      ? `${path} has a re-entrant writer in process ${ownerPid}.`
      : `${path} is locked by live process ${ownerPid}; retry.`);
    this.name = "WriterLockBusyError";
  }
}

export class WriterLockManualError extends Error {
  constructor(readonly path: string, detail: string, options?: ErrorOptions) {
    super(`${path} ${detail}; inspect and remove it manually only after verifying no writer is live.`, options);
    this.name = "WriterLockManualError";
  }
}

interface ReadOwner {
  owner: WriterLockOwner;
  identity: PrivateFileIdentity;
}

function processStartTicks(pid: number): string {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = raw.lastIndexOf(")");
  const fields = commandEnd < 0 ? [] : raw.slice(commandEnd + 1).trim().split(/\s+/u);
  const value = fields[19];
  if (!value || !/^\d+$/u.test(value)) throw new Error(`/proc/${pid}/stat has no process start identity.`);
  return value;
}

function parseOwner(path: string, raw: string): WriterLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new WriterLockManualError(path, "has malformed owner evidence", { cause });
  }
  const owner = parsed as Partial<WriterLockOwner> | null;
  if (typeof owner?.token !== "string"
    || owner.token.length === 0
    || typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.startTicks !== "string"
    || !/^\d+$/u.test(owner.startTicks)) {
    throw new WriterLockManualError(path, "has incomplete owner evidence");
  }
  return owner as WriterLockOwner;
}

function readOwner(path: string): ReadOwner | null {
  let source: ReturnType<typeof readPrivateFile>;
  try {
    source = readPrivateFile(path);
  } catch (cause) {
    if (cause instanceof PrivateReadError && cause.refusal === "open"
      && (cause.cause as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new WriterLockManualError(path, "has unsafe or changing owner evidence", { cause });
  }
  const stats = lstatSync(path, { bigint: true });
  if (stats.dev !== source.identity.device
    || stats.ino !== source.identity.inode
    || (stats.mode & 0o777n) !== 0o600n) {
    throw new WriterLockManualError(path, "must have mode 0600");
  }
  return { owner: parseOwner(path, source.text), identity: source.identity };
}

function ownerState(owner: WriterLockOwner): "live" | "dead" | "unknown" {
  try {
    return processStartTicks(owner.pid) === owner.startTicks ? "live" : "dead";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "dead";
    return "unknown";
  }
}

function restoreClaim(claim: string, path: string): void {
  try {
    const claimed = lstatSync(claim, { bigint: true });
    try {
      const current = lstatSync(path, { bigint: true });
      if (current.dev === claimed.dev && current.ino === claimed.ino && claimed.nlink === 2n) {
        unlinkSync(claim);
        fsyncPath(dirname(path));
        return;
      }
      throw new WriterLockManualError(claim, "cannot restore over another writer lock");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    try {
      // A hard link is the no-replace restore primitive. Recovery recognizes
      // and finishes the two-link state if this process stops between calls.
      linkSync(claim, path);
      unlinkSync(claim);
      fsyncPath(dirname(path));
    } catch (cause) {
      throw new WriterLockManualError(claim, "could not restore its live owner", { cause });
    }
  } catch (cause) {
    if (cause instanceof WriterLockManualError) throw cause;
    throw new WriterLockManualError(claim, "could not be reconciled", { cause });
  }
}

function recoverClaim(claim: string, path: string): void {
  // Finish a restore that stopped between link and unlink before the hardened
  // single-link reader examines the claim.
  try {
    const claimed = lstatSync(claim, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (claimed.dev === current.dev && claimed.ino === current.ino && claimed.nlink === 2n) {
      unlinkSync(claim);
      fsyncPath(dirname(path));
      return;
    }
  } catch {
    // The ordinary one-path states are handled below.
  }
  const admitted = readOwner(claim);
  if (!admitted) return;
  switch (ownerState(admitted.owner)) {
    case "dead":
      unlinkSync(claim);
      fsyncPath(dirname(path));
      return;
    case "live":
      restoreClaim(claim, path);
      return;
    case "unknown":
      throw new WriterLockManualError(claim, "has owner liveness that cannot be verified");
  }
}

function recoverClaims(path: string): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.reclaim-`;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const name of names.filter((entry) => entry.startsWith(prefix)).sort()) {
    recoverClaim(join(directory, name), path);
  }
}

function reclaimDeadOwner(path: string, admitted: ReadOwner): boolean {
  const claim = `${path}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, claim);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  const moved = readOwner(claim);
  if (!moved
    || moved.identity.device !== admitted.identity.device
    || moved.identity.inode !== admitted.identity.inode
    || moved.owner.token !== admitted.owner.token
    || ownerState(moved.owner) !== "dead") {
    restoreClaim(claim, path);
    return false;
  }
  unlinkSync(claim);
  fsyncPath(dirname(path));
  return true;
}

function tryCreate(path: string): WriterLockLease | null {
  const owner: WriterLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    startTicks: processStartTicks(process.pid),
  };
  try {
    writeFileSync(path, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return { path, owner };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw cause;
  }
}

export function acquireWriterLock(
  path: string,
  options: { waitMs: number; pollMs: number },
): WriterLockLease {
  const deadline = Date.now() + options.waitMs;
  const sleep = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const selfStart = processStartTicks(process.pid);
  for (;;) {
    recoverClaims(path);
    const lease = tryCreate(path);
    if (lease) return lease;
    let admitted: ReadOwner | null;
    try {
      admitted = readOwner(path);
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      Atomics.wait(sleep, 0, 0, options.pollMs);
      continue;
    }
    if (!admitted) continue;
    if (admitted.owner.pid === process.pid && admitted.owner.startTicks === selfStart) {
      throw new WriterLockBusyError(path, admitted.owner.pid, true);
    }
    const state = ownerState(admitted.owner);
    if (state === "dead") {
      reclaimDeadOwner(path, admitted);
      continue;
    }
    if (Date.now() >= deadline) {
      if (state === "unknown") {
        throw new WriterLockManualError(path, "has owner liveness that cannot be verified");
      }
      throw new WriterLockBusyError(path, admitted.owner.pid, false);
    }
    Atomics.wait(sleep, 0, 0, options.pollMs);
  }
}

export function releaseWriterLock(lease: WriterLockLease): void {
  const current = readOwner(lease.path);
  if (current?.owner.token !== lease.owner.token) {
    throw new WriterLockManualError(lease.path, "changed before its owner could release it");
  }
  unlinkSync(lease.path);
  fsyncPath(dirname(lease.path));
}
