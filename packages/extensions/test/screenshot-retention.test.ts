import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  isBrowserScreenshot,
  isScreenScreenshot,
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

it("matches only canonical generated and legacy screenshot names", () => {
  expect(isScreenScreenshot("screen-2026-08-22T10-11-12-345.png")).toBe(true);
  expect(isScreenScreenshot("screen-2026-08-22T10-11-12-345-2.png")).toBe(true);
  expect(isBrowserScreenshot("browser-2026-08-22T10-11-12-345.png")).toBe(true);
  expect(isBrowserScreenshot("browser-2026-08-22T10-11-12-345-2.png")).toBe(true);
  expect(isBrowserScreenshot("2026-08-22T10-11-12-345Z-7.png")).toBe(true);

  expect(isScreenScreenshot("screen-owner-data.png")).toBe(false);
  expect(isScreenScreenshot("screen-2026-99-99.png")).toBe(false);
  expect(isBrowserScreenshot("browser-owner-data.png")).toBe(false);
  expect(isBrowserScreenshot("2026-08-22T10-11-12-345.png")).toBe(false);
});

it("removes a reserved screenshot when its writer fails", async () => {
  await expect(withScreenshotDirectory(workspace.dir, async (directory) => {
    await writeScreenshotFile(
      directory,
      "screen-2026-08-22T10-11-12-345.png",
      "Test screenshot",
      async (descriptorPath) => {
        await writeFile(descriptorPath, "partial");
        throw new Error("writer failed");
      },
    );
  })).rejects.toThrowError(/writer failed/);

  expect(await readdir(join(workspace.dir, ".screenshots"))).toEqual([]);
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
