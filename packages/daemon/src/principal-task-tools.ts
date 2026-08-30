import {
  textResult,
  type GhostExtensionFactory,
  type GhostToolResult,
} from "@ghost/extensions";
import { Type } from "typebox";
import type { ConversationIdentity } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import {
  MAX_TASK_PROMPT_LENGTH,
  type CancelTaskResult,
  type TaskListView,
  type TaskManager,
  type TaskSummary,
  type TaskView,
} from "./tasks.js";
import type { WorkerCatalog, WorkerCatalogView } from "./worker-catalog.js";

const MAX_LISTED_TASKS = 20;
const DEFAULT_LISTED_TASKS = 10;
const MAX_TOOL_EVENTS = 10;
const MAX_TOOL_EVENT_TEXT_LENGTH = 2_000;
const MAX_TOOL_RESULT_LENGTH = 32_000;
const MAX_TOOL_TASK_PREVIEW_LENGTH = 160;

export const PRINCIPAL_TASK_TOOL_NAMES = [
  "worker_status",
  "task",
  "task_list",
  "task_get",
  "task_send",
  "task_cancel",
] as const;

export const GHOST_CODING_ORCHESTRATION_POLICY = [
  "# Coding delegation",
  "You are the owner's Ghost: remain responsible for the outcome, but delegate project coding and code review to a coding worker instead of acting as the coding agent yourself.",
  "Use worker_status before choosing among claude-code, codex, and pi-worker when availability or current limits matter. Start work with task { agent, task, cwd? }; give the worker a complete assignment and the correct absolute project cwd. The task is durable and asynchronous: retain its id, use task_get or task_list on a later interaction, and use task_send or task_cancel when needed. Do not poll in a tight loop or claim completion you have not read.",
  "For a clean committed Git project, task runs in an isolated worktree and returns a local review branch when changes are ready. Report that artifact to the owner; do not claim it was pushed, opened as a pull request, or merged unless a separate explicit action did so. A non-Git project runs in place.",
  "Your own Bash, edit, and write tools remain available for general computer use and for maintaining your character, memory, Documents, and other Ghost-owned files.",
].join("\n");

export interface PrincipalTaskServices {
  tasks: Pick<
    TaskManager,
    "create" | "list" | "get" | "send" | "cancel"
  >;
  workers: Pick<WorkerCatalog, "list">;
}

export interface PrincipalTaskToolsOptions {
  ghostName: string;
  parent: ConversationIdentity;
  services: PrincipalTaskServices;
}

interface TaskProjection {
  id: string;
  agent: TaskView["agent"];
  taskPreview: string;
  root: string;
  cwd: string;
  workspace: TaskView["workspace"];
  state: TaskView["state"];
  createdAt: string;
  updatedAt: string;
  nativeSessionId: string | null;
  resultPreview: string | null;
  resultTruncated: boolean;
  error: TaskView["error"];
  events: TaskView["events"];
  eventsTruncated: boolean;
}

interface TaskSummaryProjection {
  id: string;
  agent: TaskSummary["agent"];
  taskPreview: string;
  root: string;
  cwd: string;
  workspace: TaskSummary["workspace"];
  state: TaskSummary["state"];
  createdAt: string;
  updatedAt: string;
  nativeSessionId: string | null;
  resultPreview: string | null;
  resultTruncated: boolean;
  error: TaskSummary["error"];
}

function truncate(value: string, length: number): { text: string; truncated: boolean } {
  const truncated = value.length > length;
  return {
    text: truncated ? value.slice(0, length) : value,
    truncated,
  };
}

function compactPreview(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_TOOL_TASK_PREVIEW_LENGTH) return compact;
  return `${compact.slice(0, MAX_TOOL_TASK_PREVIEW_LENGTH - 1)}…`;
}

function taskProjection(task: TaskView): TaskProjection {
  const result = task.result === null ? null : truncate(task.result, MAX_TOOL_RESULT_LENGTH);
  return {
    id: task.id,
    agent: task.agent,
    taskPreview: compactPreview(task.task),
    root: task.root,
    cwd: task.cwd,
    workspace: task.workspace,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    nativeSessionId: task.nativeSessionId,
    resultPreview: result?.text ?? null,
    resultTruncated: task.resultTruncated || result?.truncated === true,
    error: task.error,
    events: task.events.slice(-MAX_TOOL_EVENTS).map((event) => {
      if (event.text === undefined) return event;
      const bounded = truncate(event.text, MAX_TOOL_EVENT_TEXT_LENGTH);
      return {
        ...event,
        text: bounded.text,
        textTruncated: event.textTruncated === true || bounded.truncated,
      };
    }),
    eventsTruncated: task.eventsTruncated || task.events.length > MAX_TOOL_EVENTS,
  };
}

function taskSummaryProjection(task: TaskSummary): TaskSummaryProjection {
  return {
    id: task.id,
    agent: task.agent,
    taskPreview: compactPreview(task.taskPreview),
    root: task.root,
    cwd: task.cwd,
    workspace: task.workspace,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    nativeSessionId: task.nativeSessionId,
    resultPreview: task.resultPreview,
    resultTruncated: task.resultTruncated,
    error: task.error,
  };
}

