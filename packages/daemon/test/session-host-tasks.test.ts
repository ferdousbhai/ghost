import {
  existsSync,
  linkSync,
  lstatSync,
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
import { homeOperationsFor } from "../src/home-operations.js";
import { createLogger, type LogRecord } from "../src/log.js";
import { projectBindingPath, ProjectBindingStore } from "../src/project-binding.js";
import {
  SessionHost,
  sessionFileNameFor,
  type SessionHostOptions,
} from "../src/session-host.js";
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

function setup(options: {
  projectBindings?: ProjectBindingStore;
  maintenance?: SessionHostOptions["maintenance"];
  logger?: SessionHostOptions["logger"];
  transactionMarkerLstat?: SessionHostOptions["transactionMarkerLstat"];
  transactionWriter?: SessionHostOptions["transactionWriter"];
} = {}): {
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

function taskMaintenance(
  reserveConversationDelete: NonNullable<SessionHostOptions["maintenance"]>["reserveConversationDelete"],
): NonNullable<SessionHostOptions["maintenance"]> {
  const idleReservation = () => ({ drained: Promise.resolve(), release() {} });
  return {
    admitOwnerAction: () => ({
      ready: Promise.resolve(),
      async finish() {},
      release() {},
    }),
    async recordOwnerActivity() {},
    reserveConversationDelete,
    completeConversationDelete() {},
    reserveGhostMove: idleReservation,
    async completeGhostRename() {},
    completeGhostDelete() {},
    async beginShutdown() {},
    async disposeAll() {},
  };
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
    version: 2,
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
    ownership: {
      version: 1,
      kind: "systemd-scope",
      nonce: "11111111111111111111111111111111",
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
  it("rejects REST task access until the exact parent is durably published", async () => {
    const { ownerHome } = setup();
    await attachTasks();
    const parent = conversationIdentity("pi", "unpublished-task-parent");
    const project = join(ownerHome, "unpublished-project");
    mkdirSync(project);
    const preview = await host!.previewProject(
      "casper", parent.conversationId, parent.runtime, project,
    );
    await host!.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await expect(host!.listTasks("casper", parent)).rejects.toMatchObject({
      code: "task_parent_unpublished",
      status: 409,
    });
    await expect(host!.createTask("casper", parent, {
      harness: "pi",
      assignment: "Must not start before publication.",
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "task_parent_unpublished",
      status: 409,
    });
  });

  it("blocks every task surface behind delete, draft-abandon, and fork markers", async () => {
    const { home } = setup();
    await attachTasks();
    const parent = conversationIdentity("pi", "task-lifecycle-markers");
    writeConversation(home, parent.conversationId);
    const sessionDir = ghostPaths(home).sessionDir;
    const stem = sessionFileNameFor(parent.conversationId).slice(0, -".jsonl".length);
    const markers = [
      join(sessionDir, `.ghost-delete-${stem}.pi.pending.json`),
      join(sessionDir, `.ghost-draft-abandon-${stem}.pi.pending.json`),
      join(sessionDir, `.ghost-fork-${stem}.pending.json`),
    ];
    for (const marker of markers) {
      writeFileSync(marker, "{}", { mode: 0o600 });
      await expect(host!.listTasks("casper", parent)).rejects.toMatchObject({
        code: "session_busy",
        status: 409,
      });
      unlinkSync(marker);
    }
    await expect(host!.listTasks("casper", parent)).resolves.toEqual([]);
  });

  it("requires draft abandonment to have no delegated task history", async () => {
    const { home, ownerHome } = setup();
    await attachTasks();
    const parent = conversationIdentity("pi", "draft-with-worker-history");
    const project = join(ownerHome, "draft-worker-project");
    mkdirSync(project);
    const preview = await host!.previewProject(
      "casper", parent.conversationId, parent.runtime, project,
    );
    await host!.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    await writeTask(home, taskRecord(home, parent, "completed"));

    await expect(host!.abandonProjectDraft(
      "casper", parent.conversationId, parent.runtime,
    )).rejects.toMatchObject({ code: "tasks_present", status: 409 });
    expect(existsSync(projectBindingPath(
      ghostPaths(home).sessionDir,
      parent.runtime,
      parent.conversationId,
    ))).toBe(true);
    expect(readdirSync(ghostPaths(home).sessionDir).some((name) =>
      name.startsWith(".ghost-draft-abandon-"))).toBe(false);

    await expect(host!.deleteSession(
      "casper", parent.conversationId, parent.runtime,
    )).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "delegated-tasks", count: 1 }),
      ]),
    });
  });

  it.each(["absent", "present", "indeterminate"] as const)(
    "treats a failed delete marker publication as %s before deciding revocation",
    async (publication) => {
      let writeAttempted = false;
      const injected = new Error(`injected ${publication} delete marker failure`);
      const { home, ownerHome } = setup({
        transactionWriter: async (path, value) => {
          writeAttempted = true;
          if (publication === "present") {
            writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
          }
          throw injected;
        },
        transactionMarkerLstat: async (path) => {
          if (publication === "indeterminate"
            && writeAttempted
            && path.includes(".ghost-delete-")) {
            throw Object.assign(new Error("injected marker inspection failure"), {
              code: "EACCES",
            });
          }
          return lstatSync(path);
        },
      });
      const parent = conversationIdentity("pi", `delete-${publication}-barrier`);
      writeConversation(home, parent.conversationId);
      const project = join(ownerHome, `${publication}-delete-project`);
      mkdirSync(project);
      const preview = await host!.previewProject(
        "casper", parent.conversationId, parent.runtime, project,
      );
      await host!.bindProject("casper", parent.conversationId, parent.runtime, {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      const bindings = (host as unknown as { projectBindings: ProjectBindingStore })
        .projectBindings;
      const receipt = await bindings.mintTaskBinding(
        ghostPaths(home).sessionDir,
        parent,
      );
      const authority = bindings.taskBindingAuthority(
        ghostPaths(home).sessionDir,
        "casper",
      );

      await expect(host!.deleteSession(
        "casper", parent.conversationId, parent.runtime,
      )).rejects.toBe(injected);
      const launch = authority.launchNative(
        receipt,
        new AbortController().signal,
        parent,
        () => "admitted",
      );
      if (publication === "absent") await expect(launch).resolves.toBe("admitted");
      else await expect(launch).rejects.toMatchObject({ code: "task_binding_changed" });
    },
  );

  it.each(["absent", "present", "indeterminate"] as const)(
    "treats a failed draft marker publication as %s before deciding revocation",
    async (publication) => {
      let writeAttempted = false;
      const injected = new Error(`injected ${publication} draft marker failure`);
      const { home, ownerHome } = setup({
        transactionWriter: async (path, value) => {
          writeAttempted = true;
          if (publication === "present") {
            writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
          }
          throw injected;
        },
        transactionMarkerLstat: async (path) => {
          if (publication === "indeterminate"
            && writeAttempted
            && path.includes(".ghost-draft-abandon-")) {
            throw Object.assign(new Error("injected marker inspection failure"), {
              code: "EACCES",
            });
          }
          return lstatSync(path);
        },
      });
      const parent = conversationIdentity("pi", `draft-${publication}-barrier`);
      const project = join(ownerHome, `${publication}-draft-project`);
      mkdirSync(project);
      const preview = await host!.previewProject(
        "casper", parent.conversationId, parent.runtime, project,
      );
      await host!.bindProject("casper", parent.conversationId, parent.runtime, {
        root: project,
        trustToken: preview.trustToken,
        expectedGeneration: 0,
      });
      const bindings = (host as unknown as { projectBindings: ProjectBindingStore })
        .projectBindings;
      const receipt = await bindings.mintTaskBinding(
        ghostPaths(home).sessionDir,
        parent,
      );
      const authority = bindings.taskBindingAuthority(
        ghostPaths(home).sessionDir,
        "casper",
      );

      await expect(host!.abandonProjectDraft(
        "casper", parent.conversationId, parent.runtime,
      )).rejects.toBe(injected);
      const launch = authority.launchNative(
        receipt,
        new AbortController().signal,
        parent,
        () => "admitted",
      );
      if (publication === "absent") await expect(launch).resolves.toBe("admitted");
      else await expect(launch).rejects.toMatchObject({ code: "task_binding_changed" });
    },
  );

  it("settles every initial recovery before the boot barrier resolves", async () => {
    const { home } = setup();
    writeConversation(home, "recovered");
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

  it("retains a poisoned controller until its store can be confirmed closed", async () => {
    const { home } = setup();
    writeConversation(home, "poisoned-controller");
    let constructions = 0;
    let disposals = 0;
    let allowClose = false;
    class PoisonedStore extends TaskStore {
      override async initialize(): Promise<void> {
        throw new Error("injected initialization failure");
      }
      override async dispose(): Promise<void> {
        disposals += 1;
        if (!allowClose) throw new Error("injected close failure");
        await super.dispose();
      }
    }
    host!.attachTaskServices({
      adapters: new Map([["pi", controlledAdapter().adapter]]),
      ownership: fakeTaskScopeManager(),
      createStore: (storeHome) => {
        constructions += 1;
        return new PoisonedStore(storeHome);
      },
    });
    await host!.restoreTaskServices();
    const parent = conversationIdentity("pi", "poisoned-controller");
    const missing = "task-11111111-1111-4111-8111-111111111111";
    await expect(host!.task("casper", parent, missing)).rejects.toMatchObject({
      code: "tasks_unavailable",
    });
    await expect(host!.task("casper", parent, missing)).rejects.toMatchObject({
      code: "tasks_unavailable",
    });
    expect(constructions).toBe(1);
    expect(disposals).toBe(1);

    await expect(homeOperationsFor(temp!.registry).reserveMove("casper"))
      .rejects.toBeInstanceOf(Error);
    expect(existsSync(home)).toBe(true);
    expect(constructions).toBe(1);
    expect(disposals).toBe(2);
    allowClose = true;
  });

  it("drains concurrent controller operations before a home move and blocks later operations", async () => {
    const { home } = setup();
    const parent = conversationIdentity("pi", "task-home-move");
    writeConversation(home, parent.conversationId);
    const entered = Promise.withResolvers<void>();
    const releases = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ] as const;
    let delayReads = false;
    let delayedReads = 0;
    let constructions = 0;
    class DelayedStore extends TaskStore {
      override async list(): Promise<TaskRecord[]> {
        if (delayReads && delayedReads < releases.length) {
          const release = releases[delayedReads];
          if (!release) throw new Error("unexpected delayed task read");
          delayedReads += 1;
          if (delayedReads === releases.length) entered.resolve();
          await release.promise;
        }
        return super.list();
      }
    }
    host!.attachTaskServices({
      adapters: new Map([["pi", controlledAdapter().adapter]]),
      ownership: fakeTaskScopeManager(),
      createStore: (storeHome) => {
        constructions += 1;
        return constructions === 1
          ? new DelayedStore(storeHome)
          : new TaskStore(storeHome);
      },
    });
    await host!.restoreTaskServices();
    delayReads = true;

    const first = host!.listTasks("casper", parent);
    const second = host!.listTasks("casper", parent);
    await entered.promise;
    let moveReady = false;
    const moving = homeOperationsFor(temp!.registry).reserveMove("casper").then((release) => {
      moveReady = true;
      return release;
    });
    await Promise.resolve();
    expect(moveReady).toBe(false);

    releases[0].resolve();
    await Promise.resolve();
    expect(moveReady).toBe(false);
    releases[1].resolve();
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    const releaseMove = await moving;
    await expect(host!.listTasks("casper", parent)).rejects.toMatchObject({
      code: "ghost_busy",
      status: 409,
    });
    releaseMove();
    await expect(host!.listTasks("casper", parent)).resolves.toEqual([]);
    expect(constructions).toBe(2);
  });

  it("isolates boot recovery failures, starts the principal, and retries that ghost", async () => {
    temp = makeTempGhosts();
    const firstHome = seedGhost(temp.root, { name: "alpha" });
    const secondHome = seedGhost(temp.root, { name: "beta" });
    const records: LogRecord[] = [];
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      logger: createLogger("debug", (record) => records.push(record)),
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    const first = {
      ...recoveredRecord(firstHome),
      id: "task-11111111-1111-4111-8111-111111111111",
      parent: conversationIdentity("pi", "alpha-recovery"),
      ownership: {
        version: 1,
        kind: "systemd-scope",
        nonce: "11111111111111111111111111111111",
      },
    } as const satisfies TaskRecord;
    const second = {
      ...recoveredRecord(secondHome),
      id: "task-22222222-2222-4222-8222-222222222222",
      parent: conversationIdentity("pi", "beta-recovery"),
      ownership: {
        version: 1,
        kind: "systemd-scope",
        nonce: "22222222222222222222222222222222",
      },
    } as const satisfies TaskRecord;
    await writeTask(firstHome, first);
    await writeTask(secondHome, second);
    writeConversation(firstHome, first.parent.conversationId);
    writeConversation(secondHome, second.parent.conversationId);
    const ownership = fakeTaskScopeManager();
    ownership.unconfirmed.add(first.id);
    const adapter = controlledAdapter().adapter;
    host.attachTaskServices({
      adapters: new Map([["pi", adapter]]),
      ownership,
    });

    await expect(host.restoreTaskServices()).resolves.toBeUndefined();
    expect([...ownership.stops].sort()).toEqual([first.id, second.id].sort());
    await expect(host.task("beta", second.parent, second.id)).resolves.toMatchObject({
      state: "interrupted",
      generation: 3,
    });
    await expect(host.task("alpha", first.parent, first.id)).rejects.toMatchObject({
      code: "tasks_unavailable",
      status: 503,
      message: "Delegated coding tasks are unavailable.",
    });
    const principal = await host.open("alpha", "principal-still-starts");
    expect(principal.ghost.name).toBe("alpha");
    const taskList = principal.session.getToolDefinition("task_list");
    expect(taskList).toBeDefined();
    await expect(taskList!.execute(
      "failed-recovery",
      {},
      undefined,
      undefined,
      {} as never,
    )).rejects.toMatchObject({
      code: "tasks_unavailable",
      message: "Delegated coding tasks are unavailable.",
    });

    ownership.unconfirmed.delete(first.id);
    await expect(taskList!.execute(
      "retry-recovery",
      {},
      undefined,
      undefined,
      {} as never,
    )).resolves.toMatchObject({
      details: expect.objectContaining({ tasks: expect.any(Array) }),
    });
    await expect(host.task("alpha", first.parent, first.id)).resolves.toMatchObject({
      state: "interrupted",
      generation: 3,
    });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "warn",
        message: "delegated task recovery is unavailable",
        fields: { ghost: "alpha" },
      }),
      expect.objectContaining({
        level: "info",
        message: "delegated task recovery completed",
        fields: { ghost: "beta" },
      }),
    ]));
    expect(JSON.stringify(records)).not.toMatch(/ownership|receipt|scope|task-/u);
  });

  it("refuses every active task state before publishing deletion state", async () => {
    const reserveConversationDelete = vi.fn(() => ({
      drained: Promise.resolve(),
      release() {},
    }));
    const { home } = setup({
      maintenance: taskMaintenance(reserveConversationDelete),
    });
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
    expect(reserveConversationDelete).not.toHaveBeenCalled();
  });

  it("reserves and drains maintenance only after terminal task inspection", async () => {
    const drained = Promise.withResolvers<void>();
    const reserveConversationDelete = vi.fn(() => ({
      drained: drained.promise,
      release: vi.fn(),
    }));
    const { home } = setup({
      maintenance: taskMaintenance(reserveConversationDelete),
    });
    await attachTasks();
    const conversationId = "terminal-maintenance-drain";
    const parent = conversationIdentity("pi", conversationId);
    const transcript = writeConversation(home, conversationId);
    await writeTask(home, taskRecord(home, parent, "completed"));

    let settled = false;
    const deletion = host!.deleteSession("casper", conversationId, "pi")
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(reserveConversationDelete).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(existsSync(transcript)).toBe(true);
    drained.resolve();
    await expect(deletion).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact: "delegated-tasks", count: 1 }),
      ]),
    });
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
    await expect(host!.listTasks("casper", parent)).rejects.toMatchObject({
      code: "task_parent_unpublished",
    });
    const records = new TaskStore(ghostPaths(home).home);
    await records.initialize();
    expect((await records.list()).map((record) => record.id)).toEqual([foreign.id]);

    const replacement = taskRecord(home, parent, "completed");
    await writeTask(home, replacement);
    expect((await records.list()).map((record) => record.id).sort())
      .toEqual([foreign.id, replacement.id].sort());
    await records.dispose();
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
    const { home, ownerHome } = setup();
    const project = join(ownerHome, "project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "same-id");
    const otherRuntime = conversationIdentity("claude-code", "same-id");
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
    for (const agent of [" \n\t ", "bad\u0000agent", "token=private-value", "[REDACTED_SECRET]"]) {
      await expect(host!.createTask("casper", parent, {
        harness: "claude-code",
        assignment: "work",
        agent,
      }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_task_agent" });
    }
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
    await expect(host!.listTasks("casper", otherRuntime))
      .rejects.toMatchObject({ code: "task_parent_unpublished", status: 409 });

    await expect(host!.task("casper", otherRuntime, admitted.id))
      .rejects.toMatchObject({ code: "task_parent_unpublished", status: 409 });
    await expect(host!.sendTask("casper", otherRuntime, admitted.id, "wrong parent"))
      .rejects.toMatchObject({ code: "task_parent_unpublished", status: 409 });
    await expect(host!.cancelTask("casper", otherRuntime, admitted.id))
      .rejects.toMatchObject({ code: "task_parent_unpublished", status: 409 });
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

  it("revalidates a project rebind after catalogue work and before native spawn", async () => {
    const { home, ownerHome } = setup();
    const project = join(ownerHome, "lease-project");
    const original = join(project, "original");
    const rebound = join(project, "rebound");
    mkdirSync(original, { recursive: true });
    mkdirSync(rebound);
    const parent = conversationIdentity("pi", "launch-lease-rebind");
    writeConversation(home, parent.conversationId);
    const preview = await host!.previewProject(
      "casper", parent.conversationId, parent.runtime, project,
    );
    await host!.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      cwd: original,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const catalogueEntered = Promise.withResolvers<void>();
    const catalogueRelease = Promise.withResolvers<void>();
    let spawnedCwd: string | undefined;
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
        catalogueEntered.resolve();
        await catalogueRelease.promise;
        await context.launchNative([{
          path: "/bin/sh",
          identity: "0".repeat(64),
          literalBoundary: true,
        }], (spawn) => {
          spawnedCwd = input.cwd;
          return spawn({
            executable: "/bin/sh",
            args: ["-c", "while :; do sleep 10; done"],
            cwd: input.cwd,
            environment: { PATH: "/usr/bin:/bin" },
          });
        });
        return { result: new Promise<string>(() => undefined), async followUp() {} };
      },
    };
    host!.attachTaskServices({
      adapters: new Map([["pi", adapter]]),
      ownership: fakeTaskScopeManager(),
    });
    await host!.restoreTaskServices();
    const admitted = await host!.createTask("casper", parent, {
      harness: "pi",
      assignment: "Pause after the slow catalogue probe.",
    }, new AbortController().signal);
    await catalogueEntered.promise;

    const nextPreview = await host!.previewProject(
      "casper", parent.conversationId, parent.runtime, project,
    );
    await host!.bindProject("casper", parent.conversationId, parent.runtime, {
      root: project,
      cwd: rebound,
      trustToken: nextPreview.trustToken,
      expectedGeneration: 1,
    });
    catalogueRelease.resolve();
    const failed = await waitFor(
      () => host!.task("casper", parent, admitted.id),
      (record) => record.state === "failed",
    );
    expect(failed.error).toMatchObject({ code: "task_failed" });
    expect(spawnedCwd).toBeUndefined();
  });

  it("does not finish forced daemon shutdown before native quiescence", async () => {
    const { home, ownerHome } = setup();
    const project = join(ownerHome, "project");
    mkdirSync(project);
    const parent = conversationIdentity("pi", "forced");
    writeConversation(home, parent.conversationId);
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
    writeConversation(home, parent.conversationId);
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
