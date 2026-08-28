import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGhostHome } from "@ghost/extensions";
import {
  ConversationMaintenance,
  MEMORY_CONSOLIDATION_COOLDOWN_MS,
  MEMORY_CONSOLIDATION_FILE_THRESHOLD,
  maintenanceStatePath,
  memoryConsolidationStatePath,
  memoryNeedsConsolidation,
  type ConversationMaintenanceStateV1,
  type MaintenanceIdentity,
  type SettledMaintenanceTurn,
} from "../src/conversation-maintenance.js";
import { ghostPaths } from "../src/ghosts.js";
import { homeOperationsFor } from "../src/home-operations.js";
import { GhostHookRunner, type GhostConversationIdleEvent } from "../src/hooks.js";
import { claudeSessionMetadataPath, sessionFileNameFor } from "../src/session-files.js";
import { makeTempGhosts, type TempGhosts } from "./helpers/fixtures.js";

type MaintenanceUpdateInput = Parameters<NonNullable<
  ConstructorParameters<typeof ConversationMaintenance>[0]["update"]
>>[0];

let fixture: TempGhosts;
let homeDir: string;
const identity: MaintenanceIdentity = {
  ghostName: "casper",
  runtime: "pi",
  conversationId: "conversation-a",
};
const source = { runtime: "pi" as const, createdAt: "2026-08-27T08:00:00.000Z" };
const claudeSource = {
  runtime: "claude-code" as const,
  createdAt: "2026-08-27T08:00:00.000Z",
  resumeId: "sdk-resume-a",
};

beforeEach(() => {
  fixture = makeTempGhosts();
  fixture.registry.ensureRoot();
  homeDir = fixture.registry.create("casper").dir;
  mkdirSync(ghostPaths(homeDir).sessionDir, { recursive: true });
});

afterEach(() => fixture.cleanup());

function turn(position = 1): SettledMaintenanceTurn {
  return {
    source,
    sourceRevision: { kind: "pi-leaf", value: `leaf-${position}` },
    cwd: fixture.ownerHome,
    ownerPrompt: `Remember fact ${position}.`,
    assistantText: `I will remember fact ${position}.`,
    outcome: "completed",
  };
}

function seedPressureMemories(prefix: string): void {
  for (let position = 0; position < MEMORY_CONSOLIDATION_FILE_THRESHOLD; position += 1) {
    writeFileSync(
      join(homeDir, "memory", `${prefix}-${String(position).padStart(3, "0")}.md`),
      `Stable fact ${position}.\n`,
    );
  }
}

function statePath(): string {
  return maintenanceStatePath(ghostPaths(homeDir).sessionDir, "pi", identity.conversationId);
}

function readState(): ConversationMaintenanceStateV1 {
  return JSON.parse(readFileSync(statePath(), "utf8")) as ConversationMaintenanceStateV1;
}

function idleEvent(state: ConversationMaintenanceStateV1): GhostConversationIdleEvent {
  return {
    type: "conversation_idle",
    session_id: identity.conversationId,
    signal: new AbortController().signal,
    ghost_name: identity.ghostName,
    ghost_home: homeDir,
    cwd: fixture.ownerHome,
    runtime: "omp",
    conversation_id: identity.conversationId,
    conversation_runtime: "pi",
    conversation_incarnation: state.incarnation,
    sequence: state.lastSequence,
    source_revision: "pi-leaf:leaf-1",
    idle_for_ms: 60_000,
    last_turn_outcome: "completed",
  };
}

async function makeMaintenance(
  update: NonNullable<ConstructorParameters<typeof ConversationMaintenance>[0]["update"]>,
  options: Partial<Pick<
    ConstructorParameters<typeof ConversationMaintenance>[0],
    "schedule" | "idleSeconds" | "now"
  >> & { hooks?: GhostHookRunner } = {},
): Promise<{ maintenance: ConversationMaintenance; hooks: GhostHookRunner }> {
  const { hooks = new GhostHookRunner(), ...maintenanceOptions } = options;
  const maintenance = new ConversationMaintenance({
    registry: fixture.registry,
    homeOperations: homeOperationsFor(fixture.registry),
    hooks,
    withRuntime: async () => { throw new Error("test updater replaces the runtime"); },
    update,
    ...maintenanceOptions,
  });
  await hooks.register(maintenance.hookFactory);
  return { maintenance, hooks };
}

async function settle(maintenance: ConversationMaintenance, value = turn()): Promise<void> {
  const admission = maintenance.admitOwnerAction(identity);
  try {
    await admission.ready;
    await admission.finish(value);
  } finally {
    admission.release();
  }
}

