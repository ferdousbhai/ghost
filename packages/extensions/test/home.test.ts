import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  stat,
  writeFile,
} from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GhostHome,
  MAX_CHARACTER_BODY_LENGTH,
  openGhostHome,
} from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";

let fixture: GhostFixture;
let home: GhostHome;

async function _waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function _childResult(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  return { code: code as number | null, stderr };
}

beforeEach(async () => {
  fixture = await createGhostFixture();
  home = openGhostHome(fixture.dir);
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("layout", () => {
  it("names itself after its directory", () => {
    expect(home.name).toBe("casper");
  });
});

describe("character", () => {
  it("reads the persona body", async () => {
    const character = await home.readCharacter();
    expect(character?.body.startsWith("# Casper")).toBe(true);
  });

  it("serves a body with no leading heading unchanged", async () => {
    await writeFile(home.characterPath, "I keep the old ledgers.\n", "utf8");
    expect(await home.readCharacter()).toEqual({
      body: "I keep the old ledgers.\n",
    });
  });

  it("returns null when there is no character file", async () => {
    expect(await openGhostHome(fixture.root).readCharacter()).toBeNull();
  });

  it("refuses to read an oversized character file", async () => {
    await writeFile(home.characterPath, "x".repeat(MAX_CHARACTER_BODY_LENGTH + 1), "utf8");
    await expect(home.readCharacter()).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});
