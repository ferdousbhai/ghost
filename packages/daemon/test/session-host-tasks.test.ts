import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { ghostPaths } from "../src/ghosts.js";
import { ProjectBindingStore } from "../src/project-binding.js";
import { SessionHost, sessionFileNameFor } from "../src/session-host.js";
import {
  TaskStore,
  type TaskAdapter,
  type TaskAdapterContext,
  type TaskAdapterHandle,
  type TaskRecord,
  type TaskState,
} from "../src/tasks.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fakeTaskScopeManager } from "./helpers/task-scope.js";

let temp: TempGhosts | undefined;
let host: SessionHost | undefined;

afterEach(async () => {
  await host?.disposeAll();
  host = undefined;
  temp?.cleanup();
  temp = undefined;
  vi.restoreAllMocks();
});

function setup(options: { projectBindings?: ProjectBindingStore } = {}): {
  home: string;
  ownerHome: string;
} {
  temp = makeTempGhosts();
  const home = seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    offline: true,
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    ...options,
  });
  return { home, ownerHome: temp.ownerHome };
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for task state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function recoveredRecord(home: string): TaskRecord {
  const at = "2026-08-30T00:00:00.000Z";
  return {
    version: 1,
    id: "task-11111111-1111-4111-8111-111111111111",
    generation: 2,
    parent: conversationIdentity("pi", "recovered"),
    harness: "pi",
    agent: null,
    task: "Recover me safely.",
    binding: {
      version: 1,
      root: home,
      rootIdentity: "1:1",
      cwd: home,
      cwdIdentity: "1:1",
      generation: 1,
    },
    state: "running",
    createdAt: at,
    updatedAt: at,
    events: [],
    eventCursor: { nextSequence: 1, dropped: 0 },
    result: null,
    resultTruncated: false,
    error: null,
  };
}

function taskRecord(
  home: string,
  parent: ReturnType<typeof conversationIdentity>,
  state: TaskState,
  id = `task-${randomUUID()}`,
): TaskRecord {
  const record = recoveredRecord(home);
  const failed = state === "failed" || state === "interrupted";
  return {
    ...record,
    id,
    parent,
    state,
    result: state === "completed" ? "Finished safely." : null,
    resultTruncated: false,
    error: failed
      ? { code: "worker_stopped", message: "The worker stopped safely." }
      : null,
  };
}

async function writeTask(home: string, record: TaskRecord): Promise<void> {
  const store = new TaskStore(ghostPaths(home).home);
  await store.initialize();
  try {
    await store.write(record);
  } finally {
    await store.dispose();
  }
}

function writeConversation(home: string, conversationId: string): string {
  const sessionDir = ghostPaths(home).sessionDir;
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, sessionFileNameFor(conversationId));
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

async function attachTasks(adapter = controlledAdapter().adapter): Promise<void> {
  host!.attachTaskServices({
    adapters: new Map([
      ["pi", adapter],
      ["claude-code", adapter],
    ]),
    ownership: fakeTaskScopeManager(),
  });
  await host!.restoreTaskServices();
}

function controlledAdapter(options: {
  forceGate?: Promise<void>;
  followUpGate?: Promise<void>;
} = {}): {
  adapter: TaskAdapter;
  followUps: string[];
  force: ReturnType<typeof vi.fn>;
  complete(result?: string): void;
} {
  const result = Promise.withResolvers<string>();
  const quiescence = Promise.withResolvers<void>();
  const followUps: string[] = [];
  const force = vi.fn(async () => {
    await options.forceGate;
    quiescence.resolve();
  });
  return {
    force,
    followUps,
    complete(value = "Finished safely.") {
      result.resolve(value);
      quiescence.resolve();
    },
    adapter: {
      start(
        _input,
        context: TaskAdapterContext,
      ): Promise<TaskAdapterHandle> {
        context.register({ force, quiescence: quiescence.promise });
        return Promise.resolve({
          result: result.promise,
          async followUp(message) {
            await options.followUpGate;
            followUps.push(message);
          },
        });
      },
    },
  };
}

