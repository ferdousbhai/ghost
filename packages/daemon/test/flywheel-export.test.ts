import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOLDOUT_FRACTION,
  exportFlywheelDataset,
  FLYWHEEL_FILES,
  isHoldoutConversation,
  type ChatMessage,
  type DpoSample,
  type FlywheelExportOptions,
  type FlywheelManifest,
  type SftSample,
} from "../src/flywheel-export.js";
import { ghostPaths } from "../src/ghosts.js";
import { reviewJournalPath } from "../src/review-journal.js";
import { claudeSessionMetadataPath } from "../src/session-files.js";
import type { ReviewJournalEntry, ReviewJournalV1 } from "../src/review-journal.js";
import { seedGhost, tempDir, useCleanups } from "./helpers/fixtures.js";

const cleanups = useCleanups();

const CHARACTER = "# Casper\n\nYou are Casper.";
/** The transcript id of the second owner turn in `twoTurnConversation`. */
const SECOND_TURN = "c";

function ghostHome(): string {
  const temp = tempDir("ghost-flywheel-");
  cleanups.push(temp.cleanup);
  const home = seedGhost(temp.path, { name: "casper", character: `${CHARACTER}\n` });
  mkdirSync(ghostPaths(home).sessionDir, { recursive: true });
  return home;
}

