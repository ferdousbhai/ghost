import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED_MEMORY_SECRET } from "@ghost/extensions";
import { afterEach, describe, expect, it } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { inspectNativeHarnessExecutable } from "../src/native-harness-identity.js";
import type { NativeTaskScopeManager } from "../src/native-task-scope.js";
import { MAX_TASK_EVENT_MESSAGE, MAX_TASK_RESULT, TaskController, TaskStore, type TaskAdapter, type TaskAdapterContext, type TaskAdapterHandle, type TaskBindingAuthority, type TaskBindingReceipt, type TaskRecord } from "../src/tasks.js";
import { fakeTaskScopeManager } from "./helpers/task-scope.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const parent = conversationIdentity("pi", "parent");
const binding: TaskBindingReceipt = { version: 1, root: "/project", rootIdentity: "1:2", cwd: "/project/exact", cwdIdentity: "1:3", generation: 4 };
const ownership = {
  version: 1,
  kind: "systemd-scope",
  nonce: "11111111111111111111111111111111",
} as const;
function authorityFrom(
  revalidate: TaskBindingAuthority["revalidate"],
): TaskBindingAuthority {
  return {
    revalidate,
    async launchNative(receipt, signal, parent, launch) {
      return launch(await revalidate(receipt, signal, parent));
    },
  };
}
const authority = authorityFrom(async (receipt: TaskBindingReceipt) => receipt);
const stores: TaskStore[] = [];
function trackedStore(home: string): TaskStore { const store = new TaskStore(home); stores.push(store); return store; }
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.dispose())); });

