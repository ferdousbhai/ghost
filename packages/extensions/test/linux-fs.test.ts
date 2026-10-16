import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  descriptorPath,
  openConfinedDirectory,
} from "../src/linux-fs.js";
import { createTempDir } from "./support/fixture.js";

let workspace: { dir: string; cleanup(): Promise<void> };

beforeEach(async () => {
  workspace = await createTempDir();
});

afterEach(async () => {
  await workspace.cleanup();
});

it("keeps a confined directory pinned across a pathname-to-symlink swap", async () => {
  const home = join(workspace.dir, "home");
  const docs = join(home, "docs");
  const movedDocs = join(home, "moved-docs");
  const outside = join(workspace.dir, "outside");
  await mkdir(docs, { recursive: true });
  await mkdir(outside);

  const directory = await openConfinedDirectory(home, docs, {
    label: "Documents path",
  });
  try {
    await rename(docs, movedDocs);
    await symlink(outside, docs);
    await writeFile(descriptorPath(directory, "pinned.md"), "pinned");
  } finally {
    await directory.close();
  }

  expect(await readFile(join(movedDocs, "pinned.md"), "utf8")).toBe("pinned");
  await expect(readFile(join(outside, "pinned.md"), "utf8")).rejects.toThrow();
});
