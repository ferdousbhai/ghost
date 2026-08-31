import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { MAX_TASK_RESULT, TaskController, TaskStore, type TaskAdapter, type TaskAdapterContext, type TaskAdapterHandle, type TaskBindingReceipt, type TaskRecord } from "../src/tasks.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const parent = conversationIdentity("pi", "parent");
const binding: TaskBindingReceipt = { version: 1, root: "/project", rootIdentity: "1:2", cwd: "/project/exact", cwdIdentity: "1:3", generation: 4 };
const authority = { async revalidate(receipt: TaskBindingReceipt) { return receipt; } };
const stores: TaskStore[] = [];
function trackedStore(home: string): TaskStore { const store = new TaskStore(home); stores.push(store); return store; }
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.dispose())); });

async function eventually(store: TaskStore, id: string, state: TaskRecord["state"]): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) { const row = await store.read(id); if (row.state === state) return row; await new Promise((done) => setTimeout(done, 2)); }
  throw new Error(`${id} did not reach ${state}`);
}
async function fixture(adapter: TaskAdapter, bindingAuthority = authority) {
  const home = await mkdtemp(join(tmpdir(), "ghost-task-")); await chmod(home, 0o700);
  const store = trackedStore(home); const controller = new TaskController(store, new Map([["native", adapter]]), bindingAuthority); await controller.initialize();
  return { home, store, controller };
}
function runtime(options: { force?: () => Promise<void>; start?: (context: TaskAdapterContext) => void } = {}) {
  const result = deferred<string>(); const quiet = deferred<void>(); let context!: TaskAdapterContext;
  const adapter: TaskAdapter = { async start(_input, next) {
    context = next; next.register({ force: options.force ?? (async () => { quiet.resolve(); result.resolve(""); }), quiescence: quiet.promise }); options.start?.(next);
    return { result: result.promise, async followUp() {} };
  } };
  return { adapter, result, quiet, context: () => context };
}
async function start(controller: TaskController) { return controller.start({ parent, harness: "native", task: "inspect", binding }); }
function record(state: TaskRecord["state"]): TaskRecord {
  const at = new Date().toISOString();
  return { version: 1, id: `task-${randomUUID()}`, generation: 1, parent, harness: "native", task: "work", binding, state,
    createdAt: at, updatedAt: at, events: [], eventCursor: { nextSequence: 1, dropped: 0 }, result: state === "completed" ? "done" : null,
    resultTruncated: false, error: state === "failed" || state === "interrupted" ? { code: "failed", message: "Safe failure." } : null };
}

