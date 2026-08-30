import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { ghostPaths } from "../src/ghosts.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import {
  MAX_TASK_EVENT_TEXT_LENGTH,
  MAX_TASK_PROMPT_LENGTH,
  MAX_TASK_RECORD_BYTES,
  MAX_TASK_RESULT_LENGTH,
  TaskManager,
  WorkerStoppedError,
  type WorkerAdapter,
  type WorkerAdapterEvent,
  type WorkerTaskRequest,
} from "../src/tasks.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

interface ControlledRun {
  request: WorkerTaskRequest;
  emit(event: WorkerAdapterEvent): Promise<void>;
  sent: string[];
  cancelled: boolean;
  resolve(text: string, nativeSessionId?: string): void;
  reject(error: Error): void;
}

function controlledAdapter(id: WorkerAdapter["id"] = "pi-worker"): {
  adapter: WorkerAdapter;
  runs: ControlledRun[];
} {
  const runs: ControlledRun[] = [];
  return {
    runs,
    adapter: {
      id,
      start: async (request, context) => {
        const result = Promise.withResolvers<{ text: string; nativeSessionId?: string }>();
        const run: ControlledRun = {
          request,
          emit: context.emit,
          sent: [],
          cancelled: false,
          resolve: (text, nativeSessionId) => result.resolve({
            text,
            ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
          }),
          reject: result.reject,
        };
        runs.push(run);
        return {
          nativeSessionId: `native-${request.taskId}`,
          result: result.promise,
          send: (text) => { run.sent.push(text); },
          cancel: () => { run.cancelled = true; },
        };
      },
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

async function untilTaskState(manager: TaskManager, taskId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await manager.get("casper", taskId)).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`task did not reach ${state}`);
}

let temp: TempGhosts | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function setup(adapter: WorkerAdapter, now: () => number = Date.now): {
  manager: TaskManager;
  homeOperations: HomeOperationCoordinator;
  root: string;
  cwd: string;
} {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  const root = join(temp.root, "project");
  const cwd = join(root, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  const homeOperations = new HomeOperationCoordinator(temp.registry);
  return {
    root,
    cwd,
    homeOperations,
    manager: new TaskManager({
      registry: temp.registry,
      adapters: [adapter],
      homeOperations,
      now,
      resolveContext: async (input) => {
        expect(input.ghostName).toBe("casper");
        expect(input.parent).toEqual(conversationIdentity("pi", "conversation-1"));
        return { root, cwd: input.requestedCwd ?? cwd };
      },
    }),
  };
}

const parent = conversationIdentity("pi", "conversation-1");

describe("TaskManager lifecycle", () => {
  it("runs tasks without a concurrency cap and persists bounded normalized results", async () => {
    const controlled = controlledAdapter();
    const { manager, root, cwd } = setup(controlled.adapter);

    const first = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Implement the parser.",
    });
    const second = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Review the tests.",
    });
    await until(() => controlled.runs.length === 2);
    expect(controlled.runs.map((run) => run.request.taskId)).toEqual([first.id, second.id]);
    expect(controlled.runs[0]?.request).toMatchObject({
      ghostName: "casper",
      root,
      cwd,
      task: "Implement the parser.",
    });

    await controlled.runs[0]!.emit({ type: "output", text: "working\n" });
    controlled.runs[0]!.resolve("Implemented.", "pi-native-1");
    controlled.runs[1]!.resolve("Reviewed.");

    await expect(manager.wait("casper", first.id)).resolves.toMatchObject({
      state: "completed",
      result: "Implemented.",
      nativeSessionId: "pi-native-1",
      events: expect.arrayContaining([expect.objectContaining({ type: "output", text: "working\n" })]),
    });
    await expect(manager.wait("casper", second.id)).resolves.toMatchObject({
      state: "completed",
      result: "Reviewed.",
    });

    const list = await manager.list("casper");
    expect(list.skipped).toEqual([]);
    expect(list.tasks).toHaveLength(2);
    expect(list.tasks.map((task) => task.taskPreview).sort()).toEqual([
      "Implement the parser.",
      "Review the tests.",
    ]);

    const reopened = new TaskManager({ registry: temp!.registry });
    await expect(reopened.get("casper", first.id)).resolves.toMatchObject({
      state: "completed",
      result: "Implemented.",
    });
  });

  it("bridges waiting, steering, and cancellation without affecting sibling tasks", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const first = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Choose an implementation.",
    });
    const second = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Keep working.",
    });
    await until(() => controlled.runs.length === 2);

    await controlled.runs[0]!.emit({ type: "waiting_for_owner", text: "Which API?" });
    await expect(manager.get("casper", first.id)).resolves.toMatchObject({
      state: "waiting_for_owner",
    });
    await expect(manager.send("casper", first.id, "Use the stable API.")).resolves.toMatchObject({
      state: "running",
    });
    expect(controlled.runs[0]!.sent).toEqual(["Use the stable API."]);

    await expect(manager.cancel("casper", first.id)).resolves.toMatchObject({
      outcome: "cancelled",
      task: { state: "cancelled" },
    });
    expect(controlled.runs[0]!.cancelled).toBe(true);
    expect(controlled.runs[1]!.cancelled).toBe(false);
    controlled.runs[0]!.resolve("late result that must be ignored");
    controlled.runs[1]!.resolve("sibling completed");
    await expect(manager.wait("casper", first.id)).resolves.toMatchObject({
      state: "cancelled",
      result: null,
    });
    await expect(manager.wait("casper", second.id)).resolves.toMatchObject({
      state: "completed",
      result: "sibling completed",
    });
    await expect(manager.cancel("casper", first.id)).resolves.toMatchObject({
      outcome: "already_settled",
    });
  });

  it("does not persist a steering acknowledgement that loses to cancellation", async () => {
    const controlled = controlledAdapter();
    const sendStarted = Promise.withResolvers<void>();
    const releaseSend = Promise.withResolvers<void>();
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async (request, context) => {
        const controller = await controlled.adapter.start(request, context);
        return {
          ...controller,
          send: async (text) => {
            controlled.runs[0]!.sent.push(text);
            sendStarted.resolve();
            await releaseSend.promise;
          },
        };
      },
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Accept guidance before stopping.",
    });
    await untilTaskState(manager, task.id, "running");

    const message = manager.send("casper", task.id, "Use the stable API.");
    await sendStarted.promise;
    const cancellation = manager.cancel("casper", task.id);
    await until(() => controlled.runs[0]!.cancelled);
    releaseSend.resolve();

    const afterMessage = await message;
    expect(afterMessage.events.some((event) => event.type === "owner_message")).toBe(false);
    await expect(cancellation).resolves.toMatchObject({
      outcome: "cancelled",
      task: { state: "cancelled" },
    });
    expect(controlled.runs[0]!.cancelled).toBe(true);
  });

  it("records an accepted message when that message completes the worker", async () => {
    const controlled = controlledAdapter();
    const releaseSend = Promise.withResolvers<void>();
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async (request, context) => {
        const controller = await controlled.adapter.start(request, context);
        return {
          ...controller,
          send: async (text) => {
            controlled.runs[0]!.sent.push(text);
            controlled.runs[0]!.resolve("completed from guidance");
            await releaseSend.promise;
          },
        };
      },
    };
    const { manager, homeOperations } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Complete after guidance.",
    });
    await untilTaskState(manager, task.id, "running");

    const message = manager.send("casper", task.id, "Finish now.");
    await untilTaskState(manager, task.id, "completed");
    await expect(homeOperations.reserveMove("casper")).rejects.toMatchObject({
      code: "ghost_busy",
      status: 409,
    });
    releaseSend.resolve();

    await expect(message).resolves.toMatchObject({
      state: "completed",
      result: "completed from guidance",
      events: expect.arrayContaining([
        expect.objectContaining({ type: "owner_message", text: "Finish now." }),
      ]),
    });
    const releaseMove = await homeOperations.reserveMove("casper");
    releaseMove();
  });

  it("does not settle an abort-driven rejection before native cancellation confirms", async () => {
    const controlled = controlledAdapter();
    const acknowledgement = Promise.withResolvers<void>();
    let cancellationCalls = 0;
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async (request, context) => {
        const controller = await controlled.adapter.start(request, context);
        return {
          ...controller,
          cancel: () => {
            cancellationCalls += 1;
            return acknowledgement.promise;
          },
        };
      },
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Wait for native cancellation.",
    });
    await untilTaskState(manager, task.id, "running");

    const cancellation = manager.cancel("casper", task.id);
    await until(() => cancellationCalls === 1);
    controlled.runs[0]!.reject(new Error("aborted"));
    await expect(manager.get("casper", task.id)).resolves.toMatchObject({ state: "cancelling" });
    acknowledgement.resolve();

    await expect(cancellation).resolves.toMatchObject({
      outcome: "cancelled",
      task: { state: "cancelled" },
    });
    expect(cancellationCalls).toBe(1);
  });

  it("reports the actual terminal state when the worker finishes during cancellation", async () => {
    const controlled = controlledAdapter();
    const acknowledgement = Promise.withResolvers<void>();
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async (request, context) => ({
        ...(await controlled.adapter.start(request, context)),
        cancel: () => acknowledgement.promise,
      }),
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Allow an honest completion.",
    });
    await untilTaskState(manager, task.id, "running");

    const cancellation = manager.cancel("casper", task.id);
    await untilTaskState(manager, task.id, "cancelling");
    controlled.runs[0]!.resolve("completed before native cancellation");
    await untilTaskState(manager, task.id, "completed");
    acknowledgement.resolve();

    await expect(cancellation).resolves.toMatchObject({
      outcome: "already_settled",
      task: { state: "completed", result: "completed before native cancellation" },
    });
  });

  it("publishes durable state changes to subscribers", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Stream progress.",
    });
    const states: string[] = [];
    const unsubscribe = manager.subscribe("casper", task.id, (next) => states.push(next.state));
    await until(() => controlled.runs.length === 1);
    await controlled.runs[0]!.emit({ type: "notice", text: "halfway" });
    controlled.runs[0]!.resolve("done");
    await manager.wait("casper", task.id);
    unsubscribe();
    expect(states).toContain("running");
    expect(states.at(-1)).toBe("completed");
  });

  it("marks active durable state interrupted when a new manager restores the ghost", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Long-running work.",
    });
    await until(() => controlled.runs.length === 1);

    const restarted = new TaskManager({ registry: temp!.registry });
    await expect(restarted.restoreGhost("casper")).resolves.toEqual({ interrupted: 1, invalid: 0 });
    await expect(restarted.get("casper", task.id)).resolves.toMatchObject({
      state: "interrupted",
      error: { code: "daemon_restarted" },
    });

    // Let the old in-memory controller settle; its terminal write sees the
    // restored state and cannot overwrite the interruption.
    controlled.runs[0]!.resolve("late");
    await manager.wait("casper", task.id);
  });

  it("blocks whole-home moves while active and keeps settled state readable after rename", async () => {
    const controlled = controlledAdapter();
    const { manager, homeOperations } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Finish before this home moves.",
    });
    await until(() => controlled.runs.length === 1);

    await expect(homeOperations.reserveMove("casper")).rejects.toMatchObject({
      code: "ghost_busy",
      status: 409,
    });

    controlled.runs[0]!.resolve("done");
    await manager.wait("casper", task.id);
    const release = await homeOperations.reserveMove("casper");
    temp!.registry.rename("casper", "wisp");
    release();

    await expect(manager.get("wisp", task.id)).resolves.toMatchObject({
      state: "completed",
      result: "done",
    });
  });

  it("closes admission and drains acknowledged native cancellation on shutdown", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Stop during shutdown.",
    });
    await until(() => controlled.runs.length === 1);

    manager.beginShutdown();
    await expect(manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Too late.",
    })).rejects.toMatchObject({ code: "daemon_shutting_down", status: 503 });
    await manager.disposeAll();

    expect(controlled.runs[0]!.cancelled).toBe(true);
    await expect(manager.get("casper", task.id)).resolves.toMatchObject({ state: "cancelled" });
  });

  it("marks every bounded native projection when it truncates", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Return a large result.",
    });
    await until(() => controlled.runs.length === 1);
    await controlled.runs[0]!.emit({
      type: "output",
      text: "o".repeat(MAX_TASK_EVENT_TEXT_LENGTH + 1),
    });
    controlled.runs[0]!.resolve("r".repeat(MAX_TASK_RESULT_LENGTH + 1));

    const completed = await manager.wait("casper", task.id);
    expect(completed.result).toHaveLength(MAX_TASK_RESULT_LENGTH);
    expect(completed.resultTruncated).toBe(true);
    expect(completed.events.find((event) => event.type === "output")).toMatchObject({
      text: "o".repeat(MAX_TASK_EVENT_TEXT_LENGTH),
      textTruncated: true,
    });
  });

  it("keeps non-ASCII durable JSON within the private-file byte ceiling", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "\ud800".repeat(MAX_TASK_PROMPT_LENGTH),
    });
    await until(() => controlled.runs.length === 1);
    controlled.runs[0]!.resolve("\ud800".repeat(MAX_TASK_RESULT_LENGTH));

    const completed = await manager.wait("casper", task.id);
    expect(completed.resultTruncated).toBe(true);
    expect(completed.eventsTruncated).toBe(true);
    const taskFile = join(ghostPaths(temp!.registry.get("casper").dir).taskDir, `${task.id}.json`);
    expect(statSync(taskFile).size).toBeLessThanOrEqual(MAX_TASK_RECORD_BYTES);
    const reopened = new TaskManager({ registry: temp!.registry });
    await expect(reopened.get("casper", task.id)).resolves.toMatchObject({
      state: "completed",
      resultTruncated: true,
      eventsTruncated: true,
    });
  });

  it("keeps cancellation pending until a starting native controller confirms it", async () => {
    const started = Promise.withResolvers<Awaited<ReturnType<WorkerAdapter["start"]>>>();
    let cancelled = false;
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: () => started.promise,
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Start slowly.",
    });
    await untilTaskState(manager, task.id, "starting");

    await expect(manager.cancel("casper", task.id)).resolves.toMatchObject({
      outcome: "cancellation_requested",
      task: { state: "cancelling" },
    });
    started.resolve({
      result: new Promise(() => {}),
      cancel: () => { cancelled = true; },
    });

    await expect(manager.wait("casper", task.id)).resolves.toMatchObject({ state: "cancelled" });
    expect(cancelled).toBe(true);
  });

  it("delivers cancellation without waiting for an in-flight steering turn", async () => {
    const steering = Promise.withResolvers<void>();
    let steeringStarted = false;
    let cancelled = false;
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async () => ({
        result: new Promise(() => {}),
        send: () => {
          steeringStarted = true;
          return steering.promise;
        },
        cancel: () => { cancelled = true; },
      }),
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Wait for steering.",
    });
    await untilTaskState(manager, task.id, "running");
    const sending = manager.send("casper", task.id, "Take another turn.");
    await until(() => steeringStarted);

    await expect(manager.cancel("casper", task.id)).resolves.toMatchObject({
      outcome: "cancelled",
      task: { state: "cancelled" },
    });
    expect(cancelled).toBe(true);
    steering.reject(new Error("cancelled"));
    await expect(sending).rejects.toMatchObject({ code: "task_send_failed" });
  });

  it("force-stops a captured worker that is still initializing before detaching it", async () => {
    const neverStarted = Promise.withResolvers<Awaited<ReturnType<WorkerAdapter["start"]>>>();
    let forced = 0;
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: (_request, context) => {
        context.registerForce(() => { forced += 1; });
        return neverStarted.promise;
      },
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Initialize forever.",
    });
    await untilTaskState(manager, task.id, "starting");

    manager.forceDisposeAll();

    expect(forced).toBe(1);
    await untilTaskState(manager, task.id, "interrupted");
  });

  it("records a confirmed stopped-worker failure instead of masking it as cancellation", async () => {
    const failure = new WorkerStoppedError("native shutdown failed");
    const result = Promise.withResolvers<{ text: string }>();
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async () => ({
        result: result.promise,
        cancel: () => {
          result.reject(failure);
          throw failure;
        },
      }),
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Fail while stopping.",
    });
    await untilTaskState(manager, task.id, "running");

    await expect(manager.cancel("casper", task.id)).resolves.toMatchObject({
      outcome: "already_settled",
      task: {
        state: "failed",
        error: { code: "worker_failed", message: "native shutdown failed" },
      },
    });
  });
});

