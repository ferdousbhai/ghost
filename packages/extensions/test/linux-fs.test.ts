import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  descriptorPath,
  openConfinedDirectory,
  withDescriptorLock,
} from "../src/linux-fs.js";
import { createTempDir } from "./support/fixture.js";

let workspace: { dir: string; cleanup(): Promise<void> };

beforeEach(async () => {
  workspace = await createTempDir();
});

afterEach(async () => {
  await workspace.cleanup();
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

it("serializes a descriptor lock across Bun processes", async () => {
  const marker = join(workspace.dir, "locked");
  const moduleUrl = new URL("../src/linux-fs.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "-e",
    `
      const { open } = await import("node:fs/promises");
      const { withDescriptorLock } = await import(${JSON.stringify(moduleUrl)});
      const directory = await open(${JSON.stringify(workspace.dir)});
      await withDescriptorLock(directory, async () => {
        await Bun.write(${JSON.stringify(marker)}, "locked");
        await Bun.sleep(400);
      });
      await directory.close();
    `,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const childExit = once(child, "exit");

  const parentDirectory = await open(workspace.dir);
  try {
    await waitForFile(marker);
    const started = Date.now();
    await withDescriptorLock(parentDirectory, async () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  } finally {
    await parentDirectory.close();
  }

  const [code] = await childExit;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Lock subprocess exited ${String(code)}: ${stderr}`);
  }
  await writeFile(marker, "complete");
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
