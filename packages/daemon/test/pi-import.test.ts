/**
 * Conversations the embedded pi runtime wrote become conversation logs once:
 * the active branch, titles, failed tool calls, owner commands, and stop-hook
 * continuations survive; the original moves beside the log; pins and read
 * marks lose their `pi:` prefix.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationDir, readLog, transcriptMessages } from "../src/conversation-log.js";
import { silentLogger } from "../src/log.js";
import { importPiConversations, PI_TRANSCRIPT_FILENAME } from "../src/pi-import.js";
import { readPinState, writePins } from "../src/pins.js";
import { readReadState, writeReads } from "../src/reads.js";
import { tempDir } from "./helpers/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sessions(): string {
  const dir = tempDir();
  cleanups.push(dir.cleanup);
  mkdirSync(join(dir.path, "sessions"));
  return join(dir.path, "sessions");
}

const lines = (...entries: unknown[]) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const TRANSCRIPT = lines(
  { type: "session", id: "s", timestamp: "2026-09-01T10:00:00.000Z" },
  { type: "model_change", id: "m", parentId: null },
  { type: "message", id: "sys", parentId: "m", message: { role: "system", content: "prompt" } },
  { type: "message", id: "u1", parentId: "sys", message: { role: "user", content: [{ type: "text", text: "Check the build" }], timestamp: 1 } },
  // An abandoned branch: pi's active branch ends at the last entry.
  { type: "message", id: "dead", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" } }] } },
  { type: "custom", id: "c", parentId: "a1", customType: "ghost.tool-cwd" },
  { type: "message", id: "r1", parentId: "c", message: { role: "toolResult", toolCallId: "t1", isError: true, content: [{ type: "text", text: "fail" }] } },
  { type: "message", id: "a2", parentId: "r1", message: { role: "assistant", content: [{ type: "text", text: "The build failed." }] } },
  { type: "custom_message", id: "h", parentId: "a2", customType: "session-stop-continuation", content: "Stop hook feedback:\nkeep going" },
  { type: "message", id: "b", parentId: "h", message: { role: "bashExecution", command: "ls", output: "a\n", exitCode: 0, excludeFromContext: true } },
  { type: "session_info", id: "i", parentId: "b", name: "Build check" },
);

describe("importPiConversations", () => {
  it("turns pi's active branch into a log and keeps the original beside it", async () => {
    const dir = sessions();
    writeFileSync(join(dir, "conv-1.jsonl"), TRANSCRIPT);
    expect(await importPiConversations(dir, silentLogger)).toBe(1);

    expect(existsSync(join(dir, "conv-1.jsonl"))).toBe(false);
    expect(readFileSync(join(conversationDir(dir, "conv-1"), PI_TRANSCRIPT_FILENAME), "utf8")).toBe(TRANSCRIPT);
    const entries = (await readLog(dir, "conv-1")) ?? [];
    expect(entries.find((entry) => entry.type === "title")).toMatchObject({ title: "Build check" });
    expect(entries.find((entry) => entry.type === "command")).toMatchObject({ command: "ls", excluded: true });
    expect(transcriptMessages(entries).map((message) => [message.role, message.content])).toEqual([
      ["user", [{ type: "text", text: "Check the build" }]],
      ["assistant", [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" }, failed: true }]],
      ["assistant", [{ type: "text", text: "The build failed." }]],
      ["hook", [{ type: "text", text: "keep going" }]],
    ]);
  });

  it("runs once, and rekeys pins and read marks", async () => {
    const dir = sessions();
    writeFileSync(join(dir, "conv-1.jsonl"), TRANSCRIPT);
    await writePins(dir, ["pi:conv-1"]);
    await writeReads(dir, { "pi:conv-1": "2026-09-01T10:00:00.000Z" });
    await importPiConversations(dir, silentLogger);
    expect(await importPiConversations(dir, silentLogger)).toBe(0);
    expect((await readPinState(dir)).pinned).toEqual(["conv-1"]);
    expect(Object.keys((await readReadState(dir)).reads)).toEqual(["conv-1"]);
  });

  it("leaves files that are not pi transcripts alone", async () => {
    const dir = sessions();
    writeFileSync(join(dir, "notes.jsonl"), '{"type":"other"}\n');
    expect(await importPiConversations(dir, silentLogger)).toBe(0);
    expect(existsSync(join(dir, "notes.jsonl"))).toBe(true);
  });
});