describe("ConversationMaintenance", () => {
  it("detects index pressure before the hard memory-file threshold", () => {
    const files = Array.from({ length: 62 }, (_, position) => ({
      slug: `pressure-${String(position).padStart(3, "0")}`,
      description: "x".repeat(32),
      content: `Stable fact ${position}.`,
      updated: "2026-08-27T08:00:00.000Z",
    }));
    expect(memoryNeedsConsolidation(files.slice(0, 61))).toBe(false);
    expect(memoryNeedsConsolidation(files)).toBe(true);
  });

  it("journals one exact plain-Markdown memory receipt and acknowledges its notice once", async () => {
    const update = vi.fn(async ({ transcript, writeMemory }) => {
      expect(transcript).toContain("Remember fact 1.");
      await writeMemory({ name: "owner-fact", content: "The owner prefers Helix." });
    });
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const pending = readState();
    expect(pending).toMatchObject({
      version: 1,
      runtime: "pi",
      conversationId: "conversation-a",
      source,
      stateRevision: expect.any(Number),
      activityGeneration: 1,
      lastSequence: 1,
      lastSourceRevision: { kind: "pi-leaf", value: "leaf-1" },
      retainedThroughSequence: 0,
      pendingTurns: [{ sequence: 1 }],
      deliveredIdleRegistrations: [],
      maintenanceRetry: null,
      activeRun: null,
      activeMutation: null,
    });
    expect(pending.incarnation).toMatch(/^[0-9a-f-]{36}$/u);
    expect(readFileSync(statePath()).subarray(0, 1).toString()).toBe("{");
    await expect((await import("node:fs/promises")).stat(statePath()).then(({ mode }) => mode & 0o777))
      .resolves.toBe(0o600);

    await hooks.emitConversationIdle(idleEvent(pending));
    expect(readFileSync(`${homeDir}/memory/owner-fact.md`, "utf8"))
      .toBe("The owner prefers Helix.\n");
    const completed = readState();
    expect(completed.retainedThroughSequence).toBe(1);
    expect(completed.pendingTurns).toEqual([]);
    expect(completed.notices).toHaveLength(1);
    expect(completed.notices[0]?.context).toContain("memory/owner-fact.md");
    expect(completed.notices[0]?.context).not.toContain("The owner prefers Helix");

    const prompt = await hooks.emitBeforePrompt({
      type: "before_prompt",
      prompt: "Continue.",
      turn_id: 2,
      session_id: identity.conversationId,
      signal: new AbortController().signal,
      ghost_name: identity.ghostName,
      ghost_home: homeDir,
      cwd: fixture.ownerHome,
      runtime: "omp",
      conversation_id: identity.conversationId,
      conversation_runtime: "pi",
    });
    expect(prompt?.additionalContext).toContain("after_sha256=");
    expect(readState().notices).toHaveLength(1);
    await prompt?.acknowledge?.();
    expect(readState().notices).toEqual([]);
    await maintenance.disposeAll();
  });

  it("permits at most one successful memory write in a generation", async () => {
    const { maintenance, hooks } = await makeMaintenance(async ({ writeMemory }) => {
      await writeMemory({ name: "first", content: "First durable fact." });
      await expect(writeMemory({ name: "second", content: "Second durable fact." }))
        .rejects.toThrow("at most one successful memory write");
    });
    await settle(maintenance);
    await hooks.emitConversationIdle(idleEvent(readState()));
    expect(await openGhostHome(homeDir).listMemory()).toMatchObject({
      files: [{ slug: "first" }],
    });
    await maintenance.disposeAll();
  });

  it("runs consolidation under file pressure and observes the persisted six-hour cooldown", async () => {
    seedPressureMemories("pressure");
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const modes: string[] = [];
    const { maintenance, hooks } = await makeMaintenance(async ({ mode }) => {
      modes.push(mode);
    }, { now: () => new Date(nowMs) });

    await settle(maintenance, turn(1));
    await hooks.emitConversationIdle(idleEvent(readState()));
    expect(modes).toEqual(["consolidation"]);
    expect(JSON.parse(readFileSync(memoryConsolidationStatePath(homeDir), "utf8")))
      .toEqual({ version: 1, lastRunAt: "2026-08-27T08:00:00.000Z" });
    expect(statSync(memoryConsolidationStatePath(homeDir)).mode & 0o777).toBe(0o600);
    expect(readState().notices.at(-1)?.context).toContain("no memory changes");

    nowMs += 60_000;
    await settle(maintenance, turn(2));
    await hooks.emitConversationIdle(idleEvent(readState()));
    expect(modes).toEqual(["consolidation", "normal"]);

    nowMs += MEMORY_CONSOLIDATION_COOLDOWN_MS;
    await settle(maintenance, turn(3));
    await hooks.emitConversationIdle(idleEvent(readState()));
    expect(modes).toEqual(["consolidation", "normal", "consolidation"]);
    await maintenance.disposeAll();
  });

  it("enforces independent four-write and four-delete consolidation caps", async () => {
    seedPressureMemories("cap");
    const { maintenance, hooks } = await makeMaintenance(async ({
      mode,
      writeMemory,
      deleteMemory,
    }) => {
      expect(mode).toBe("consolidation");
      for (let position = 0; position < 4; position += 1) {
        await writeMemory({ name: `new-${position}`, content: `New fact ${position}.` });
        await deleteMemory(`cap-${String(position).padStart(3, "0")}`);
      }
      await expect(writeMemory({ name: "new-4", content: "A fifth write." }))
        .rejects.toThrow("at most 4 successful writes");
      await expect(deleteMemory("cap-004"))
        .rejects.toThrow("at most 4 successful deletes");
    });
    await settle(maintenance);
    await hooks.emitConversationIdle(idleEvent(readState()));
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      activeRun: null,
      activeMutation: null,
      notices: [{ context: expect.stringContaining("deleted memory/cap-000.md") }],
    });
    expect(readState().notices[0]?.context).toContain("created memory/new-3.md");
    await maintenance.disposeAll();
  });

  it("deduplicates an exact source revision and rejects stale Claude counters", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    await settle(maintenance);
    await settle(maintenance);
    expect(readState().lastSequence).toBe(1);

    const claudeIdentity = { ...identity, runtime: "claude-code" as const };
    const first = maintenance.admitOwnerAction(claudeIdentity);
    await first.ready;
    await first.finish({
      ...turn(),
      source: claudeSource,
      sourceRevision: { kind: "claude-owner-turn", value: 3 },
    });
    first.release();
    const stale = maintenance.admitOwnerAction(claudeIdentity);
    await stale.ready;
    await expect(stale.finish({
      ...turn(),
      source: claudeSource,
      sourceRevision: { kind: "claude-owner-turn", value: 2 },
    })).rejects.toMatchObject({ code: "maintenance_source_stale", status: 409 });
    stale.release();
    await maintenance.disposeAll();
  });

  it("rejects cross-runtime incoming source revisions without overwriting state", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    await settle(maintenance);
    const piBytes = readFileSync(statePath());
    const pi = maintenance.admitOwnerAction(identity);
    await pi.ready;
    await expect(pi.finish({
      ...turn(2),
      sourceRevision: { kind: "claude-owner-turn", value: 2 },
    })).rejects.toMatchObject({ code: "maintenance_state_invalid", status: 500 });
    pi.release();
    expect(readFileSync(statePath())).toEqual(piBytes);

    const claudeIdentity = { ...identity, runtime: "claude-code" as const };
    const claudePath = maintenanceStatePath(
      ghostPaths(homeDir).sessionDir,
      "claude-code",
      identity.conversationId,
    );
    const claude = maintenance.admitOwnerAction(claudeIdentity);
    await claude.ready;
    await expect(claude.finish({
      ...turn(),
      source: claudeSource,
      sourceRevision: { kind: "pi-leaf", value: "wrong-runtime-leaf" },
    })).rejects.toMatchObject({ code: "maintenance_state_invalid", status: 500 });
    claude.release();
    expect(() => readFileSync(claudePath)).toThrow();
    await maintenance.disposeAll();
  });

  it("rejects cross-runtime persisted last and pending source revisions", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    await settle(maintenance);
    const valid = readState();
    const variants: ConversationMaintenanceStateV1[] = [
      {
        ...valid,
        lastSourceRevision: { kind: "claude-owner-turn", value: 1 },
      },
      {
        ...valid,
        pendingTurns: valid.pendingTurns.map((pending) => ({
          ...pending,
          sourceRevision: { kind: "claude-owner-turn" as const, value: 1 },
        })),
      },
    ];
    for (const variant of variants) {
      const bytes = Buffer.from(`${JSON.stringify(variant)}\n`);
      writeFileSync(statePath(), bytes, { mode: 0o600 });
      await expect(maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
        restored: 0,
        invalid: 1,
      });
      expect(readFileSync(statePath())).toEqual(bytes);
    }
    await maintenance.disposeAll();
  });

  it("rejects malformed persisted idle delivery and retry state without repair", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    await settle(maintenance);
    const valid = readState();
    const missingActivityGeneration = { ...valid } as Partial<ConversationMaintenanceStateV1>;
    delete missingActivityGeneration.activityGeneration;
    const variants = [
      missingActivityGeneration,
      { ...valid, activityGeneration: -1 },
      { ...valid, deliveredIdleRegistrations: ["bad id with spaces"] },
      { ...valid, deliveredIdleRegistrations: ["same", "same"] },
      {
        ...valid,
        deliveredIdleRegistrations: [],
        maintenanceRetry: {
          kind: "memory",
          registrationId: "ghost.memory-maintenance.v1",
          dueAt: "2026-08-27T09:00:00.000Z",
        },
      },
      {
        ...valid,
        deliveredIdleRegistrations: ["ghost.memory-maintenance.v1"],
        maintenanceRetry: {
          kind: "other",
          registrationId: "ghost.memory-maintenance.v1",
          dueAt: "not-an-iso-time",
        },
      },
    ];
    for (const variant of variants) {
      const bytes = Buffer.from(`${JSON.stringify(variant)}\n`);
      writeFileSync(statePath(), bytes, { mode: 0o600 });
      await expect(maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
        restored: 0,
        invalid: 1,
      });
      expect(readFileSync(statePath())).toEqual(bytes);
    }
    await maintenance.disposeAll();
  });

  it("fails closed on a corrupt existing sidecar and never repairs it", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    writeFileSync(statePath(), "{}\n", { mode: 0o600 });
    const before = readFileSync(statePath());
    const admission = maintenance.admitOwnerAction(identity);
    await admission.ready;
    await expect(admission.finish(turn())).rejects.toMatchObject({
      code: "maintenance_state_invalid",
      status: 500,
    });
    admission.release();
    expect(readFileSync(statePath())).toEqual(before);
    await expect(maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
      restored: 0,
      invalid: 1,
    });
    expect(readFileSync(statePath())).toEqual(before);
    await maintenance.disposeAll();
  });

  it("rejects missing or cross-runtime persisted source identities", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    const claudeIdentity = { ...identity, runtime: "claude-code" as const };
    const admission = maintenance.admitOwnerAction(claudeIdentity);
    await admission.ready;
    await admission.finish({
      ...turn(),
      source: claudeSource,
      sourceRevision: { kind: "claude-owner-turn", value: 1 },
    });
    admission.release();
    const path = maintenanceStatePath(
      ghostPaths(homeDir).sessionDir,
      "claude-code",
      identity.conversationId,
    );
    const valid = JSON.parse(readFileSync(path, "utf8")) as ConversationMaintenanceStateV1;
    const invalidSources = [
      { runtime: "claude-code", createdAt: claudeSource.createdAt },
      { runtime: "pi", createdAt: claudeSource.createdAt },
    ];
    for (const invalidSource of invalidSources) {
      const bytes = Buffer.from(`${JSON.stringify({ ...valid, source: invalidSource })}\n`);
      writeFileSync(path, bytes, { mode: 0o600 });
      await expect(maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
        restored: 0,
        invalid: 1,
      });
      expect(readFileSync(path)).toEqual(bytes);
    }
    await maintenance.disposeAll();
  });

  it("treats hostile mode state as invalid instead of empty", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    writeFileSync(statePath(), "{}\n", { mode: 0o600 });
    chmodSync(statePath(), 0o640);
    const admission = maintenance.admitOwnerAction(identity);
    await admission.ready;
    await expect(admission.finish(turn())).rejects.toMatchObject({
      code: "maintenance_state_invalid",
      status: 500,
    });
    admission.release();
    expect(chmodSync(statePath(), 0o600)).toBeUndefined();
    await maintenance.disposeAll();
  });

  it("reserves conversation deletion and whole-home moves before a slot exists", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    const deletion = maintenance.reserveConversationDelete(identity);
    await deletion.drained;
    expect(() => maintenance.admitOwnerAction(identity)).toThrow(expect.objectContaining({
      code: "session_busy",
    }));
    deletion.release("rolled-back");

    const move = maintenance.reserveGhostMove(identity.ghostName);
    await move.drained;
    expect(() => maintenance.admitOwnerAction({
      ...identity,
      conversationId: "not-seen-before",
    })).toThrow(expect.objectContaining({ code: "session_busy" }));
    move.release();
    const admitted = maintenance.admitOwnerAction({
      ...identity,
      conversationId: "not-seen-before",
    });
    admitted.release();
    await maintenance.disposeAll();
  });

  it("re-arms durable pending work when a reserved deletion fails after aborting its run", async () => {
    const scheduled: Array<() => void> = [];
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runs = 0;
    const { maintenance } = await makeMaintenance(async () => {
      runs += 1;
      if (runs === 1) {
        started();
        await firstGate;
      }
    }, {
      schedule: (run) => {
        scheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
    });
    await settle(maintenance);
    scheduled[0]?.();
    await didStart;

    const deletion = maintenance.reserveConversationDelete(identity);
    releaseFirst();
    await deletion.drained;
    expect(readState()).toMatchObject({
      retainedThroughSequence: 0,
      pendingTurns: [{ sequence: 1 }],
      activeRun: null,
    });
    deletion.release("rolled-back");

    await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    scheduled[1]?.();
    await vi.waitFor(() => expect(runs).toBe(2));
    await vi.waitFor(() => expect(readState().retainedThroughSequence).toBe(1));
    await maintenance.disposeAll();
  });

  it("keeps a tombstone-owned failed deletion suppressed until an explicit retry outcome", async () => {
    const scheduled: Array<() => void> = [];
    const { maintenance } = await makeMaintenance(async () => {}, {
      schedule: (run) => {
        scheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
    });
    await settle(maintenance);
    expect(scheduled).toHaveLength(1);

    const failed = maintenance.reserveConversationDelete(identity);
    await failed.drained;
    failed.release("recovery-pending");
    expect(scheduled).toHaveLength(1);
    expect(() => maintenance.admitOwnerAction(identity)).toThrow(expect.objectContaining({
      code: "delete_recovery_pending",
      status: 500,
    }));

    const retry = maintenance.reserveConversationDelete(identity);
    await retry.drained;
    expect(() => maintenance.admitOwnerAction(identity)).toThrow(expect.objectContaining({
      code: "delete_recovery_pending",
    }));
    retry.release("rolled-back");
    await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    const admitted = maintenance.admitOwnerAction(identity);
    admitted.release();
    await maintenance.disposeAll();
  });

  it("coalesces stale timers so only the latest pending generation runs", async () => {
    const scheduled: Array<() => void> = [];
    const update = vi.fn(async (_input: MaintenanceUpdateInput) => {});
    const { maintenance } = await makeMaintenance(update, {
      schedule: (run) => {
        scheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
    });
    await settle(maintenance, turn(1));
    await settle(maintenance, turn(2));
    expect(scheduled).toHaveLength(2);
    scheduled[0]?.();
    scheduled[1]?.();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0].transcript).toContain("Remember fact 1.");
    expect(update.mock.calls[0]?.[0].transcript).toContain("Remember fact 2.");
    await maintenance.disposeAll();
  });

  it("owner admission aborts a run and waits even when the updater ignores abort", async () => {
    const scheduled: Array<() => void> = [];
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    let runs = 0;
    const { maintenance } = await makeMaintenance(async ({ signal }) => {
      runs += 1;
      started();
      expect(signal.aborted).toBe(false);
      await runGate;
    }, {
      schedule: (run) => {
        scheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
    });
    await settle(maintenance);
    scheduled[0]?.();
    await didStart;

    const admission = maintenance.admitOwnerAction(identity);
    let ready = false;
    void admission.ready.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    releaseRun();
    await admission.ready;
    expect(ready).toBe(true);
    await admission.finish();
    admission.release();
    expect(readState()).toMatchObject({
      retainedThroughSequence: 0,
      pendingTurns: [{ sequence: 1 }],
      activeRun: null,
    });
    expect(scheduled).toHaveLength(2);
    scheduled[1]?.();
    await vi.waitFor(() => expect(runs).toBe(2));
    await vi.waitFor(() => expect(readState().retainedThroughSequence).toBe(1));
    await maintenance.disposeAll();
  });

  it("publishes an exact receipt notice when the updater fails after its write", async () => {
    const { maintenance, hooks } = await makeMaintenance(async ({ writeMemory }) => {
      await writeMemory({ name: "partial", content: "The write completed first." });
      throw new Error("provider failed after the tool result");
    });
    await settle(maintenance);
    await hooks.emitConversationIdle(idleEvent(readState()));
    expect(readFileSync(`${homeDir}/memory/partial.md`, "utf8"))
      .toBe("The write completed first.\n");
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [],
      activeRun: null,
      activeMutation: null,
      notices: [{ context: expect.stringContaining("memory/partial.md") }],
    });
    await maintenance.disposeAll();
  });

  it("replays exact pre-rename journal bytes without rerunning a changed model", async () => {
    const update = vi.fn(async ({ writeMemory }) => {
      await writeMemory({ name: "replayed", content: "Different model output must never win." });
    });
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const pending = readState();
    const before = "\uFEFF  Earlier owner-authored fact stays byte-exact.  \n\n";
    const after = "Exact bytes selected before the crash.\n";
    writeFileSync(`${homeDir}/memory/replayed.md`, before);
    pending.activeRun = { id: randomUUID(), throughSequence: 1, receipts: [] };
    pending.activeMutation = {
      id: randomUUID(),
      path: "memory/replayed.md",
      before,
      after,
      beforeSha256: createHash("sha256").update(before).digest("hex"),
      afterSha256: createHash("sha256").update(after).digest("hex"),
    };
    writeFileSync(statePath(), `${JSON.stringify(pending)}\n`, { mode: 0o600 });

    await hooks.emitConversationIdle(idleEvent(pending));
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(`${homeDir}/memory/replayed.md`, "utf8")).toBe(after);
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [],
      activeRun: null,
      activeMutation: null,
      notices: [{ context: expect.stringContaining("memory/replayed.md") }],
    });
    await maintenance.disposeAll();
  });

  it("never re-deletes an ambiguous journaled delete during recovery", async () => {
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const before = "The owner still needs this fact.\n";
    const path = join(homeDir, "memory", "delete-recovery.md");
    writeFileSync(path, before);
    const state = readState();
    state.activeRun = {
      id: randomUUID(),
      throughSequence: 1,
      mode: "consolidation",
      receipts: [],
    };
    state.activeMutation = {
      id: randomUUID(),
      path: "memory/delete-recovery.md",
      before,
      beforeSha256: createHash("sha256").update(before).digest("hex"),
      trash: ".trash/delete-recovery.md",
    };
    writeFileSync(statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await hooks.emitConversationIdle(idleEvent(state));
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [],
      activeRun: null,
      activeMutation: null,
      notices: [{ context: expect.stringContaining("Recovery did not move or delete anything") }],
    });
    expect(() => readFileSync(join(homeDir, ".trash", "delete-recovery.md"), "utf8"))
      .toThrow();
    await maintenance.disposeAll();
  });

  it("classifies an already-renamed journaled delete and publishes its exact receipt", async () => {
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const home = openGhostHome(homeDir);
    await home.writeMemory({ name: "confirmed-delete", content: "A superseded fact." });
    let intent!: NonNullable<ConversationMaintenanceStateV1["activeMutation"]>;
    const deletion = await home.deleteMemoryWithReceipt("confirmed-delete", async (journaled) => {
      intent = journaled;
    });
    const state = readState();
    state.activeRun = {
      id: randomUUID(),
      throughSequence: 1,
      mode: "consolidation",
      receipts: [],
    };
    state.activeMutation = intent;
    writeFileSync(statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await hooks.emitConversationIdle(idleEvent(state));
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(join(homeDir, deletion.deleted.trash), "utf8"))
      .toBe("A superseded fact.\n");
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [],
      activeRun: null,
      activeMutation: null,
      notices: [{ context: expect.stringContaining("deleted memory/confirmed-delete.md") }],
    });
    await maintenance.disposeAll();
  });

  it("retains receipt recovery when the current memory exceeds its byte boundary", async () => {
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const state = readState();
    const before = "Expected prior bytes.\n";
    const after = "Receipt bytes must stay pending.\n";
    state.activeRun = {
      id: randomUUID(),
      throughSequence: 1,
      receipts: [{
        id: randomUUID(),
        path: "memory/oversized-receipt.md",
        before,
        after,
        beforeSha256: createHash("sha256").update(before).digest("hex"),
        afterSha256: createHash("sha256").update(after).digest("hex"),
        operation: "updated",
      }],
    };
    const oversized = `${"\u0800".repeat(2_000)}\n\n`;
    expect(Buffer.byteLength(oversized)).toBe(6_002);
    writeFileSync(`${homeDir}/memory/oversized-receipt.md`, oversized);
    writeFileSync(statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await hooks.emitConversationIdle(idleEvent(state));
    expect(readFileSync(`${homeDir}/memory/oversized-receipt.md`, "utf8")).toBe(oversized);
    expect(readState()).toMatchObject({
      retainedThroughSequence: 0,
      pendingTurns: [{ sequence: 1 }],
      activeRun: { throughSequence: 1, receipts: [{ after }] },
      activeMutation: null,
    });
    expect(update).not.toHaveBeenCalled();
    await maintenance.disposeAll();
  });

  it("completes already-published bytes but retains a third-value replay conflict", async () => {
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const pending = readState();
    const before = "Expected old bytes.\n";
    const after = "Journaled new bytes.\n";
    const intent = {
      id: randomUUID(),
      path: "memory/recovery-state.md" as const,
      before,
      after,
      beforeSha256: createHash("sha256").update(before).digest("hex"),
      afterSha256: createHash("sha256").update(after).digest("hex"),
    };
    pending.activeRun = { id: randomUUID(), throughSequence: 1, receipts: [] };
    pending.activeMutation = intent;
    writeFileSync(`${homeDir}/memory/recovery-state.md`, after);
    writeFileSync(statePath(), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    await hooks.emitConversationIdle(idleEvent(pending));
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [],
      activeRun: null,
      activeMutation: null,
    });

    await settle(maintenance, turn(2));
    const conflicting = readState();
    conflicting.activeRun = { id: randomUUID(), throughSequence: 2, receipts: [] };
    conflicting.activeMutation = {
      ...intent,
      id: randomUUID(),
      before: after,
      beforeSha256: intent.afterSha256,
      after: "Second journaled value.\n",
      afterSha256: createHash("sha256").update("Second journaled value.\n").digest("hex"),
    };
    writeFileSync(`${homeDir}/memory/recovery-state.md`, "Conflicting owner bytes.\n");
    writeFileSync(statePath(), `${JSON.stringify(conflicting)}\n`, { mode: 0o600 });
    await hooks.emitConversationIdle(idleEvent(conflicting));
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [{ sequence: 2 }],
      activeRun: { throughSequence: 2, receipts: [] },
      activeMutation: { after: "Second journaled value.\n" },
    });
    expect(readFileSync(`${homeDir}/memory/recovery-state.md`, "utf8"))
      .toBe("Conflicting owner bytes.\n");
    expect(update).not.toHaveBeenCalled();
    await maintenance.disposeAll();
  });

  it("verifies stored completed receipts against after, before, and conflicting current bytes", async () => {
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update);
    const path = `${homeDir}/memory/completed-receipt.md`;
    const receipt = (
      before: string | null,
      after: string,
    ) => ({
      id: randomUUID(),
      path: "memory/completed-receipt.md" as const,
      before,
      after,
      beforeSha256: before === null ? null : createHash("sha256").update(before).digest("hex"),
      afterSha256: createHash("sha256").update(after).digest("hex"),
      operation: before === null ? "created" as const : "updated" as const,
    });

    await settle(maintenance, turn(1));
    const firstAfter = "Already published before the receipt sidecar fsync.\n";
    const first = readState();
    first.activeRun = { id: randomUUID(), throughSequence: 1, receipts: [receipt(null, firstAfter)] };
    writeFileSync(path, firstAfter);
    writeFileSync(statePath(), `${JSON.stringify(first)}\n`, { mode: 0o600 });
    await hooks.emitConversationIdle(idleEvent(first));
    expect(readState()).toMatchObject({ retainedThroughSequence: 1, notices: [{ throughSequence: 1 }] });

    await settle(maintenance, turn(2));
    const secondAfter = "Exact receipt bytes replayed after a pre-rename crash.\n";
    const second = readState();
    second.activeRun = {
      id: randomUUID(),
      throughSequence: 2,
      receipts: [receipt(firstAfter, secondAfter)],
    };
    writeFileSync(path, firstAfter);
    writeFileSync(statePath(), `${JSON.stringify(second)}\n`, { mode: 0o600 });
    await hooks.emitConversationIdle(idleEvent(second));
    expect(readFileSync(path, "utf8")).toBe(secondAfter);
    expect(readState()).toMatchObject({
      retainedThroughSequence: 2,
      pendingTurns: [],
      notices: [{ throughSequence: 1 }, { throughSequence: 2 }],
    });

    await settle(maintenance, turn(3));
    const thirdAfter = "This receipt must not overwrite a later owner edit.\n";
    const third = readState();
    third.activeRun = {
      id: randomUUID(),
      throughSequence: 3,
      receipts: [receipt(secondAfter, thirdAfter)],
    };
    const ownerEdit = "The owner changed these bytes after the model write.\n";
    writeFileSync(path, ownerEdit);
    writeFileSync(statePath(), `${JSON.stringify(third)}\n`, { mode: 0o600 });
    await hooks.emitConversationIdle(idleEvent(third));
    expect(readFileSync(path, "utf8")).toBe(ownerEdit);
    expect(readState()).toMatchObject({
      retainedThroughSequence: 2,
      pendingTurns: [{ sequence: 3 }],
      notices: [{ throughSequence: 1 }, { throughSequence: 2 }],
      activeRun: { throughSequence: 3, receipts: [{ after: thirdAfter }] },
      activeMutation: null,
    });
    expect(update).not.toHaveBeenCalled();
    await maintenance.disposeAll();
  });

  it("replays a stored created receipt only while its target remains missing", async () => {
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update);
    await settle(maintenance);
    const after = "Created receipt bytes.\n";
    const state = readState();
    state.activeRun = {
      id: randomUUID(),
      throughSequence: 1,
      receipts: [{
        id: randomUUID(),
        path: "memory/created-receipt.md",
        before: null,
        after,
        beforeSha256: null,
        afterSha256: createHash("sha256").update(after).digest("hex"),
        operation: "created",
      }],
    };
    writeFileSync(statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await hooks.emitConversationIdle(idleEvent(state));
    expect(readFileSync(`${homeDir}/memory/created-receipt.md`, "utf8")).toBe(after);
    expect(readState()).toMatchObject({
      retainedThroughSequence: 1,
      pendingTurns: [],
      activeRun: null,
      notices: [{ throughSequence: 1 }],
    });
    expect(update).not.toHaveBeenCalled();
    await maintenance.disposeAll();
  });

  it("rejects forged active mutation and receipt digests without repairing state", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    await settle(maintenance);
    const original = readState();
    const variants: ConversationMaintenanceStateV1[] = [
      {
        ...original,
        activeRun: { id: randomUUID(), throughSequence: 1, receipts: [] },
        activeMutation: {
          id: randomUUID(),
          path: "memory/forged.md",
          before: null,
          after: "Forged bytes.\n",
          beforeSha256: null,
          afterSha256: "0".repeat(64),
        },
      },
      {
        ...original,
        activeRun: {
          id: randomUUID(),
          throughSequence: 1,
          receipts: [{
            id: randomUUID(),
            path: "memory/forged.md",
            before: null,
            after: "Forged bytes.\n",
            beforeSha256: null,
            afterSha256: "f".repeat(64),
            operation: "created",
          }],
        },
        activeMutation: null,
      },
      {
        ...original,
        activeRun: {
          id: randomUUID(),
          throughSequence: 1,
          mode: "consolidation",
          receipts: [],
        },
        activeMutation: {
          id: randomUUID(),
          path: "memory/forged-delete.md",
          before: "Forged delete bytes.\n",
          beforeSha256: "0".repeat(64),
          trash: ".trash/forged-delete.md",
        },
      },
    ];
    for (const variant of variants) {
      const bytes = Buffer.from(`${JSON.stringify(variant)}\n`);
      writeFileSync(statePath(), bytes, { mode: 0o600 });
      await expect(maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
        restored: 0,
        invalid: 1,
      });
      expect(readFileSync(statePath())).toEqual(bytes);
    }
    await maintenance.disposeAll();
  });

  it("dispatches each idle deadline once and reports actual elapsed idle time", async () => {
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const scheduled: Array<{ run: () => void; milliseconds: number }> = [];
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        scheduled.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    const observed: Array<{ label: string; elapsed: number }> = [];
    await hooks.register((api) => {
      api.on("conversation_idle", (event) => {
        observed.push({ label: "early", elapsed: event.idle_for_ms });
      }, { idleSeconds: 10 });
      api.on("conversation_idle", (event) => {
        observed.push({ label: "late", elapsed: event.idle_for_ms });
      }, { idleSeconds: 120 });
    });
    await settle(maintenance);
    expect(scheduled[0]?.milliseconds).toBe(10_000);

    nowMs += 10_000;
    scheduled[0]?.run();
    await vi.waitFor(() => expect(observed).toEqual([{ label: "early", elapsed: 10_000 }]));
    await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    expect(scheduled[1]?.milliseconds).toBe(50_000);

    nowMs += 50_000;
    scheduled[1]?.run();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(scheduled).toHaveLength(3));
    expect(scheduled[2]?.milliseconds).toBe(60_000);

    nowMs += 60_000;
    scheduled[2]?.run();
    await vi.waitFor(() => expect(observed).toEqual([
      { label: "early", elapsed: 10_000 },
      { label: "late", elapsed: 120_000 },
    ]));
    await maintenance.disposeAll();
  });

  it("does not redispatch a durably claimed observer after failure and restart", async () => {
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const firstScheduled: Array<{ run: () => void; milliseconds: number }> = [];
    let observations = 0;
    const first = await makeMaintenance(async () => {}, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        firstScheduled.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    await first.hooks.register((api) => {
      api.on("conversation_idle", () => {
        observations += 1;
        throw new Error("observer failed after its side effect");
      }, {
        name: "Stable observer",
        description: "One at-most-once side effect.",
        idleSeconds: 10,
      });
    });
    await settle(first.maintenance);
    nowMs += 10_000;
    firstScheduled[0]?.run();
    await vi.waitFor(() => expect(observations).toBe(1));
    await vi.waitFor(() => expect(readState().deliveredIdleRegistrations).toHaveLength(1));
    await first.maintenance.disposeAll();

    const resumedScheduled: Array<{ run: () => void; milliseconds: number }> = [];
    const resumedUpdate = vi.fn(async () => {});
    const resumed = await makeMaintenance(resumedUpdate, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        resumedScheduled.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    await resumed.hooks.register((api) => {
      api.on("conversation_idle", () => { observations += 1; }, {
        name: "Stable observer",
        description: "One at-most-once side effect.",
        idleSeconds: 10,
      });
    });
    await resumed.maintenance.restoreGhost(identity.ghostName);
    expect(resumedScheduled).toHaveLength(1);
    expect(resumedScheduled[0]?.milliseconds).toBe(50_000);
    nowMs += 50_000;
    resumedScheduled[0]?.run();
    await vi.waitFor(() => expect(resumedUpdate).toHaveBeenCalledTimes(1));
    expect(observations).toBe(1);
    await resumed.maintenance.disposeAll();
  });

  it("restores the remaining idle deadline and runs overdue work immediately", async () => {
    const base = Date.parse("2026-08-27T08:00:00.000Z");
    let nowMs = base;
    const first = await makeMaintenance(async () => {}, {
      now: () => new Date(nowMs),
      schedule: () => setTimeout(() => {}, 60_000),
    });
    await settle(first.maintenance);
    await first.maintenance.disposeAll();

    nowMs = base + 30_000;
    const remaining: number[] = [];
    const resumed = await makeMaintenance(async () => {}, {
      now: () => new Date(nowMs),
      schedule: (_run, milliseconds) => {
        remaining.push(milliseconds);
        return setTimeout(() => {}, 60_000);
      },
    });
    await resumed.maintenance.restoreGhost(identity.ghostName);
    expect(remaining).toEqual([30_000]);
    await resumed.maintenance.disposeAll();

    nowMs = base + 90_000;
    const overdue: number[] = [];
    const late = await makeMaintenance(async () => {}, {
      now: () => new Date(nowMs),
      schedule: (_run, milliseconds) => {
        overdue.push(milliseconds);
        return setTimeout(() => {}, 60_000);
      },
    });
    await late.maintenance.restoreGhost(identity.ghostName);
    expect(overdue).toEqual([0]);
    await late.maintenance.disposeAll();
  });

  it("retries only memory maintenance without redispatching a same-deadline observer", async () => {
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const scheduled: Array<{ run: () => void; milliseconds: number }> = [];
    let attempts = 0;
    const commandCount = join(fixture.root, "idle-command-count.txt");
    const commandScript = join(fixture.root, "idle-command.mjs");
    writeFileSync(commandScript, `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const path = ${JSON.stringify(commandCount)};
      const count = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
      writeFileSync(path, String(count + 1));
    `);
    const commandConfig = join(fixture.root, "idle-command-hooks.json");
    writeFileSync(commandConfig, JSON.stringify({
      hooks: {
        conversation_idle: [{
          hooks: [{
            type: "command",
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(commandScript)}`,
            idleSeconds: 60,
          }],
        }],
      },
    }));
    const configuredHooks = GhostHookRunner.fromConfig(commandConfig);
    const { maintenance, hooks } = await makeMaintenance(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient provider failure");
    }, {
      hooks: configuredHooks,
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        scheduled.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    let observations = 0;
    await hooks.register((api) => {
      api.on("conversation_idle", () => {
        observations += 1;
      }, { idleSeconds: 60 });
    });
    await settle(maintenance);
    nowMs += 60_000;
    scheduled[0]?.run();
    await vi.waitFor(() => expect(attempts).toBe(1));
    await vi.waitFor(() => expect(observations).toBe(1));
    await vi.waitFor(() => expect(readFileSync(commandCount, "utf8")).toBe("1"));
    await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    expect(scheduled[1]?.milliseconds).toBe(60_000);
    expect(readState().pendingTurns).toHaveLength(1);

    nowMs += 60_000;
    scheduled[1]?.run();
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(observations).toBe(1);
    expect(readFileSync(commandCount, "utf8")).toBe("1");
    await vi.waitFor(() => expect(readState().pendingTurns).toEqual([]));
    expect(scheduled).toHaveLength(2);
    await maintenance.disposeAll();
  });

  it("restores the exact remaining and overdue built-in retry deadline after restart", async () => {
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const firstScheduled: Array<() => void> = [];
    const first = await makeMaintenance(async () => {
      throw new Error("provider unavailable before restart");
    }, {
      now: () => new Date(nowMs),
      schedule: (run) => {
        firstScheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
    });
    await settle(first.maintenance);
    nowMs += 60_000;
    firstScheduled[0]?.();
    await vi.waitFor(() => expect(readState()).toMatchObject({
      retainedThroughSequence: 0,
      pendingTurns: [{ sequence: 1 }],
      activeRun: null,
      maintenanceRetry: {
        kind: "memory",
        registrationId: "ghost.memory-maintenance.v1",
        dueAt: "2026-08-27T08:02:00.000Z",
      },
    }));
    await first.maintenance.disposeAll();

    nowMs += 30_000;
    const resumedSchedules: Array<{ run: () => void; milliseconds: number }> = [];
    const resumed = await makeMaintenance(async () => {}, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        resumedSchedules.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    await resumed.maintenance.restoreGhost(identity.ghostName);
    expect(resumedSchedules).toHaveLength(1);
    expect(resumedSchedules[0]?.milliseconds).toBe(30_000);
    await resumed.maintenance.disposeAll();

    nowMs += 60_000;
    const overdueSchedules: Array<{ run: () => void; milliseconds: number }> = [];
    const overdueUpdate = vi.fn(async () => {});
    const overdue = await makeMaintenance(overdueUpdate, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        overdueSchedules.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    await overdue.maintenance.restoreGhost(identity.ghostName);
    expect(overdueSchedules).toHaveLength(1);
    expect(overdueSchedules[0]?.milliseconds).toBe(0);
    overdueSchedules[0]?.run();
    await vi.waitFor(() => expect(overdueUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(readState().pendingTurns).toEqual([]));
    await overdue.maintenance.disposeAll();
  });

  it("restores valid pending work but skips an authoritative delete tombstone", async () => {
    let schedules = 0;
    const first = await makeMaintenance(async () => {}, {
      schedule: (run) => {
        schedules += 1;
        return setTimeout(run, 60_000);
      },
    });
    await settle(first.maintenance);
    await first.maintenance.disposeAll();
    schedules = 0;

    const restored = await makeMaintenance(async () => {}, {
      schedule: (run) => {
        schedules += 1;
        return setTimeout(run, 60_000);
      },
    });
    await expect(restored.maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
      restored: 1,
      invalid: 0,
    });
    expect(schedules).toBe(1);
    await restored.maintenance.disposeAll();

    const marker = `${ghostPaths(homeDir).sessionDir}/.ghost-delete-conversation-a.pi.pending.json`;
    writeFileSync(marker, "{}\n", { mode: 0o600 });
    schedules = 0;
    const blocked = await makeMaintenance(async () => {}, {
      schedule: (run) => {
        schedules += 1;
        return setTimeout(run, 60_000);
      },
    });
    await expect(blocked.maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
      restored: 0,
      invalid: 0,
    });
    expect(schedules).toBe(0);
    expect(() => blocked.maintenance.admitOwnerAction(identity)).toThrow(expect.objectContaining({
      code: "delete_recovery_pending",
      status: 500,
    }));
    rmSync(marker);
    const retry = blocked.maintenance.reserveConversationDelete(identity);
    await retry.drained;
    retry.release("rolled-back");
    await vi.waitFor(() => expect(schedules).toBe(1));
    await blocked.maintenance.disposeAll();
  });

  it("keeps equal raw ids isolated by runtime and mints a new incarnation after removal", async () => {
    const { maintenance } = await makeMaintenance(async () => {});
    await settle(maintenance);
    const piState = readState();
    const claude = { ...identity, runtime: "claude-code" as const };
    const admission = maintenance.admitOwnerAction(claude);
    await admission.ready;
    await admission.finish({
      ...turn(),
      source: claudeSource,
      sourceRevision: { kind: "claude-owner-turn", value: 1 },
    });
    admission.release();
    const claudePath = maintenanceStatePath(
      ghostPaths(homeDir).sessionDir,
      "claude-code",
      identity.conversationId,
    );
    const claudeState = JSON.parse(readFileSync(claudePath, "utf8")) as ConversationMaintenanceStateV1;
    expect(claudeState.runtime).toBe("claude-code");
    expect(claudeState.incarnation).not.toBe(piState.incarnation);

    const deletion = maintenance.reserveConversationDelete(identity);
    await deletion.drained;
    rmSync(statePath());
    maintenance.completeConversationDelete(identity);
    deletion.release("completed");
    await settle(maintenance, turn(2));
    expect(readState().incarnation).not.toBe(piState.incarnation);
    await maintenance.disposeAll();
  });

  it("restores colliding raw ids with runtime-specific idle session identities and files", async () => {
    const first = await makeMaintenance(async () => {});
    await settle(first.maintenance);
    const claudeIdentity = { ...identity, runtime: "claude-code" as const };
    const claude = first.maintenance.admitOwnerAction(claudeIdentity);
    await claude.ready;
    await claude.finish({
      ...turn(),
      source: claudeSource,
      sourceRevision: { kind: "claude-owner-turn", value: 1 },
    });
    claude.release();
    await first.maintenance.disposeAll();

    const scheduled: Array<() => void> = [];
    const observed: GhostConversationIdleEvent[] = [];
    const resumed = await makeMaintenance(async () => {}, {
      schedule: (run) => {
        scheduled.push(run);
        return setTimeout(() => {}, 60_000);
      },
    });
    await resumed.hooks.register((api) => {
      api.on("conversation_idle", (event) => { observed.push(event); }, { idleSeconds: 60 });
    });
    await expect(resumed.maintenance.restoreGhost(identity.ghostName)).resolves.toEqual({
      restored: 2,
      invalid: 0,
    });
    expect(scheduled).toHaveLength(2);
    for (const run of scheduled) run();
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    const pi = observed.find(({ conversation_runtime }) => conversation_runtime === "pi");
    const claudeEvent = observed.find(({ conversation_runtime }) => conversation_runtime === "claude-code");
    expect(pi).toMatchObject({
      session_id: identity.conversationId,
      conversation_id: identity.conversationId,
      session_file: join(ghostPaths(homeDir).sessionDir, sessionFileNameFor(identity.conversationId)),
    });
    expect(claudeEvent).toMatchObject({
      session_id: claudeSource.resumeId,
      conversation_id: identity.conversationId,
      session_file: claudeSessionMetadataPath(ghostPaths(homeDir).sessionDir, identity.conversationId),
    });
    expect(pi?.session_file).not.toBe(claudeEvent?.session_file);
    await resumed.maintenance.disposeAll();
  });

  it("durably settles no-model owner activity without inventing a pending turn", async () => {
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const scheduled: Array<{ run: () => void; milliseconds: number }> = [];
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        scheduled.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    const observed: GhostConversationIdleEvent[] = [];
    await hooks.register((api) => {
      api.on("conversation_idle", (event) => { observed.push(event); }, { idleSeconds: 10 });
    });
    const admission = maintenance.admitOwnerAction(identity);
    await admission.ready;
    await maintenance.recordOwnerActivity(identity, {
      source,
      cwd: fixture.ownerHome,
    });
    admission.release();
    expect(readState()).toMatchObject({
      source,
      operationalCwd: fixture.ownerHome,
      lastActivityAt: new Date(nowMs).toISOString(),
      lastSequence: 0,
      lastSourceRevision: null,
      retainedThroughSequence: 0,
      pendingTurns: [],
    });
    expect(scheduled[0]?.milliseconds).toBe(10_000);
    nowMs += 10_000;
    scheduled[0]?.run();
    await vi.waitFor(() => expect(observed[0]).toMatchObject({
      session_id: identity.conversationId,
      sequence: 0,
      source_revision: "pi-leaf:none",
      idle_for_ms: 10_000,
      last_turn_outcome: "completed",
    }));
    expect(update).not.toHaveBeenCalled();
    await maintenance.disposeAll();
  });

  it("resets a near-deadline pending turn from no-model activity and its new cwd", async () => {
    let nowMs = Date.parse("2026-08-27T08:00:00.000Z");
    const scheduled: Array<{ run: () => void; milliseconds: number }> = [];
    const update = vi.fn(async () => {});
    const { maintenance, hooks } = await makeMaintenance(update, {
      now: () => new Date(nowMs),
      schedule: (run, milliseconds) => {
        scheduled.push({ run, milliseconds });
        return setTimeout(() => {}, 60_000);
      },
    });
    const observed: GhostConversationIdleEvent[] = [];
    await hooks.register((api) => {
      api.on("conversation_idle", (event) => { observed.push(event); }, { idleSeconds: 60 });
    });
    await settle(maintenance);
    expect(scheduled[0]?.milliseconds).toBe(60_000);

    nowMs += 59_000;
    const nextCwd = join(fixture.ownerHome, "changed-by-cd");
    const admission = maintenance.admitOwnerAction(identity);
    await admission.ready;
    await maintenance.recordOwnerActivity(identity, { source, cwd: nextCwd });
    admission.release();
    expect(readState()).toMatchObject({
      lastSequence: 1,
      pendingTurns: [{ sequence: 1 }],
      operationalCwd: nextCwd,
      lastActivityAt: new Date(nowMs).toISOString(),
    });
    expect(scheduled[1]?.milliseconds).toBe(60_000);

    scheduled[0]?.run();
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    nowMs += 60_000;
    scheduled[1]?.run();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observed[0]).toMatchObject({
      cwd: nextCwd,
      idle_for_ms: 60_000,
      sequence: 1,
    }));
    await maintenance.disposeAll();
  });

  it("rekeys and re-arms pending state only after a reserved whole-home rename", async () => {
    let schedules = 0;
    const { maintenance } = await makeMaintenance(async () => {}, {
      schedule: (run) => {
        schedules += 1;
        return setTimeout(run, 60_000);
      },
    });
    await settle(maintenance);
    const move = maintenance.reserveGhostMove("casper");
    await move.drained;
    fixture.registry.rename("casper", "renamed");
    await maintenance.completeGhostRename("casper", "renamed");
    homeDir = fixture.registry.get("renamed").dir;
    expect(() => maintenance.admitOwnerAction({
      ...identity,
      ghostName: "renamed",
    })).toThrow(expect.objectContaining({ code: "session_busy" }));
    move.release();
    const admitted = maintenance.admitOwnerAction({ ...identity, ghostName: "renamed" });
    admitted.release();
    expect(schedules).toBeGreaterThanOrEqual(2);
    await maintenance.disposeAll();
  });

  it("retains an exact notice when acknowledgement persistence fails", async () => {
    const { maintenance, hooks } = await makeMaintenance(async ({ writeMemory }) => {
      await writeMemory({ name: "receipt", content: "A durable receipt fact." });
    });
    await settle(maintenance);
    await hooks.emitConversationIdle(idleEvent(readState()));
    const prompt = await hooks.emitBeforePrompt({
      type: "before_prompt",
      prompt: "Continue.",
      turn_id: 2,
      session_id: identity.conversationId,
      signal: new AbortController().signal,
      ghost_name: identity.ghostName,
      ghost_home: homeDir,
      cwd: fixture.ownerHome,
      runtime: "omp",
      conversation_id: identity.conversationId,
      conversation_runtime: "pi",
    });
    const durable = readFileSync(statePath());
    writeFileSync(statePath(), "{}\n", { mode: 0o600 });
    await expect(prompt?.acknowledge?.()).rejects.toMatchObject({
      code: "maintenance_state_invalid",
    });
    writeFileSync(statePath(), durable, { mode: 0o600 });
    expect(readState().notices).toHaveLength(1);
    await prompt?.acknowledge?.();
    expect(readState().notices).toEqual([]);
    await maintenance.disposeAll();
  });

  it("shutdown aborts and drains active work before rejecting new admissions", async () => {
    let scheduled!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const { maintenance } = await makeMaintenance(async () => {
      started();
      await runGate;
    }, {
      schedule: (run) => {
        scheduled = run;
        return setTimeout(() => {}, 60_000);
      },
    });
    await settle(maintenance);
    scheduled();
    await didStart;
    let drained = false;
    const shutdown = maintenance.beginShutdown().then(() => { drained = true; });
    expect(() => maintenance.admitOwnerAction(identity)).toThrow(expect.objectContaining({
      code: "daemon_shutting_down",
      status: 503,
    }));
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseRun();
    await shutdown;
    expect(drained).toBe(true);
    await maintenance.disposeAll();
  });
});
