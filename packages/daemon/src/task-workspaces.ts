/** Git worktree lifecycle for durable coding tasks. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { serializeByKey } from "./promise-chain.js";

export const TASK_WORKSPACE_STRATEGIES = ["git-worktree", "in-place"] as const;
export type TaskWorkspaceStrategy = typeof TASK_WORKSPACE_STRATEGIES[number];
export const TASK_WORKSPACE_STATES = ["preparing", "active", "removed", "preserved"] as const;
export type TaskWorkspaceState = typeof TASK_WORKSPACE_STATES[number];
export const TASK_REVIEW_STATES = [
  "pending",
  "ready",
  "no_changes",
  "needs_attention",
  "not_applicable",
] as const;
export type TaskReviewState = typeof TASK_REVIEW_STATES[number];
export type TaskWorkspaceOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export interface TaskWorkspaceView {
  strategy: TaskWorkspaceStrategy;
  state: TaskWorkspaceState;
  root: string;
  cwd: string;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  review: TaskReviewState;
  notice: string | null;
}

export interface TaskWorkspaceInput {
  taskId: string;
  sourceRoot: string;
  sourceCwd: string;
}

export interface TaskWorkspaceFinishInput extends TaskWorkspaceInput {
  workspace: TaskWorkspaceView;
  outcome: TaskWorkspaceOutcome;
}

export interface TaskWorkspaceLifecycle {
  plan(input: TaskWorkspaceInput): Promise<TaskWorkspaceView>;
  provision(input: TaskWorkspaceInput & { workspace: TaskWorkspaceView }): Promise<TaskWorkspaceView>;
  finish(input: TaskWorkspaceFinishInput): Promise<TaskWorkspaceView>;
  preserve(workspace: TaskWorkspaceView, notice: string): TaskWorkspaceView;
}

export class TaskWorkspaceError extends Error {
  override readonly name = "TaskWorkspaceError";

  constructor(
    readonly code: string,
    message: string,
    readonly workspace?: TaskWorkspaceView,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<GitResult>;

export interface GitTaskWorkspaceOptions {
  ownerHome?: string;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  runGit?: GitRunner;
}

interface RepositoryPlan {
  commonDir: string;
}

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 1_048_576;
export const MAX_TASK_WORKSPACE_NOTICE_LENGTH = 1_000;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function boundedNotice(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.slice(0, MAX_TASK_WORKSPACE_NOTICE_LENGTH);
}

/** Parse the cross-package workspace view and enforce its state invariants. */
export function parseTaskWorkspace(
  value: unknown,
  input: TaskWorkspaceInput,
): TaskWorkspaceView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const workspace = value as Partial<TaskWorkspaceView>;
  if (!TASK_WORKSPACE_STRATEGIES.includes(workspace.strategy as TaskWorkspaceStrategy)
    || !TASK_WORKSPACE_STATES.includes(workspace.state as TaskWorkspaceState)
    || !TASK_REVIEW_STATES.includes(workspace.review as TaskReviewState)
    || typeof workspace.root !== "string"
    || !isAbsolute(workspace.root)
    || workspace.root.length > MAX_WORKSPACE_PATH_LENGTH
    || typeof workspace.cwd !== "string"
    || !isAbsolute(workspace.cwd)
    || workspace.cwd.length > MAX_WORKSPACE_PATH_LENGTH
    || !isWithin(workspace.root, workspace.cwd)
    || (workspace.notice !== null
      && (typeof workspace.notice !== "string"
        || workspace.notice.length > MAX_TASK_WORKSPACE_NOTICE_LENGTH))) {
    return null;
  }
  const strategy = workspace.strategy as TaskWorkspaceStrategy;
  const state = workspace.state as TaskWorkspaceState;
  const review = workspace.review as TaskReviewState;

  if (strategy === "in-place") {
    if (workspace.root !== input.sourceRoot
      || workspace.cwd !== input.sourceCwd
      || workspace.branch !== null
      || workspace.baseCommit !== null
      || workspace.headCommit !== null
      || review !== "not_applicable"
      || (state !== "active" && state !== "preserved")) {
      return null;
    }
  } else {
    if (workspace.branch !== `ghost/${input.taskId}`
      || typeof workspace.baseCommit !== "string"
      || !GIT_OBJECT_ID_PATTERN.test(workspace.baseCommit)
      || (workspace.headCommit !== null
        && (typeof workspace.headCommit !== "string"
          || !GIT_OBJECT_ID_PATTERN.test(workspace.headCommit)))) {
      return null;
    }
    if (state === "preparing"
      && (review !== "pending" || workspace.headCommit !== null)) return null;
    if (state === "active" && review !== "pending") return null;
    if (state === "preserved" && review !== "needs_attention") return null;
    if (state === "removed"
      && (workspace.headCommit === null
        || !["ready", "no_changes", "needs_attention"].includes(review))) return null;
  }

  return {
    strategy,
    state,
    root: workspace.root,
    cwd: workspace.cwd,
    branch: workspace.branch ?? null,
    baseCommit: workspace.baseCommit ?? null,
    headCommit: workspace.headCommit ?? null,
    review,
    notice: workspace.notice ?? null,
  };
}

