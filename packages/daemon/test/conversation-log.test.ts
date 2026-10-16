import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendLog, listedLog, logPath, logState, readLog, readTranscriptPage, transcriptPage, latestRunResources, type LogEntry } from "../src/conversation-log.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ghost-log-"));
  roots.push(root);
  await mkdir(join(root, "s"));
  return root;
}

describe("conversation log reads", () => {
  it("reads chunk boundaries and skips malformed, blank, and torn lines", async () => {
    const root = await scratch();
    const entry = { type: "user", at: "now", text: "🐈".repeat(40_000) };
    await writeFile(logPath(root, "s"), `\n${JSON.stringify(entry)}\nmalformed\nnull\n{}\n{"type":`);
    expect(await readLog(root, "s")).toEqual([entry]);
    expect(await readLog(root, "missing")).toBeNull();
  });

  it("refreshes a replaced log even if its size and mtime match the cached file", async () => {
    const root = await scratch();
    const path = logPath(root, "s");
    const entry = (text: string) => `${JSON.stringify({ type: "user", at: "2026-10-15T00:00:00Z", text })}\n`;
    await writeFile(path, entry("first topic"));
    const original = await stat(path);
    expect((await listedLog(root, "s"))?.state.preview).toBe("first topic");
    await writeFile(`${path}.new`, entry("other topic"));
    await utimes(`${path}.new`, original.atime, original.mtime);
    await rename(`${path}.new`, path);
    expect((await listedLog(root, "s"))?.state.preview).toBe("other topic");
    await rm(path);
    expect(await listedLog(root, "s")).toBeNull();
  });
});


