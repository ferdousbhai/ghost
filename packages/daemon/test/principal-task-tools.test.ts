import { collectGhostExtension, type GhostToolResult } from "@ghost/extensions";
import { describe, expect, it, vi } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { GhostError } from "../src/ghosts.js";
import {
  createPrincipalTaskTools,
  PRINCIPAL_TASK_TOOL_NAMES,
  type PrincipalTaskServices,
} from "../src/principal-task-tools.js";
import type { TaskSummary, TaskView } from "../src/tasks.js";

const parent = conversationIdentity("pi", "conversation-1");
const sibling = conversationIdentity("pi", "conversation-2");

function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    version: 3,
    id: "task-11111111-1111-4111-8111-111111111111",
    parent,
    harness: "codex",
    agent: null,
    task: "Implement the parser.",
    root: "/repo",
    cwd: "/repo/packages/parser",
    workspace: {
      strategy: "git-worktree",
      state: "active",
      root: "/state/ghost/task-worktrees/repo/task-11111111-1111-4111-8111-111111111111",
      cwd: "/state/ghost/task-worktrees/repo/task-11111111-1111-4111-8111-111111111111/packages/parser",
      branch: "ghost/task-11111111-1111-4111-8111-111111111111",
      baseCommit: "a".repeat(40),
      headCommit: "a".repeat(40),
      review: "pending",
      notice: "Running in an isolated worktree.",
    },
    state: "running",
    createdAt: "2026-08-30T09:00:00.000Z",
    updatedAt: "2026-08-30T09:01:00.000Z",
    nativeSessionId: "native-1",
    result: null,
    resultTruncated: false,
    error: null,
    events: [{
      sequence: 1,
      at: "2026-08-30T09:00:00.000Z",
      type: "state",
      state: "running",
    }],
    eventsTruncated: false,
    ...overrides,
  };
}

function taskSummary(task: TaskView): TaskSummary {
  return {
    id: task.id,
    parent: task.parent,
    harness: task.harness,
    agent: task.agent,
    taskPreview: task.task,
    root: task.root,
    cwd: task.cwd,
    workspace: task.workspace,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    nativeSessionId: task.nativeSessionId,
    resultPreview: task.result,
    resultTruncated: task.resultTruncated,
    error: task.error,
  };
}

function fakeServices(tasks: TaskView[] = [taskView()]): {
  services: PrincipalTaskServices;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => tasks[0]!);
  const get = vi.fn(async (_ghostName: string, id: string) => {
    const found = tasks.find((task) => task.id === id);
    if (!found) throw new GhostError("task_not_found", "No such task.", 404);
    return found;
  });
  const send = vi.fn(async () => tasks[0]!);
  const cancel = vi.fn(async () => ({ outcome: "cancellation_requested" as const, task: tasks[0]! }));
  return {
    create,
    get,
    send,
    cancel,
    services: {
      tasks: {
        create,
        list: vi.fn(async () => ({ tasks: tasks.map(taskSummary), skipped: [] })),
        get,
        send,
        cancel,
      },
    },
  };
}

async function toolsFor(services: PrincipalTaskServices) {
  return collectGhostExtension(createPrincipalTaskTools({
    ghostName: "casper",
    parent,
    services,
  }));
}

async function call(
  services: PrincipalTaskServices,
  name: string,
  input: Record<string, unknown>,
): Promise<GhostToolResult<unknown>> {
  const extension = await toolsFor(services);
  const definition = extension.tools.get(name);
  if (!definition) throw new Error(`Missing principal tool ${name}`);
  return definition.execute("call-1", input as never, undefined, undefined, { cwd: "/repo" });
}

describe("principal task tools", () => {
  it("registers the fixed Pi-compatible task surface and returns an asynchronous handle", async () => {
    const fixture = fakeServices([taskView({ harness: "claude-code", agent: "reviewer" })]);
    const extension = await toolsFor(fixture.services);
    expect([...extension.tools]).toEqual(PRINCIPAL_TASK_TOOL_NAMES.map((name) => [
      name,
      expect.objectContaining({ name }),
    ]));
    expect(extension.tools.get("task")?.parameters).toMatchObject({
      type: "object",
      required: ["harness", "task"],
      additionalProperties: false,
      properties: {
        harness: expect.any(Object),
        agent: expect.any(Object),
        task: expect.any(Object),
        cwd: expect.any(Object),
      },
    });

    const result = await call(fixture.services, "task", {
      harness: "claude-code",
      agent: "reviewer",
      task: "Implement the parser.",
      cwd: "/repo/packages/parser",
    });

    expect(fixture.create).toHaveBeenCalledWith({
      ghostName: "casper",
      parent,
      harness: "claude-code",
      agent: "reviewer",
      task: "Implement the parser.",
      cwd: "/repo/packages/parser",
    });
    expect(result.details).toMatchObject({
      id: "task-11111111-1111-4111-8111-111111111111",
      state: "running",
      taskPreview: "Implement the parser.",
    });
    expect(result.details).not.toHaveProperty("parent");
    expect(result.details).not.toHaveProperty("task");
  });

  it("keeps list/get/send/cancel within one runtime-qualified parent", async () => {
    const own = taskView();
    const foreign = taskView({
      id: "task-22222222-2222-4222-8222-222222222222",
      parent: sibling,
      task: "A sibling's private assignment.",
    });
    const fixture = fakeServices([own, foreign]);

    const listed = await call(fixture.services, "task_list", { limit: 20 });
    expect(listed.details).toMatchObject({
      shown: 1,
      total: 1,
      tasks: [expect.objectContaining({ id: own.id })],
    });
    expect(JSON.stringify(listed.details)).not.toContain("private assignment");
    await expect(call(fixture.services, "task_get", { task_id: foreign.id }))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });

    await call(fixture.services, "task_send", { task_id: own.id, text: "Check edge cases." });
    expect(fixture.send).toHaveBeenCalledWith(
      "casper",
      own.id,
      "Check edge cases.",
      "principal",
    );
    await call(fixture.services, "task_cancel", { task_id: own.id });
    expect(fixture.cancel).toHaveBeenCalledWith("casper", own.id);
  });

});