async function eventually(store: TaskStore, id: string, state: TaskRecord["state"]): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const row = await store.read(id);
      if (row.state === state) return row;
    } catch (error) {
      const changed = error as { code?: string; message?: string };
      if (changed.code !== "unsafe_task_record"
        || changed.message !== "The task record changed.") throw error;
    }
    await new Promise((done) => setTimeout(done, 2));
  }
  throw new Error(`${id} did not reach ${state}`);
}
async function readPersistedTask(home: string, id: string): Promise<TaskRecord> {
  const reader = new TaskStore(home);
  await reader.initialize();
  try { return await reader.read(id); } finally { await reader.dispose(); }
}
async function fixture(
  adapter: TaskAdapter,
  bindingAuthority: Pick<TaskBindingAuthority, "revalidate"> = authority,
) {
  const home = await mkdtemp(join(tmpdir(), "ghost-task-")); await chmod(home, 0o700);
  const store = trackedStore(home); const controller = new TaskController(store, new Map([["native", adapter]]), authorityFrom(bindingAuthority.revalidate), fakeTaskScopeManager()); await controller.initialize();
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
async function start(controller: TaskController) {
  return controller.start({
    parent,
    harness: "native",
    task: "inspect",
    binding,
  });
}
function record(state: TaskRecord["state"]): TaskRecord {
  const at = new Date().toISOString();
  return { version: 2, id: `task-${randomUUID()}`, generation: 1, parent, harness: "native", agent: null, task: "work", binding, ownership, state,
    createdAt: at, updatedAt: at, events: [], eventCursor: { nextSequence: 1, dropped: 0 }, result: state === "completed" ? "done" : null,
    resultTruncated: false, error: state === "failed" || state === "interrupted" ? { code: "failed", message: "Safe failure." } : null };
}

describe("durable task foundation", () => {
  it("requires initialization and revalidates the exact admitted binding before spawn", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const store = trackedStore(home); let received: unknown; const native = runtime();
    const admitted: TaskAdapter = { ...native.adapter, async start(input, context) { received = input; return native.adapter.start(input, context); } };
    const controller = new TaskController(store, new Map([["native", admitted], ["claude-code", admitted]]), authority, fakeTaskScopeManager());
    await expect(start(controller)).rejects.toMatchObject({ code: "tasks_uninitialized" }); await controller.initialize();
    const task = await controller.start({ parent, harness: "claude-code", agent: "owner-agent", task: "inspect", binding }); await eventually(store, task.id, "running");
    expect(received).toMatchObject({ cwd: "/project/exact", binding, agent: "owner-agent" });
    expect(await store.read(task.id)).toMatchObject({
      version: 2,
      agent: "owner-agent",
      ownership: {
        version: 1,
        kind: "systemd-scope",
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/u),
      },
    });
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

  it.each(["zero", "twice", "thenable"] as const)(
    "rejects a %s-use native launch callback before task publication",
    async (kind) => {
      const executable = "/usr/bin/true";
      const executableEvidence = {
        path: executable,
        identity: await inspectNativeHarnessExecutable(executable, true),
        literalBoundary: true,
      };
      const adapter: TaskAdapter = {
        async start(input, context) {
          const quiet = Promise.withResolvers<void>();
          context.register({
            async force() {
              await context.stopNative();
              quiet.resolve();
            },
            quiescence: quiet.promise,
          });
          await context.launchNative([executableEvidence], (spawn) => {
            if (kind === "zero") return "no spawn";
            spawn({
              executable,
              args: [],
              cwd: input.cwd,
              environment: { PATH: "/usr/bin:/bin" },
            });
            if (kind === "twice") {
              spawn({
                executable,
                args: [],
                cwd: input.cwd,
                environment: { PATH: "/usr/bin:/bin" },
              });
            }
            return kind === "thenable" ? Promise.resolve("late") : "spawned";
          });
          return { result: new Promise<string>(() => undefined), async followUp() {} };
        },
      };
      const { home, store, controller } = await fixture(adapter);
      const task = await controller.start({
        parent,
        harness: "native",
        task: "inspect launch capability",
        binding: {
          ...binding,
          root: home,
          rootIdentity: "test-root",
          cwd: home,
          cwdIdentity: "test-cwd",
        },
      });
      await expect(eventually(store, task.id, "failed")).resolves.toMatchObject({
        error: { code: "task_failed" },
      });
    },
  );

  it.each([
    ["Pi executable", ["pi"], 0, 0],
    ["Codex executable", ["codex"], 0, 0],
    ["Claude native executable", ["claude"], 0, 0],
    ["Claude script", ["claude.mjs", "bun"], 0, 1],
    ["Claude Bun interpreter", ["claude.mjs", "bun"], 1, 1],
  ] as const)(
    "rejects a replaced %s after binding admission without spawning",
    async (_label, names, replacementIndex, spawnIndex) => {
      const home = await mkdtemp(join(tmpdir(), "ghost-task-executable-"));
      await chmod(home, 0o700);
      const paths = names.map((name) => join(home, name));
      for (const path of paths) await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const executables = await Promise.all(paths.map(async (path) => ({
        path,
        identity: await inspectNativeHarnessExecutable(path, true),
        literalBoundary: true,
      })));
      const entered = deferred<void>();
      const release = deferred<void>();
      const bindingAuthority: TaskBindingAuthority = {
        async revalidate(receipt) { return receipt; },
        async launchNative(receipt, _signal, _parent, launch) {
          entered.resolve();
          await release.promise;
          return launch(receipt);
        },
      };
      let spawns = 0;
      let confirmations = 0;
      const manager: NativeTaskScopeManager = {
        async reserve(taskId) {
          return {
            unit: `ghost-${taskId}.scope`,
            spawn() {
              spawns += 1;
              throw new Error("replacement reached scope spawn");
            },
            async stopAndConfirm() { confirmations += 1; },
          };
        },
        async stopAndConfirm() { confirmations += 1; },
        async recoverAndConfirm() { confirmations += 1; },
      };
      const adapter: TaskAdapter = {
        async start(input, context) {
          const quiet = deferred<void>();
          context.register({
            async force() {
              await context.stopNative();
              quiet.resolve();
            },
            quiescence: quiet.promise,
          });
          await context.launchNative(executables, (spawn) => spawn({
            executable: paths[spawnIndex]!,
            args: [],
            cwd: input.cwd,
            environment: { PATH: "/usr/bin:/bin" },
          }));
          return { result: new Promise<string>(() => undefined), async followUp() {} };
        },
      };
      const store = trackedStore(home);
      const controller = new TaskController(
        store,
        new Map([["native", adapter]]),
        bindingAuthority,
        manager,
      );
      await controller.initialize();
      const task = await controller.start({
        parent,
        harness: "native",
        task: "reject replaced executable",
        binding: {
          ...binding,
          root: home,
          rootIdentity: "test-root",
          cwd: home,
          cwdIdentity: "test-cwd",
        },
      });
      await entered.promise;
      const replacement = join(home, `replacement-${replacementIndex}`);
      await writeFile(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await rename(replacement, paths[replacementIndex]!);
      release.resolve();

      await expect(eventually(store, task.id, "failed")).resolves.toMatchObject({
        error: { code: "task_failed" },
      });
      expect(spawns).toBe(0);
      expect(confirmations).toBeGreaterThan(0);
    },
  );

  it("rejects blank work and non-Claude agents at the durable boundary", async () => {
    const native = runtime();
    const { store, controller } = await fixture(native.adapter);
    await expect(controller.start({
      parent, harness: "native", task: " \n\t ", binding,
    })).rejects.toMatchObject({ code: "invalid_task" });
    await expect(controller.start({
      parent, harness: "native", agent: "claude-only", task: "work", binding,
    })).rejects.toMatchObject({ code: "invalid_task" });
    for (const agent of [
      " \n\t ",
      "reviewer\nname",
      "sk-abcdefgh",
      "[REDACTED_SECRET]",
      "-----BEGIN PRIVATE KEY-----",
    ]) {
      await expect(controller.start({
        parent, harness: "claude-code", agent, task: "work", binding,
      })).rejects.toMatchObject({ code: "invalid_task" });
    }
    expect(await store.list()).toEqual([]);
  });

  it("keeps follow-up and cancellation within the qualified parent", async () => {
    const native = runtime();
    const { store, controller } = await fixture(native.adapter);
    const task = await start(controller);
    await eventually(store, task.id, "running");
    const foreign = conversationIdentity("claude-code", parent.conversationId);
    await expect(controller.followUp(task.id, "foreign", foreign))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });
    await expect(controller.cancel(task.id, foreign))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });
    expect((await store.read(task.id)).state).toBe("running");
    await expect(controller.followUp(task.id, " \n\t ", parent))
      .rejects.toMatchObject({ code: "invalid_task", status: 400 });
    await controller.cancel(task.id, parent);
  });

  it("shares initialization and never recovers a live task twice", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter);
    const first = controller.initialize(); const second = controller.initialize(); expect(first).toBe(second); await first;
    const task = await start(controller); await eventually(store, task.id, "running"); await controller.initialize();
    expect((await store.read(task.id)).state).toBe("running");
  });

  it("registers admission before a blocked durable write and lets shutdown fence it", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const gate = deferred<void>(); const listEntered = deferred<void>(); const listRelease = deferred<void>();
    let firstWrite = true; let staleList = false; let spawned = false;
    class DelayedStore extends TaskStore {
      override async write(row: TaskRecord): Promise<void> { if (firstWrite) { firstWrite = false; await gate.promise; } await super.write(row); }
      override async list(): Promise<TaskRecord[]> {
        if (!staleList) return super.list();
        const snapshot: TaskRecord[] = []; listEntered.resolve(); await listRelease.promise; return snapshot;
      }
    }
    const store = new DelayedStore(home); stores.push(store); const native = runtime();
    const controller = new TaskController(store, new Map([["native", { ...native.adapter, async start(input, context) { spawned = true; return native.adapter.start(input, context); } }]]), authority, fakeTaskScopeManager()); await controller.initialize();
    staleList = true; const admission = start(controller); const shutdown = controller.beginShutdown(); gate.resolve(); await listEntered.promise; listRelease.resolve();
    await expect(admission).rejects.toMatchObject({ code: "tasks_shutting_down" }); await shutdown;
    staleList = false; expect(spawned).toBe(false); expect((await store.list())[0]?.state).toBe("interrupted");
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

  it("isolates and freezes binding copies across authority and adapter calls", async () => {
    let authorityFrozen = false; let adapterFrozen = false;
    const native = runtime(); const { store, controller } = await fixture({ ...native.adapter, async start(input, context) {
      adapterFrozen = Object.isFrozen(input.binding); return native.adapter.start(input, context);
    } }, { async revalidate(receipt) {
      authorityFrozen = Object.isFrozen(receipt); expect(Reflect.set(receipt, "cwd", "/mutated")).toBe(false); return receipt;
    } });
    const task = await start(controller); await eventually(store, task.id, "running");
    expect(authorityFrozen).toBe(true); expect(adapterFrozen).toBe(true); expect((await store.read(task.id)).binding).toEqual(binding);
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

  it("lets cancellation enter while follow-up waits on a handle or native acknowledgement", async () => {
    const pendingHandle = deferred<TaskAdapterHandle>(); const quiet = deferred<void>();
    const first = await fixture({ start(_input, context) {
      context.register({ async force() { quiet.resolve(); }, quiescence: quiet.promise }); return pendingHandle.promise;
    } });
    const firstTask = await start(first.controller); await eventually(first.store, firstTask.id, "running");
    const waitingForHandle = first.controller.followUp(firstTask.id, "more"); expect((await first.controller.cancel(firstTask.id)).state).toBe("cancelled");
    await expect(waitingForHandle).rejects.toMatchObject({ code: "task_not_running" });

    const followGate = deferred<void>(); const secondNative = runtime(); secondNative.adapter.start = async (_input, context) => {
      context.register({ async force() { secondNative.quiet.resolve(); secondNative.result.resolve(""); }, quiescence: secondNative.quiet.promise });
      return { result: secondNative.result.promise, async followUp() { await followGate.promise; } };
    };
    const second = await fixture(secondNative.adapter); const secondTask = await start(second.controller); await eventually(second.store, secondTask.id, "running");
    const waitingForFollow = second.controller.followUp(secondTask.id, "more"); expect((await second.controller.cancel(secondTask.id)).state).toBe("cancelled");
    await expect(waitingForFollow).rejects.toMatchObject({ code: "task_not_running" }); followGate.resolve();
  });

  it("forces and quiesces sync start, handle, and result failures before failing", async () => {
    for (const kind of ["sync", "handle", "result"] as const) {
      const forceGate = deferred<void>(); const quiet = deferred<void>(); let forces = 0;
      const adapter: TaskAdapter = { start(_input, context) {
        context.register({ async force() { forces += 1; await forceGate.promise; quiet.resolve(); }, quiescence: quiet.promise });
        if (kind === "sync") throw new Error("raw sync stderr");
        if (kind === "handle") return Promise.reject(new Error("raw handle protocol"));
        return Promise.resolve({ result: Promise.reject(new Error("raw result environment")), async followUp() {} });
      } };
      const current = await fixture(adapter); const task = await start(current.controller); await eventually(current.store, task.id, "running");
      await new Promise((done) => setTimeout(done, 2)); expect((await current.store.read(task.id)).state).not.toBe("failed"); expect(forces).toBe(1);
      forceGate.resolve(); expect((await eventually(current.store, task.id, "failed")).error).toEqual({ code: "task_failed", message: "The native task failed safely." });
    }
  });

  it("does not publish completion until quiescence and fences late emissions", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    native.result.resolve("done"); await new Promise((done) => setTimeout(done, 3)); expect((await store.read(task.id)).state).toBe("running");
    native.quiet.resolve(); expect((await eventually(store, task.id, "completed")).result).toBe("done");
    await native.context().emit({ code: "late", message: "not recorded" }); expect((await store.read(task.id)).events).toEqual([]);
  });

  it("does not publish completion until scope inactivity is confirmed", async () => {
    const native = runtime();
    const confirmation = deferred<void>();
    const ownership = fakeTaskScopeManager();
    ownership.stopAndConfirm = async (taskId) => {
      ownership.stops.push(taskId);
      await confirmation.promise;
    };
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    const store = trackedStore(home);
    const controller = new TaskController(
      store,
      new Map([["native", native.adapter]]),
      authority,
      ownership,
    );
    await controller.initialize();
    const task = await start(controller);
    await eventually(store, task.id, "running");
    native.result.resolve("done");
    native.quiet.resolve();
    await new Promise((done) => setTimeout(done, 3));
    expect((await store.read(task.id)).state).toBe("running");
    confirmation.resolve();
    expect((await eventually(store, task.id, "completed")).result).toBe("done");
  });

  it("keeps cancellation nonterminal when scope ownership is unconfirmed", async () => {
    const native = runtime();
    const ownership = fakeTaskScopeManager();
    let confirmations = 0;
    ownership.stopAndConfirm = async (taskId) => {
      ownership.stops.push(taskId);
      confirmations += 1;
      if (confirmations === 1) throw new Error("private bus failure");
    };
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    const store = trackedStore(home);
    const controller = new TaskController(
      store,
      new Map([["native", native.adapter]]),
      authority,
      ownership,
    );
    await controller.initialize();
    const task = await start(controller);
    await eventually(store, task.id, "running");
    await expect(controller.cancel(task.id)).rejects.toMatchObject({ code: "task_cancel_failed" });
    const cancelling = await store.read(task.id);
    expect(cancelling.state).toBe("cancelling");
    expect(cancelling.events.at(-1)).toMatchObject({ code: "ownership_unconfirmed" });
    expect((await controller.cancel(task.id)).state).toBe("cancelled");
    expect(confirmations).toBe(2);
  });

  it("bounds completed results and records truncation", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    native.result.resolve("x".repeat(MAX_TASK_RESULT + 10)); native.quiet.resolve(); const completed = await eventually(store, task.id, "completed");
    expect(completed.result).toHaveLength(MAX_TASK_RESULT); expect(completed.resultTruncated).toBe(true);
  });

  it("redacts PEM secrets spanning event and result truncation boundaries", async () => {
    const native = runtime(); const { store, controller } = await fixture(native.adapter); const task = await start(controller); await eventually(store, task.id, "running");
    const eventPem = `${"e".repeat(MAX_TASK_EVENT_MESSAGE - 40)}-----BEGIN PRIVATE KEY-----${"S".repeat(200)}`;
    await native.context().emit({ code: "progress", message: eventPem }); const event = (await store.read(task.id)).events[0]?.message ?? "";
    expect(event).toContain(REDACTED_MEMORY_SECRET); expect(event).not.toContain("BEGIN PRIVATE KEY"); expect(event).not.toContain("SSSSSSSS");
    const resultPem = `${"r".repeat(MAX_TASK_RESULT - 40)}-----BEGIN PRIVATE KEY-----${"K".repeat(200)}-----END PRIVATE KEY-----`;
    native.result.resolve(resultPem); native.quiet.resolve(); const completed = await eventually(store, task.id, "completed");
    expect(completed.result).toContain(REDACTED_MEMORY_SECRET); expect(completed.result).not.toContain("BEGIN PRIVATE KEY"); expect(completed.result).not.toContain("KKKKKKKK");
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
    const task = await start(controller); await eventually(store, task.id, "starting"); const recovery = new TaskController(store, new Map(), authority, fakeTaskScopeManager()); await recovery.initialize();
    const path = join(home, ".tasks", `${task.id}.json`); const before = await readFile(path); const beforeStat = await stat(path, { bigint: true }); validation.resolve(binding); await controller.beginShutdown();
    expect(spawned).toBe(false); expect(await readFile(path)).toEqual(before); expect((await stat(path, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);

    const runningNative = runtime(); const second = await fixture(runningNative.adapter); const active = await start(second.controller); await eventually(second.store, active.id, "running");
    const secondRecovery = new TaskController(second.store, new Map(), authority, fakeTaskScopeManager()); await secondRecovery.initialize(); const activePath = join(second.home, ".tasks", `${active.id}.json`);
    const activeBefore = await readFile(activePath); const activeStat = await stat(activePath, { bigint: true }); runningNative.result.resolve("late"); runningNative.quiet.resolve(); await second.controller.beginShutdown();
    expect(await readFile(activePath)).toEqual(activeBefore); expect((await stat(activePath, { bigint: true })).mtimeNs).toBe(activeStat.mtimeNs);
  });

  it("quiesces a retained native control before reading a terminal record", async () => {
    const result = deferred<string>(); const quiet = deferred<void>(); let forces = 0;
    const current = await fixture({ async start(_input, context) {
      context.register({ async force() { forces += 1; quiet.resolve(); result.resolve(""); }, quiescence: quiet.promise });
      return { result: result.promise, async followUp() {} };
    } });
    const task = await start(current.controller); await eventually(current.store, task.id, "running");
    const recovery = new TaskController(current.store, new Map(), authority, fakeTaskScopeManager()); await recovery.initialize();
    expect((await current.controller.cancel(task.id)).state).toBe("interrupted"); expect(forces).toBe(1);
    result.resolve("late"); quiet.resolve(); await current.controller.beginShutdown();
  });

  it("quiesces an active control exactly once before reporting a read failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); let failReads = false;
    class FailingReadStore extends TaskStore {
      override async read(id: string): Promise<TaskRecord> {
        if (failReads) throw new Error("store read failed");
        return super.read(id);
      }
    }
    const store = new FailingReadStore(home); stores.push(store);
    const forceEntered = deferred<void>(); const releaseForce = deferred<void>(); const quiet = deferred<void>(); const result = deferred<string>(); let forces = 0;
    const controller = new TaskController(store, new Map([["native", { async start(_input, context) {
      context.register({ async force() { forces += 1; forceEntered.resolve(); await releaseForce.promise; quiet.resolve(); result.resolve(""); }, quiescence: quiet.promise });
      return { result: result.promise, async followUp() {} };
    } }]]), authority, fakeTaskScopeManager()); await controller.initialize();
    const task = await start(controller); await eventually(store, task.id, "running"); failReads = true;
    let settled = false; const cancellation = controller.cancel(task.id); void cancellation.finally(() => { settled = true; }).catch(() => {});
    await forceEntered.promise; expect(forces).toBe(1); expect(settled).toBe(false); releaseForce.resolve();
    await expect(cancellation).rejects.toMatchObject({ code: "task_storage_failed" }); expect(forces).toBe(1); expect(settled).toBe(true);
  });

  it("quiesces every live control even when shutdown cannot list storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); let failList = false;
    class FailingListStore extends TaskStore {
      override async list(): Promise<TaskRecord[]> {
        if (failList) throw new Error("store list failed");
        return super.list();
      }
    }
    const store = new FailingListStore(home); stores.push(store); const executions: Array<{ forces: number; quiet: boolean }> = [];
    const controller = new TaskController(store, new Map([["native", { async start(_input, context) {
      const execution = { forces: 0, quiet: false }; executions.push(execution); const quiet = deferred<void>(); const result = deferred<string>();
      context.register({ async force() { execution.forces += 1; execution.quiet = true; quiet.resolve(); result.resolve(""); }, quiescence: quiet.promise });
      return { result: result.promise, async followUp() {} };
    } }]]), authority, fakeTaskScopeManager()); await controller.initialize();
    const first = await start(controller); const second = await start(controller);
    await eventually(store, first.id, "running"); await eventually(store, second.id, "running"); failList = true;
    await expect(controller.beginShutdown()).rejects.toMatchObject({ code: "task_shutdown_failed" });
    expect(executions).toEqual([{ forces: 1, quiet: true }, { forces: 1, quiet: true }]);
    expect((await store.read(first.id)).state).toBe("interrupted"); expect((await store.read(second.id)).state).toBe("interrupted");
  });

  it("quiesces other live work when one admission write fails during shutdown", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const writeEntered = deferred<void>(); const releaseWrite = deferred<void>(); let rejectAdmission = false;
    class FailingAdmissionStore extends TaskStore {
      override async write(row: TaskRecord): Promise<void> {
        if (rejectAdmission && row.state === "queued") { rejectAdmission = false; writeEntered.resolve(); await releaseWrite.promise; throw new Error("admission write failed"); }
        await super.write(row);
      }
    }
    const store = new FailingAdmissionStore(home); stores.push(store); const quiet = deferred<void>(); const result = deferred<string>(); let forces = 0;
    const controller = new TaskController(store, new Map([["native", { async start(_input, context) {
      context.register({ async force() { forces += 1; quiet.resolve(); result.resolve(""); }, quiescence: quiet.promise });
      return { result: result.promise, async followUp() {} };
    } }]]), authority, fakeTaskScopeManager()); await controller.initialize();
    const live = await start(controller); await eventually(store, live.id, "running"); rejectAdmission = true;
    const admission = start(controller).then(() => undefined, (error: unknown) => error); await writeEntered.promise;
    const shutdown = controller.beginShutdown(); expect(forces).toBe(1); releaseWrite.resolve();
    expect(await admission).toBeInstanceOf(Error); await expect(shutdown).rejects.toMatchObject({ code: "task_shutdown_failed" });
    expect(forces).toBe(1); expect((await store.read(live.id)).state).toBe("interrupted");
  });

  it("serializes follow-up and repeated cancellation until full quiescence", async () => {
    const gate = deferred<void>(); const quiet = deferred<void>(); const result = deferred<string>(); const order: string[] = [];
    const adapter: TaskAdapter = { async start(_input, context) { context.register({ async force() { order.push("force"); await gate.promise; }, quiescence: quiet.promise }); return { result: result.promise, async followUp() { order.push("follow"); } }; } };
    const { store, controller } = await fixture(adapter); const task = await start(controller); await eventually(store, task.id, "running");
    await controller.followUp(task.id, "more"); const first = controller.cancel(task.id); const second = controller.cancel(task.id);
    await new Promise((done) => setTimeout(done, 2)); expect(order).toEqual(["follow", "force"]); gate.resolve(); quiet.resolve(); result.resolve("");
    expect((await first).state).toBe("cancelled"); expect((await second).state).toBe("cancelled"); expect(order.filter((item) => item === "force")).toHaveLength(1);
  });

  it("gives shutdown deterministic precedence over cancellation in either ordering", async () => {
    for (const shutdownFirst of [false, true]) {
      const gate = deferred<void>(); const quiet = deferred<void>(); const result = deferred<string>();
      const current = await fixture({ async start(_input, context) {
        context.register({ async force() { await gate.promise; quiet.resolve(); result.resolve(""); }, quiescence: quiet.promise });
        return { result: result.promise, async followUp() {} };
      } });
      const task = await start(current.controller); await eventually(current.store, task.id, "running");
      const first = shutdownFirst ? current.controller.beginShutdown() : current.controller.cancel(task.id);
      const second = shutdownFirst ? current.controller.cancel(task.id) : current.controller.beginShutdown();
      gate.resolve(); await Promise.all([first, second]); expect((await current.store.read(task.id)).state).toBe("interrupted");
    }
  });

  it("keeps an upgraded shutdown target authoritative across a blocked cancelled write", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const blocked = deferred<void>(); const release = deferred<void>(); let blockCancelled = false;
    class BlockingStore extends TaskStore {
      override async write(row: TaskRecord): Promise<void> {
        if (blockCancelled && row.state === "cancelled") { blockCancelled = false; blocked.resolve(); await release.promise; }
        await super.write(row);
      }
    }
    const store = new BlockingStore(home); stores.push(store); const native = runtime();
    const controller = new TaskController(store, new Map([["native", native.adapter]]), authority, fakeTaskScopeManager()); await controller.initialize();
    const task = await start(controller); await eventually(store, task.id, "running"); blockCancelled = true;
    const cancelled = controller.cancel(task.id); await blocked.promise; const shutdown = controller.beginShutdown(); release.resolve();
    expect((await cancelled).state).toBe("interrupted"); await shutdown; expect((await store.read(task.id)).state).toBe("interrupted");
  });

  it("strictly advances task, event, and recovery timestamps under a backward clock", async () => {
    let clock = Date.parse("2030-01-01T00:00:10.000Z"); const now = () => { clock -= 1_000; return new Date(clock); }; const native = runtime();
    const writes: Array<Pick<TaskRecord, "id" | "state" | "updatedAt">> = [];
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    class RecordingStore extends TaskStore {
      override async write(row: TaskRecord): Promise<void> {
        writes.push({ id: row.id, state: row.state, updatedAt: row.updatedAt });
        await super.write(row);
      }
    }
    const store = new RecordingStore(home); stores.push(store);
    const controller = new TaskController(store, new Map([["native", native.adapter]]), authority, fakeTaskScopeManager(), now); await controller.initialize();
    const task = await start(controller); await eventually(store, task.id, "running"); await native.context().emit({ code: "progress", message: "one" });
    native.result.resolve("done"); native.quiet.resolve(); const completed = await eventually(store, task.id, "completed");
    const taskTimes = writes.filter((row) => row.id === task.id)
      .map((row) => Date.parse(row.updatedAt));
    expect(taskTimes.every((time, index) => index === 0 || time > taskTimes[index - 1]!))
      .toBe(true);
    expect(completed.events.every((event, index) => index === 0
      ? Date.parse(event.at) > Date.parse(completed.createdAt)
      : event.at > completed.events[index - 1]!.at)).toBe(true);

    const pending = record("running"); pending.createdAt = "2040-01-01T00:00:00.000Z"; pending.updatedAt = "2040-01-01T00:00:05.000Z"; await store.write(pending);
    const recovery = new TaskController(store, new Map(), authority, fakeTaskScopeManager(), () => new Date("2020-01-01T00:00:00.000Z"));
    const recovered = await recovery.initialize(); expect(recovered.find((row) => row.id === pending.id)?.updatedAt).toBe("2040-01-01T00:00:05.001Z");
  });

  it("recovers every nonterminal state with a generation fence and skips unrelated names", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-")); const store = trackedStore(home); await store.initialize();
    const rows = [record("queued"), record("starting"), record("running"), record("cancelling"), record("completed")]; for (const row of rows) await store.write(row);
    await writeFile(join(home, ".tasks", "task-not-a-record.json"), "foreign", { mode: 0o600 });
    const ownership = fakeTaskScopeManager();
    const controller = new TaskController(store, new Map(), authority, ownership); const recovered = await controller.initialize();
    expect(recovered.filter((row) => row.state === "interrupted")).toHaveLength(4); expect(recovered.filter((row) => row.state === "interrupted").every((row) => row.generation === 2)).toBe(true);
    expect(recovered.find((row) => row.id === rows[4]?.id)?.state).toBe("completed");
    expect([...ownership.stops].sort()).toEqual(rows.slice(0, 4).map((row) => row.id).sort());
  });

  it("attempts every recovery independently and interrupts only confirmed scopes", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    const store = trackedStore(home);
    await store.initialize();
    const rows = [record("running"), record("starting"), record("cancelling")];
    for (const row of rows) await store.write(row);
    const ownership = fakeTaskScopeManager();
    ownership.unconfirmed.add(rows[1]!.id);

    const controller = new TaskController(store, new Map(), authority, ownership);
    await expect(controller.initialize()).rejects.toMatchObject({
      code: "task_recovery_failed",
    });

    expect([...ownership.stops].sort()).toEqual(rows.map((row) => row.id).sort());
    expect(await readPersistedTask(home, rows[0]!.id)).toMatchObject({
      state: "interrupted",
      generation: 2,
    });
    expect(await readPersistedTask(home, rows[1]!.id)).toMatchObject({
      state: "starting",
      generation: 1,
    });
    expect(await readPersistedTask(home, rows[2]!.id)).toMatchObject({
      state: "interrupted",
      generation: 2,
    });
  });

  it("disposes every failed initialization before clearing it for a clean retry", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    const seed = trackedStore(home);
    await seed.initialize();
    const pending = record("running");
    await seed.write(pending);
    await seed.dispose();

    const disposeEntered = deferred<void>();
    const allowDispose = deferred<void>();
    class ObservedTaskStore extends TaskStore {
      disposals = 0;

      override async dispose(): Promise<void> {
        this.disposals += 1;
        disposeEntered.resolve();
        await allowDispose.promise;
        await super.dispose();
      }
    }
    const store = new ObservedTaskStore(home);
    stores.push(store);
    const ownership = fakeTaskScopeManager();
    ownership.unconfirmed.add(pending.id);
    const controller = new TaskController(store, new Map(), authority, ownership);

    const first = controller.initialize();
    const rejected = expect(first).rejects.toMatchObject({ code: "task_recovery_failed" });
    await disposeEntered.promise;
    expect(controller.initialize()).toBe(first);
    allowDispose.resolve();
    await rejected;
    expect(store.disposals).toBe(1);
    await expect(store.list()).rejects.toMatchObject({ code: "task_store_uninitialized" });

    await expect(controller.initialize()).rejects.toMatchObject({
      code: "task_recovery_failed",
    });
    expect(store.disposals).toBe(2);
    await expect(store.list()).rejects.toMatchObject({ code: "task_store_uninitialized" });

    ownership.unconfirmed.delete(pending.id);
    await expect(controller.initialize()).resolves.toEqual([
      expect.objectContaining({ id: pending.id, state: "interrupted" }),
    ]);
  });

  it("poisons initialization until a failed store close is retried successfully", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    let allowClose = false;
    let closes = 0;
    class PoisonedStore extends TaskStore {
      override async initialize(): Promise<void> {
        throw new Error("injected initialization failure");
      }
      override async dispose(): Promise<void> {
        closes += 1;
        if (!allowClose) throw new Error("injected close failure");
        await super.dispose();
      }
    }
    const store = new PoisonedStore(home);
    stores.push(store);
    const controller = new TaskController(
      store,
      new Map(),
      authority,
      fakeTaskScopeManager(),
    );
    const initialization = controller.initialize();
    await expect(initialization).rejects.toMatchObject({
      _tag: "TaskControllerPoisonedError",
    });
    expect(controller.poisoned).toBe(true);
    expect(controller.initialize()).toBe(initialization);
    expect(closes).toBe(1);
    allowClose = true;
    await controller.dispose();
    expect(controller.poisoned).toBe(false);
    expect(closes).toBe(2);
  });

  it("does not admit a retry when task-store disposal is unconfirmed", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    const seed = trackedStore(home);
    await seed.initialize();
    const pending = record("running");
    await seed.write(pending);
    await seed.dispose();

    class RefusingTaskStore extends TaskStore {
      attempts = 0;
      override async dispose(): Promise<void> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error("injected close failure");
        await super.dispose();
      }
    }
    const store = new RefusingTaskStore(home);
    stores.push(store);
    const nativeOwnership = fakeTaskScopeManager();
    nativeOwnership.unconfirmed.add(pending.id);
    const controller = new TaskController(store, new Map(), authority, nativeOwnership);

    const first = controller.initialize();
    await expect(first).rejects.toMatchObject({ _tag: "TaskControllerPoisonedError" });
    expect(controller.initialize()).toBe(first);
    expect(store.attempts).toBe(1);
  });

  it("retries scope confirmation after a crash window before recovery publication", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    let failInterruptedWrite = false;
    class RecoveryCrashStore extends TaskStore {
      override async write(row: TaskRecord): Promise<void> {
        if (failInterruptedWrite && row.state === "interrupted") {
          failInterruptedWrite = false;
          throw new Error("simulated recovery publication crash");
        }
        await super.write(row);
      }
    }
    const store = new RecoveryCrashStore(home);
    stores.push(store);
    await store.initialize();
    const pending = record("running");
    await store.write(pending);
    failInterruptedWrite = true;
    const firstOwnership = fakeTaskScopeManager();
    const first = new TaskController(store, new Map(), authority, firstOwnership);
    await expect(first.initialize()).rejects.toThrow();
    expect((await readPersistedTask(home, pending.id)).state).toBe("running");
    expect(firstOwnership.stops).toEqual([pending.id]);

    const secondOwnership = fakeTaskScopeManager();
    const second = new TaskController(store, new Map(), authority, secondOwnership);
    await expect(second.initialize()).resolves.toEqual([
      expect.objectContaining({ id: pending.id, state: "interrupted", generation: 2 }),
    ]);
    expect(secondOwnership.stops).toEqual([pending.id]);
  });

  it("leaves recovery nonterminal when the derived scope cannot be confirmed", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghost-task-"));
    const store = trackedStore(home);
    await store.initialize();
    const pending = record("running");
    await store.write(pending);
    const ownership = fakeTaskScopeManager();
    ownership.unconfirmed.add(pending.id);
    const controller = new TaskController(store, new Map(), authority, ownership);
    await expect(controller.initialize()).rejects.toThrow();
    expect(await readPersistedTask(home, pending.id)).toMatchObject({
      state: "running",
      generation: 1,
      error: null,
    });
    expect(ownership.stops).toEqual([pending.id]);
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
    await writeFile(path, JSON.stringify({ ...row, task: " \n\t " }), { mode: 0o600 }); await expect(store.read(row.id)).rejects.toMatchObject({ code: "invalid_task_record" });
    await writeFile(path, JSON.stringify({ ...row, agent: "claude-only" }), { mode: 0o600 }); await expect(store.read(row.id)).rejects.toMatchObject({ code: "invalid_task_record" });
    await writeFile(path, JSON.stringify({ ...row, harness: "claude-code", agent: "token=private-value" }), { mode: 0o600 }); await expect(store.read(row.id)).rejects.toMatchObject({ code: "invalid_task_record" });
    for (const invalidOwnership of [
      undefined,
      { ...row.ownership, nonce: "A".repeat(32) },
      { ...row.ownership, nonce: "0".repeat(31) },
      { ...row.ownership, extra: true },
    ]) {
      const malformed = { ...row, ownership: invalidOwnership };
      await writeFile(path, JSON.stringify(malformed), { mode: 0o600 });
      await expect(store.read(row.id)).rejects.toMatchObject({
        code: "invalid_task_record",
      });
    }
  });
});