describe("durable task foundation", () => {
  it("requires initialization and revalidates the exact admitted binding before spawn", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const store = trackedStore(home); let received: unknown; const native = runtime();
    const controller = new TaskController(store, new Map([["native", { ...native.adapter, async start(input, context) { received = input; return native.adapter.start(input, context); } }]]), authority);
    await expect(start(controller)).rejects.toMatchObject({ code: "tasks_uninitialized" }); await controller.initialize();
    const task = await start(controller); await eventually(store, task.id, "running"); expect(received).toMatchObject({ cwd: "/project/exact", binding });
    expect(await readFile(new URL("../src/tasks.ts", import.meta.url), "utf8")).not.toMatch(/node:child_process|\bgit\b/iu);
  });

  it("starts independent tasks concurrently without a global limit", async () => {
    const executions: Array<{ result: ReturnType<typeof deferred<string>>; quiet: ReturnType<typeof deferred<void>> }> = [];
    const { store, controller } = await fixture({ async start(_input, context) {
      const result = deferred<string>(); const quiet = deferred<void>(); executions.push({ result, quiet });
      context.register({ async force() { quiet.resolve(); result.resolve(""); }, quiescence: quiet.promise });
      return { result: result.promise, async followUp() {} };
    } });
    const first = await start(controller); const second = await start(controller);
    await eventually(store, first.id, "running"); await eventually(store, second.id, "running"); expect(executions).toHaveLength(2);
    for (const execution of executions) { execution.result.resolve("done"); execution.quiet.resolve(); }
  });

  it("shares initialization and never recovers a live task twice", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter);
    const first = controller.initialize(); const second = controller.initialize(); expect(first).toBe(second); await first;
    const task = await start(controller); await eventually(store, task.id, "running"); await controller.initialize();
    expect((await store.read(task.id)).state).toBe("running");
  });

  it("cancels while binding validation is blocked without spawning", async () => {
    const admitted = deferred<TaskBindingReceipt>(); let spawned = false; const native = runtime();
    const { store, controller } = await fixture({ ...native.adapter, async start(input, context) { spawned = true; return native.adapter.start(input, context); } }, { async revalidate() { return admitted.promise; } });
    const task = await start(controller); await eventually(store, task.id, "starting"); const cancelled = controller.cancel(task.id); admitted.resolve(binding);
    expect((await cancelled).state).toBe("cancelled"); await new Promise((done) => setTimeout(done, 2)); expect(spawned).toBe(false);
  });

  it("accepts reordered exact receipts and rejects outside or rebound cwd", async () => {
    const reordered = { generation: 4, cwdIdentity: "1:3", cwd: "/project/exact", rootIdentity: "1:2", root: "/project", version: 1 } as TaskBindingReceipt;
    const native = runtime(); const { store, controller } = await fixture(native.adapter, { async revalidate() { return reordered; } });
    const accepted = await start(controller); await eventually(store, accepted.id, "running");
    await expect(controller.start({ parent, harness: "native", task: "outside", binding: { ...binding, cwd: "/elsewhere" } })).rejects.toMatchObject({ code: "invalid_task" });
    let spawned = false; const changed = await fixture({ ...native.adapter, async start(input, context) { spawned = true; return native.adapter.start(input, context); } }, { async revalidate(receipt) { return { ...receipt, generation: receipt.generation + 1 }; } });
    const rejected = await start(changed.controller); await eventually(changed.store, rejected.id, "failed"); expect(spawned).toBe(false);
  });

  it("aborts a blocked handle and tracks it through shutdown", async () => {
    const never = deferred<TaskAdapterHandle>(); const quiet = deferred<void>();
    const { store, controller } = await fixture({ start(_input, context) {
      context.register({ async force() { quiet.resolve(); }, quiescence: quiet.promise }); return never.promise;
    } });
    const task = await start(controller); await eventually(store, task.id, "running"); await controller.beginShutdown();
    expect((await store.read(task.id)).state).toBe("interrupted");
    await controller.dispose(); await expect(store.list()).rejects.toMatchObject({ code: "task_store_uninitialized" });
  });

  it("does not publish completion until quiescence and fences late emissions", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    native.result.resolve("done"); await new Promise((done) => setTimeout(done, 3)); expect((await store.read(task.id)).state).toBe("running");
    native.quiet.resolve(); expect((await eventually(store, task.id, "completed")).result).toBe("done");
    await native.context().emit({ code: "late", message: "not recorded" }); expect((await store.read(task.id)).events).toEqual([]);
  });

  it("bounds completed results and records truncation", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    native.result.resolve("x".repeat(MAX_TASK_RESULT + 10)); native.quiet.resolve(); const completed = await eventually(store, task.id, "completed");
    expect(completed.result).toHaveLength(MAX_TASK_RESULT); expect(completed.resultTruncated).toBe(true);
  });

  it("keeps terminal cancellation byte- and mtime-stable", async () => {
    const native = runtime(); const { home, store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    native.result.resolve("done"); native.quiet.resolve(); await eventually(store, task.id, "completed");
    const path = join(home, ".tasks", `${task.id}.json`); const before = await readFile(path); const beforeStat = await stat(path, { bigint: true });
    expect((await controller.cancel(task.id)).state).toBe("completed"); expect(await readFile(path)).toEqual(before); expect((await stat(path, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
  });

  it("makes old-generation launch and result publication durable no-ops", async () => {
    const validation = deferred<TaskBindingReceipt>(); let spawned = false; const native = runtime();
    const { home, store, controller } = await fixture({ ...native.adapter, async start(input, context) { spawned = true; return native.adapter.start(input, context); } }, { async revalidate() { return validation.promise; } });
    const task = await start(controller); await eventually(store, task.id, "starting"); const recovery = new TaskController(store, new Map(), authority); await recovery.initialize();
    const path = join(home, ".tasks", `${task.id}.json`); const before = await readFile(path); const beforeStat = await stat(path, { bigint: true }); validation.resolve(binding); await controller.beginShutdown();
    expect(spawned).toBe(false); expect(await readFile(path)).toEqual(before); expect((await stat(path, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);

    const runningNative = runtime(); const second = await fixture(runningNative.adapter); const active = await start(second.controller); await eventually(second.store, active.id, "running");
    const secondRecovery = new TaskController(second.store, new Map(), authority); await secondRecovery.initialize(); const activePath = join(second.home, ".tasks", `${active.id}.json`);
    const activeBefore = await readFile(activePath); const activeStat = await stat(activePath, { bigint: true }); runningNative.result.resolve("late"); runningNative.quiet.resolve(); await second.controller.beginShutdown();
    expect(await readFile(activePath)).toEqual(activeBefore); expect((await stat(activePath, { bigint: true })).mtimeNs).toBe(activeStat.mtimeNs);
  });

  it("serializes follow-up and repeated cancellation until full quiescence", async () => {
    const gate = deferred<void>(); const quiet = deferred<void>(); const result = deferred<string>(); const order: string[] = [];
    const adapter: TaskAdapter = { async start(_input, context) { context.register({ async force() { order.push("force"); await gate.promise; }, quiescence: quiet.promise }); return { result: result.promise, async followUp() { order.push("follow"); } }; } };
    const { store, controller } = await fixture(adapter); const task = await start(controller); await eventually(store, task.id, "running");
    await controller.followUp(task.id, "more"); const first = controller.cancel(task.id); const second = controller.cancel(task.id);
    await new Promise((done) => setTimeout(done, 2)); expect(order).toEqual(["follow", "force"]); gate.resolve(); quiet.resolve(); result.resolve("");
    expect((await first).state).toBe("cancelled"); expect((await second).state).toBe("cancelled"); expect(order.filter((item) => item === "force")).toHaveLength(1);
  });

  it("recovers every nonterminal state with a generation fence and skips unrelated names", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const store = trackedStore(home); await store.initialize();
    const rows = [record("queued"), record("starting"), record("running"), record("cancelling"), record("completed")]; for (const row of rows) await store.write(row);
    await writeFile(join(home, ".tasks", "task-not-a-record.json"), "foreign", { mode: 0o600 });
    const controller = new TaskController(store, new Map(), authority); const recovered = await controller.initialize();
    expect(recovered.filter((row) => row.state === "interrupted")).toHaveLength(4); expect(recovered.filter((row) => row.state === "interrupted").every((row) => row.generation === 2)).toBe(true);
    expect(recovered.find((row) => row.id === rows[4]?.id)?.state).toBe("completed");
  });

  it("keeps monotonic event cursors when bounded history is truncated", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    for (let index = 1; index <= 70; index += 1) await native.context().emit({ code: "progress", message: String(index) });
    const row = await store.read(task.id); expect(row.events).toHaveLength(64); expect(row.events[0]?.sequence).toBe(7); expect(row.events.at(-1)?.sequence).toBe(70);
    expect(row.eventCursor).toEqual({ nextSequence: 71, dropped: 6 });
  });

  it("maps adapter errors and redacts bounded arbitrary harness text", async () => {
    const quiet = Promise.resolve(); const { store, controller } = await fixture({ async start(_input, context) {
      context.register({ async force() { throw new Error("Bearer force-secret"); }, quiescence: quiet }); await context.emit({ code: "progress", message: "token=ghp_abcdefghijk" });
      throw new Error("stderr protocol Bearer provider-secret");
    } });
    const task = await start(controller); const failed = await eventually(store, task.id, "failed");
    expect(JSON.stringify(failed)).not.toContain("ghp_abcdefghijk"); expect(JSON.stringify(failed)).not.toContain("provider-secret");
    expect(failed.error).toEqual({ code: "task_failed", message: "The native task failed safely." });
  });

  it("rejects unsafe task directories and record links or modes", async () => {
    const native = runtime(); const { home, store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    const file = join(home, ".tasks", `${task.id}.json`); await link(file, join(home, ".tasks", "extra-link")); await expect(store.read(task.id)).rejects.toMatchObject({ code: "unsafe_task_record" });
    const secondHome = await mkdtemp(join(tmpdir(), "ghost-task-")); await symlink(tmpdir(), join(secondHome, ".tasks")); await expect(trackedStore(secondHome).initialize()).rejects.toBeTruthy();
  });

  it("rejects directory replacement and keeps durable files exactly private", async () => {
    const native = runtime(); const { home, store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    const file = join(home, ".tasks", `${task.id}.json`); expect((await stat(file)).mode & 0o777).toBe(0o600); expect((await stat(join(home, ".tasks"))).mode & 0o777).toBe(0o700);
    await rename(join(home, ".tasks"), join(home, ".tasks-old")); await mkdir(join(home, ".tasks"), { mode: 0o700 }); await expect(store.read(task.id)).rejects.toMatchObject({ code: "unsafe_task_store" });
  });

  it("recovers a durable CAS crash and rejects an inode replacement race", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const store = trackedStore(home); await store.initialize(); const row = record("queued"); await store.write(row);
    const path = join(home, ".tasks", `${row.id}.json`); await rename(path, `${path}.ghost-migration-cas`);
    expect((await store.list())[0]?.id).toBe(row.id);
    const admitted = await store.read(row.id); const replacement = `${path}.replacement`;
    await writeFile(replacement, `${JSON.stringify(admitted, null, 2)}\n`, { mode: 0o600 }); await rename(replacement, path);
    admitted.state = "starting"; await expect(store.write(admitted)).rejects.toMatchObject({ code: "private_write_conflict" });
    expect((await store.read(row.id)).state).toBe("queued");
  });

  it("fails closed on exact schema, invariant, and timestamp violations", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const store = trackedStore(home); await store.initialize(); const row = record("queued"); await store.write(row);
    const path = join(home, ".tasks", `${row.id}.json`); await writeFile(path, JSON.stringify({ ...row, createdAt: "yesterday", unknown: true }), { mode: 0o600 });
    await expect(store.read(row.id)).rejects.toMatchObject({ code: "invalid_task_record" });
    const at = row.createdAt; const badCursor = { ...row, events: [{ sequence: 2, at, code: "progress", message: "gap" }], eventCursor: { nextSequence: 3, dropped: 0 } };
    await writeFile(path, JSON.stringify(badCursor), { mode: 0o600 }); await expect(store.read(row.id)).rejects.toMatchObject({ code: "invalid_task_record" });
    const firstAt = new Date(Date.parse(at) + 2_000).toISOString(); const secondAt = new Date(Date.parse(at) + 1_000).toISOString();
    const reversed = { ...row, updatedAt: firstAt, events: [{ sequence: 1, at: firstAt, code: "progress", message: "first" }, { sequence: 2, at: secondAt, code: "progress", message: "second" }], eventCursor: { nextSequence: 3, dropped: 0 } };
    await writeFile(path, JSON.stringify(reversed), { mode: 0o600 }); await expect(store.read(row.id)).rejects.toMatchObject({ code: "invalid_task_record" });
  });
});
