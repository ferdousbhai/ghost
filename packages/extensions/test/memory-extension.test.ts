import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryExtension,
  GHOST_MEMORY_LIST,
  GHOST_MEMORY_READ,
  GHOST_MEMORY_WRITE,
} from "../src/extensions/memory.js";
import { openGhostHome } from "../src/home.js";
import { visitorScope } from "../src/scope.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import { loadExtension, resultText } from "./support/harness.js";

let fixture: GhostFixture;

beforeEach(async () => {
  fixture = await createGhostFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("memory extension", () => {
  it("registers exactly the three memory tools", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    expect(harness.toolNames()).toEqual([
      GHOST_MEMORY_LIST,
      GHOST_MEMORY_READ,
      GHOST_MEMORY_WRITE,
    ]);
  });

  it("lists the derived index, not a stored file", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    const text = resultText(await harness.call(GHOST_MEMORY_LIST));
    expect(text).toContain("- apprentice-question.md: A visitor asked how to start");
    expect(text).toContain("- working-habit.md: I work in the morning");
  });

  it("reads one memory file", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    const result = await harness.call(GHOST_MEMORY_READ, { name: "working-habit.md" });
    expect(resultText(result)).toContain("The press is cold until ten.");
    expect(result.details).toMatchObject({ slug: "working-habit", updated: "2026-08-02" });
  });

  it("throws on a missing file rather than returning an error payload", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    await expect(harness.call(GHOST_MEMORY_READ, { name: "nope.md" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("throws with instructional guidance on a bad name", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    await expect(harness.call(GHOST_MEMORY_READ, { name: "../../character.md" }))
      .rejects.toThrow(/kebab-case/);
  });

  it("writes one atomic file and derives its name when none is given", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    const result = await harness.call(GHOST_MEMORY_WRITE, {
      description: "Prefers short answers",
      content: "Said so twice.",
    });
    expect(result.details).toMatchObject({
      slug: "prefers-short-answers",
      path: "memory/prefers-short-answers.md",
      created: true,
    });
    expect(await readFile(join(fixture.dir, "memory/prefers-short-answers.md"), "utf8"))
      .toBe("---\ndescription: Prefers short answers\nupdated: "
        + `${new Date().toISOString().slice(0, 10)}\n---\n\nSaid so twice.\n`);
  });

  it("replaces a file when the name already exists", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    const result = await harness.call(GHOST_MEMORY_WRITE, {
      name: "working-habit",
      description: "I work in the morning",
      content: "Now: the press is cold until nine.",
    });
    expect(result.details).toMatchObject({ created: false });
    expect((await openGhostHome(fixture.dir).listMemory()).files).toHaveLength(2);
  });

  it("scopes a visitor session's writes to memory/.visitors/<id>/", async () => {
    const harness = await loadExtension(
      createMemoryExtension({ scope: visitorScope("visitor-1") }),
      fixture.dir,
    );
    const written = await harness.call(GHOST_MEMORY_WRITE, {
      description: "They restore presses too",
      content: "A Vandercook 4, same as mine.",
    });
    expect(written.details).toMatchObject({
      path: "memory/.visitors/visitor-1/they-restore-presses-too.md",
    });

    // The visitor session sees only its own scope, in both directions.
    const listed = resultText(await harness.call(GHOST_MEMORY_LIST));
    expect(listed).toContain("they-restore-presses-too.md");
    expect(listed).not.toContain("working-habit.md");
    await expect(harness.call(GHOST_MEMORY_READ, { name: "working-habit.md" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps parallel writes to one file consistent", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    await Promise.all(
      Array.from({ length: 10 }, (_, position) =>
        harness.call(GHOST_MEMORY_WRITE, {
          name: "hot-file.md",
          description: `write ${position}`,
          content: `body ${position}`,
        })),
    );
    const file = await openGhostHome(fixture.dir).readMemory("hot-file");
    expect(file.content).toBe(`body ${file.description.slice("write ".length)}`);
  });
});
