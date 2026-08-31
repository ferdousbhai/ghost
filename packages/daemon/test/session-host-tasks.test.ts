import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import { ghostPaths } from "../src/ghosts.js";
import { SessionHost } from "../src/session-host.js";
import {
  TaskStore,
  type TaskAdapter,
  type TaskAdapterContext,
  type TaskAdapterHandle,
  type TaskRecord,
} from "../src/tasks.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | undefined;
let host: SessionHost | undefined;

afterEach(async () => {
  await host?.disposeAll();
  host = undefined;
  temp?.cleanup();
  temp = undefined;
  vi.restoreAllMocks();
});

function setup(): { home: string; ownerHome: string } {
  temp = makeTempGhosts();
  const home = seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    offline: true,
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
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

function controlledAdapter(options: { forceGate?: Promise<void> } = {}): {
  adapter: TaskAdapter;
  followUps: string[];
  force: ReturnType<typeof vi.fn>;
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
    adapter: {
      start(
        _input,
        context: TaskAdapterContext,
      ): Promise<TaskAdapterHandle> {
        context.register({ force, quiescence: quiescence.promise });
        return Promise.resolve({
          result: result.promise,
          async followUp(message) {
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
    host!.attachTaskServices({ adapters: new Map([["pi", controlled.adapter]]) });
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
    host!.attachTaskServices({ adapters: new Map([["pi", controlled.adapter]]) });
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
    host!.attachTaskServices({ adapters: new Map([["pi", controlled.adapter]]) });
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
});
