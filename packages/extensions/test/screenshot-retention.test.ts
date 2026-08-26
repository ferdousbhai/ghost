import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ghostScreenshotMatcher,
  ghostScreenshotName,
  resolveScreenshotDirectory,
  withScreenshotDirectory,
  writeScreenshotFile,
} from "../src/extensions/screenshot-retention.js";
import { createTempDir } from "./support/fixture.js";

let workspace: { dir: string; cleanup(): Promise<void> };

beforeEach(async () => {
  workspace = await createTempDir();
});

afterEach(async () => {
  await workspace.cleanup();
});

it("names a capture after the ghost that took it", () => {
  const now = new Date("2026-08-22T10:11:12.345Z");
  expect(ghostScreenshotName("casper", "screen", now))
    .toBe("ghost-casper-screen-2026-08-22T10-11-12-345.png");
  expect(ghostScreenshotName("casper", "browser", now))
    .toBe("ghost-casper-browser-2026-08-22T10-11-12-345.png");
});

it("matches one ghost's captures and nothing else in the drawer", () => {
  const casper = ghostScreenshotMatcher("casper", "screen");

  expect(casper("ghost-casper-screen-2026-08-22T10-11-12-345.png")).toBe(true);
  expect(casper("ghost-casper-screen-2026-08-22T10-11-12-345-2.png")).toBe(true);

  // Another ghost's captures, the other producer, the owner's own screenshots,
  // and anything else that happens to live in the pictures directory.
  expect(casper("ghost-mina-screen-2026-08-22T10-11-12-345.png")).toBe(false);
  expect(casper("ghost-casper-browser-2026-08-22T10-11-12-345.png")).toBe(false);
  expect(casper("screenshot-2026-08-22_10-11-12.png")).toBe(false);
  expect(casper("ghost-casper-screen-holiday.png")).toBe(false);
  expect(casper("holiday.png")).toBe(false);
});

it("treats a ghost name as text, not as a pattern", () => {
  const matcher = ghostScreenshotMatcher("a.c", "screen");

  expect(matcher("ghost-a.c-screen-2026-08-22T10-11-12-345.png")).toBe(true);
  expect(matcher("ghost-abc-screen-2026-08-22T10-11-12-345.png")).toBe(false);
});

it("follows the desktop's own screenshot destination", () => {
  const home = "/home/someone";

  expect(resolveScreenshotDirectory({ OMARCHY_SCREENSHOT_DIR: "~/Shots" }, home))
    .toBe("/home/someone/Shots");
  expect(resolveScreenshotDirectory({ XDG_PICTURES_DIR: "$HOME/Bilder" }, home))
    .toBe("/home/someone/Bilder");
  expect(resolveScreenshotDirectory({}, home)).toBe("/home/someone/Pictures");
});

it("removes a reserved screenshot when its writer fails", async () => {
  await expect(withScreenshotDirectory(workspace.dir, async (directory) => {
    await writeScreenshotFile(
      directory,
      "ghost-casper-screen-2026-08-22T10-11-12-345.png",
      "Test screenshot",
      async (descriptorPath) => {
        await writeFile(descriptorPath, "partial");
        throw new Error("writer failed");
      },
    );
  })).rejects.toThrowError(/writer failed/);

  expect(await readdir(workspace.dir)).toEqual([]);
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

it("serializes screenshot mutations across Bun processes", async () => {
  const marker = join(workspace.dir, "screenshot-lock-held");
  const moduleUrl = new URL("../src/extensions/screenshot-retention.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "-e",
    `
      const { withScreenshotDirectory } = await import(${JSON.stringify(moduleUrl)});
      await withScreenshotDirectory(${JSON.stringify(workspace.dir)}, async () => {
        await Bun.write(${JSON.stringify(marker)}, "locked");
        await Bun.sleep(400);
      });
    `,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const childExit = once(child, "exit");

  await waitForFile(marker);
  const started = Date.now();
  await withScreenshotDirectory(workspace.dir, async () => undefined);
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);

  const [code] = await childExit;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Screenshot-lock subprocess exited ${String(code)}: ${stderr}`);
  }
});
