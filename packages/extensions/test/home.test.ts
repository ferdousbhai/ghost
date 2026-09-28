import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GhostHome,
  MAX_CHARACTER_BODY_LENGTH,
  openGhostHome,
} from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";

let fixture: GhostFixture;
let home: GhostHome;

beforeEach(async () => {
  fixture = await createGhostFixture();
  home = openGhostHome(fixture.dir);
});

afterEach(async () => {
  await fixture.cleanup();
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

  it("refuses an oversized owner edit before writing, counting UTF-16 code units", async () => {
    const original = (await home.readCharacter())?.body;
    const allowed = "🙂".repeat(MAX_CHARACTER_BODY_LENGTH / 2);
    await home.writeCharacter({ body: allowed });
    expect((await home.readCharacter())?.body).toBe(allowed);
    await expect(home.writeCharacter({ body: `${allowed}x` })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect((await home.readCharacter())?.body).toBe(allowed);
    expect(original).not.toBe(allowed);
  });
});
