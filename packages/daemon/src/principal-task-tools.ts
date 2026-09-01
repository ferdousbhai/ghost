import {
  textResult,
  type GhostExtensionFactory,
  type GhostToolResult,
} from "@ghost/extensions";
import { Type } from "typebox";
import type { ConversationIdentity } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import type { NativeTaskScopeManager } from "./native-task-scope.js";
import {
  MAX_TASK_AGENT,
  MAX_TASK_TEXT,
  isValidTaskAgent,
  type TaskBindingReceipt,
  type TaskAdapter,
  type TaskController,
  type TaskRecord,
  type TaskStore,
} from "./tasks.js";

export const MAX_LISTED_TASKS = 20;
export const DEFAULT_LISTED_TASKS = 10;
const MAX_PROJECTED_EVENTS = 10;
const MAX_RESULT_PREVIEW = 32_768;
const MAX_TASK_PREVIEW = 240;

export const PRINCIPAL_TASK_TOOL_NAMES = [
  "task",
  "task_list",
  "task_get",
  "task_send",
  "task_cancel",
] as const;

export const PRINCIPAL_TASK_POLICY = [
  "# Coding delegation",
  "You remain the owner's principal Ghost and are responsible for the outcome. For coding work, you may delegate to a native Pi, Codex, or Claude Code worker; the worker owns coding mechanics while you choose the assignment, follow up, inspect the result, and report it to the owner.",
  "Start asynchronous work with task, retain its id, and use task_get or task_list later. Use task_send only to steer a running task and task_cancel only when cancellation is actually needed. Do not poll in a tight loop or claim work you have not inspected.",
  "Delegation is optional and does not replace your private memory, shared Obsidian notes and tasks, continuity, schedules, communications, browser, computer, CLI, recap, queue, titles, or other owner-agent responsibilities.",
].join("\n");

export interface PrincipalTaskContext {
  controller(): Promise<TaskController>;
  parent: ConversationIdentity;
  cwd: string;
  operation<T>(action: () => Promise<T>): Promise<T>;
  mintBinding(cwd: string | undefined, signal: AbortSignal): Promise<TaskBindingReceipt>;
}

export interface PrincipalTaskServices {
  adapters: ReadonlyMap<string, TaskAdapter>;
  ownership: NativeTaskScopeManager;
  createStore?(home: string): TaskStore;
}

function sameParent(left: ConversationIdentity, right: ConversationIdentity): boolean {
  return left.id === right.id
    && left.runtime === right.runtime
    && left.conversationId === right.conversationId;
}

function notFound(): GhostError {
  return new GhostError("task_not_found", "No such task belongs to this conversation.", 404);
}

function compact(value: string, maximum: number): { text: string; truncated: boolean } {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? { text: normalized, truncated: false }
    : { text: `${normalized.slice(0, maximum - 1)}…`, truncated: true };
}

export function taskProjection(
  record: TaskRecord,
  detailed: boolean,
): Record<string, unknown> {
  const task = compact(record.task, MAX_TASK_PREVIEW);
  const result = record.result === null
    ? null
    : record.result.slice(0, MAX_RESULT_PREVIEW);
  return {
    id: record.id,
    harness: record.harness,
    agent: record.agent,
    cwd: record.binding.cwd,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    taskPreview: task.text,
    taskTruncated: task.truncated,
    resultPreview: result,
    resultTruncated: record.resultTruncated
      || (record.result?.length ?? 0) > MAX_RESULT_PREVIEW,
    error: record.error,
    ...(detailed
      ? {
          events: record.events.slice(-MAX_PROJECTED_EVENTS),
          eventsTruncated: record.eventCursor.dropped > 0
            || record.events.length > MAX_PROJECTED_EVENTS,
        }
      : {}),
  };
}

async function ownTask(context: PrincipalTaskContext, id: string): Promise<TaskRecord> {
  try {
    const record = await (await context.controller()).get(id);
    if (!sameParent(record.parent, context.parent)) throw notFound();
    return record;
  } catch (error) {
    if (error instanceof GhostError
      && (error.code === "task_not_found" || error.code === "invalid_task_id")) {
      throw notFound();
    }
    throw error;
  }
}

