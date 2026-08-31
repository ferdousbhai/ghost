import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { TaskController, TaskStore, type TaskAdapter, type TaskAdapterHandle, type TaskRecord } from "../src/tasks.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function eventually(store: TaskStore, id: string, state: TaskRecord["state"]): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await store.read(id);
    if (record.state === state) return record;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`task ${id} did not reach ${state}`);
}

async function fixture(adapter: TaskAdapter) {
  const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
  await chmod(home, 0o700);
  const store = new TaskStore(home);
  const controller = new TaskController(store, new Map([["native", adapter]]));
  await controller.initialize();
  return { home, store, controller };
}

const parent = conversationIdentity("pi", "parent");

describe("durable tasks", () => {
  it("persists exact cwd privately and completes without Git machinery", async () => {
    const done = deferred<string>();
    let received: unknown;
    const { store, controller } = await fixture({
      async start(input) { received = input; return { result: done.promise, async followUp() {}, async cancel() {} }; },
    });
    const task = await controller.start({ parent, harness: "native", task: "inspect", cwd: "/projects/exact" });
    await eventually(store, task.id, "running");
    expect(received).toMatchObject({ cwd: "/projects/exact", task: "inspect" });
    done.resolve("finished");
    const completed = await eventually(store, task.id, "completed");
    expect(completed.result).toBe("finished");
    expect((await stat(store.path(task.id))).mode & 0o777).toBe(0o600);
    expect(await readFile(new URL("../src/tasks.ts", import.meta.url), "utf8")).not.toMatch(/node:child_process|\bgit\b/iu);
  });

  it("starts independent tasks concurrently without a controller queue", async () => {
    const starts: string[] = [];
    const results = new Map<string, ReturnType<typeof deferred<string>>>();
    const { store, controller } = await fixture({ async start({ id }) {
      starts.push(id); const result = deferred<string>(); results.set(id, result);
      return { result: result.promise, async followUp() {}, async cancel() {} };
    } });
    const first = await controller.start({ parent, harness: "native", task: "one", cwd: "/one" });
    const second = await controller.start({ parent, harness: "native", task: "two", cwd: "/two" });
    await eventually(store, first.id, "running"); await eventually(store, second.id, "running");
    expect(starts).toHaveLength(2);
    results.get(first.id)!.resolve("one"); results.get(second.id)!.resolve("two");
  });

  it("recovers every nonterminal state as interrupted", async () => {
    const result = deferred<string>();
    const { store, controller } = await fixture({ async start() { return { result: result.promise, async followUp() {}, async cancel() {} }; } });
    const task = await controller.start({ parent, harness: "native", task: "work", cwd: "/project" });
    await eventually(store, task.id, "running");
    const recovered = await new TaskController(store, new Map()).initialize();
    expect(recovered[0]?.state).toBe("interrupted");
    result.resolve("late");
  });

  it("rejects invalid identity, harness, cwd, and transitions", async () => {
    const { controller } = await fixture({ async start() { throw new Error("unused"); } });
    await expect(controller.start({ parent, harness: "native", task: "x", cwd: "relative" })).rejects.toMatchObject({ code: "invalid_task" });
    await expect(controller.followUp("task-00000000-0000-4000-8000-000000000000", "x")).rejects.toMatchObject({ code: "task_not_found" });
  });

  it("serializes follow-up with cancellation and resolves cancel after quiescence", async () => {
    const result = deferred<string>(); const follow = deferred<void>(); const quiet = deferred<void>();
    const order: string[] = [];
    const handle: TaskAdapterHandle = { result: result.promise,
      async followUp() { order.push("follow-start"); await follow.promise; order.push("follow-end"); },
      async cancel() { order.push("cancel-start"); await quiet.promise; order.push("quiet"); result.resolve(""); } };
    const { store, controller } = await fixture({ async start() { return handle; } });
    const task = await controller.start({ parent, harness: "native", task: "work", cwd: "/project" });
    await eventually(store, task.id, "running");
    const followed = controller.followUp(task.id, "more");
    const cancelled = controller.cancel(task.id);
    for (let attempt = 0; order.length === 0 && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(order).toEqual(["follow-start"]);
    follow.resolve(); await followed;
    for (let attempt = 0; !order.includes("cancel-start") && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(order).toContain("cancel-start");
    let settled = false; void cancelled.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    quiet.resolve(); expect((await cancelled).state).toBe("cancelled"); expect(order.at(-1)).toBe("quiet");
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await store.read(task.id)).state).toBe("cancelled");
  });

  it("bounds records and redacts credentials and thrown adapter details", async () => {
    const { store, controller } = await fixture({ async start(_input, emit) {
      await emit({ code: "progress", message: `token=ghp_abcdefghijk ${"x".repeat(4_000)}` });
      throw new Error("stderr Bearer secret-provider-wire");
    } });
    const task = await controller.start({ parent, harness: "native", task: "work", cwd: "/project" });
    const failed = await eventually(store, task.id, "failed");
    const bytes = await readFile(store.path(task.id), "utf8");
    expect(bytes).not.toContain("ghp_abcdefghijk"); expect(bytes).not.toContain("secret-provider-wire");
    expect(failed.events[0]?.message.length).toBeLessThanOrEqual(2_000);
    expect(failed.error).toEqual({ code: "task_failed", message: "The native task failed." });
  });

  it("never exposes a partial JSON record during concurrent atomic writes", async () => {
    const result = deferred<string>();
    const { store, controller } = await fixture({ async start() { return { result: result.promise, async followUp() {}, async cancel() {} }; } });
    const task = await controller.start({ parent, harness: "native", task: "work", cwd: "/project" });
    await eventually(store, task.id, "running");
    const reads = Array.from({ length: 100 }, async () => JSON.parse(await readFile(store.path(task.id), "utf8")));
    result.resolve("done");
    await expect(Promise.all(reads)).resolves.toHaveLength(100);
  });
});
