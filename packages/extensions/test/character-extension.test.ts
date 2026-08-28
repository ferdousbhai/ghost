import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCharacterExtension,
  GHOST_CHARACTER,
  MAX_CHARACTER_BODY_LENGTH,
} from "../src/extensions/character.js";
import { openGhostHome } from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import { loadExtension, resultText } from "./support/harness.js";

const SEEDED_CHARACTER = `# casper

You are casper.

## Voice

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Your memory files are yours, and the owner's Documents are shared with you. Read
them before you answer a question they cover, and write a memory file when you
learn something worth keeping.
`;

let fixture: GhostFixture;

beforeEach(async () => {
  fixture = await createGhostFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

function characterPath(): string {
  return join(fixture.dir, "character.md");
}

describe("character extension", () => {
  it("registers exactly the one character tool", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    expect(harness.toolNames()).toEqual([GHOST_CHARACTER]);
  });

  it("derives the populated character title from its Markdown heading", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(resultText(result)).toContain("You are Casper, the ghost of a working typographer");
    expect(resultText(result)).toContain("title: Casper");
    expect(result.details).toMatchObject({
      exists: true,
      empty: false,
      seeded: false,
      title: "Casper",
      truncated: false,
    });
  });

  it("says so plainly when there is no character file yet", async () => {
    await rm(characterPath());
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(resultText(result)).toContain("not written yet");
    expect(result.details).toMatchObject({ exists: false, empty: true, title: null });
  });

  it("reports an empty body as empty rather than as a persona", async () => {
    await writeFile(characterPath(), "\n\n", "utf8");
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(resultText(result)).toContain("is empty");
    expect(result.details).toMatchObject({ exists: true, empty: true, length: 0 });
  });

  it("flags the current file when it is still seeded", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await writeFile(characterPath(), SEEDED_CHARACTER, "utf8");
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(resultText(result)).toContain("still the seeded file");
    expect(result.details).toMatchObject({ exists: true, empty: false, seeded: true });
  });

  it("writes a body and round-trips it through the home reader", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, {
      action: "write",
      body: "# Casper\n\nI set type in the morning and answer plainly.",
    });
    expect(result.details).toMatchObject({ created: false });
    const character = await openGhostHome(fixture.dir).readCharacter();
    expect(character).toMatchObject({
      title: "Casper",
      body: "# Casper\n\nI set type in the morning and answer plainly.",
    });
  });

  it("writes the supplied plain Markdown without adding metadata", async () => {
    await writeFile(characterPath(), "Old body.\n", "utf8");
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await harness.call(GHOST_CHARACTER, {
      action: "write",
      body: "# New self\n\nNew body.",
    });
    const text = await readFile(characterPath(), "utf8");
    expect(text).toBe("# New self\n\nNew body.");
  });

  it("derives a title from any leading Markdown heading level", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await harness.call(GHOST_CHARACTER, {
      action: "write",
      body: "## Casper the printer\n\nI am someone else now.",
    });
    expect(await openGhostHome(fixture.dir).readCharacter())
      .toMatchObject({ title: "Casper the printer" });
  });

  it("creates the file when there is none", async () => {
    await rm(characterPath());
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, {
      action: "write",
      body: "I am new here.",
    });
    expect(result.details).toMatchObject({ created: true });
    expect(await openGhostHome(fixture.dir).readCharacter())
      .toMatchObject({ body: "I am new here." });
  });

  it("throws on an empty body rather than blanking the persona", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await expect(harness.call(GHOST_CHARACTER, { action: "write", body: "   \n" }))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(harness.call(GHOST_CHARACTER, { action: "write" }))
      .rejects.toMatchObject({ code: "invalid_format" });
    // Nothing was written: the fixture's character file is untouched.
    expect((await openGhostHome(fixture.dir).readCharacter())?.body)
      .toContain("You are Casper, the ghost of a working typographer");
  });

  it("throws when the body is over the cap, and writes nothing", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await expect(harness.call(GHOST_CHARACTER, {
      action: "write",
      body: "x".repeat(MAX_CHARACTER_BODY_LENGTH + 1),
    })).rejects.toMatchObject({
      code: "limit_exceeded",
      details: { limit: MAX_CHARACTER_BODY_LENGTH },
    });
    expect((await openGhostHome(fixture.dir).readCharacter())?.body)
      .toContain("You are Casper, the ghost of a working typographer");
  });

  it("rejects a hand-edited oversized body before it reaches the model", async () => {
    await writeFile(
      characterPath(),
      `${"y".repeat(MAX_CHARACTER_BODY_LENGTH + 500)}\n`,
      "utf8",
    );
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await expect(harness.call(GHOST_CHARACTER, { action: "read" }))
      .rejects.toMatchObject({
        code: "limit_exceeded",
        details: { limit: MAX_CHARACTER_BODY_LENGTH },
      });
  });
});