export function legacyInPlaceTaskWorkspace(
  input: TaskWorkspaceInput,
): TaskWorkspaceView {
  return {
    strategy: "in-place",
    state: "preserved",
    root: input.sourceRoot,
    cwd: input.sourceCwd,
    branch: null,
    baseCommit: null,
    headCommit: null,
    review: "not_applicable",
    notice: "Legacy task record; no isolated workspace or review artifact was managed.",
  };
}

function defaultWorkspaceRoot(
  ownerHome: string,
  env: NodeJS.ProcessEnv,
): string {
  const configured = env.XDG_STATE_HOME?.trim();
  const stateHome = configured && isAbsolute(configured)
    ? configured
    : join(ownerHome, ".local", "state");
  return join(stateHome, "ghost", "task-worktrees");
}

export function defaultTaskWorkspaceRoot(
  ownerHome: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return defaultWorkspaceRoot(resolve(ownerHome), env);
}

async function defaultGitRunner(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<GitResult> {
  const result = await execFileAsync("git", [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TaskWorkspaceError(
      "task_workspace_invalid",
      "The task workspace directory is unsafe.",
    );
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function inPlaceWorkspace(input: TaskWorkspaceInput, notice: string): TaskWorkspaceView {
  return {
    strategy: "in-place",
    state: "active",
    root: input.sourceRoot,
    cwd: input.sourceCwd,
    branch: null,
    baseCommit: null,
    headCommit: null,
    review: "not_applicable",
    notice: boundedNotice(notice),
  };
}

function preservedWorkspace(workspace: TaskWorkspaceView, notice: string): TaskWorkspaceView {
  if (workspace.state === "removed") return workspace;
  return {
    ...workspace,
    state: "preserved",
    review: workspace.strategy === "git-worktree" ? "needs_attention" : "not_applicable",
    notice: boundedNotice(notice),
  };
}

/** Minimal fallback for embedders that do not opt into machine Git worktrees. */
export class InPlaceTaskWorkspaceLifecycle implements TaskWorkspaceLifecycle {
  async plan(input: TaskWorkspaceInput): Promise<TaskWorkspaceView> {
    return inPlaceWorkspace(input, "This task is running in place; no Git review artifact is managed.");
  }

  async provision(input: TaskWorkspaceInput & { workspace: TaskWorkspaceView }): Promise<TaskWorkspaceView> {
    return input.workspace;
  }

  async finish(input: TaskWorkspaceFinishInput): Promise<TaskWorkspaceView> {
    return this.preserve(input.workspace, "The in-place task has settled; its project files remain where it ran.");
  }

  preserve(workspace: TaskWorkspaceView, notice: string): TaskWorkspaceView {
    return preservedWorkspace(workspace, notice);
  }
}

/** Owner-machine worktree manager; it never contacts a remote. */
export class GitTaskWorkspaceManager implements TaskWorkspaceLifecycle {
  private readonly env: NodeJS.ProcessEnv;
  private readonly workspaceRoot: string;
  private readonly runGit: GitRunner;
  private readonly repositoryPlans = new Map<string, RepositoryPlan>();
  private readonly repositoryMutations = new Map<string, Promise<unknown>>();
  private readonly taskFinishes = new Map<string, Promise<TaskWorkspaceView>>();

  constructor(options: GitTaskWorkspaceOptions = {}) {
    const ownerHome = options.ownerHome ?? homedir();
    if (!isAbsolute(ownerHome)) throw new TypeError("ownerHome must be absolute");
    this.env = {
      ...(options.env ?? process.env),
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    };
    const workspaceRoot = options.workspaceRoot
      ?? defaultWorkspaceRoot(resolve(ownerHome), this.env);
    if (!isAbsolute(workspaceRoot)) throw new TypeError("workspaceRoot must be absolute");
    this.workspaceRoot = resolve(workspaceRoot);
    this.runGit = options.runGit ?? defaultGitRunner;
  }

  async plan(input: TaskWorkspaceInput): Promise<TaskWorkspaceView> {
    this.assertInput(input);
    let topLevel: string;
    try {
      topLevel = await this.gitLine(input.sourceRoot, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      if (!pathExists(join(input.sourceRoot, ".git"))) {
        return inPlaceWorkspace(
          input,
          "This project is not a Git repository, so the harness task is running in place and no review branch will be created.",
        );
      }
      throw new TaskWorkspaceError(
        "task_workspace_unavailable",
        "Git could not inspect this project's repository metadata.",
        undefined,
        { cause: error },
      );
    }

    const canonicalTopLevel = await realpath(topLevel);
    if (canonicalTopLevel !== input.sourceRoot) {
      throw new TaskWorkspaceError(
        "task_project_root_required",
        "Bind the Git repository root before delegating; a nested project root cannot be isolated safely.",
      );
    }
    if (await this.gitLine(input.sourceRoot, ["rev-parse", "--is-bare-repository"]) !== "false") {
      throw new TaskWorkspaceError(
        "task_workspace_unavailable",
        "A coding task requires a non-bare Git worktree.",
      );
    }
    await this.assertClean(input.sourceRoot);
    const baseCommit = await this.head(input.sourceRoot, "task_project_uncommitted");
    const commonPath = await this.gitLine(input.sourceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonDir = await realpath(commonPath);
    const repositoryHash = createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
    const root = join(this.workspaceRoot, repositoryHash, input.taskId);
    if (isWithin(input.sourceRoot, root) || isWithin(root, input.sourceRoot)) {
      throw new TaskWorkspaceError(
        "task_workspace_unavailable",
        "The configured task-worktree directory must be outside the source repository.",
      );
    }
    const sourceRelativeCwd = relative(input.sourceRoot, input.sourceCwd);
    const workspace: TaskWorkspaceView = {
      strategy: "git-worktree",
      state: "preparing",
      root,
      cwd: sourceRelativeCwd ? join(root, sourceRelativeCwd) : root,
      branch: `ghost/${input.taskId}`,
      baseCommit,
      headCommit: null,
      review: "pending",
      notice: boundedNotice(
        `Preparing an isolated Git worktree at ${root}; Ghost will keep a local review branch and will not push or open a pull request.`,
      ),
    };
    this.repositoryPlans.set(input.taskId, { commonDir });
    return workspace;
  }

  async provision(
    input: TaskWorkspaceInput & { workspace: TaskWorkspaceView },
  ): Promise<TaskWorkspaceView> {
    const { workspace } = input;
    if (workspace.strategy === "in-place") return workspace;
    const plan = this.repositoryPlans.get(input.taskId);
    if (!plan || !workspace.branch || !workspace.baseCommit) {
      throw new TaskWorkspaceError(
        "task_workspace_invalid",
        "The Git task workspace plan is incomplete.",
        preservedWorkspace(workspace, "The incomplete task workspace plan was preserved for inspection."),
      );
    }
    const branchName = workspace.branch;
    const baseCommit = workspace.baseCommit;
    const provisioning = serializeByKey<TaskWorkspaceView>(
      this.repositoryMutations,
      plan.commonDir,
      async () => {
        try {
          await this.assertClean(input.sourceRoot);
          const currentHead = await this.head(input.sourceRoot, "task_project_uncommitted");
          if (currentHead !== baseCommit) {
            throw new TaskWorkspaceError(
              "task_project_changed",
              "The project HEAD changed while the task workspace was being prepared; retry from the new commit.",
            );
          }
          if (pathExists(workspace.root)) {
            throw new TaskWorkspaceError(
              "task_workspace_exists",
              "The planned task workspace path already exists.",
            );
          }
          ensureDirectory(dirname(workspace.root));
          await this.git(input.sourceRoot, [
            "worktree",
            "add",
            "-b",
            branchName,
            workspace.root,
            baseCommit,
          ]);
          const [headCommit, branch] = await Promise.all([
            this.head(workspace.root, "task_workspace_invalid"),
            this.gitLine(workspace.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          ]);
          if (headCommit !== baseCommit || branch !== branchName) {
            throw new TaskWorkspaceError(
              "task_workspace_invalid",
              "Git created a task workspace at an unexpected branch or commit.",
            );
          }
          return {
            ...workspace,
            state: "active",
            headCommit,
            notice: boundedNotice(
              `The coding worker is running in isolated worktree ${workspace.root} on local branch ${workspace.branch}. Ghost will not push or open a pull request.`,
            ),
          };
        } catch (error) {
          if (error instanceof TaskWorkspaceError && error.workspace) throw error;
          throw new TaskWorkspaceError(
            error instanceof TaskWorkspaceError ? error.code : "task_workspace_prepare_failed",
            error instanceof TaskWorkspaceError
              ? error.message
              : "The isolated Git task workspace could not be prepared.",
            preservedWorkspace(
              workspace,
              `Workspace preparation did not complete safely. Inspect ${workspace.root} and ${workspace.branch} before removing either artifact.`,
            ),
            { cause: error },
          );
        }
      },
    );
    return provisioning.finally(() => {
      this.repositoryPlans.delete(input.taskId);
    });
  }

  finish(input: TaskWorkspaceFinishInput): Promise<TaskWorkspaceView> {
    const active = this.taskFinishes.get(input.taskId);
    if (active) return active;
    const finishing = this.finishFresh(input).finally(() => {
      if (this.taskFinishes.get(input.taskId) === finishing) {
        this.taskFinishes.delete(input.taskId);
      }
      this.repositoryPlans.delete(input.taskId);
    });
    this.taskFinishes.set(input.taskId, finishing);
    return finishing;
  }

  preserve(workspace: TaskWorkspaceView, notice: string): TaskWorkspaceView {
    return preservedWorkspace(workspace, notice);
  }

  private async finishFresh(input: TaskWorkspaceFinishInput): Promise<TaskWorkspaceView> {
    const { workspace } = input;
    if (workspace.state === "removed" || workspace.state === "preserved") return workspace;
    if (workspace.strategy === "in-place") {
      return this.preserve(
        workspace,
        "The in-place task has settled; its project files remain where it ran.",
      );
    }
    if (input.outcome === "interrupted") {
      return this.preserve(
        workspace,
        `The daemon interrupted this task; inspect preserved worktree ${workspace.root} before taking any Git action.`,
      );
    }
    const plan = this.repositoryPlans.get(input.taskId);
    let commonDir = plan?.commonDir;
    if (!commonDir) {
      try {
        commonDir = await realpath(await this.gitLine(workspace.root, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]));
      } catch {
        return this.preserve(
          workspace,
          `Git could not re-open preserved task workspace ${workspace.root}; inspect it manually.`,
        );
      }
    }
    return serializeByKey(this.repositoryMutations, commonDir, async () => {
      try {
        if (!workspace.branch || !workspace.baseCommit) {
          return this.preserve(workspace, "The task workspace is missing its branch or base commit.");
        }
        const branch = await this.gitLine(workspace.root, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]);
        if (branch !== workspace.branch) {
          return this.preserve(
            workspace,
            `The worker left task worktree ${workspace.root} on ${branch}; Ghost did not stage, commit, or remove it.`,
          );
        }

        let dirty = await this.isDirty(workspace.root);
        if (dirty && input.outcome !== "completed") {
          return this.preserve(
            workspace,
            `The ${input.outcome} task left changes in ${workspace.root}; Ghost did not auto-commit them.`,
          );
        }
        if (dirty) {
          await this.git(workspace.root, ["add", "--all", "--", "."]);
          await this.git(workspace.root, ["commit", "-m", `Ghost task ${input.taskId}`]);
          dirty = await this.isDirty(workspace.root);
          if (dirty) {
            return this.preserve(
              workspace,
              `Git hooks left task worktree ${workspace.root} dirty after commit; inspect it manually.`,
            );
          }
        }

        const headCommit = await this.head(workspace.root, "task_workspace_finalize_failed");
        await this.git(input.sourceRoot, ["worktree", "remove", workspace.root]);
        if (headCommit === workspace.baseCommit) {
          try {
            await this.git(input.sourceRoot, [
              "update-ref",
              "-d",
              `refs/heads/${workspace.branch}`,
              workspace.baseCommit,
            ]);
          } catch {
            return {
              ...workspace,
              state: "removed",
              headCommit,
              review: "needs_attention",
              notice: boundedNotice(
                `The empty worktree was removed, but local branch ${workspace.branch} could not be deleted safely.`,
              ),
            };
          }
          return {
            ...workspace,
            state: "removed",
            headCommit,
            review: "no_changes",
            notice: "The task produced no Git changes; its clean worktree and unchanged local branch were removed.",
          };
        }
        return {
          ...workspace,
          state: "removed",
          headCommit,
          review: "ready",
          notice: boundedNotice(
            `Local review branch ${workspace.branch} is ready at ${headCommit}. Ghost removed the clean worktree and did not push or open a pull request.`,
          ),
        };
      } catch {
        return this.preserve(
          workspace,
          `Ghost could not safely finalize task worktree ${workspace.root}; its files and branch were left for inspection.`,
        );
      }
    });
  }

  private assertInput(input: TaskWorkspaceInput): void {
    if (!isAbsolute(input.sourceRoot)
      || !isAbsolute(input.sourceCwd)
      || !isWithin(input.sourceRoot, input.sourceCwd)) {
      throw new TaskWorkspaceError(
        "task_workspace_invalid",
        "The task workspace source must be an absolute cwd inside its project root.",
      );
    }
  }

  private async git(cwd: string, args: readonly string[]): Promise<GitResult> {
    return this.runGit(args, { cwd, env: this.env });
  }

  private async gitLine(cwd: string, args: readonly string[]): Promise<string> {
    const value = (await this.git(cwd, args)).stdout.trim();
    if (!value || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
      throw new TaskWorkspaceError(
        "task_workspace_invalid",
        "Git returned malformed task workspace metadata.",
      );
    }
    return value;
  }

  private async assertClean(root: string): Promise<void> {
    if (await this.isDirty(root)) {
      throw new TaskWorkspaceError(
        "task_project_dirty",
        "Commit, stash, or remove every tracked and untracked source-checkout change before delegating a coding task.",
      );
    }
  }

  private async isDirty(root: string): Promise<boolean> {
    const status = await this.git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    return status.stdout.length > 0;
  }

  private async head(root: string, code: string): Promise<string> {
    let value: string;
    try {
      value = await this.gitLine(root, ["rev-parse", "--verify", "HEAD"]);
    } catch (error) {
      throw new TaskWorkspaceError(
        code,
        code === "task_project_uncommitted"
          ? "Commit the project before delegating; an isolated task needs a pinned HEAD."
          : "Git could not resolve the task workspace HEAD.",
        undefined,
        { cause: error },
      );
    }
    if (!GIT_OBJECT_ID_PATTERN.test(value)) {
      throw new TaskWorkspaceError(code, "Git returned an invalid task workspace commit id.");
    }
    return value;
  }
}
