/**
 * What is running right now: the daemon's version, and — when it runs from a
 * source checkout rather than the packaged install — that checkout's root and
 * HEAD commit. Read straight from the filesystem: no `git` subprocess, and no
 * throw, because an unreadable or missing `.git` only means "unknown".
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface RunningSource {
  readonly version: string;
  readonly commit: string | null;
  readonly root: string | null;
}

const WORKSPACE_PACKAGE_NAME = "ghost-workspace";
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `<dir>/.git` as a git directory: the directory itself for a normal clone, or
 * the directory a `gitdir:` file points at for a worktree. Null when neither.
 */
function gitDirectoryOf(dir: string): string | null {
  const dotGit = join(dir, ".git");
  if (isDirectory(dotGit)) return dotGit;
  const pointer = readTextOrNull(dotGit);
  if (pointer === null || !pointer.startsWith("gitdir:")) return null;
  const target = pointer.slice("gitdir:".length).trim();
  if (!target) return null;
  return isAbsolute(target) ? resolve(target) : resolve(dir, target);
}

function isWorkspaceRoot(dir: string): boolean {
  const text = readTextOrNull(join(dir, "package.json"));
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { name?: unknown }).name === WORKSPACE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** The nearest ancestor of `startDir` that is this repository's checkout root. */
export function findSourceRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (gitDirectoryOf(dir) !== null && isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A worktree's git directory holds its own HEAD but shares refs with the main
 * one, named by `commondir`.
 */
function commonGitDirectoryOf(gitDir: string): string {
  const pointer = readTextOrNull(join(gitDir, "commondir"))?.trim();
  if (!pointer) return gitDir;
  return isAbsolute(pointer) ? resolve(pointer) : resolve(gitDir, pointer);
}

function readPackedRef(commonDir: string, ref: string): string | null {
  const packed = readTextOrNull(join(commonDir, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const [id, name] = line.trim().split(/\s+/, 2);
    if (name === ref && id !== undefined && OBJECT_ID.test(id)) return id;
  }
  return null;
}

/** The commit `HEAD` names in the checkout at `root`, or null if it cannot be read. */
export function readHeadCommit(root: string): string | null {
  const gitDir = gitDirectoryOf(root);
  if (gitDir === null) return null;
  const head = readTextOrNull(join(gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (!head.startsWith("ref:")) return OBJECT_ID.test(head) ? head : null;
  const ref = head.slice("ref:".length).trim();
  if (!ref || ref.includes("..")) return null;
  const commonDir = commonGitDirectoryOf(gitDir);
  for (const dir of new Set([gitDir, commonDir])) {
    const loose = readTextOrNull(join(dir, ref))?.trim();
    if (loose && OBJECT_ID.test(loose)) return loose;
  }
  return readPackedRef(commonDir, ref);
}

/** What is running: `version` plus the checkout behind it when there is one. */
export function resolveRunningSource(version: string, startDir: string): RunningSource {
  const root = findSourceRoot(startDir);
  return { version, root, commit: root === null ? null : readHeadCommit(root) };
}
