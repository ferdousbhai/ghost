import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listResults, MAX_RESULT_BYTES, openResult, publishResult, revokeResult } from "../src/results.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ghost-results-")); roots.push(root);
  const conversation = join(root, "conversation"); await mkdir(conversation);
  return { root, conversation, path: join(root, "résumé.bin") };
}

it("shares a binary snapshot, lists it without source paths, and revokes to private Trash", async () => {
  const { root, conversation, path } = await fixture();
  const content = Buffer.from([0, 255, 1, 10]); await writeFile(path, content);
  const result = await publishResult(conversation, path);
  await writeFile(path, "changed");
  const opened = await openResult(conversation, result.id);
  try { expect(await opened.file.readFile()).toEqual(content); } finally { await opened.file.close(); }
  expect(await listResults(conversation)).toEqual([result]);
  expect(JSON.stringify(await listResults(conversation))).not.toContain(root);
  const data = join(root, "data"); await mkdir(data);
  await revokeResult(conversation, result.id, { ...process.env, HOME: root, XDG_DATA_HOME: data });
  expect(await listResults(conversation)).toEqual([]);
  await expect(openResult(conversation, result.id)).rejects.toMatchObject({ status: 404 });
  expect(await readFile(join(data, "Trash", "files", result.id, result.name))).toEqual(content);
});

it("supports empty files and refuses non-files, large sources, and unscoped identifiers", async () => {
  const { conversation, path } = await fixture();
  await writeFile(path, "");
  expect(await publishResult(conversation, path)).toMatchObject({ bytes: 0 });
  await expect(publishResult(conversation, conversation)).rejects.toMatchObject({ status: 400 });
  await expect(publishResult(conversation, "relative")).rejects.toMatchObject({ status: 400 });
  await truncate(path, MAX_RESULT_BYTES + 1);
  await expect(publishResult(conversation, path)).rejects.toMatchObject({ status: 413 });
  await expect(openResult(conversation, "../outside")).rejects.toMatchObject({ status: 404 });
});

it("refuses replaced snapshot files and directories that are symlinks", async () => {
  const { conversation, path } = await fixture();
  await writeFile(path, "secret");
  const result = await publishResult(conversation, path), directory = join(conversation, "results", result.id);
  await rm(join(directory, result.name)); await symlink(path, join(directory, result.name));
  expect(await listResults(conversation)).toEqual([]);
  await rm(directory, { recursive: true }); await symlink(conversation, directory);
  await expect(openResult(conversation, result.id)).rejects.toMatchObject({ status: 404 });
});