describe("TaskManager boundaries", () => {
  it("rejects unavailable workers, invalid contexts, and unbounded task input before persistence", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const empty = new TaskManager({ registry: temp.registry });
    await expect(empty.create({
      ghostName: "casper",
      parent,
      agent: "codex",
      task: "Do work.",
    })).rejects.toMatchObject({ code: "worker_unavailable", status: 503 });

    const controlled = controlledAdapter();
    const manager = new TaskManager({
      registry: temp.registry,
      adapters: [controlled.adapter],
      resolveContext: async () => ({ root: "/project", cwd: "/outside" }),
    });
    await expect(manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Do work.",
    })).rejects.toMatchObject({ code: "invalid_task_context", status: 409 });
    await expect(manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "   ",
    })).rejects.toMatchObject({ code: "invalid_task", status: 400 });
  });

  it("lists a malformed daemon record as skipped and rejects direct reads", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const taskDir = ghostPaths(temp!.registry.get("casper").dir).taskDir;
    mkdirSync(taskDir, { recursive: true });
    const id = "task-00000000-0000-4000-8000-000000000001";
    writeFileSync(join(taskDir, `${id}.json`), "{not json}\n", { mode: 0o600 });

    const list = await manager.list("casper");
    expect(list.skipped).toEqual([{ path: `.tasks/${id}.json`, reason: "task_state_invalid" }]);
    await expect(manager.get("casper", id)).rejects.toMatchObject({
      code: "task_state_invalid",
      status: 409,
    });
  });

  it("turns adapter failure into one durable terminal error", async () => {
    const controlled = controlledAdapter();
    const { manager } = setup(controlled.adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Fail cleanly.",
    });
    await until(() => controlled.runs.length === 1);
    await untilTaskState(manager, task.id, "running");
    controlled.runs[0]!.reject(new Error("fixture failure"));
    await expect(manager.wait("casper", task.id)).resolves.toMatchObject({
      state: "failed",
      error: { code: "worker_failed", message: "fixture failure" },
    });
  });

  it("stops a controller with invalid native identity before failing the task", async () => {
    let cancelled = false;
    const adapter: WorkerAdapter = {
      id: "pi-worker",
      start: async () => ({
        nativeSessionId: "x".repeat(2_001),
        result: new Promise(() => {}),
        cancel: () => { cancelled = true; },
      }),
    };
    const { manager } = setup(adapter);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Reject invalid controller metadata.",
    });

    await expect(manager.wait("casper", task.id)).resolves.toMatchObject({
      state: "failed",
      error: {
        code: "worker_failed",
        message: "The worker returned an invalid native session id.",
      },
    });
    expect(cancelled).toBe(true);
  });

  it("does not record or resume a message the native worker rejects", async () => {
    const controlled = controlledAdapter();
    const rejecting: WorkerAdapter = {
      id: "pi-worker",
      start: async (request, context) => {
        const controller = await controlled.adapter.start(request, context);
        return {
          ...controller,
          send: () => { throw new Error("not accepted"); },
        };
      },
    };
    const { manager } = setup(rejecting);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Wait for guidance.",
    });
    await until(() => controlled.runs.length === 1);
    await controlled.runs[0]!.emit({ type: "waiting_for_owner", text: "Which API?" });

    await expect(manager.send("casper", task.id, "Use stable.")).rejects.toMatchObject({
      code: "task_send_failed",
      status: 502,
    });
    const waiting = await manager.get("casper", task.id);
    expect(waiting.state).toBe("waiting_for_owner");
    expect(waiting.events.some((event) => event.type === "owner_message")).toBe(false);
  });

  it("keeps failed cancellation non-terminal until the native task actually settles", async () => {
    const controlled = controlledAdapter();
    const refusing: WorkerAdapter = {
      id: "pi-worker",
      start: async (request, context) => {
        const controller = await controlled.adapter.start(request, context);
        return {
          ...controller,
          cancel: () => { throw new Error("still running"); },
        };
      },
    };
    const { manager } = setup(refusing);
    const task = await manager.create({
      ghostName: "casper",
      parent,
      agent: "pi-worker",
      task: "Do not pretend cancellation worked.",
    });
    await until(() => controlled.runs.length === 1);
    await untilTaskState(manager, task.id, "running");

    await expect(manager.cancel("casper", task.id)).rejects.toMatchObject({
      code: "task_cancel_failed",
      status: 502,
    });
    await expect(manager.get("casper", task.id)).resolves.toMatchObject({
      state: "cancelling",
      error: { code: "cancellation_failed", message: "still running" },
    });

    controlled.runs[0]!.resolve("finished despite cancellation");
    await expect(manager.wait("casper", task.id)).resolves.toMatchObject({
      state: "completed",
      result: "finished despite cancellation",
      error: null,
    });
  });
});
