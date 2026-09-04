import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSourceRoot, readHeadCommit, resolveRunningSource } from "../src/running-source.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

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
  it("follows HEAD to a loose ref", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/master\n", "utf8");
    writeFileSync(join(root, ".git", "refs", "heads", "master"), `${COMMIT}\n`, "utf8");
    expect(readHeadCommit(root)).toBe(COMMIT);
  });

  it("falls back to packed-refs when the loose ref is absent", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/master\n", "utf8");
    writeFileSync(
      join(root, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/other\n${COMMIT} refs/heads/master\n`,
      "utf8",
    );
    expect(readHeadCommit(root)).toBe(COMMIT);
  });

  it("reads a detached HEAD as the commit itself", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), `${COMMIT}\n`, "utf8");
    expect(readHeadCommit(root)).toBe(COMMIT);
  });

  it("reads a worktree's own HEAD against the refs of its common dir", () => {
    const base = tempRoot();
    const root = workspace(join(base, "worktree"));
    const commonDir = join(base, "main", ".git");
    const gitDir = join(commonDir, "worktrees", "wt");
    mkdirSync(join(commonDir, "refs", "heads"), { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    writeFileSync(join(gitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic\n", "utf8");
    writeFileSync(join(commonDir, "refs", "heads", "topic"), `${COMMIT}\n`, "utf8");
    expect(readHeadCommit(root)).toBe(COMMIT);
  });

  it("is null rather than a throw when nothing can be read", () => {
    const base = tempRoot();
    const root = workspace(join(base, "checkout"));
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(readHeadCommit(root)).toBeNull();
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
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/master\n", "utf8");
    writeFileSync(join(root, ".git", "refs", "heads", "master"), `${COMMIT}\n`, "utf8");
    expect(resolveRunningSource("0.0.1", join(root, "packages", "daemon"))).toEqual({
      version: "0.0.1",
      root,
      commit: COMMIT,
    });
  });
});
