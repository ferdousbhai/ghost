import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCharacter, writeCharacter } from "../src/home.js";
import { CHARACTER_FILENAME, MAX_CHARACTER_BODY_LENGTH } from "../src/persona.js";
import { createGhostFixture, type GhostFixture } from "./helpers/home-fixture.js";

let fixture: GhostFixture;
let characterPath: string;

beforeEach(async () => {
  fixture = await createGhostFixture();
  characterPath = join(fixture.dir, CHARACTER_FILENAME);
});

afterEach(async () => {
  await fixture.cleanup();
});


describe("character", () => {
  it("reads the persona body", async () => {
    const character = await readCharacter(fixture.dir);
    expect(character?.body.startsWith("# Casper")).toBe(true);
  });

  it("serves a body with no leading heading unchanged", async () => {
    await writeFile(characterPath, "I keep the old ledgers.\n", "utf8");
    expect(await readCharacter(fixture.dir)).toEqual({
      body: "I keep the old ledgers.\n",
    });
  });

  it("returns null when there is no character file", async () => {
    expect(await readCharacter(fixture.root)).toBeNull();
  });

  it("refuses to read an oversized character file", async () => {
    await writeFile(characterPath, "x".repeat(MAX_CHARACTER_BODY_LENGTH + 1), "utf8");
    await expect(readCharacter(fixture.dir)).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("refuses an oversized owner edit before writing, counting UTF-16 code units", async () => {
    const original = (await readCharacter(fixture.dir))?.body;
    const allowed = "🙂".repeat(MAX_CHARACTER_BODY_LENGTH / 2);
    await writeCharacter(fixture.dir, allowed);
    expect((await readCharacter(fixture.dir))?.body).toBe(allowed);
    await expect(writeCharacter(fixture.dir, `${allowed}x`)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect((await readCharacter(fixture.dir))?.body).toBe(allowed);
    expect(original).not.toBe(allowed);
  });
});
