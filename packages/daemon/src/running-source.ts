/**
 * What is running right now: the daemon's version, and — when it runs from a
 * source checkout rather than the packaged install — that checkout's root and
 * HEAD commit. Never throws: an unreadable checkout only means "unknown".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RunningSource {
  readonly version: string;
  readonly commit: string | null;
  readonly root: string | null;
}

const WORKSPACE_PACKAGE_NAME = "ghost-workspace";

function isWorkspaceRoot(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name === WORKSPACE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** The nearest ancestor of `startDir` that is this repository's checkout root (a clone or a worktree). */
export function findSourceRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git")) && isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The commit `HEAD` names in the checkout at `root`, or null if git cannot say. */
export function readHeadCommit(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** What is running: `version` plus the checkout behind it when there is one. */
export function resolveRunningSource(version: string, startDir: string): RunningSource {
  const root = findSourceRoot(startDir);
  return { version, root, commit: root === null ? null : readHeadCommit(root) };
}

/** Where the package installs the skills Ghost ships. */
export const PACKAGED_SKILLS = "/usr/lib/ghost/skills";

/** The skills Ghost ships: the checkout's `skills/`, else the package's. */
export function bundledSkillsDir(running: RunningSource): string {
  return running.root === null ? PACKAGED_SKILLS : join(running.root, "skills");
}
