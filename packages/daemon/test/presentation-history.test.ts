import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRESENTATION_HISTORY_MAX_TEXT_CHARS,
  PresentationHistoryStore,
  presentationHistoryPath,
  type PresentationHistoryIdentity,
  type PresentationHistoryV1,
  type SettledTurn,
} from "../src/presentation-history.js";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function sessionDir(): string {
  root = mkdtempSync(join(tmpdir(), "ghost-presentation-"));
  const path = join(root, "sessions");
  mkdirSync(path);
  return path;
}

const identity: PresentationHistoryIdentity = {
  runtime: "pi",
  conversationId: "conversation-1",
};

function turn(ordinal: number, text = `answer-${ordinal}`): SettledTurn {
  return {
    source: { runtime: "pi", createdAt: "2026-08-31T10:00:00.000Z" },
    sourceRevision: { kind: "pi-leaf", value: `leaf-${ordinal}` },
    sourceOrdinal: ordinal,
    ownerPrompt: `prompt-${ordinal}`,
    assistantText: text,
    outcome: "completed",
  };
}

describe("presentation history", () => {
  it("atomically records, reads, and deduplicates one settled native turn", async () => {
    const dir = sessionDir();
    const now = new Date("2026-08-31T12:00:00.000Z");
    const store = new PresentationHistoryStore({ now: () => now });
    const state = await store.recordSettledTurn(dir, identity, turn(1));

    expect(state).toMatchObject({
      version: 1,
      ...identity,
      historyPrefixOmitted: false,
      lastSequence: 1,
      droppedThroughSequence: 0,
      lastSourceOrdinal: 1,
      lastSourceRevision: { kind: "pi-leaf", value: "leaf-1" },
      turns: [{
        sequence: 1,
        sourceOrdinal: 1,
        settledAt: now.toISOString(),
        ownerText: "prompt-1",
        assistantText: "answer-1",
      }],
    });
    const path = presentationHistoryPath(dir, "pi", identity.conversationId);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path).nlink).toBe(1);
    const before = readFileSync(path);
    await expect(store.recordSettledTurn(dir, identity, turn(1))).resolves.toEqual(state);
    expect(readFileSync(path)).toEqual(before);
    await expect(store.read(dir, identity)).resolves.toEqual(state);
  });

  it("serializes concurrent writes and marks a missing native ordinal", async () => {
    const dir = sessionDir();
    const store = new PresentationHistoryStore();
    await Promise.all([
      store.recordSettledTurn(dir, identity, turn(1)),
      store.recordSettledTurn(dir, identity, turn(3)),
    ]);
    await expect(store.read(dir, identity)).resolves.toMatchObject({
      historyPrefixOmitted: true,
      lastSequence: 2,
      lastSourceOrdinal: 3,
      turns: [{ sourceOrdinal: 1 }, { sourceOrdinal: 3 }],
    });
  });

  it("rejects stale ordinals and an equal ordinal with a different revision", async () => {
    const dir = sessionDir();
    const store = new PresentationHistoryStore();
    await store.recordSettledTurn(dir, identity, turn(2));
    await expect(store.recordSettledTurn(dir, identity, turn(1)))
      .rejects.toMatchObject({ code: "presentation_history_invalid", status: 500 });
    await expect(store.recordSettledTurn(dir, identity, {
      ...turn(2),
      sourceRevision: { kind: "pi-leaf", value: "different-leaf" },
    })).rejects.toMatchObject({ code: "presentation_history_invalid", status: 500 });
  });

  it("requires a Claude revision to equal its durable owner ordinal", async () => {
    const dir = sessionDir();
    const store = new PresentationHistoryStore();
    const claudeIdentity = { runtime: "claude-code" as const, conversationId: "claude-1" };
    const claudeTurn: SettledTurn = {
      source: {
        runtime: "claude-code",
        createdAt: "2026-08-31T10:00:00.000Z",
        resumeId: "native-session",
      },
      sourceRevision: { kind: "claude-owner-turn", value: 1 },
      sourceOrdinal: 2,
      ownerPrompt: "prompt",
      assistantText: "answer",
      outcome: "completed",
    };
    await expect(store.recordSettledTurn(dir, claudeIdentity, claudeTurn))
      .rejects.toMatchObject({ code: "presentation_history_invalid", status: 500 });
  });

  it("truncates owner and assistant text without hiding that it did so", async () => {
    const dir = sessionDir();
    const store = new PresentationHistoryStore();
    const long = "x".repeat(PRESENTATION_HISTORY_MAX_TEXT_CHARS + 1);
    const state = await store.recordSettledTurn(dir, identity, {
      ...turn(1, long),
      ownerPrompt: long,
    });
    expect(state.turns[0]).toMatchObject({
      ownerText: "x".repeat(PRESENTATION_HISTORY_MAX_TEXT_CHARS),
      ownerTextTruncated: true,
      assistantText: "x".repeat(PRESENTATION_HISTORY_MAX_TEXT_CHARS),
      assistantTextTruncated: true,
    });
  });

  it("fails closed for mismatched identity, malformed sequence, permissions, and hard links", async () => {
    const variants = [
      (state: PresentationHistoryV1) => ({ ...state, conversationId: "other" }),
      (state: PresentationHistoryV1) => ({
        ...state,
        turns: state.turns.map((entry) => ({ ...entry, sequence: 2 })),
      }),
    ];
    for (const mutate of variants) {
      const dir = sessionDir();
      const store = new PresentationHistoryStore();
      const valid = await store.recordSettledTurn(dir, identity, turn(1));
      const path = presentationHistoryPath(dir, "pi", identity.conversationId);
      writeFileSync(path, `${JSON.stringify(mutate(valid))}\n`, { mode: 0o600 });
      await expect(store.read(dir, identity))
        .rejects.toMatchObject({ code: "presentation_history_invalid", status: 500 });
      rmSync(root!, { recursive: true, force: true });
      root = null;
    }

    const permissionDir = sessionDir();
    const permissionStore = new PresentationHistoryStore();
    await permissionStore.recordSettledTurn(permissionDir, identity, turn(1));
    const permissionPath = presentationHistoryPath(permissionDir, "pi", identity.conversationId);
    chmodSync(permissionPath, 0o644);
    await expect(permissionStore.read(permissionDir, identity))
      .rejects.toMatchObject({ code: "presentation_history_invalid", status: 500 });

    chmodSync(permissionPath, 0o600);
    linkSync(permissionPath, join(permissionDir, "second-link"));
    await expect(permissionStore.read(permissionDir, identity))
      .rejects.toMatchObject({ code: "presentation_history_invalid", status: 500 });
  });

  it("does not let a presentation file publish or alias a legacy Pi identity", async () => {
    const dir = sessionDir();
    const store = new PresentationHistoryStore();
    const unsafe = { runtime: "pi" as const, conversationId: "folder/conversation" };
    expect(await store.read(dir, unsafe)).toBeNull();
    await store.recordSettledTurn(dir, unsafe, turn(1));
    expect(presentationHistoryPath(dir, "pi", unsafe.conversationId)).toMatch(
      /ghost~[0-9a-f]{64}\.pi\.presentation\.json$/u,
    );
    await expect(store.read(dir, { ...unsafe, conversationId: "folder/other" }))
      .resolves.toBeNull();
  });
});