function result<T>(value: T): GhostToolResult<T> {
  return textResult(JSON.stringify(value, null, 2), value);
}

async function toolAction<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof GhostError) throw error;
    throw new GhostError(
      "task_operation_failed",
      "The delegated task operation failed safely.",
      500,
    );
  }
}

/** Runtime-neutral principal controls bound to one qualified conversation. */
export function createPrincipalTaskTools(context: PrincipalTaskContext): GhostExtensionFactory {
  return (api) => {
    api.registerTool({
      name: "task",
      label: "Delegate coding task",
      description: "Start one durable asynchronous native coding worker and retain its task id.",
      parameters: Type.Object({
        harness: Type.Union([
          Type.Literal("pi"),
          Type.Literal("codex"),
          Type.Literal("claude-code"),
        ]),
        assignment: Type.String({ minLength: 1, maxLength: MAX_TASK_TEXT, pattern: "\\S" }),
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        agent: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_AGENT })),
      }, { additionalProperties: false }),
      async execute(_id, params, signal) {
        if (params.assignment.trim() === "") {
          throw new GhostError("invalid_task", "The task assignment is invalid.", 400);
        }
        if (params.agent !== undefined
          && (params.harness !== "claude-code" || !isValidTaskAgent(params.agent))) {
          throw new GhostError(
            "invalid_task_agent",
            "An agent may be selected only for a Claude Code task.",
            400,
          );
        }
        const admittedSignal = signal ?? new AbortController().signal;
        return toolAction(() => context.operation(async () => {
          const binding = await context.mintBinding(params.cwd, admittedSignal);
          admittedSignal.throwIfAborted();
          return result(taskProjection(await (await context.controller()).start({
            parent: context.parent,
            harness: params.harness,
            ...(params.agent === undefined ? {} : { agent: params.agent }),
            task: params.assignment,
            binding,
          }), true));
        }), admittedSignal);
      },
    });

    api.registerTool({
      name: "task_list",
      label: "List coding tasks",
      description: "List recent durable coding tasks owned by this conversation.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: MAX_LISTED_TASKS,
          default: DEFAULT_LISTED_TASKS,
        })),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        return toolAction(() => context.operation(async () => {
          const owned = (await (await context.controller()).list())
            .filter((record) => sameParent(record.parent, context.parent))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          const visible = owned.slice(0, params.limit ?? DEFAULT_LISTED_TASKS);
          return result({
            tasks: visible.map((record) => taskProjection(record, false)),
            shown: visible.length,
            total: owned.length,
          });
        }));
      },
    });

    api.registerTool({
      name: "task_get",
      label: "Inspect coding task",
      description: "Read bounded state, progress, and result for one task owned by this conversation.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1, maxLength: 64 }),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        return toolAction(() => context.operation(async () => result(taskProjection(
          await ownTask(context, params.task_id), true,
        ))));
      },
    });

    api.registerTool({
      name: "task_send",
      label: "Steer coding task",
      description: "Send additional guidance to one running task owned by this conversation.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1, maxLength: 64 }),
        message: Type.String({ minLength: 1, maxLength: MAX_TASK_TEXT, pattern: "\\S" }),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        if (params.message.trim() === "") {
          throw new GhostError("invalid_task", "The task follow-up is invalid.", 400);
        }
        return toolAction(() => context.operation(async () => {
          await ownTask(context, params.task_id);
          return result(taskProjection(
            await (await context.controller()).followUp(
              params.task_id,
              params.message,
              context.parent,
            ),
            true,
          ));
        }));
      },
    });

    api.registerTool({
      name: "task_cancel",
      label: "Cancel coding task",
      description: "Cancel one task owned by this conversation and wait for native quiescence.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1, maxLength: 64 }),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        return toolAction(() => context.operation(async () => {
          await ownTask(context, params.task_id);
          return result(taskProjection(
            await (await context.controller()).cancel(params.task_id, context.parent),
            true,
          ));
        }));
      },
    });
  };
}
