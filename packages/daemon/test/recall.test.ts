import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { rankRecords } from "../src/recall.js";

const originalPath = process.env.PATH;
let root: string | undefined;
afterEach(async () => {
  process.env.PATH = originalPath;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const records = [{ id: "current", title: "Travel", text: "Holiday plans" }];
async function fake(reply: unknown) {
  root = await mkdtemp(join(tmpdir(), "ghost-recall-"));
  const path = join(root, "recall");
  await writeFile(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`);
  await chmod(path, 0o700);
  process.env.PATH = `${root}:/usr/bin`;
}
test("missing Recall is an optional fallback", async () => {
  root = await mkdtemp(join(tmpdir(), "ghost-no-recall-"));
  process.env.PATH = root;
  expect(await rankRecords("ghost:test", "holiday", records)).toBeNull();
});
test("rank accepts only current session IDs", async () => {
  await fake({ api: 1, meaning: true, hits: [{ id: "current", score: .8 }] });
  expect(await rankRecords("ghost:test", "holiday", records)).toEqual(["current"]);
});
test.each([
  { api: 2, meaning: true, hits: [] },
  { api: 1, meaning: true, hits: [{ id: "deleted", score: .9 }] },
  { api: 1, error: "warming up" },
])("incompatible and untrusted results fall back: %j", async (reply) => {
  await fake(reply);
  expect(await rankRecords("ghost:test", "holiday", records)).toBeNull();
});

test("CLI semantic fallback keeps session listing usable", async () => {
  root = await mkdtemp(join(tmpdir(), "ghost-cli-no-recall-"));
  process.env.PATH = root;
  const { runCli } = await import("./helpers/cli.js");
  const sessions = [
    { id: "a", title: "Holiday plans", preview: "travel", messageCount: 2 },
    { id: "b", title: "Work", preview: "meeting", messageCount: 1 },
  ];
  const result = await runCli(["sessions", "-g", "test", "--semantic", "holiday", "--json"], {
    env: { GHOSTD_PORT: "7718" }, home: root,
    fetch: async () => new Response(JSON.stringify({ sessions }), { headers: { "content-type": "application/json" } }),
  });
  expect(result.code).toBe(0);
  const reply = JSON.parse(result.stdout);
  expect(reply.meaning).toBe(false);
  expect(reply.warning).toContain("Recall unavailable");
  expect(reply.sessions.map((session: { id: string }) => session.id)).toEqual(["a"]);
});
