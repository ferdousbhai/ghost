import { describe, expect, it } from "vitest";
import { logState, type LogEntry } from "../src/conversation-log.js";
import { transcriptPage } from "./helpers/transcript-oracle.js";

const command: LogEntry = { type: "command", at: "now", command: "pwd", output: "```\n/tmp", exitCode: 1, excluded: false };

describe("transcript pages", () => {
  it("preserves message ids, split command pairs, totals, and out-of-range pages", () => {
    const entries: LogEntry[] = [
      { type: "title", at: "now", title: "ignored" },
      { type: "user", at: "now", text: "hello" },
      command,
      { ...command, excluded: true },
      { type: "assistant", at: "now", harness: "pi", content: [{ type: "text", text: "answer" }] },
    ];
    const all = transcriptPage(entries);
    expect(all.total).toBe(4);
    expect(all.messages.map(message => message.entryId)).toEqual(["e1", "e2", "e2o", "e4"]);
    for (let offset = 0; offset < 8; offset++) {
      for (let limit = 1; limit < 8; limit++) {
        expect(transcriptPage(entries, offset, limit)).toEqual({ messages: all.messages.slice(offset, offset + limit), total: 4 });
      }
    }
  });

  it("shows a compaction as its own notice, without the owner or ghost having added anything", () => {
    const entries: LogEntry[] = [
      { type: "user", at: "2026-11-16T00:00:00.000Z", text: "hello" },
      { type: "compacted", at: "2026-11-16T00:00:05.000Z", harness: "claude", trigger: "auto", preTokens: 287944 },
      { type: "compacted", at: "2026-11-16T00:00:06.000Z", harness: "claude", trigger: "manual" },
    ];
    expect(transcriptPage(entries).messages.slice(1)).toEqual([
      { role: "compacted", content: [{ type: "text", text: "auto · 288k tokens" }], entryId: "e1" },
      { role: "compacted", content: [{ type: "text", text: "manual" }], entryId: "e2" },
    ]);
    expect(logState(entries).activeAt).toBe("2026-11-16T00:00:00.000Z");
  });

  it("does not format command output outside the requested page", () => {
    const expensive = { ...command };
    Object.defineProperty(expensive, "output", { get: () => { throw new Error("off-page output formatted"); } });
    expect(transcriptPage([expensive], 0, 1).messages[0]?.entryId).toBe("e0");
    expect(transcriptPage([expensive], 2, 1)).toEqual({ messages: [], total: 2 });
  });
});