function sameParent(left: ConversationIdentity, right: ConversationIdentity): boolean {
  return left.id === right.id
    && left.runtime === right.runtime
    && left.conversationId === right.conversationId;
}

function taskNotFound(): GhostError {
  return new GhostError("task_not_found", "No such task belongs to this conversation.", 404);
}

async function requireOwnTask(options: PrincipalTaskToolsOptions, taskId: string): Promise<TaskView> {
  let task: TaskView;
  try {
    task = await options.services.tasks.get(options.ghostName, taskId);
  } catch (error) {
    if (error instanceof GhostError && error.code === "task_not_found") throw taskNotFound();
    throw error;
  }
  if (!sameParent(task.parent, options.parent)) throw taskNotFound();
  return task;
}

function result<T>(value: T): GhostToolResult<T> {
  return textResult(JSON.stringify(value, null, 2), value);
}

function workerProjection(view: WorkerCatalogView): object {
  return {
    workers: view.workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      kind: worker.kind,
      nativeConfiguration: worker.nativeConfiguration,
      installation: worker.installation,
      authentication: worker.authentication,
      reason: worker.reason,
      usage: worker.usage === null
        ? null
        : {
            state: worker.usage.state,
            updatedAt: worker.usage.updatedAt,
            stale: worker.usage.stale,
            tier: worker.usage.tier,
            status: worker.usage.status,
            help: worker.usage.help,
            limits: worker.usage.limits.map((limit) => ({
              label: limit.label,
              remainingFraction: Math.max(0, Math.min(1, 1 - limit.usedFraction)),
              resetsAt: limit.resetsAt,
            })),
            today: worker.usage.today,
          },
    })),
  };
}

function listProjection(listing: TaskListView, parent: ConversationIdentity, limit: number): object {
  const tasks = listing.tasks.filter((task) => sameParent(task.parent, parent));
  const visibleTasks = tasks.slice(0, limit);
  return {
    tasks: visibleTasks.map(taskSummaryProjection),
    shown: visibleTasks.length,
    total: tasks.length,
    skipped: listing.skipped.length,
  };
}

function cancellationProjection(cancelled: CancelTaskResult): object {
  return {
    outcome: cancelled.outcome,
    task: taskProjection(cancelled.task),
  };
}

/** Runtime-neutral task controls bound to one Ghost principal conversation. */
export function createPrincipalTaskTools(options: PrincipalTaskToolsOptions): GhostExtensionFactory {
  return (api) => {
    api.registerTool({
      name: "worker_status",
      label: "Worker status",
      description: "Check installed coding workers, authentication, and Omarchy usage windows before delegating.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(workerProjection(await options.services.workers.list())),
    });

    api.registerTool({
      name: "task",
      label: "Delegate task",
      description: "Start one durable asynchronous coding task. Use worker_status first when worker availability or limits matter; retain the returned task id for later task_get, task_send, or task_cancel calls.",
      parameters: Type.Object({
        agent: Type.Union([
          Type.Literal("claude-code"),
          Type.Literal("codex"),
          Type.Literal("pi-worker"),
        ], { description: "Coding worker responsible for this task" }),
        task: Type.String({
          minLength: 1,
          maxLength: MAX_TASK_PROMPT_LENGTH,
          description: "Complete assignment for the coding worker",
        }),
        cwd: Type.Optional(Type.String({
          minLength: 1,
          description: "Absolute working directory inside the conversation's trusted project",
        })),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        const task = await options.services.tasks.create({
          ghostName: options.ghostName,
          parent: options.parent,
          agent: params.agent,
          task: params.task,
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        });
        return result(taskProjection(task));
      },
    });

    api.registerTool({
      name: "task_list",
      label: "List tasks",
      description: "List recent durable coding tasks attributed to this Ghost conversation.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: MAX_LISTED_TASKS,
          default: DEFAULT_LISTED_TASKS,
        })),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => result(listProjection(
        await options.services.tasks.list(options.ghostName),
        options.parent,
        params.limit ?? DEFAULT_LISTED_TASKS,
      )),
    });

    api.registerTool({
      name: "task_get",
      label: "Inspect task",
      description: "Read bounded state, recent progress, and result for one task from this Ghost conversation.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => result(taskProjection(
        await requireOwnTask(options, params.task_id),
      )),
    });

    api.registerTool({
      name: "task_send",
      label: "Steer task",
      description: "Send additional principal guidance to a running task from this Ghost conversation.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1, maxLength: MAX_TASK_PROMPT_LENGTH }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        await requireOwnTask(options, params.task_id);
        return result(taskProjection(await options.services.tasks.send(
          options.ghostName,
          params.task_id,
          params.text,
          "principal",
        )));
      },
    });

    api.registerTool({
      name: "task_cancel",
      label: "Cancel task",
      description: "Request cancellation of one task from this Ghost conversation.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        await requireOwnTask(options, params.task_id);
        return result(cancellationProjection(await options.services.tasks.cancel(
          options.ghostName,
          params.task_id,
        )));
      },
    });
  };
}
