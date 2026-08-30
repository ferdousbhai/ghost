import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LOCK_FILE_FLAGS =
  constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;

const libc = dlopen("libc.so.6", {
  __errno_location: {
    args: [],
    returns: FFIType.ptr,
  },
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

function flock(descriptor: number, operation: number): number {
  if (libc.symbols.flock(descriptor, operation) === 0) return 0;
  const errno = libc.symbols.__errno_location();
  return errno === null ? -1 : read.i32(errno);
}

export class HomeReservationBusyError extends Error {
  readonly code = "home_reservation_busy";

  constructor(readonly ghostsRoot: string) {
    super(`Another ghostd or login is using ${ghostsRoot}.`);
    this.name = "HomeReservationBusyError";
  }
}

export interface HomeReservation {
  readonly ghostsRoot: string;
  close(): Promise<void>;
}

interface CanonicalRoot {
  path: string;
  lockParent: string;
}

async function canonicalRoot(path: string): Promise<CanonicalRoot> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  // Creating only the containing directory makes the lock location stable
  // before and after GhostRegistry creates the root itself.
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    const existing = await realpath(absolute);
    return { path: existing, lockParent: dirname(existing) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existingParent = await realpath(parent);
    return {
      path: join(existingParent, basename(absolute)),
      lockParent: existingParent,
    };
  }
}

async function openPrivateLockDirectory(parent: string): Promise<FileHandle> {
  const path = join(parent, ".ghost-home-gates");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const directory = await open(path, DIRECTORY_FLAGS);
  try {
    const stats = await directory.stat();
    if (!stats.isDirectory()) throw new Error(`${path} is not a directory.`);
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error(`${path} is not owned by the current user.`);
    }
    await directory.chmod(0o700);
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

async function openLockFile(directory: FileHandle, canonicalPath: string): Promise<FileHandle> {
  const key = createHash("sha256").update(canonicalPath).digest("hex");
  const path = `/proc/self/fd/${directory.fd}/${key}.lock`;
  const file = await open(path, LOCK_FILE_FLAGS, 0o600);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`Home reservation ${path} is not a regular file.`);
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error(`Home reservation ${path} is not owned by the current user.`);
    }
    await file.chmod(0o600);
    return file;
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Acquire a non-waiting, crash-recoverable reservation for one ghosts root.
 * The empty lock inode persists so a pathname replacement cannot split users
 * across two inodes; the kernel releases the reservation when the fd closes or
 * its process exits.
 */
export async function acquireHomeReservation(ghostsRoot: string): Promise<HomeReservation> {
  const canonical = await canonicalRoot(ghostsRoot);
  const directory = await openPrivateLockDirectory(canonical.lockParent);
  let file: FileHandle | undefined;
  try {
    file = await openLockFile(directory, canonical.path);
  } finally {
    await directory.close().catch(() => undefined);
  }

  const lockError = flock(file.fd, LOCK_EX | LOCK_NB);
  if (lockError !== 0) {
    await file.close().catch(() => undefined);
    if (lockError === EWOULDBLOCK) throw new HomeReservationBusyError(canonical.path);
    throw new Error(`Could not acquire the ghost-home reservation (errno ${lockError}).`);
  }

  let closed = false;
  return {
    ghostsRoot: canonical.path,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const unlockError = flock(file.fd, LOCK_UN);
      let closeError: unknown;
      try {
        await file.close();
      } catch (error) {
        closeError = error;
      }
      if (closeError !== undefined) throw closeError;
      if (unlockError !== 0) {
        throw new Error(`Could not release the ghost-home reservation (errno ${unlockError}).`);
      }
    },
  };
}
