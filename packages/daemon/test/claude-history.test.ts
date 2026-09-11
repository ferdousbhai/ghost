import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClaudeHistoryEntries,
  readClaudeHistoryEntry,
  searchClaudeHistory,
} from "../src/claude-history.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function transcript(name: string, lines: object[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "ghost-claude-history-"));
  const path = join(dir, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

const user = (uuid: string, text: string, timestamp: string, extra: object = {}) => ({
  type: "user", uuid, timestamp, message: { role: "user", content: [{ type: "text", text }] }, ...extra,
});
const assistant = (uuid: string, content: unknown[], timestamp: string) => ({
  type: "assistant", uuid, timestamp, message: { role: "assistant", content },
});

describe("Claude history", () => {
  it("reads user and assistant entries, summarises tool use, and skips sidechains and noise", async () => {
    const path = transcript("a.jsonl", [
      { type: "mode", sessionId: "a" },
      user("u1", "why is the sky blue?", "2026-09-05T12:01:36Z"),
      assistant("a1", [
        { type: "text", text: "Let me check." },
        { type: "tool_use", name: "Read", input: { file_path: "/etc/hostname" } },
      ], "2026-09-05T12:01:39Z"),
      { type: "user", uuid: "r1", timestamp: "2026-09-05T12:01:40Z",
        message: { role: "user", content: [{ type: "tool_result", content: "omarchy\n" }] } },
      user("side", "hidden", "2026-09-05T12:02:00Z", { isSidechain: true }),
      "not json",
    ]);
    const entries = await readClaudeHistoryEntries({ path, label: "" });
    expect(entries.map((entry) => [entry.id, entry.role, entry.text])).toEqual([
      ["u1", "user", "why is the sky blue?"],
      ["a1", "assistant", 'Let me check.\n[tool Read] {"file_path":"/etc/hostname"}'],
      ["r1", "user", "[tool result] omarchy"],
    ]);
  });

  it("searches newest first, the current conversation before the others, with labels", async () => {
    const current = transcript("current.jsonl", [
      user("c1", "first mention of Skellet", "2026-09-05T10:00:00Z"),
      user("c2", "second mention of Skellet", "2026-09-05T11:00:00Z"),
    ]);
    const other = transcript("other.jsonl", [
      user("o1", "Skellet in another conversation", "2026-09-04T10:00:00Z"),
    ]);
    const hits = await searchClaudeHistory(
      [{ path: current, label: "" }, { path: other, label: "Lighthouse notes" }],
      "skellet",
      10,
    );
    expect(hits).toEqual([
      "2026-09-05T11:00:00Z [c2] [user] second mention of Skellet",
      "2026-09-05T10:00:00Z [c1] [user] first mention of Skellet",
      "Lighthouse notes 2026-09-04T10:00:00Z [o1] [user] Skellet in another conversation",
    ]);
    expect(await searchClaudeHistory([{ path: current, label: "" }], "skellet", 1)).toHaveLength(1);
    expect(await searchClaudeHistory([{ path: current, label: "" }], "nothing here", 5)).toEqual([]);
  });

  it("reads one entry by id with paging and refuses an unknown id or a bad offset", async () => {
    const long = "x".repeat(13_000);
    const path = transcript("long.jsonl", [assistant("big", [{ type: "text", text: long }], "2026-09-05T12:00:00Z")]);
    const files = [{ path, label: "" }];
    const first = await readClaudeHistoryEntry(files, "big", 0);
    expect(first).toContain("[big] [assistant] [chars 0-12000 of 13000]");
    expect(first).toContain('More remains; call history read with id "big" and offset 12000.');
    const rest = await readClaudeHistoryEntry(files, "big", 12_000);
    expect(rest).toContain("[chars 12000-13000 of 13000]");
    expect(rest).not.toContain("More remains");
    await expect(readClaudeHistoryEntry(files, "big", 13_000)).rejects.toThrow(/past the end/);
    await expect(readClaudeHistoryEntry(files, "nope", 0)).rejects.toThrow(/No history entry/);
  });

  it("treats a missing transcript as empty", async () => {
    expect(await readClaudeHistoryEntries({ path: "/nonexistent/none.jsonl", label: "" })).toEqual([]);
  });
});
