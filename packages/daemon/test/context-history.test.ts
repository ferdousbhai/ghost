import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ghostContextWindowsExtension as sharedExtension } from "@ghost/runtime/context-windows";
import { ghostContextWindowsExtension } from "../src/context-windows.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function historyTool(extension: ReturnType<typeof sharedExtension>) {
  const tools = new Map<string, ToolDefinition>();
  await extension({ on() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); } } as never);
  return tools.get("history")!;
}
const entry = { type: "message", id: "abc12345", timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content: "needle in original history" } };
const context = (root: string) => ({ sessionManager: { getSessionDir: () => root, getBranch: () => [] }, getContextUsage: () => undefined });

it("keeps local history on its supplied JSONL root and ignores intent files", async () => {
  const home = await mkdtemp(join(tmpdir(), "ghost-context-history-")); homes.push(home);
  await writeFile(join(home, "saved.jsonl"), `broken line\n${JSON.stringify(entry)}\n`);
  await writeFile(join(home, "saved.intent.jsonl"), JSON.stringify({ ...entry, id: "intent", message: { role: "user", content: "needle intent must stay hidden" } }));
  const tool = await historyTool(ghostContextWindowsExtension({ enabled: false }));
  const result = await tool.execute("search", { op: "search", query: "needle", all: true }, undefined, undefined, context(home) as never);
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("saved.jsonl") }]);
  expect(JSON.stringify(result.content)).not.toContain("intent must stay hidden");
  const read = await tool.execute("read", { op: "read", id: entry.id }, undefined, undefined, context(home) as never);
  expect(JSON.stringify(read.content)).toContain("needle in original history");
});

it("awaits a host-provided session index without interpreting identities as filesystem paths", async () => {
  const requested: string[] = [];
  const tool = await historyTool(sharedExtension({ enabled: false }, {
    async files(root) { requested.push(root); return ["opaque-session-id"]; },
    async *entries(id, signal) {
      expect(id).toBe("opaque-session-id");
      signal?.throwIfAborted();
      yield { entry, windowId: "initial", text: "needle in original history", images: [] };
    },
    source(root, id) { expect(root).toBe("backend-scope"); return id; },
  }));
  const result = await tool.execute("search", { op: "search", query: "needle", all: true }, undefined, undefined, context("backend-scope") as never);
  expect(requested).toEqual(["backend-scope"]);
  expect(JSON.stringify(result.content)).toContain("opaque-session-id");
  await expect(tool.execute("read", { op: "read", id: entry.id }, AbortSignal.abort(), undefined, context("backend-scope") as never)).rejects.toThrow();
});
