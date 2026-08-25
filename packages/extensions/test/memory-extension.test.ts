import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryExtension,
  GHOST_MEMORY_WRITE,
} from "../src/extensions/memory.js";
import { openGhostHome } from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import { loadExtension } from "./support/harness.js";

let fixture: GhostFixture;

beforeEach(async () => {
  fixture = await createGhostFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("memory extension", () => {
  it("registers only the structured writer", async () => {
    const harness = await loadExtension(createMemoryExtension(), fixture.dir);
    expect(harness.toolNames()).toEqual([GHOST_MEMORY_WRITE]);
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
