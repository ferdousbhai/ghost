import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCharacterExtension,
  GHOST_CHARACTER,
  MAX_CHARACTER_BODY_LENGTH,
} from "../src/extensions/character.js";
import { openGhostHome } from "../src/home.js";
import { visitorScope } from "../src/scope.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import { loadExtension, resultText } from "./support/harness.js";

/** The file the daemon seeds a freshly summoned ghost with. */
const SEEDED_CHARACTER = `---
public: true
title: casper
---

# casper

You are casper.

## Voice

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Your notes and memory files are yours. Read them before you answer a question
they cover, and write a memory file when you learn something about a visitor
that you would want to remember the next time they come back.
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

  it("reads the populated character file with its frontmatter", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(resultText(result)).toContain("You are Casper, the ghost of a working typographer");
    expect(resultText(result)).toContain("title: Casper");
    expect(result.details).toMatchObject({
      exists: true,
      empty: false,
      seeded: false,
      title: "Casper",
      public: true,
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
    await writeFile(characterPath(), "---\npublic: true\ntitle: Casper\n---\n\n\n", "utf8");
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(resultText(result)).toContain("is empty");
    expect(result.details).toMatchObject({ exists: true, empty: true, length: 0 });
  });

  it("flags a file that is still the seeded one", async () => {
    await writeFile(characterPath(), SEEDED_CHARACTER, "utf8");
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
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
    expect(result.details).toMatchObject({ created: false, title: "Casper", public: true });
    const character = await openGhostHome(fixture.dir).readCharacter();
    expect(character).toMatchObject({
      title: "Casper",
      public: true,
      body: "# Casper\n\nI set type in the morning and answer plainly.",
    });
  });

  it("keeps the existing title and public flag when the write omits them", async () => {
    await writeFile(
      characterPath(),
      "---\npublic: false\ntitle: Casper\n---\n\nOld body.\n",
      "utf8",
    );
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await harness.call(GHOST_CHARACTER, { action: "write", body: "New body." });
    const text = await readFile(characterPath(), "utf8");
    expect(text).toContain("public: false");
    expect(text).toContain("title: Casper");
    expect(text).toContain("New body.");
  });

  it("takes a new title when one is given", async () => {
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    await harness.call(GHOST_CHARACTER, {
      action: "write",
      body: "I am someone else now.",
      title: "Casper the printer",
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
    expect(result.details).toMatchObject({ created: true, public: true, title: null });
    expect(await openGhostHome(fixture.dir).readCharacter())
      .toMatchObject({ body: "I am new here.", public: true });
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

  it("caps an oversized body on the way to the model", async () => {
    await writeFile(
      characterPath(),
      `---\npublic: true\ntitle: Casper\n---\n\n${"y".repeat(MAX_CHARACTER_BODY_LENGTH + 500)}\n`,
      "utf8",
    );
    const harness = await loadExtension(createCharacterExtension(), fixture.dir);
    const result = await harness.call(GHOST_CHARACTER, { action: "read" });
    expect(result.details).toMatchObject({ truncated: true });
    expect(resultText(result)).toContain("showing the first");
  });

  it("registers no tool at all in a visitor scope, and gates the name", async () => {
    const harness = await loadExtension(
      createCharacterExtension({ scope: visitorScope("visitor-1") }),
      fixture.dir,
    );
    expect(harness.toolNames()).toEqual([]);
    const blocked = await harness.toolCall(GHOST_CHARACTER, { action: "read" });
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain("visitor conversation");
  });
});
