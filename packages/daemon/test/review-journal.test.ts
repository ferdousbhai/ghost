import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import {
  REVIEW_JOURNAL_MAX_BYTES,
  REVIEW_JOURNAL_MAX_ENTRIES,
  REVIEW_JOURNAL_MAX_TEXT_CHARS,
  REVIEW_JOURNAL_VERSION,
  ReviewJournalStore,
  reviewJournalPath,
  type NewReviewJournalEntry,
  type ReviewJournalIdentity,
} from "../src/review-journal.js";
import { tempDir, useCleanups } from "./helpers/fixtures.js";
import { recordingLogger } from "./helpers/recording-logger.js";

const cleanups = useCleanups();
const identity: ReviewJournalIdentity = { runtime: "pi", conversationId: "session-1" };

function scratchSessionDir(): string {
  const temp = tempDir("ghost-review-journal-");
  cleanups.push(temp.cleanup);
  const sessionDir = ghostPaths(temp.path).sessionDir;
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function entry(overrides: Partial<NewReviewJournalEntry> = {}): NewReviewJournalEntry {
  return {
    turnId: 1,
    mode: "advisory",
    delta: {
      text: "user: fix it",
      commands: ["ls"],
      paths: ["src/a.ts"],
      source: "transcript",
      delegations: 0,
    },
    lint: [],
    notes: [],
    delivered: "none",
    continuationPass: false,
    ...overrides,
  };
}

function seed(sessionDir: string, entries: unknown[]): void {
  writeFileSync(
    reviewJournalPath(sessionDir, identity.runtime, identity.conversationId),
    `${JSON.stringify({
      version: REVIEW_JOURNAL_VERSION,
      ...identity,
      lastSequence: entries.length,
      droppedThroughSequence: 0,
      entries,
    })}\n`,
    { mode: 0o600 },
  );
}

function seededEntry(sequence: number, text: string): Record<string, unknown> {
  return {
    sequence,
    turnId: sequence,
    recordedAt: "2026-01-01T00:00:00.000Z",
    mode: "lint",
    delta: { text, commands: [], paths: [], source: "transcript", delegations: 0 },
    lint: [],
    notes: [],
    delivered: "none",
    continuationPass: false,
    truncated: false,
  };
}

describe("review journal", () => {
  it("reads nothing before the first reviewed turn", async () => {
    await expect(new ReviewJournalStore().read(scratchSessionDir(), identity)).resolves.toBeNull();
  });

  it("numbers entries and stamps when each turn was reviewed", async () => {
    const sessionDir = scratchSessionDir();
    const store = new ReviewJournalStore({ now: () => new Date("2026-02-03T04:05:06.000Z") });
    await store.record(sessionDir, identity, entry());
    await store.record(sessionDir, identity, entry({
      turnId: 2,
      lint: [{ ruleId: "chatbot-phrase", severity: "nit", message: "Remove canned phrasing." }],
      notes: [{ note: "Exercise the error path.", severity: "concern" }],
      severity: "concern",
      delivered: "next-turn",
      delta: { ...entry().delta, delegations: 2 },
    }));

    const journal = await store.read(sessionDir, identity);
    expect(journal).toMatchObject({
      version: REVIEW_JOURNAL_VERSION,
      runtime: "pi",
      conversationId: "session-1",
      lastSequence: 2,
      droppedThroughSequence: 0,
    });
    expect(journal?.entries.map((item) => item.sequence)).toEqual([1, 2]);
    expect(journal?.entries[0]).toMatchObject({
      turnId: 1,
      recordedAt: "2026-02-03T04:05:06.000Z",
      delta: {
        text: "user: fix it",
        commands: ["ls"],
        paths: ["src/a.ts"],
        source: "transcript",
        delegations: 0,
      },
      delivered: "none",
      continuationPass: false,
      truncated: false,
    });
    expect(journal?.entries[0]).not.toHaveProperty("severity");
    expect(journal?.entries[1]).toMatchObject({
      severity: "concern",
      delivered: "next-turn",
      lint: [{ ruleId: "chatbot-phrase", severity: "nit", message: "Remove canned phrasing." }],
      notes: [{ note: "Exercise the error path.", severity: "concern" }],
      delta: { delegations: 2 },
    });
  });

  it("redacts credentials from every text field and caps each one", async () => {
    const sessionDir = scratchSessionDir();
    const store = new ReviewJournalStore();
    await store.record(sessionDir, identity, entry({
      delta: {
        text: `token: hunter2 ${"x".repeat(REVIEW_JOURNAL_MAX_TEXT_CHARS)}`,
        commands: ["curl -H 'Authorization: Bearer sk-abcdefgh12345678'"],
        paths: ["/home/casper/api_key=abcdefgh"],
        source: "transcript",
        delegations: 0,
      },
      lint: [{ ruleId: "secret", severity: "concern", message: "password: swordfish" }],
      notes: [{ note: "Drop the ghp_abcdefgh12345678 you pasted.", severity: "blocker" }],
      severity: "blocker",
      delivered: "next-turn",
    }));

    const recorded = (await store.read(sessionDir, identity))?.entries[0];
    expect(recorded?.truncated).toBe(true);
    expect(recorded?.delta.text).toHaveLength(REVIEW_JOURNAL_MAX_TEXT_CHARS);
    expect(recorded?.delta.text).toContain("token: [REDACTED_SECRET]");
    expect(recorded?.delta.text).not.toContain("hunter2");
    expect(recorded?.delta.commands[0]).not.toContain("sk-abcdefgh12345678");
    expect(recorded?.delta.paths[0]).not.toContain("abcdefgh");
    expect(recorded?.lint[0]?.message).not.toContain("swordfish");
    expect(recorded?.notes[0]?.note).not.toContain("ghp_abcdefgh12345678");
  });

  it("attaches a continuation pass to the entry whose critique asked for it", async () => {
    const sessionDir = scratchSessionDir();
    const store = new ReviewJournalStore();
    await store.record(sessionDir, identity, entry({
      notes: [{ note: "The write is not awaited.", severity: "blocker" }],
      severity: "blocker",
      delivered: "continuation",
    }));
    await store.record(sessionDir, identity, entry({
      turnId: 2,
      delta: {
        text: "assistant: awaited the write",
        commands: [],
        paths: [],
        source: "transcript",
        delegations: 0,
      },
      delivered: "none",
      continuationPass: true,
    }));

    const journal = await store.read(sessionDir, identity);
    expect(journal?.entries[0]).toMatchObject({
      delivered: "continuation",
      continuation: { turnId: 2, text: "assistant: awaited the write" },
    });
    expect(journal?.entries[1]).toMatchObject({ continuationPass: true, sequence: 2 });
    expect(journal?.entries[1]).not.toHaveProperty("continuation");
  });

  it("drops the oldest entries once the journal is full", async () => {
    const sessionDir = scratchSessionDir();
    seed(
      sessionDir,
      Array.from({ length: REVIEW_JOURNAL_MAX_ENTRIES }, (_, index) =>
        seededEntry(index + 1, `turn ${index + 1}`)),
    );
    const store = new ReviewJournalStore();
    await store.record(sessionDir, identity, entry({ turnId: 1_001 }));

    const journal = await store.read(sessionDir, identity);
    expect(journal?.entries).toHaveLength(REVIEW_JOURNAL_MAX_ENTRIES);
    expect(journal?.lastSequence).toBe(REVIEW_JOURNAL_MAX_ENTRIES + 1);
    expect(journal?.droppedThroughSequence).toBe(1);
    expect(journal?.entries[0]?.sequence).toBe(2);
    expect(journal?.entries.at(-1)?.turnId).toBe(1_001);
  });

  it("stays under its byte bound by dropping the oldest entries", async () => {
    const sessionDir = scratchSessionDir();
    const filler = "y".repeat(REVIEW_JOURNAL_MAX_TEXT_CHARS);
    const seeded = 520;
    seed(sessionDir, Array.from({ length: seeded }, (_, index) =>
      seededEntry(index + 1, filler)));
    const store = new ReviewJournalStore();
    await store.record(sessionDir, identity, entry({
      delta: { text: filler, commands: [], paths: [], source: "transcript", delegations: 0 },
    }));

    const path = reviewJournalPath(sessionDir, identity.runtime, identity.conversationId);
    expect(statSync(path).size).toBeLessThanOrEqual(REVIEW_JOURNAL_MAX_BYTES);
    const journal = await store.read(sessionDir, identity);
    expect(journal?.entries.length).toBeLessThan(seeded + 1);
    expect(journal?.droppedThroughSequence).toBeGreaterThan(0);
    expect(journal?.entries.at(-1)?.sequence).toBe(seeded + 1);
  });

  it("starts fresh from an unusable journal instead of failing the review", async () => {
    const sessionDir = scratchSessionDir();
    const logger = recordingLogger();
    const store = new ReviewJournalStore({ logger });
    for (const corrupt of ["not json", JSON.stringify({ version: "review-journal/v0" })]) {
      writeFileSync(
        reviewJournalPath(sessionDir, identity.runtime, identity.conversationId),
        `${corrupt}\n`,
        { mode: 0o600 },
      );
      await store.record(sessionDir, identity, entry({ turnId: 7 }));
      const journal = await store.read(sessionDir, identity);
      expect(journal?.entries).toMatchObject([{ sequence: 1, turnId: 7 }]);
    }
    expect(logger.records.filter((record) =>
      record.message === "review journal was invalid and starts fresh"
    )).toHaveLength(2);
  });
});