describe("indexed conversation reads", () => {
  const at = "2026-10-15T00:00:00Z";
  const user = (text: string): LogEntry => ({ type: "user", at, text });

  it("preserves every page, entry ID and resource snapshot through incremental appends", async () => {
    const root = await scratch();
    const entries: LogEntry[] = [
      { type: "conversation", v: 1, id: "s", createdAt: at },
      { type: "harness", at, harness: "codex", session: "h1" },
      user("Explain the new feature"),
      { type: "command", at, command: "printf hello", output: "hello", exitCode: 0, excluded: false },
      { type: "resources", at: "2026-10-14T23:59:59Z", run: "r1", harness: "codex", resources: { skills: ["mail"], extensions: [], mcpServers: [] }, summary: "legacy" },
      { type: "assistant", at, harness: "codex", content: [{ type: "text", text: "answer" }], model: "model" },
      { type: "command", at, command: "private", output: "hidden", exitCode: 0, excluded: true },
      { type: "title", at, title: "Custom title" },
      { type: "handoff", at, harness: "codex", text: "handoff" },
    ];
    for (const entry of entries) {
      await appendLog(root, "s", [entry]);
      const prefix = entries.slice(0, entries.indexOf(entry) + 1);
      expect((await listedLog(root, "s"))?.state).toEqual(logState(prefix));
      expect((await readTranscriptPage(root, "s", 0, 10)).resources).toEqual(latestRunResources(prefix));
    }
    const expected = transcriptPage(entries);
    for (let offset = 0; offset <= expected.total + 1; offset++) {
      for (const limit of [1, 2, 4]) {
        expect(await readTranscriptPage(root, "s", offset, limit)).toEqual({
          messages: expected.messages.slice(offset, offset + limit), total: expected.total, resources: latestRunResources(entries),
        });
      }
    }
  });

  it("parses only appended records for list refresh and only requested records for a warm page", async () => {
    const root = await scratch();
    const entries = Array.from({ length: 1500 }, (_, n) => user(`indexed-payload-${n} ${"x".repeat(4000)}`));
    await appendLog(root, "s", entries);
    await listedLog(root, "s");
    const parse = vi.spyOn(JSON, "parse");
    const reads = () => parse.mock.calls.filter(([text]) => text.includes("indexed-payload-")).length;
    try {
      expect((await readTranscriptPage(root, "s", 1499, 1)).messages[0]?.entryId).toBe("e1499");
      expect(reads()).toBe(1);
      await appendLog(root, "s", [user("indexed-payload-new")]);
      expect((await listedLog(root, "s"))?.state.messageCount).toBe(1501);
      expect(reads()).toBe(2);
      await listedLog(root, "s");
      expect(reads()).toBe(2);
    } finally { parse.mockRestore(); }
  });

  it("retains lightweight summaries after more than sixteen offset indexes are evicted", async () => {
    const root = await scratch();
    for (let n = 0; n < 24; n++) {
      await appendLog(root, `summary-${n}`, [user(`summary-cache-${n}`)]);
      await listedLog(root, `summary-${n}`);
    }
    const parse = vi.spyOn(JSON, "parse");
    const reads = () => parse.mock.calls.filter(([text]) => text.includes("summary-cache-")).length;
    try {
      for (let n = 0; n < 24; n++) expect((await listedLog(root, `summary-${n}`))?.state.messageCount).toBe(1);
      expect(reads()).toBe(0);
      // An evicted offset array can be rebuilt without affecting the summary.
      expect((await readTranscriptPage(root, "summary-0", 0, 1)).messages[0]?.entryId).toBe("e0");
      expect(reads()).toBe(2);
      await appendLog(root, "summary-1", [user("summary-cache-new")]);
      expect((await listedLog(root, "summary-1"))?.state.messageCount).toBe(2);
      expect(reads()).toBe(3);
    } finally { parse.mockRestore(); }
  });

  it("keeps page snapshots intact while concurrent reads evict more than sixteen indexes", async () => {
    const root = await scratch();
    const names = Array.from({ length: 24 }, (_, n) => `parallel-${n}`);
    await Promise.all(names.map((name) => appendLog(root, name,
      Array.from({ length: 30 }, (_, n) => user(`${name}: ${n}`)))));
    const pages = await Promise.all(names.map((name) => readTranscriptPage(root, name, 5, 20)));
    for (const [n, page] of pages.entries()) {
      expect(page.total).toBe(30);
      expect(page.messages).toHaveLength(20);
      expect(page.messages[0]).toMatchObject({ entryId: "e5", content: [{ type: "text", text: `${names[n]}: 5` }] });
      expect(page.messages[19]).toMatchObject({ entryId: "e24", content: [{ type: "text", text: `${names[n]}: 24` }] });
    }
  });

  it("rebuilds for truncation, replacement and external growing rewrites", async () => {
    const root = await scratch();
    const path = logPath(root, "s");
    for (const entries of [[user("first")], [user("entirely different and longer"), user("second")], []]) {
      await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      expect(await readTranscriptPage(root, "s", 0, 10)).toEqual({ ...transcriptPage(entries), resources: null });
      expect((await listedLog(root, "s"))?.state).toEqual(logState(entries));
    }
    await writeFile(`${path}.new`, JSON.stringify(user("replacement")) + "\n");
    await rename(`${path}.new`, path);
    expect((await readTranscriptPage(root, "s", 0, 1)).messages[0]?.content).toEqual([{ type: "text", text: "replacement" }]);
    await rm(path);
    expect(await readTranscriptPage(root, "s", 0, 1)).toEqual({ messages: [], total: 0, resources: null });
  });

  it("keeps concurrent reads and appends coherent and rebuilds after an unterminated record", async () => {
    const root = await scratch();
    const entries = Array.from({ length: 300 }, (_, n) => user(`message ${n}`));
    await appendLog(root, "s", entries);
    await listedLog(root, "s");
    for (let n = 0; n < 5; n++) {
      const entry = user(`append ${n}`);
      const [page] = await Promise.all([
        readTranscriptPage(root, "s", 250, 10), appendLog(root, "s", [entry]), listedLog(root, "s"),
      ]);
      expect(page.messages).toEqual(transcriptPage(entries, 250, 10).messages);
      entries.push(entry);
      expect((await listedLog(root, "s"))?.state).toEqual(logState(entries));
    }
    await writeFile(logPath(root, "s"), JSON.stringify(user("no newline")));
    expect((await readTranscriptPage(root, "s", 0, 10)).total).toBe(1);
    await appendLog(root, "s", [user("concatenated")]);
    const actual = (await readLog(root, "s")) ?? [];
    expect(await readTranscriptPage(root, "s", 0, 10)).toEqual({ ...transcriptPage(actual), resources: null });
  });

  it("handles malformed, split UTF-8, torn and valid unterminated final lines", async () => {
    const root = await scratch();
    const path = logPath(root, "s");
    const first = user("🐈".repeat(40_000));
    await writeFile(path, `\n${JSON.stringify(first)}\nmalformed\nnull\n{}\n{"type":`);
    expect((await readTranscriptPage(root, "s", 0, 10)).messages).toEqual(transcriptPage([first]).messages);
    await appendFile(path, '"user","at":"now","text":"recovered"}');
    const recovered: LogEntry = { type: "user", at: "now", text: "recovered" };
    expect((await readTranscriptPage(root, "s", 0, 10)).messages).toEqual(transcriptPage([first, recovered]).messages);
    await appendFile(path, "\n");
    await appendLog(root, "s", [user("last")]);
    expect(await readTranscriptPage(root, "s", 0, 10)).toEqual({ ...transcriptPage([first, recovered, user("last")]), resources: null });
  });
});
