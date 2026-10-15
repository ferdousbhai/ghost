import { describe, expect, it } from "vitest";
import { transcriptPage, type LogEntry } from "../src/conversation-log.js";

const command: LogEntry = { type: "command", at: "now", command: "pwd", output: "```\n/tmp", exitCode: 1, excluded: false };

describe("transcript pages", () => {
  it("preserves message ids, split command pairs, totals, and out-of-range pages", () => {
    const entries: LogEntry[] = [
      { type: "title", at: "now", title: "ignored" },
      { type: "user", at: "now", text: "hello" },
      command,
      { ...command, excluded: true },
      { type: "assistant", at: "now", harness: "pi", content: [{ type: "text", text: "answer" }] },
      { type: "handoff", at: "now", harness: "pi", text: "historical" },
    ];
    const all = transcriptPage(entries);
    expect(all.total).toBe(5);
    expect(all.messages.map(message => message.entryId)).toEqual(["e1", "e2", "e2o", "e4", "e5"]);
    for (let offset = 0; offset < 8; offset++) {
      for (let limit = 1; limit < 8; limit++) {
        expect(transcriptPage(entries, offset, limit)).toEqual({ messages: all.messages.slice(offset, offset + limit), total: 5 });
      }
    }
  });

  it("does not format command output outside the requested page", () => {
    const expensive = { ...command };
    Object.defineProperty(expensive, "output", { get: () => { throw new Error("off-page output formatted"); } });
    expect(transcriptPage([expensive], 0, 1).messages[0]?.entryId).toBe("e0");
    expect(transcriptPage([expensive], 2, 1)).toEqual({ messages: [], total: 2 });
  });
});
