import { collectGhostExtension, type GhostToolResult } from "@ghost/extensions";
import { describe, expect, it, vi } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import {
  createPrincipalTaskTools,
  PRINCIPAL_TASK_TOOL_NAMES,
  type PrincipalTaskContext,
} from "../src/principal-task-tools.js";
import type {
  TaskBindingReceipt,
  TaskController,
  TaskRecord,
} from "../src/tasks.js";

const parent = conversationIdentity("pi", "same-raw-id");
const foreignParent = conversationIdentity("claude-code", "same-raw-id");
const binding: TaskBindingReceipt = {
  version: 1,
  root: "/trusted/project",
  rootIdentity: "1:2",
  cwd: "/trusted/project/pkg",
  cwdIdentity: "1:3",
  generation: 4,
};

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const at = "2026-08-31T12:00:00.000Z";
  return {
    version: 1,
    id: "task-11111111-1111-4111-8111-111111111111",
    generation: 1,
    parent,
    harness: "codex",
    agent: null,
    task: "Implement the parser without exposing PRIVATE_ASSIGNMENT_TAIL.",
    binding,
    state: "running",
    createdAt: at,
    updatedAt: at,
    events: [{ sequence: 1, at, code: "started", message: "Native worker started." }],
    eventCursor: { nextSequence: 2, dropped: 0 },
    result: null,
    resultTruncated: false,
    error: null,
    ...overrides,
  };
}

function fixture(records: TaskRecord[] = [record()]) {
  const start = vi.fn(async (input) => record({
    harness: input.harness,
    agent: input.agent ?? null,
    task: input.task,
    binding: input.binding,
  }));
  const get = vi.fn(async (id: string) => {
    const found = records.find((candidate) => candidate.id === id);
    if (!found) throw new Error("missing raw storage path");
    return found;
  });
  const list = vi.fn(async () => records);
  const followUp = vi.fn(async (id: string) => get(id));
  const cancel = vi.fn(async (id: string) => get(id));
  const mintBinding = vi.fn(async () => binding);
  return {
    start,
    get,
    list,
    followUp,
    cancel,
    mintBinding,
    context: {
      parent,
      cwd: binding.cwd,
      mintBinding,
      controller: Promise.resolve(
        { start, get, list, followUp, cancel } as unknown as TaskController,
      ),
    } satisfies PrincipalTaskContext,
  };
}

async function tools(context: PrincipalTaskContext) {
  return collectGhostExtension(createPrincipalTaskTools(context));
}

async function call(
  context: PrincipalTaskContext,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GhostToolResult<unknown>> {
  const extension = await tools(context);
  const tool = extension.tools.get(name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.execute("call-1", input as never, signal, undefined, { cwd: binding.cwd });
}

describe("principal task tools", () => {
  it("registers the exact surface and delegates with the minted trusted receipt", async () => {
    const current = fixture();
    const extension = await tools(current.context);
    expect([...extension.tools.keys()]).toEqual(PRINCIPAL_TASK_TOOL_NAMES);
    expect(extension.tools.get("task")?.parameters).toMatchObject({
      type: "object",
      required: ["harness", "assignment"],
      additionalProperties: false,
    });
    const abort = new AbortController();
    const output = await call(current.context, "task", {
      harness: "claude-code",
      assignment: "Review the parser.",
      cwd: "/trusted/project/pkg",
      agent: "owner-reviewer",
    }, abort.signal);
    expect(current.mintBinding).toHaveBeenCalledWith(
      "/trusted/project/pkg",
      abort.signal,
    );
    expect(current.start).toHaveBeenCalledWith({
      parent,
      harness: "claude-code",
      agent: "owner-reviewer",
      task: "Review the parser.",
      binding,
    });
    expect(output.details).toMatchObject({
      harness: "claude-code",
      agent: "owner-reviewer",
      state: "running",
    });
    expect(output.details).not.toHaveProperty("binding");
  });

  it("isolates the same raw conversation id across runtimes with a generic 404", async () => {
    const own = record();
    const foreign = record({
      id: "task-22222222-2222-4222-8222-222222222222",
      parent: foreignParent,
      task: "FOREIGN_PRIVATE_ASSIGNMENT",
    });
    const current = fixture([own, foreign]);
    const listing = await call(current.context, "task_list", { limit: 20 });
    expect(listing.details).toMatchObject({ shown: 1, total: 1 });
    expect(JSON.stringify(listing.details)).not.toContain("FOREIGN_PRIVATE_ASSIGNMENT");
    await expect(call(current.context, "task_get", { task_id: foreign.id }))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });
    expect(JSON.stringify(await call(current.context, "task_get", { task_id: own.id })))
      .not.toContain("rootIdentity");
  });

  it("restricts opaque agents to Claude and keeps controller failures generic", async () => {
    const current = fixture();
    await expect(call(current.context, "task", {
      harness: "codex",
      assignment: " \n\t ",
    })).rejects.toMatchObject({ code: "invalid_task" });
    await expect(call(current.context, "task", {
      harness: "pi",
      assignment: "Work.",
      agent: "not-for-pi",
    })).rejects.toMatchObject({ code: "invalid_task_agent" });
    expect(current.mintBinding).not.toHaveBeenCalled();
    expect(current.start).not.toHaveBeenCalled();
    current.list.mockRejectedValueOnce(new Error("PRIVATE_RAW_STORE_FAILURE"));
    await expect(call(current.context, "task_list", {})).rejects.toMatchObject({
      code: "task_operation_failed",
      message: "The delegated task operation failed safely.",
    });
  });

  it("does not admit a task after its creating tool call is aborted", async () => {
    const current = fixture();
    const abort = new AbortController();
    const reason = new Error("owner stopped the tool");
    abort.abort(reason);
    await expect(call(current.context, "task", {
      harness: "codex",
      assignment: "Do not start.",
    }, abort.signal)).rejects.toBe(reason);
    expect(current.start).not.toHaveBeenCalled();
  });

  it("checks ownership before steering or cancellation", async () => {
    const foreign = record({ parent: foreignParent });
    const current = fixture([foreign]);
    await expect(call(current.context, "task_send", {
      task_id: foreign.id,
      message: "Change direction.",
    })).rejects.toMatchObject({ code: "task_not_found" });
    await expect(call(current.context, "task_cancel", { task_id: foreign.id }))
      .rejects.toMatchObject({ code: "task_not_found" });
    expect(current.followUp).not.toHaveBeenCalled();
    expect(current.cancel).not.toHaveBeenCalled();
  });

  it("rejects a blank follow-up before touching its durable task", async () => {
    const current = fixture();
    await expect(call(current.context, "task_send", {
      task_id: record().id,
      message: " \n\t ",
    })).rejects.toMatchObject({ code: "invalid_task" });
    expect(current.get).not.toHaveBeenCalled();
    expect(current.followUp).not.toHaveBeenCalled();
  });
});
