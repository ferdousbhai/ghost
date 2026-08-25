/** Linux descriptor-relative filesystem primitives used at ghost trust boundaries. */
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { GhostError } from "./errors.js";

const DIRECTORY_FLAGS = constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW;
const REGULAR_FILE_FLAGS = constants.O_RDONLY
  | constants.O_NONBLOCK
  | constants.O_NOFOLLOW;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCK_RETRY_MS = 10;

const libc = dlopen("libc.so.6", {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

function invalidPath(label: string, path: string, reason: string): GhostError {
  return new GhostError(
    "invalid_path",
    `${label} ${JSON.stringify(path)} ${reason}.`,
    { path },
  );
}

function pathSegments(homeDir: string, targetDir: string, label: string): string[] {
  const home = resolve(homeDir);
  const target = resolve(targetDir);
  const child = relative(home, target);
  if (child === ".." || child.startsWith(`..${sep}`)) {
    throw invalidPath(label, targetDir, "escapes the ghost home");
  }
  return child.split(sep).filter(Boolean);
}

function noFollowError(error: unknown, label: string, path: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") throw invalidPath(label, path, "is a symbolic link");
  if (code === "ENOTDIR") {
    throw invalidPath(label, path, "contains a non-directory component");
  }
  throw error;
}

export function descriptorPath(directory: FileHandle, name?: string): string {
  const base = `/proc/self/fd/${directory.fd}`;
  return name === undefined ? base : `${base}/${name}`;
}

export async function openDirectoryNoFollow(
  path: string,
  label: string,
): Promise<FileHandle> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, DIRECTORY_FLAGS);
    const stats = await directory.stat();
    if (!stats.isDirectory()) {
      throw invalidPath(label, path, "is not a directory");
    }
    return directory;
  } catch (error) {
    await directory?.close().catch(() => undefined);
    return noFollowError(error, label, path);
  }
}

/** Open a regular file without following links or blocking on special files. */
export async function openRegularFileNoFollow(
  path: string,
  label: string,
): Promise<FileHandle> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, REGULAR_FILE_FLAGS);
    if (!(await file.stat()).isFile()) {
      throw invalidPath(label, path, "is not a regular file");
    }
    return file;
  } catch (error) {
    await file?.close().catch(() => undefined);
    return noFollowError(error, label, path);
  }
}

/**
 * Resolve every child directory relative to an already-open parent descriptor.
 * A rename or symlink swap of a pathname cannot redirect a later component.
 */
export async function openConfinedDirectory(
  homeDir: string,
  targetDir: string,
  options: { create?: boolean; label: string },
): Promise<FileHandle> {
  if (options.create) await mkdir(homeDir, { recursive: true });
  let current = await openDirectoryNoFollow(homeDir, options.label);
  try {
    for (const segment of pathSegments(homeDir, targetDir, options.label)) {
      const child = descriptorPath(current, segment);
      if (options.create) {
        try {
          await mkdir(child);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const next = await openDirectoryNoFollow(child, options.label);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

export async function openConfinedFile(
  homeDir: string,
  path: string,
  label: string,
): Promise<FileHandle | null> {
  let parent: FileHandle;
  try {
    parent = await openConfinedDirectory(homeDir, dirname(path), { label });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    try {
      return await openRegularFileNoFollow(
        descriptorPath(parent, basename(path)),
        label,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  } finally {
    await parent.close();
  }
}

export async function withDescriptorLock<T>(
  descriptor: FileHandle,
  action: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now();
  while (libc.symbols.flock(descriptor.fd, LOCK_EX | LOCK_NB) !== 0) {
    if (Date.now() - started >= timeoutMs) {
      throw new GhostError(
        "conflict",
        `Timed out waiting ${timeoutMs}ms for a filesystem mutation lock.`,
        { timeoutMs },
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
  }
  let actionFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  const unlockFailed = libc.symbols.flock(descriptor.fd, LOCK_UN) !== 0;
  if (actionFailed) throw actionError;
  if (unlockFailed) throw new Error("Could not release a filesystem mutation lock.");
  return result as T;
}