describe("SessionHost delegated task composition", () => {
  it("settles every initial recovery before the boot barrier resolves", async () => {
    const { home } = setup();
    const store = new TaskStore(ghostPaths(home).home);
    await store.initialize();
    await store.write(recoveredRecord(home));
    await store.dispose();

    const controlled = controlledAdapter();
    host!.attachTaskServices({
      adapters: new Map([["pi", controlled.adapter]]),
      ownership: fakeTaskScopeManager(),
    });
    await expect(host!.restoreTaskServices()).resolves.toBeUndefined();
    await expect(host!.restoreTaskServices()).resolves.toBeUndefined();

    const recovered = await host!.task(
      "casper",
      conversationIdentity("pi", "recovered"),
      "task-11111111-1111-4111-8111-111111111111",
    );
    expect(recovered.state).toBe("interrupted");
    expect(recovered.generation).toBe(3);
    expect(recovered.error).toEqual({
      code: "daemon_restarted",
      message: "The daemon restarted before the task became quiescent.",
    });
  });

  it("refuses every active task state before publishing deletion state", async () => {
    const { home } = setup();
    await attachTasks();
    for (const state of ["queued", "starting", "running", "cancelling"] as const) {
      const conversationId = `active-${state}`;
      const parent = conversationIdentity("pi", conversationId);
      const transcript = writeConversation(home, conversationId);
      const record = taskRecord(home, parent, state);
      await writeTask(home, record);

      await expect(host!.deleteSession("casper", conversationId, "pi"))
        .rejects.toMatchObject({ code: "tasks_active", status: 409 });
      expect(existsSync(transcript)).toBe(true);
      expect(existsSync(join(ghostPaths(home).home, ".tasks", `${record.id}.json`))).toBe(true);
      expect(readdirSync(ghostPaths(home).sessionDir).some((name) =>
        name.includes(`ghost-delete-${conversationId}`))).toBe(false);
    }
  });

  it("moves terminal task history as one bounded qualified-parent bundle", async () => {
    const { home } = setup();
    await attachTasks();
    const rawId = "terminal-bundle";
    const parent = conversationIdentity("pi", rawId);
    const otherRuntime = conversationIdentity("claude-code", rawId);
    writeConversation(home, rawId);
    const terminal = (["completed", "failed", "cancelled", "interrupted"] as const)
      .map((state) => taskRecord(home, parent, state));
    const foreign = taskRecord(home, otherRuntime, "completed");
    for (const record of [...terminal, foreign]) await writeTask(home, record);

    const deleted = await host!.deleteSession("casper", rawId, "pi");
    const group = deleted.artifacts.find((artifact) => artifact.artifact === "delegated-tasks");
    expect(group).toMatchObject({
      artifact: "delegated-tasks",
      count: terminal.length,
      kind: "fallback",
      source: join(ghostPaths(home).home, ".tasks"),
    });
    expect(group?.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(readdirSync(group!.trash).sort()).toEqual(
      terminal.map((record) => `${record.id}.json`).sort(),
    );
    expect(await host!.listTasks("casper", parent)).toEqual([]);
    expect(await host!.listTasks("casper", otherRuntime)).toMatchObject([{ id: foreign.id }]);

    const replacement = taskRecord(home, parent, "completed");
    await writeTask(home, replacement);
    expect(await host!.listTasks("casper", parent)).toMatchObject([{ id: replacement.id }]);
    expect(readdirSync(group!.trash)).toHaveLength(terminal.length);
  });

  it("waits for start, follow-up, and cancel ownership before deleting", async () => {
    temp = makeTempGhosts();
    const home = seedGhost(temp.root, { name: "casper" });
    const mintEntered = Promise.withResolvers<void>();
    const mintRelease = Promise.withResolvers<void>();
    class DelayedProjectBindings extends ProjectBindingStore {
      override async mintTaskBinding(...args: Parameters<ProjectBindingStore["mintTaskBinding"]>) {
        mintEntered.resolve();
        await mintRelease.promise;
        return super.mintTaskBinding(...args);
      }
    }
    const bindings = new DelayedProjectBindings({ ownerHome: temp.ownerHome });
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      projectBindings: bindings,
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    const project = join(temp.ownerHome, "project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "task-delete-races");
    writeConversation(home, parent.conversationId);
    const preview = await host.previewProject(
      "casper",
      parent.conversationId,
      parent.runtime,
      project,
    );
    await host.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const followUpGate = Promise.withResolvers<void>();
    const forceGate = Promise.withResolvers<void>();
    const controlled = controlledAdapter({
      followUpGate: followUpGate.promise,
      forceGate: forceGate.promise,
    });
    await attachTasks(controlled.adapter);

    const creating = host.createTask("casper", parent, {
      harness: "pi",
      assignment: "Stay owned across deletion races.",
    }, new AbortController().signal);
    await mintEntered.promise;
    let deleteSettled = false;
    const duringStart = host.deleteSession("casper", parent.conversationId, "pi")
      .finally(() => { deleteSettled = true; });
    await Promise.resolve();
    expect(deleteSettled).toBe(false);
    mintRelease.resolve();
    const admitted = await creating;
    await expect(duringStart).rejects.toMatchObject({ code: "tasks_active" });

    await waitFor(
      () => host!.task("casper", parent, admitted.id),
      (record) => record.state === "running",
    );
    const sending = host.sendTask("casper", parent, admitted.id, "Check the race.");
    await Promise.resolve();
    deleteSettled = false;
    const duringSend = host.deleteSession("casper", parent.conversationId, "pi")
      .finally(() => { deleteSettled = true; });
    await Promise.resolve();
    expect(deleteSettled).toBe(false);
    followUpGate.resolve();
    await sending;
    await expect(duringSend).rejects.toMatchObject({ code: "tasks_active" });

    const cancelling = host.cancelTask("casper", parent, admitted.id);
    await Promise.resolve();
    deleteSettled = false;
    const duringCancel = host.deleteSession("casper", parent.conversationId, "pi")
      .finally(() => { deleteSettled = true; });
    await Promise.resolve();
    expect(deleteSettled).toBe(false);
    forceGate.resolve();
    await expect(cancelling).resolves.toMatchObject({ state: "cancelled" });
    await expect(duringCancel).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "delegated-tasks", count: 1 }),
      ]),
    });
  });

  it("resumes source-only, partial, and destination-only task bundle moves", async () => {
    for (const taskCount of [3, 1]) {
      temp = makeTempGhosts();
      const home = seedGhost(temp.root, { name: "casper" });
      let fail = true;
      host = new SessionHost({
        registry: temp.registry,
        ownerHome: temp.ownerHome,
        offline: true,
        scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
        transactionProbe: async (stage) => {
          if (stage === "delete-task-record-rename" && fail) {
            fail = false;
            throw new Error("injected task move crash");
          }
        },
      });
      await attachTasks();
      const conversationId = `task-recovery-${taskCount}`;
      const parent = conversationIdentity("pi", conversationId);
      writeConversation(home, conversationId);
      const records = Array.from({ length: taskCount }, () =>
        taskRecord(home, parent, "completed"));
      for (const record of records) await writeTask(home, record);

      await expect(host.deleteSession("casper", conversationId, "pi"))
        .rejects.toThrow("injected task move crash");
      const markerName = readdirSync(ghostPaths(home).sessionDir)
        .find((name) => name.startsWith(".ghost-delete-"));
      const marker = JSON.parse(readFileSync(
        join(ghostPaths(home).sessionDir, markerName!),
        "utf8",
      )) as { delegatedTasks: { trash: string } };
      expect(readdirSync(marker.delegatedTasks.trash)).toHaveLength(1);

      await expect(host.deleteSession("casper", conversationId, "pi"))
        .resolves.toMatchObject({
          artifacts: expect.arrayContaining([
            expect.objectContaining({ artifact: "delegated-tasks", count: taskCount }),
          ]),
        });
      expect(readdirSync(marker.delegatedTasks.trash)).toHaveLength(taskCount);
      await host.disposeAll();
      host = undefined;
      temp.cleanup();
      temp = undefined;
    }
  });

  it("resumes a recorded task bundle before its destination directory exists", async () => {
    temp = makeTempGhosts();
    const home = seedGhost(temp.root, { name: "casper" });
    let fail = true;
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
      transactionProbe: async (stage) => {
        if (stage === "delete-task-group-recorded" && fail) {
          fail = false;
          throw new Error("injected recorded-group crash");
        }
      },
    });
    await attachTasks();
    const conversationId = "task-source-only-recovery";
    const parent = conversationIdentity("pi", conversationId);
    writeConversation(home, conversationId);
    const records = [
      taskRecord(home, parent, "completed"),
      taskRecord(home, parent, "cancelled"),
    ];
    for (const record of records) await writeTask(home, record);

    await expect(host.deleteSession("casper", conversationId, "pi"))
      .rejects.toThrow("injected recorded-group crash");
    const markerName = readdirSync(ghostPaths(home).sessionDir)
      .find((name) => name.startsWith(".ghost-delete-"));
    const marker = JSON.parse(readFileSync(
      join(ghostPaths(home).sessionDir, markerName!),
      "utf8",
    )) as { delegatedTasks: { trash: string } };
    expect(existsSync(marker.delegatedTasks.trash)).toBe(false);
    for (const record of records) {
      expect(existsSync(join(ghostPaths(home).home, ".tasks", `${record.id}.json`))).toBe(true);
    }
    await expect(host.deleteSession("casper", conversationId, "pi"))
      .resolves.toMatchObject({
        artifacts: expect.arrayContaining([
          expect.objectContaining({ artifact: "delegated-tasks", count: 2 }),
        ]),
      });
  });

  it("keeps the deletion marker bounded as terminal task history grows", async () => {
    temp = makeTempGhosts();
    const home = seedGhost(temp.root, { name: "casper" });
    let fail = true;
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
      transactionProbe: async (stage) => {
        if (stage === "delete-task-group-recorded" && fail) {
          fail = false;
          throw new Error("inspect bounded task marker");
        }
      },
    });
    await attachTasks();
    const conversationId = "bounded-task-history";
    const parent = conversationIdentity("pi", conversationId);
    writeConversation(home, conversationId);
    const records = Array.from({ length: 64 }, () =>
      taskRecord(home, parent, "completed"));
    for (const record of records) await writeTask(home, record);
    await expect(host.deleteSession("casper", conversationId, "pi"))
      .rejects.toThrow("inspect bounded task marker");

    const markerName = readdirSync(ghostPaths(home).sessionDir)
      .find((name) => name.startsWith(".ghost-delete-"));
    const markerBytes = readFileSync(join(ghostPaths(home).sessionDir, markerName!));
    const markerText = markerBytes.toString("utf8");
    expect(markerBytes.byteLength).toBeLessThan(2_048);
    expect(JSON.parse(markerText)).toMatchObject({
      delegatedTasks: { artifact: "delegated-tasks", count: records.length },
    });
    expect(records.some((record) => markerText.includes(record.id))).toBe(false);
    await expect(host.deleteSession("casper", conversationId, "pi"))
      .resolves.toMatchObject({
        artifacts: expect.arrayContaining([
          expect.objectContaining({ artifact: "delegated-tasks", count: records.length }),
        ]),
      });
  });

  it("fails closed when recorded task bytes change before recovery", async () => {
    temp = makeTempGhosts();
    const home = seedGhost(temp.root, { name: "casper" });
    let fail = true;
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
      transactionProbe: async (stage) => {
        if (stage === "delete-task-group-recorded" && fail) {
          fail = false;
          throw new Error("retain task deletion marker");
        }
      },
    });
    await attachTasks();
    const conversationId = "task-digest-tamper";
    const parent = conversationIdentity("pi", conversationId);
    const transcript = writeConversation(home, conversationId);
    const record = taskRecord(home, parent, "completed");
    await writeTask(home, record);
    await expect(host.deleteSession("casper", conversationId, "pi"))
      .rejects.toThrow("retain task deletion marker");

    const store = new TaskStore(ghostPaths(home).home);
    await store.initialize();
    const changed = await store.read(record.id);
    changed.task = "A different but still valid terminal assignment.";
    await store.write(changed);
    await store.dispose();

    await expect(host.deleteSession("casper", conversationId, "pi"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
    expect(existsSync(transcript)).toBe(true);
    await expect(host.listTasks("casper", parent)).rejects.toMatchObject({
      code: "session_busy",
      status: 409,
    });
  });

  it("rejects linked task records before deletion publishes a tombstone", async () => {
    const { home } = setup();
    await attachTasks();
    const conversationId = "linked-task-record";
    const parent = conversationIdentity("pi", conversationId);
    const transcript = writeConversation(home, conversationId);
    const record = taskRecord(home, parent, "completed");
    await writeTask(home, record);
    const taskPath = join(ghostPaths(home).home, ".tasks", `${record.id}.json`);
    const alias = join(ghostPaths(home).home, ".tasks", "linked-record-alias");
    linkSync(taskPath, alias);
    await expect(host!.deleteSession("casper", conversationId, "pi"))
      .rejects.toMatchObject({ code: "unsafe_task_record" });
    expect(existsSync(transcript)).toBe(true);
    expect(readdirSync(ghostPaths(home).sessionDir).some((name) =>
      name.startsWith(".ghost-delete-"))).toBe(false);
    unlinkSync(alias);
  });

  it("rejects a symlinked task-group destination during recovery", async () => {
    temp = makeTempGhosts();
    const home = seedGhost(temp.root, { name: "casper" });
    let fail = true;
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
      transactionProbe: async (stage) => {
        if (stage === "delete-task-group-recorded" && fail) {
          fail = false;
          throw new Error("retain source-only task group");
        }
      },
    });
    await attachTasks();
    const conversationId = "symlinked-task-group";
    const parent = conversationIdentity("pi", conversationId);
    writeConversation(home, conversationId);
    await writeTask(home, taskRecord(home, parent, "completed"));
    await expect(host.deleteSession("casper", conversationId, "pi"))
      .rejects.toThrow("retain source-only task group");
    const markerName = readdirSync(ghostPaths(home).sessionDir)
      .find((name) => name.startsWith(".ghost-delete-"));
    const marker = JSON.parse(readFileSync(
      join(ghostPaths(home).sessionDir, markerName!),
      "utf8",
    )) as { delegatedTasks: { trash: string } };
    const target = join(home, ".trash", "foreign-task-directory");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, marker.delegatedTasks.trash, "dir");
    await expect(host.deleteSession("casper", conversationId, "pi"))
      .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
  });

  it("rejects both, missing, and wrong-parent task recovery inventories", async () => {
    for (const corruption of ["both", "missing", "wrong-parent"] as const) {
      temp = makeTempGhosts();
      const home = seedGhost(temp.root, { name: "casper" });
      let fail = true;
      host = new SessionHost({
        registry: temp.registry,
        ownerHome: temp.ownerHome,
        offline: true,
        scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
        transactionProbe: async (stage) => {
          if (stage === "delete-task-record-rename" && fail) {
            fail = false;
            throw new Error("retain destination-only task group");
          }
        },
      });
      await attachTasks();
      const conversationId = `task-${corruption}-recovery`;
      const parent = conversationIdentity("pi", conversationId);
      writeConversation(home, conversationId);
      const record = taskRecord(home, parent, "completed");
      await writeTask(home, record);
      await expect(host.deleteSession("casper", conversationId, "pi"))
        .rejects.toThrow("retain destination-only task group");
      const markerName = readdirSync(ghostPaths(home).sessionDir)
        .find((name) => name.startsWith(".ghost-delete-"));
      const marker = JSON.parse(readFileSync(
        join(ghostPaths(home).sessionDir, markerName!),
        "utf8",
      )) as { delegatedTasks: { trash: string } };
      const source = join(ghostPaths(home).home, ".tasks", `${record.id}.json`);
      const destination = join(marker.delegatedTasks.trash, `${record.id}.json`);
      if (corruption === "both") {
        writeFileSync(source, readFileSync(destination), { mode: 0o600 });
      } else if (corruption === "missing") {
        unlinkSync(destination);
      } else {
        const wrong = JSON.parse(readFileSync(destination, "utf8")) as TaskRecord;
        wrong.parent = conversationIdentity("claude-code", conversationId);
        writeFileSync(destination, `${JSON.stringify(wrong)}\n`, { mode: 0o600 });
      }
      await expect(host.deleteSession("casper", conversationId, "pi"))
        .rejects.toMatchObject({ code: "delete_recovery_pending", status: 500 });
      await host.disposeAll();
      host = undefined;
      temp.cleanup();
      temp = undefined;
    }
  });

  it("allows completion to win or requires one bounded retry without losing history", async () => {
    const { home } = setup();
    const controlled = controlledAdapter();
    await attachTasks(controlled.adapter);
    const project = join(temp!.ownerHome, "completion-project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "completion-delete-race");
    writeConversation(home, parent.conversationId);
    const preview = await host!.previewProject(
      "casper",
      parent.conversationId,
      parent.runtime,
      project,
    );
    await host!.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const admitted = await host!.createTask("casper", parent, {
      harness: "pi",
      assignment: "Finish while deletion is admitted.",
    }, new AbortController().signal);
    await waitFor(
      () => host!.task("casper", parent, admitted.id),
      (row) => row.state === "running",
    );

    controlled.complete("The completion survived the race.");
    let deleted: Awaited<ReturnType<SessionHost["deleteSession"]>>;
    try {
      deleted = await host!.deleteSession("casper", parent.conversationId, "pi");
    } catch (error) {
      expect(error).toMatchObject({ code: "tasks_active", status: 409 });
      await waitFor(
        () => host!.task("casper", parent, admitted.id),
        (row) => row.state === "completed",
      );
      deleted = await host!.deleteSession("casper", parent.conversationId, "pi");
    }
    expect(deleted).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "delegated-tasks", count: 1 }),
      ]),
    });
  });

  it("creates, observes, steers, and cancels only for the exact qualified parent", async () => {
    const { ownerHome } = setup();
    const project = join(ownerHome, "project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "same-id");
    const otherRuntime = conversationIdentity("claude-code", "same-id");
    const preview = await host!.previewProject(
      "casper",
      parent.conversationId,
      parent.runtime,
      project,
    );
    await host!.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const controlled = controlledAdapter();
    host!.attachTaskServices({
      adapters: new Map([["pi", controlled.adapter]]),
      ownership: fakeTaskScopeManager(),
    });
    await host!.restoreTaskServices();

    await expect(host!.createTask("casper", parent, {
      harness: "pi",
      assignment: " \n\t ",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_task" });
    await expect(host!.createTask("casper", parent, {
      harness: "pi",
      assignment: "work",
      agent: "claude-only",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_task_agent" });
    expect(await host!.listTasks("casper", parent)).toEqual([]);

    const admitted = await host!.createTask("casper", parent, {
      harness: "pi",
      assignment: "Implement the bounded change.",
    }, new AbortController().signal);
    const running = await waitFor(
      () => host!.task("casper", parent, admitted.id),
      (record) => record.state === "running",
    );
    expect(running.binding.cwd).toBe(project);
    expect(await host!.listTasks("casper", parent)).toHaveLength(1);
    expect(await host!.listTasks("casper", otherRuntime)).toEqual([]);

    await expect(host!.task("casper", otherRuntime, admitted.id))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });
    await expect(host!.sendTask("casper", otherRuntime, admitted.id, "wrong parent"))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });
    await expect(host!.cancelTask("casper", otherRuntime, admitted.id))
      .rejects.toMatchObject({ code: "task_not_found", status: 404 });
    expect(controlled.followUps).toEqual([]);
    expect(controlled.force).not.toHaveBeenCalled();

    await expect(host!.sendTask("casper", parent, admitted.id, " \n\t "))
      .rejects.toMatchObject({ code: "invalid_task" });
    expect(controlled.followUps).toEqual([]);

    await expect(host!.sendTask("casper", parent, admitted.id, "Run the focused test."))
      .resolves.toMatchObject({ state: "running" });
    expect(controlled.followUps).toEqual(["Run the focused test."]);
    await expect(host!.cancelTask("casper", parent, admitted.id))
      .resolves.toMatchObject({ state: "cancelled" });
    expect(controlled.force).toHaveBeenCalledOnce();
  });

  it("does not finish forced daemon shutdown before native quiescence", async () => {
    const { ownerHome } = setup();
    const project = join(ownerHome, "project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "forced");
    const preview = await host!.previewProject("casper", "forced", "pi", project);
    await host!.bindProject("casper", "forced", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const gate = Promise.withResolvers<void>();
    const controlled = controlledAdapter({ forceGate: gate.promise });
    host!.attachTaskServices({
      adapters: new Map([["pi", controlled.adapter]]),
      ownership: fakeTaskScopeManager(),
    });
    await host!.restoreTaskServices();
    const admitted = await host!.createTask("casper", parent, {
      harness: "pi",
      assignment: "Remain active until forced.",
    }, new AbortController().signal);
    await waitFor(
      () => host!.task("casper", parent, admitted.id),
      (record) => record.state === "running",
    );

    let settled = false;
    const forced = host!.forceDisposeAll().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controlled.force).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    gate.resolve();
    await forced;
    expect(settled).toBe(true);
  });

  it("fences a task whose binding mint crosses synchronous host shutdown", async () => {
    temp = makeTempGhosts();
    const home = seedGhost(temp.root, { name: "casper" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class DelayedProjectBindings extends ProjectBindingStore {
      override async mintTaskBinding(...args: Parameters<ProjectBindingStore["mintTaskBinding"]>) {
        entered.resolve();
        await release.promise;
        return super.mintTaskBinding(...args);
      }
    }
    const projectBindings = new DelayedProjectBindings({ ownerHome: temp.ownerHome });
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      projectBindings,
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    const project = join(temp.ownerHome, "project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "shutdown-race");
    const preview = await host.previewProject("casper", "shutdown-race", "pi", project);
    await host.bindProject("casper", "shutdown-race", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const ownership = fakeTaskScopeManager();
    const controlled = controlledAdapter();
    host.attachTaskServices({
      adapters: new Map([["pi", controlled.adapter]]),
      ownership,
    });
    await host.restoreTaskServices();

    const creation = host.createTask("casper", parent, {
      harness: "pi",
      assignment: "Must not escape shutdown.",
    }, new AbortController().signal);
    await entered.promise;
    const shutdown = host.forceDisposeAll();
    release.resolve();
    await expect(creation).rejects.toMatchObject({ code: "tasks_shutting_down" });
    await expect(shutdown).resolves.toBeUndefined();
    expect(ownership.reservations).toEqual([]);

    const records = new TaskStore(ghostPaths(home).home);
    await records.initialize();
    expect(await records.list()).toEqual([]);
    await records.dispose();
  });
});
