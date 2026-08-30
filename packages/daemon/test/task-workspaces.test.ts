import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitTaskWorkspaceManager,
  TaskWorkspaceError,
} from "../src/task-workspaces.js";

const TASK_ID = "task-12345678-1234-4123-8123-123456789abc";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

describe("GitTaskWorkspaceManager", () => {
  let temporaryRoot: string;
  let sourceRoot: string;
  let sourceCwd: string;
  let manager: GitTaskWorkspaceManager;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "ghost-task-workspace-test-"));
    sourceRoot = join(temporaryRoot, "source");
    sourceCwd = join(sourceRoot, "packages", "app");
    mkdirSync(sourceCwd, { recursive: true });
    git(sourceRoot, ["init", "--initial-branch=main"]);
    git(sourceRoot, ["config", "user.name", "Ghost Test"]);
    git(sourceRoot, ["config", "user.email", "ghost-test@example.invalid"]);
    writeFileSync(join(sourceCwd, "README.md"), "source\n");
    git(sourceRoot, ["add", "--all"]);
    git(sourceRoot, ["commit", "-m", "base"]);
    manager = new GitTaskWorkspaceManager({
      ownerHome: join(temporaryRoot, "home"),
      workspaceRoot: join(temporaryRoot, "worktrees"),
    });
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  async function prepare() {
    const input = { taskId: TASK_ID, sourceRoot, sourceCwd };
    const planned = await manager.plan(input);
    const active = await manager.provision({ ...input, workspace: planned });
    return { input, planned, active };
  }

  it("runs from the source-relative cwd and leaves a local review branch after success", async () => {
    const { input, planned, active } = await prepare();
    expect(planned).toMatchObject({
      strategy: "git-worktree",
      state: "preparing",
      branch: `ghost/${TASK_ID}`,
      review: "pending",
    });
    expect(active.cwd).toBe(join(active.root, "packages", "app"));
    expect(readFileSync(join(active.cwd, "README.md"), "utf8")).toBe("source\n");

    writeFileSync(join(active.cwd, "README.md"), "worker\n");
    writeFileSync(join(active.cwd, "new.txt"), "new\n");
    const finished = await manager.finish({ ...input, workspace: active, outcome: "completed" });

    expect(finished).toMatchObject({ state: "removed", review: "ready" });
    expect(finished.headCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(existsSync(active.root)).toBe(false);
    expect(readFileSync(join(sourceCwd, "README.md"), "utf8")).toBe("source\n");
    expect(git(sourceRoot, ["show", `${active.branch}:packages/app/README.md`])).toBe("worker");
    expect(git(sourceRoot, ["show", `${active.branch}:packages/app/new.txt`])).toBe("new");
    expect(git(sourceRoot, ["log", "-1", "--format=%s", active.branch!])).toBe(`Ghost task ${TASK_ID}`);
  });

  it.each(["tracked", "untracked"] as const)(
    "rejects a dirty %s source checkout before creating durable artifacts",
    async (kind) => {
      if (kind === "tracked") writeFileSync(join(sourceCwd, "README.md"), "dirty\n");
      else writeFileSync(join(sourceCwd, "untracked.txt"), "dirty\n");

      await expect(manager.plan({ taskId: TASK_ID, sourceRoot, sourceCwd }))
        .rejects.toMatchObject({ code: "task_project_dirty" });
      expect(existsSync(join(temporaryRoot, "worktrees"))).toBe(false);
      expect(git(sourceRoot, ["branch", "--list", `ghost/${TASK_ID}`])).toBe("");
    },
  );

  it("rejects a bound root nested inside a larger repository", async () => {
    await expect(manager.plan({
      taskId: TASK_ID,
      sourceRoot: join(sourceRoot, "packages"),
      sourceCwd,
    })).rejects.toMatchObject({ code: "task_project_root_required" });
  });

  it("runs a genuine non-Git project in place with no review artifact", async () => {
    const root = join(temporaryRoot, "plain");
    mkdirSync(root);
    const workspace = await manager.plan({
      taskId: TASK_ID,
      sourceRoot: root,
      sourceCwd: root,
    });

    expect(workspace).toMatchObject({
      strategy: "in-place",
      state: "active",
      root,
      cwd: root,
      branch: null,
      review: "not_applicable",
    });
  });

  it("removes both clean worktree and unchanged task branch when there are no changes", async () => {
    const { input, active } = await prepare();
    const finished = await manager.finish({ ...input, workspace: active, outcome: "completed" });

    expect(finished).toMatchObject({ state: "removed", review: "no_changes" });
    expect(existsSync(active.root)).toBe(false);
    expect(git(sourceRoot, ["branch", "--list", active.branch!])).toBe("");
  });

  it("preserves dirty failed work without staging or committing it", async () => {
    const { input, active } = await prepare();
    writeFileSync(join(active.cwd, "README.md"), "unfinished\n");
    const finished = await manager.finish({ ...input, workspace: active, outcome: "failed" });

    expect(finished).toMatchObject({ state: "preserved", review: "needs_attention" });
    expect(existsSync(active.root)).toBe(true);
    expect(git(active.root, ["status", "--porcelain"])).toContain("README.md");
    expect(git(active.root, ["rev-parse", "HEAD"])).toBe(active.baseCommit);
  });

  it("retains clean commits made by a failed worker as a reviewable branch", async () => {
    const { input, active } = await prepare();
    writeFileSync(join(active.cwd, "README.md"), "committed by worker\n");
    git(active.root, ["add", "--all"]);
    git(active.root, ["commit", "-m", "worker checkpoint"]);
    const finished = await manager.finish({ ...input, workspace: active, outcome: "failed" });

    expect(finished).toMatchObject({ state: "removed", review: "ready" });
    expect(existsSync(active.root)).toBe(false);
    expect(git(sourceRoot, ["log", "-1", "--format=%s", active.branch!])).toBe("worker checkpoint");
  });

  it("fails visibly when the source checkout changes between planning and provisioning", async () => {
    const input = { taskId: TASK_ID, sourceRoot, sourceCwd };
    const planned = await manager.plan(input);
    writeFileSync(join(sourceCwd, "race.txt"), "raced\n");

    let failure: unknown;
    try {
      await manager.provision({ ...input, workspace: planned });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TaskWorkspaceError);
    expect(failure).toMatchObject({
      code: "task_project_dirty",
      workspace: { state: "preserved", review: "needs_attention" },
    });
    expect(existsSync(planned.root)).toBe(false);
    expect(git(sourceRoot, ["branch", "--list", planned.branch!])).toBe("");
  });

  it("preserves an active worktree on daemon interruption without Git mutation", async () => {
    const { input, active } = await prepare();
    const finished = await manager.finish({ ...input, workspace: active, outcome: "interrupted" });

    expect(finished).toMatchObject({ state: "preserved", review: "needs_attention" });
    expect(existsSync(active.root)).toBe(true);
    expect(git(active.root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(active.branch);
  });
});
