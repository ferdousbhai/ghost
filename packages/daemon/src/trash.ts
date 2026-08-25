/**
 * Recoverable deletion for any user-owned path.
 *
 * The ordinary destination is the freedesktop home trash. When that trash is
 * on another filesystem, rename(2) cannot move the source there; in that case
 * the path moves into a hidden sibling trash (or the caller's explicit
 * fallback root). No code in this module copies and then unlinks data.
 */
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const pad2 = (value: number) => String(value).padStart(2, "0");

/** `20260824-153000` — local time, sortable, and safe in a file name. */
function trashStamp(now: Date): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
    + `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

/** The freedesktop home trash, resolved at call time for XDG-aware tests. */
export function homeTrashDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  return join(base, "Trash");
}

function encodeTrashInfoPath(path: string): string {
  return encodeURIComponent(path).replaceAll("%2F", "/");
}

function deletionDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

export interface TrashPathOptions {
  now?: Date;
  /** Same-filesystem recovery directory used only when the home trash is EXDEV. */
  fallbackRoot?: string;
  /** Test seams for XDG trash resolution. */
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface TrashPathResult {
  /** Absolute destination of the moved path. */
  trash: string;
  /** Whether the path landed in the freedesktop trash or the EXDEV fallback. */
  kind: "freedesktop" | "fallback";
}

/**
 * Move one file, directory, or symlink to recoverable trash.
 *
 * The `.trashinfo` file atomically claims a freedesktop trash name. A failed
 * move removes that claim. The EXDEV fallback is a same-filesystem rename into
 * a hidden sibling and therefore remains recoverable with an ordinary `mv`.
 */
export function trashPath(
  inputPath: string,
  options: TrashPathOptions = {},
): TrashPathResult {
  const source = resolve(inputPath);
  const now = options.now ?? new Date();
  const trashDir = homeTrashDir(options.env, options.home);
  const filesDir = join(trashDir, "files");
  const infoDir = join(trashDir, "info");
  for (const dir of [trashDir, filesDir, infoDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const baseName = basename(source);
  const info = `[Trash Info]\nPath=${encodeTrashInfoPath(source)}\n`
    + `DeletionDate=${deletionDate(now)}\n`;
  let trashName = baseName;
  let infoPath = join(infoDir, `${trashName}.trashinfo`);
  let target = join(filesDir, trashName);
  for (let suffix = 2; ; suffix += 1) {
    try {
      writeFileSync(infoPath, info, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      trashName = `${baseName}.${suffix}`;
      infoPath = join(infoDir, `${trashName}.trashinfo`);
      target = join(filesDir, trashName);
      continue;
    }
    if (!existsSync(target)) break;
    unlinkSync(infoPath);
    trashName = `${baseName}.${suffix}`;
    infoPath = join(infoDir, `${trashName}.trashinfo`);
    target = join(filesDir, trashName);
  }

  try {
    renameSync(source, target);
    return { trash: target, kind: "freedesktop" };
  } catch (error) {
    try {
      unlinkSync(infoPath);
    } catch {
      // The rename error is authoritative.
    }
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  const fallbackRoot = resolve(options.fallbackRoot ?? join(dirname(source), ".trash"));
  mkdirSync(fallbackRoot, { recursive: true, mode: 0o700 });
  const fallbackBase = join(fallbackRoot, `${baseName}-${trashStamp(now)}`);
  let fallbackTarget = fallbackBase;
  for (let suffix = 2; existsSync(fallbackTarget); suffix += 1) {
    fallbackTarget = `${fallbackBase}-${suffix}`;
  }
  renameSync(source, fallbackTarget);
  return { trash: fallbackTarget, kind: "fallback" };
}