function writeTranscript(home: string, name: string, lines: readonly unknown[]): void {
  writeFileSync(
    join(ghostPaths(home).sessionDir, name),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

/** One journalled turn: a clean review of turn 2 unless a test says otherwise. */
function entry(
  sequence: number,
  overrides: Omit<Partial<ReviewJournalEntry>, "delta">
    & Pick<ReviewJournalEntry, "turnId">
    & { delta?: Partial<ReviewJournalEntry["delta"]> },
): ReviewJournalEntry {
  const { delta, ...rest } = overrides;
  return {
    sequence,
    recordedAt: `2026-09-0${sequence}T00:00:00.000Z`,
    mode: "advisory",
    lint: [],
    notes: [],
    delivered: "none",
    continuationPass: false,
    truncated: false,
    ...rest,
    delta: {
      text: 'user: "Second question."\nassistant: []',
      commands: [],
      paths: [],
      source: "transcript",
      delegations: 0,
      ownerRecordId: SECOND_TURN,
      ...delta,
    },
  };
}

function writeJournal(
  home: string,
  conversationId: string,
  entries: readonly ReviewJournalEntry[],
  runtime: ReviewJournalV1["runtime"] = "pi",
): void {
  const journal: ReviewJournalV1 = {
    version: "review-journal/v1",
    runtime,
    conversationId,
    lastSequence: entries.at(-1)?.sequence ?? 0,
    droppedThroughSequence: 0,
    entries: [...entries],
  };
  // Mode 0600 is what `writeDaemonControlFile` publishes and what the paired
  // reader admits; a journal written any other way is not one Ghost wrote.
  writeFileSync(
    reviewJournalPath(ghostPaths(home).sessionDir, runtime, conversationId),
    `${JSON.stringify(journal)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Two owner turns: a plain exchange, then a turn that runs one tool whose
 * result carries a credential, behind a private reasoning block.
 */
function twoTurnConversation(home: string, id = "conv-a", system?: string): void {
  writeTranscript(home, `${id}.jsonl`, [
    ...(system
      ? [{ type: "system", id: "s", parentId: null, message: { role: "system", content: system } }]
      : []),
    {
      type: "message",
      id: "a",
      parentId: system ? "s" : null,
      message: { role: "user", content: "First question." },
    },
    {
      type: "message",
      id: "b",
      parentId: "a",
      message: { role: "assistant", content: [{ type: "text", text: "First answer." }] },
    },
    {
      type: "message",
      id: SECOND_TURN,
      parentId: "b",
      message: { role: "user", content: "Second question." },
    },
    {
      type: "message",
      id: "d",
      parentId: SECOND_TURN,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private deliberation" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
      },
    },
    {
      type: "message",
      id: "e",
      parentId: "d",
      message: { role: "toolResult", content: [{ type: "text", text: "token=super-secret-value" }] },
    },
    {
      type: "message",
      id: "f",
      parentId: "e",
      message: { role: "assistant", content: [{ type: "text", text: "Second answer." }] },
    },
  ]);
}

async function runExport(
  home: string,
  overrides: Partial<FlywheelExportOptions> = {},
): Promise<{ manifest: FlywheelManifest; out: string; lines(file: string): unknown[] }> {
  const temp = tempDir("ghost-flywheel-out-");
  cleanups.push(temp.cleanup);
  const out = join(temp.path, "dataset");
  const manifest = await exportFlywheelDataset({
    ghost: "casper",
    home,
    outDir: out,
    holdout: 0,
    now: () => new Date("2026-09-05T12:00:00.000Z"),
    ...overrides,
  });
  return {
    manifest,
    out,
    lines: (file) => readFileSync(join(out, file), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown),
  };
}

describe("ghost flywheel export", () => {
  it("turns a clean turn into one SFT sample with redacted tools and no reasoning", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    writeJournal(home, "conv-a", [entry(1, { turnId: 2 })]);

    const { manifest, lines } = await runExport(home);
    const samples = lines(FLYWHEEL_FILES.sftTrain) as SftSample[];
    expect(samples).toHaveLength(1);
    expect(samples[0]).toEqual({
      weight: 1,
      messages: [
        { role: "system", content: CHARACTER },
        { role: "user", content: "First question." },
        { role: "assistant", content: "First answer." },
        { role: "user", content: "Second question." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "token=[REDACTED_SECRET]" },
        { role: "assistant", content: "Second answer." },
      ] satisfies ChatMessage[],
    });
    expect(JSON.stringify(samples)).not.toContain("private deliberation");
    expect(JSON.stringify(samples)).not.toContain("super-secret-value");
    expect(manifest.entries).toBe(1);
    expect(manifest.files[FLYWHEEL_FILES.sftTrain]).toBe(1);
    expect(manifest.newestRecordedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("pairs a corrected turn as DPO with the context up to the owner prompt", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    const attempt = 'user: "Second question."\nassistant: ["a first try"]';
    writeJournal(home, "conv-a", [
      entry(1, {
        turnId: 2,
        delivered: "continuation",
        severity: "blocker",
        notes: [{ note: "Wrong file.", severity: "blocker" }],
        delta: { text: attempt },
        continuation: { turnId: 2, text: 'assistant: ["the rewrite"]' },
      }),
    ]);

    const { manifest, lines } = await runExport(home);
    const pairs = lines(FLYWHEEL_FILES.dpoTrain) as DpoSample[];
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({
      input: {
        messages: [
          { role: "system", content: CHARACTER },
          { role: "user", content: "First question." },
          { role: "assistant", content: "First answer." },
          { role: "user", content: "Second question." },
        ],
      },
      preferred_output: { role: "assistant", content: 'assistant: ["the rewrite"]' },
      non_preferred_output: { role: "assistant", content: attempt },
    });
    expect(manifest.files[FLYWHEEL_FILES.sftTrain]).toBe(0);
  });

  it("skips escalated, uncorrected, continuation-pass, truncated, and unlocatable turns", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    writeJournal(home, "conv-a", [
      entry(1, { turnId: 2, delta: { delegations: 1 } }),
      entry(2, { turnId: 2, notes: [{ note: "Risky.", severity: "concern" }] }),
      entry(3, { turnId: 2, delivered: "continuation", severity: "blocker" }),
      entry(4, { turnId: 2, continuationPass: true }),
      entry(5, { turnId: 2, truncated: true }),
      entry(6, { turnId: 2, delta: { ownerRecordId: "no-such-record" } }),
      entry(7, { turnId: 2, delta: { ownerRecordId: undefined, source: "assistant-fallback" } }),
    ]);

    const { manifest, lines } = await runExport(home);
    expect(manifest.skipped).toEqual({
      "before-watermark": 0,
      truncated: 1,
      "continuation-pass": 1,
      escalated: 1,
      "unresolved-critique": 2,
      "transcript-missing": 2,
    });
    expect(lines(FLYWHEEL_FILES.sftTrain)).toHaveLength(0);
    expect(manifest.entries).toBe(7);
  });

  it("honours the --since watermark and reports the next one", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    writeJournal(home, "conv-a", [entry(1, { turnId: 2 }), entry(2, { turnId: 2 })]);

    const { manifest, lines } = await runExport(home, { since: "2026-09-01T00:00:00.000Z" });
    expect(manifest.skipped["before-watermark"]).toBe(1);
    expect(lines(FLYWHEEL_FILES.sftTrain)).toHaveLength(1);
    expect(manifest.since).toBe("2026-09-01T00:00:00.000Z");
    expect(manifest.newestRecordedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("keeps a conversation whole on one side of a deterministic holdout split", async () => {
    expect(isHoldoutConversation("conv-a", 0)).toBe(false);
    expect(isHoldoutConversation("conv-a", 1)).toBe(true);
    expect(isHoldoutConversation("conv-a", DEFAULT_HOLDOUT_FRACTION))
      .toBe(isHoldoutConversation("conv-a", DEFAULT_HOLDOUT_FRACTION));

    const home = ghostHome();
    twoTurnConversation(home);
    writeJournal(home, "conv-a", [entry(1, { turnId: 2 }), entry(2, { turnId: 2 })]);

    const all = await runExport(home, { holdout: 1 });
    expect(all.lines(FLYWHEEL_FILES.sftHoldout)).toHaveLength(2);
    expect(all.lines(FLYWHEEL_FILES.sftTrain)).toHaveLength(0);

    const none = await runExport(home);
    expect(none.lines(FLYWHEEL_FILES.sftTrain)).toHaveLength(2);
    expect(none.lines(FLYWHEEL_FILES.sftHoldout)).toHaveLength(0);
  });

  it("uses the runtime's own system prompt only under --system full", async () => {
    const home = ghostHome();
    twoTurnConversation(home, "conv-a", "FULL POLICY TEXT");
    writeJournal(home, "conv-a", [entry(1, { turnId: 2 })]);

    const character = await runExport(home);
    const full = await runExport(home, { system: "full" });
    expect((character.lines(FLYWHEEL_FILES.sftTrain)[0] as SftSample).messages[0])
      .toEqual({ role: "system", content: CHARACTER });
    expect((full.lines(FLYWHEEL_FILES.sftTrain)[0] as SftSample).messages[0])
      .toEqual({ role: "system", content: "FULL POLICY TEXT" });
    expect(character.manifest.system).toBe("character");
    expect(full.manifest.system).toBe("full");
  });

  it("bounds a tool result and drops context beyond --context-turns", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    writeJournal(home, "conv-a", [entry(1, { turnId: 2 })]);

    const { lines } = await runExport(home, { contextTurns: 0, maxToolResultChars: 6 });
    const sample = lines(FLYWHEEL_FILES.sftTrain)[0] as SftSample;
    expect(sample.messages.map((message) => message.role))
      .toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(sample.messages.find((message) => message.role === "tool")?.content)
      .toBe("token=\n…[truncated]");
  });

  it("reads a Claude conversation through its resume metadata", async () => {
    const home = ghostHome();
    const sessions = ghostPaths(home).sessionDir;
    const projects = tempDir("ghost-flywheel-claude-");
    cleanups.push(projects.cleanup);
    const projectDir = join(projects.path, "projects", "-encoded-cwd");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sdk-session-1.jsonl"),
      [
        { type: "user", uuid: "a", parentUuid: null, message: { role: "user", content: "Claude ask." } },
        {
          type: "assistant",
          uuid: "b",
          parentUuid: "a",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x.ts" } }],
          },
        },
        {
          type: "user",
          uuid: "c",
          parentUuid: "b",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
          },
        },
        {
          type: "assistant",
          uuid: "d",
          parentUuid: "c",
          message: { role: "assistant", content: [{ type: "text", text: "Claude answer." }] },
        },
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8",
    );
    writeFileSync(
      claudeSessionMetadataPath(sessions, "conv-c"),
      JSON.stringify({
        version: 3,
        runtime: "claude-code",
        conversationId: "conv-c",
        sessionId: "sdk-session-1",
        created: "2026-09-01T00:00:00.000Z",
        modified: "2026-09-01T00:00:00.000Z",
        messageCount: 2,
        ownerTurnCount: 1,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    writeJournal(home, "conv-c", [
      entry(1, { turnId: 1, delta: { ownerRecordId: "a" } }),
    ], "claude-code");

    const { lines } = await runExport(home, { env: { CLAUDE_CONFIG_DIR: projects.path } });
    const sample = lines(FLYWHEEL_FILES.sftTrain)[0] as SftSample;
    expect(sample.messages).toEqual([
      { role: "system", content: CHARACTER },
      { role: "user", content: "Claude ask." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "toolu_1",
          type: "function",
          function: { name: "Read", arguments: '{"file_path":"x.ts"}' },
        }],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "file body" },
      { role: "assistant", content: "Claude answer." },
    ] satisfies ChatMessage[]);
  });

  it("counts an unreadable Claude transcript as missing and keeps going", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    writeJournal(home, "conv-a", [entry(1, { turnId: 2 })]);
    writeJournal(home, "conv-gone", [entry(1, { turnId: 1, delta: { ownerRecordId: "a" } })], "claude-code");

    const { manifest, lines } = await runExport(home);
    expect(manifest.journals).toBe(2);
    expect(manifest.skipped["transcript-missing"]).toBe(1);
    expect(lines(FLYWHEEL_FILES.sftTrain)).toHaveLength(1);
  });

  it("ignores a journal whose declared conversation is not the one it is filed under", async () => {
    const home = ghostHome();
    twoTurnConversation(home);
    const journal: ReviewJournalV1 = {
      version: "review-journal/v1",
      runtime: "pi",
      conversationId: "conv-a",
      lastSequence: 1,
      droppedThroughSequence: 0,
      entries: [entry(1, { turnId: 2 })],
    };
    writeFileSync(
      join(ghostPaths(home).sessionDir, "conv-impostor.pi.review-journal.json"),
      `${JSON.stringify(journal)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const { manifest, lines } = await runExport(home);
    expect(manifest.journals).toBe(0);
    expect(lines(FLYWHEEL_FILES.sftTrain)).toHaveLength(0);
  });

  it("writes a manifest and private, empty files for a ghost with no journals", async () => {
    const home = ghostHome();
    const { manifest, out } = await runExport(home, { holdout: DEFAULT_HOLDOUT_FRACTION });

    expect(manifest).toEqual({
      version: "flywheel-export/v1",
      ghost: "casper",
      exportedAt: "2026-09-05T12:00:00.000Z",
      since: null,
      newestRecordedAt: null,
      system: "character",
      contextTurns: 6,
      holdout: DEFAULT_HOLDOUT_FRACTION,
      maxToolResultChars: 4_000,
      journals: 0,
      entries: 0,
      files: {
        [FLYWHEEL_FILES.sftTrain]: 0,
        [FLYWHEEL_FILES.sftHoldout]: 0,
        [FLYWHEEL_FILES.dpoTrain]: 0,
        [FLYWHEEL_FILES.dpoHoldout]: 0,
      },
      skipped: {
        "before-watermark": 0,
        truncated: 0,
        "continuation-pass": 0,
        escalated: 0,
        "unresolved-critique": 0,
        "transcript-missing": 0,
      },
    } satisfies FlywheelManifest);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const file of Object.values(FLYWHEEL_FILES)) {
      expect(statSync(join(out, file)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(join(out, FLYWHEEL_FILES.manifest), "utf8")))
      .toEqual(manifest);
  });
});
