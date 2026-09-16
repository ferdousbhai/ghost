/**
 * Mutations pair the path-keyed in-process queue with descriptor locks and
 * atomic rename so independently opened home handles share one publication
 * boundary for quotas and file contents.
 */
import {
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { GhostError } from "./errors.js";
import {
  descriptorPath,
  openConfinedDirectory,
  openConfinedFile,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
  withDescriptorLock,
} from "./linux-fs.js";
import type { CharacterFile } from "./types.js";

export const CHARACTER_FILENAME = "character.md";
export const MAX_CHARACTER_BODY_LENGTH = 20_000;

const fileMutationQueues = new Map<string, Promise<unknown>>();

async function withFileMutationQueue<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(path) ?? Promise.resolve();
  const running = previous.catch(() => undefined).then(mutate);
  fileMutationQueues.set(path, running);
  try {
    return await running;
  } finally {
    if (fileMutationQueues.get(path) === running) fileMutationQueues.delete(path);
  }
}

function _message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function _resolveWithin(base: string, relativePath: string, label: string): string {
  const full = resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new GhostError(
      "invalid_path",
      `${label} ${JSON.stringify(relativePath)} escapes the ghost home.`,
      { path: relativePath },
    );
  }
  return full;
}

async function readConfinedText(
  homeDir: string,
  path: string,
  label: string,
): Promise<string | null> {
  const source = await readConfinedTextFile(homeDir, path, label);
  return source?.text ?? null;
}

interface ReadTextFile {
  readonly text: string;
  readonly modified: Date;
}

function _sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

async function readConfinedTextFile(
  homeDir: string,
  path: string,
  label: string,
): Promise<ReadTextFile | null> {
  const file = await openConfinedFile(homeDir, path, label);
  if (!file) return null;
  try {
    const text = await file.readFile("utf8");
    const stats = await file.stat();
    return { text, modified: stats.mtime };
  } finally {
    await file.close();
  }
}

async function existingFileMode(
  directory: FileHandle,
  name: string,
  label: string,
): Promise<number | null> {
  let file: FileHandle;
  try {
    file = await openRegularFileNoFollow(
      descriptorPath(directory, name),
      label,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await file.stat();
    return stats.mode & 0o777;
  } finally {
    await file.close();
  }
}

async function atomicWriteFile(
  homeDir: string,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  // This opens the directory itself, so it also locks and closes it.
  const directory = await openConfinedDirectory(
    homeDir,
    dirname(path),
    { create: true, label: "Write path" },
  );
  const name = basename(path);
  const temporaryName = `.${name}.write-${process.pid}-${randomUUID()}`;
  let handle: FileHandle | undefined;
  const publish = async (): Promise<void> => {
    const existingMode = await existingFileMode(directory, name, "Write path");
    const mode = existingMode ?? 0o666;
    const temporary = descriptorPath(directory, temporaryName);
    const target = descriptorPath(directory, name);
    try {
      handle = await open(
        temporary,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        mode,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await directory.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
  try {
    await withDescriptorLock(directory, publish);
  } finally {
    await directory.close();
  }
}

async function _openOrCreateChildDirectory(
  parent: FileHandle,
  name: string,
  label: string,
): Promise<FileHandle> {
  const child = descriptorPath(parent, name);
  try {
    await mkdir(child);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openDirectoryNoFollow(child, label);
}

export class GhostHome {
  readonly dir: string;
  readonly name: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
  }

  get characterPath(): string {
    return join(this.dir, CHARACTER_FILENAME);
  }

  relative(absolutePath: string): string {
    return absolutePath.startsWith(this.dir + sep)
      ? absolutePath.slice(this.dir.length + 1).split(sep).join("/")
      : absolutePath;
  }

  async ensure(): Promise<void> {
    await withFileMutationQueue(this.dir, async () => {
      await mkdir(this.dir, { recursive: true });
      const directory = await openConfinedDirectory(this.dir, this.dir, {
        label: "Ghost home",
      });
      await directory.close();
    });
  }

  /**
   * `enforceLimit: false` is for the owner's editor: an oversize hand-edited
   * file must still load so it can be shortened, while every prompt-bound
   * reader keeps the default refusal.
   */
  async readCharacter(
    options?: { enforceLimit?: boolean },
  ): Promise<CharacterFile | null> {
    const body = await readConfinedText(this.dir, this.characterPath, "Character path");
    if (body === null) return null;
    if ((options?.enforceLimit ?? true) && body.length > MAX_CHARACTER_BODY_LENGTH) {
      throw new GhostError(
        "limit_exceeded",
        `${CHARACTER_FILENAME} may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
        + `it contains ${body.length}. Shorten the file before starting a session.`,
        { length: body.length, limit: MAX_CHARACTER_BODY_LENGTH },
      );
    }
    return { body };
  }

  /**
   * The owner's persona edits land here so an oversize body is refused at
   * write time, not discovered when the next cold session fails to start.
   */
  async writeCharacter(input: { body: string }): Promise<void> {
    if (input.body.length > MAX_CHARACTER_BODY_LENGTH) {
      throw new GhostError(
        "limit_exceeded",
        `${CHARACTER_FILENAME} may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
        + `that body is ${input.body.length}. Nothing was written.`,
        { length: input.body.length, limit: MAX_CHARACTER_BODY_LENGTH },
      );
    }
    await withFileMutationQueue(this.characterPath, async () => {
      await atomicWriteFile(this.dir, this.characterPath, input.body);
    });
  }
}

export function openGhostHome(dir: string): GhostHome {
  return new GhostHome(dir);
}
