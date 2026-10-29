import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSourceRoot, readHeadCommit, replacedSinceStart, resolveRunningSource } from "../src/running-source.js";

/** Make `root` a git repository with one commit, and return that commit. */
function gitCommit(root: string): string {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
  if (!existsSync(join(root, ".git"))) {
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  }
  return git("rev-parse", "HEAD");
}

let scratch: string | null = null;

function tempRoot(): string {
  scratch = mkdtempSync(join(tmpdir(), "running-source-"));
  return scratch;
}

/** A checkout whose package.json marks it as this repository's workspace root. */
function workspace(root: string, name = "ghost-workspace"): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "9.9.9" }), "utf8");
  return root;
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("finding the running source root", () => {
  it("walks up to the workspace root that has a .git directory", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const deep = join(root, "packages", "daemon", "dist");
    mkdirSync(deep, { recursive: true });
    expect(findSourceRoot(deep)).toBe(root);
  });

  it("accepts a worktree, whose .git is a gitdir: file", () => {
    const base = tempRoot();
    const root = workspace(join(base, "worktree"));
    const gitDir = join(base, "main", ".git", "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    expect(findSourceRoot(root)).toBe(root);
  });

  it("refuses a git checkout that is some other workspace", () => {
    const base = tempRoot();
    const root = workspace(join(base, "elsewhere"), "not-ghost");
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(findSourceRoot(root)).toBeNull();
  });

  it("reports no root for a packaged install with no .git above it", () => {
    const base = tempRoot();
    const runtime = join(base, "usr", "lib", "ghost", "runtime");
    mkdirSync(runtime, { recursive: true });
    expect(findSourceRoot(runtime)).toBeNull();
  });
});

describe("reading the head commit", () => {
  it("asks git, and is null rather than a throw when git cannot say", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    expect(readHeadCommit(root)).toBeNull();
    expect(gitCommit(root)).toMatch(/^[0-9a-f]{40,64}$/);
    expect(readHeadCommit(root)).toBe(gitCommit(root));
    expect(readHeadCommit(join(base, "missing"))).toBeNull();
  });
});

describe("resolveRunningSource", () => {
  it("carries the version even when there is no checkout", () => {
    const base = tempRoot();
    expect(resolveRunningSource("1.2.3", base)).toEqual({
      version: "1.2.3",
      root: null,
      commit: null,
    });
  });

  it("reports the checkout root and its commit", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    const commit = gitCommit(root);
    expect(resolveRunningSource("0.0.1", join(root, "packages", "daemon"))).toEqual({
      version: "0.0.1",
      root,
      commit,
    });
  });
});

// A daemon outlives its install: what answers can be older than what is on
// disk, and `ghost status` has to be able to say so.
describe("replacedSinceStart", () => {
  it("sees an installed entry file rewritten after the daemon started", () => {
    const base = tempRoot();
    const entry = join(base, "ghostd.js");
    writeFileSync(entry, "old");
    const running = resolveRunningSource("1.0.0", base, entry);
    expect(running.entry).toBe(entry);
    // Started after the file was written: current.
    expect(replacedSinceStart({ ...running, startedAt: Date.now() + 60_000 })).toBe(false);
    // Written after the daemon started (its ctime, which an install cannot backdate): stale.
    expect(replacedSinceStart({ ...running, startedAt: Date.now() - 60_000 })).toBe(true);
    // An entry that is gone was replaced under another name.
    expect(replacedSinceStart({ ...running, entry: join(base, "missing.js") })).toBe(true);
  });

  it("sees a checkout moved to another commit, and knows nothing without an entry", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    gitCommit(root);
    const running = resolveRunningSource("0.0.1", join(root, "packages", "daemon"));
    expect(replacedSinceStart(running)).toBe(false);
    expect(replacedSinceStart({ ...running, commit: "0".repeat(40) })).toBe(true);
    // An unreadable checkout is unknown, not stale.
    expect(replacedSinceStart({ ...running, root: join(base, "nowhere") })).toBe(false);
    expect(replacedSinceStart({ version: "1", root: null, commit: null })).toBe(false);
  });
});
