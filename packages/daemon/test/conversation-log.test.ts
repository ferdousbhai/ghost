import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listedLog, logPath, readLog } from "../src/conversation-log.js";

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
