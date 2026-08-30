import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostError, MemoryFileFormatError } from "../src/errors.js";
import {
  type GhostHome,
  MAX_CHARACTER_BODY_LENGTH,
  openGhostHome,
} from "../src/home.js";
import { deriveMemoryIndex, MAX_MEMORY_FILE_BYTES } from "../src/memory-file.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";

let fixture: GhostFixture;
let home: GhostHome;

async function waitForPath(path: string): Promise<void> {
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

async function childResult(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
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
    expect(home.memoryDir).toBe(join(fixture.dir, "memory"));
  });

  it("never writes a derived index", async () => {
    await home.writeMemory({ content: "a fact" });
    const listing = await home.listMemory();
    expect(deriveMemoryIndex(listing.files).lines.length).toBeGreaterThan(0);
    await expect(readFile(join(fixture.dir, "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it.each([
    ["notes/ only", {
      "notes/project.md": "---\ntitle: Old note\n---\n\nOriginal bytes.\n",
    }],
    ["docs/ only", {
      "docs/project.md": "---\ntitle: Old document\n---\n\nOther original bytes.\n",
    }],
    ["notes/ and docs/ together", {
      "notes/project.md": "---\ntitle: Old note\n---\n\nOriginal bytes.\n",
      "docs/project.md": "---\ntitle: Old document\n---\n\nOther original bytes.\n",
    }],
  ] as const)("leaves retained %s names, inodes, and bytes untouched", async (_label, files) => {
    const retained = await createGhostFixture("retained", files);
    try {
      const directories = [...new Set(Object.keys(files).map((path) => path.split("/")[0]!))];
      const directoryInodes = new Map<string, number>();
      const directoryEntries = new Map<string, string[]>();
      const fileInodes = new Map<string, number>();
      for (const directory of directories) {
        directoryInodes.set(directory, (await stat(join(retained.dir, directory))).ino);
        directoryEntries.set(directory, await readdir(join(retained.dir, directory)));
      }
      for (const path of Object.keys(files)) {
        fileInodes.set(path, (await stat(join(retained.dir, path))).ino);
      }

      await openGhostHome(retained.dir).ensure();

      for (const directory of directories) {
        expect((await stat(join(retained.dir, directory))).ino).toBe(directoryInodes.get(directory));
        expect(await readdir(join(retained.dir, directory))).toEqual(directoryEntries.get(directory));
      }
      for (const [path, bytes] of Object.entries(files)) {
        expect((await stat(join(retained.dir, path))).ino).toBe(fileInodes.get(path));
        expect(await readFile(join(retained.dir, path))).toEqual(Buffer.from(bytes));
      }
      expect((await readdir(retained.dir)).sort()).toEqual([
        ...directories,
        "memory",
      ].sort());
    } finally {
      await retained.cleanup();
    }
  });
});

describe("character", () => {
  it("reads the persona and derives its title from the leading heading", async () => {
    const character = await home.readCharacter();
    expect(character?.title).toBe("Casper");
    expect(character?.body.startsWith("# Casper")).toBe(true);
  });

  it("leaves the derived title empty when the body has no leading heading", async () => {
    await writeFile(home.characterPath, "I keep the old ledgers.\n", "utf8");
    expect(await home.readCharacter()).toEqual({
      title: undefined,
      body: "I keep the old ledgers.\n",
    });
  });

  it("returns null when there is no character file", async () => {
    expect(await openGhostHome(fixture.root).readCharacter()).toBeNull();
  });

  it("rejects an oversized direct write without replacing the character", async () => {
    const before = await readFile(home.characterPath, "utf8");
    await expect(home.writeCharacter({
      body: "x".repeat(MAX_CHARACTER_BODY_LENGTH + 1),
    })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(await readFile(home.characterPath, "utf8")).toBe(before);
  });
});

describe("memory", () => {
  it("lists memory in slug order", async () => {
    const { files, skipped } = await home.listMemory();
    expect(skipped).toEqual([]);
    expect(files.map((file) => file.slug)).toEqual([
      "apprentice-question",
      "working-habit",
    ]);
    expect(files[0]?.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("replaces an existing file rather than appending a second one", async () => {
    await home.writeMemory({
      name: "working-habit.md",
      content: "Updated: the press is cold until nine.",
    });
    const { files } = await home.listMemory();
    expect(files).toHaveLength(2);
    expect((await home.readMemory("working-habit")).content)
      .toBe("Updated: the press is cold until nine.");
  });

  it("redacts secrets before validation, slug derivation, and publication", async () => {
    const result = await home.writeMemory({
      content: `api_key=${"s".repeat(2_100)}`,
    });
    expect(result.slug).toBe("apikeyredactedsecret");
    expect(await readFile(join(home.memoryDir, `${result.slug}.md`), "utf8"))
      .toBe("api_key=[REDACTED_SECRET]\n");

    await home.writeMemory({
      name: "credentials",
      content: "Use Bearer eyJhbGciOi.secret.signature and ghp_abcdefghijklmnopqrstuvwxyz123456.",
    });
    const stored = await readFile(join(home.memoryDir, "credentials.md"), "utf8");
    expect(stored).toBe("Use Bearer [REDACTED_SECRET] and [REDACTED_SECRET].\n");
  });

  it("moves memories into collision-safe in-home trash under the write lock", async () => {
    const first = await home.deleteMemory("working-habit");
    expect(first).toEqual({
      slug: "working-habit",
      path: "memory/working-habit.md",
      trash: ".trash/working-habit.md",
    });
    expect(await readFile(join(fixture.dir, first.trash), "utf8"))
      .toContain("press");

    await home.writeMemory({ name: "working-habit", content: "A replacement fact." });
    const second = await home.deleteMemory("working-habit.md");
    expect(second.trash).toBe(".trash/working-habit-2.md");
    expect(await readFile(join(fixture.dir, first.trash), "utf8"))
      .not.toBe(await readFile(join(fixture.dir, second.trash), "utf8"));
    await expect(home.readMemory("working-habit")).rejects.toMatchObject({ code: "not_found" });

    const longestSlug = "x".repeat(64);
    await home.writeMemory({ name: longestSlug, content: "First longest-slug fact." });
    await home.deleteMemory(longestSlug);
    await home.writeMemory({ name: longestSlug, content: "Second longest-slug fact." });
    const longestCollision = await home.deleteMemory(longestSlug);
    expect(longestCollision.trash).toBe(`.trash/${longestSlug}-2.md`);
    await expect(home.readTrashedMemorySource(longestCollision.trash))
      .resolves.toBe("Second longest-slug fact.\n");
  });

  it("journals a delete before rename and confines every memory and trash name", async () => {
    const source = await home.readMemorySource("working-habit");
    let intent!: Parameters<typeof home.validateMemoryDeleteIntent>[0];
    const result = await home.deleteMemoryWithReceipt("working-habit", async (journaled) => {
      intent = journaled;
      home.validateMemoryDeleteIntent(journaled);
      expect(journaled.before).toBe(source);
      expect(journaled.beforeSha256).toMatch(/^[0-9a-f]{64}$/u);
      await expect(home.readMemory("working-habit")).resolves.toBeDefined();
    });
    expect(result.receipt).toMatchObject({ operation: "deleted", ...intent });
    expect(await home.readTrashedMemorySource(result.receipt.trash)).toBe(source);
    await expect(home.deleteMemory("../../character.md"))
      .rejects.toBeInstanceOf(MemoryFileFormatError);
    await expect(home.readTrashedMemorySource("../character.md"))
      .rejects.toMatchObject({ code: "invalid_path" });

    const outside = join(fixture.root, "outside-delete.md");
    await writeFile(outside, "must stay outside\n");
    await symlink(outside, join(home.memoryDir, "linked-delete.md"));
    await expect(home.deleteMemory("linked-delete"))
      .rejects.toMatchObject({ code: "invalid_path" });
    expect(await readFile(outside, "utf8")).toBe("must stay outside\n");
  });

  it("does not move a memory when its delete journal fails", async () => {
    await expect(home.deleteMemoryWithReceipt("working-habit", async () => {
      throw new Error("journal unavailable");
    })).rejects.toThrow("journal unavailable");
    await expect(home.readMemory("working-habit")).resolves.toBeDefined();
  });

  it("journals exact memory bytes before publishing and returns the matching receipt", async () => {
    const before = await readFile(join(home.memoryDir, "working-habit.md"), "utf8");
    let publishedDuringJournal = false;
    const result = await home.writeMemoryWithReceipt({
      name: "working-habit",
      content: "The owner now starts the press at ten.",
    }, async (intent) => {
      expect(intent.before).toBe(before);
      expect(intent.after).toBe("The owner now starts the press at ten.\n");
      expect(intent.beforeSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(intent.afterSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(intent.path).toBe("memory/working-habit.md");
      publishedDuringJournal = await readFile(join(home.memoryDir, "working-habit.md"), "utf8")
        === intent.after;
    });

    expect(publishedDuringJournal).toBe(false);
    expect(result.written).toEqual({
      slug: "working-habit",
      path: "memory/working-habit.md",
      created: false,
    });
    expect(result.receipt).toMatchObject({
      operation: "updated",
      before,
      after: "The owner now starts the press at ten.\n",
    });
    expect(await readFile(join(home.memoryDir, "working-habit.md"), "utf8"))
      .toBe(result.receipt.after);
  });

  it("does not publish a memory write when its pre-publication journal fails", async () => {
    const path = join(home.memoryDir, "working-habit.md");
    const before = await readFile(path, "utf8");
    await expect(home.writeMemoryWithReceipt({
      name: "working-habit",
      content: "This must not publish.",
    }, async () => {
      throw new Error("journal unavailable");
    })).rejects.toThrow("journal unavailable");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("replays only the exact journaled memory bytes under the descriptor lock", async () => {
    const path = join(home.memoryDir, "working-habit.md");
    const before = await readFile(path, "utf8");
    let intent: Parameters<typeof home.replayMemoryWriteIntent>[0] | undefined;
    await expect(home.writeMemoryWithReceipt({
      name: "working-habit",
      content: "The owner starts the press at eleven.",
    }, async (journaled) => {
      intent = journaled;
      throw new Error("simulated crash before rename");
    })).rejects.toThrow("simulated crash before rename");
    expect(await readFile(path, "utf8")).toBe(before);

    const receipt = await home.replayMemoryWriteIntent(intent as NonNullable<typeof intent>);
    expect(receipt).toMatchObject({
      operation: "updated",
      before,
      after: "The owner starts the press at eleven.\n",
    });
    expect(await readFile(path, "utf8")).toBe(receipt.after);
    await expect(home.replayMemoryWriteIntent(intent as NonNullable<typeof intent>))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a malformed write with instructional guidance", async () => {
    await expect(home.writeMemory({ content: "" }))
      .rejects.toThrow(MemoryFileFormatError);
    await expect(home.writeMemory({ content: "x".repeat(2_001) }))
      .rejects.toThrow(MemoryFileFormatError);
  });

  it("reports an empty memory file instead of dropping it silently", async () => {
    await writeFile(join(home.memoryDir, "broken.md"), "\n", "utf8");
    const { files, skipped } = await home.listMemory();
    expect(files.map((file) => file.slug)).not.toContain("broken");
    expect(skipped[0]?.path).toBe("memory/broken.md");
  });

  it("admits the exact 6,001-byte UTF-8 boundary and skips one byte beyond it", async () => {
    const content = "\u0800".repeat(2_000);
    const atLimit = join(home.memoryDir, "at-limit.md");
    const overLimit = join(home.memoryDir, "over-limit.md");
    const overCharacters = join(home.memoryDir, "over-characters.md");
    const bomOverLimit = join(home.memoryDir, "bom-over-limit.md");
    await writeFile(atLimit, `${content}\n`);
    await writeFile(overLimit, `${content}\n\n`);
    await writeFile(overCharacters, `${"x".repeat(2_001)}\n`);
    await writeFile(bomOverLimit, `\uFEFF${content}\n`);

    expect((await stat(atLimit)).size).toBe(MAX_MEMORY_FILE_BYTES);
    expect((await stat(overCharacters)).size).toBeLessThan(MAX_MEMORY_FILE_BYTES);
    expect((await stat(bomOverLimit)).size).toBe(MAX_MEMORY_FILE_BYTES + 3);
    await expect(home.readMemory("at-limit")).resolves.toMatchObject({ content });
    await expect(home.readMemorySource("at-limit")).resolves.toBe(`${content}\n`);
    await expect(home.readMemory("over-limit"))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.readMemorySource("over-limit"))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.readMemory("over-characters"))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.readMemorySource("over-characters"))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.readMemory("bom-over-limit"))
      .rejects.toMatchObject({ code: "invalid_format" });

    const listing = await home.listMemory();
    expect(listing.files.map((file) => file.slug)).toContain("at-limit");
    expect(listing.files.map((file) => file.slug)).not.toContain("over-limit");
    expect(listing.files.map((file) => file.slug)).not.toContain("over-characters");
    expect(listing.skipped).toContainEqual(expect.objectContaining({
      path: "memory/over-limit.md",
      reason: expect.stringContaining(`${MAX_MEMORY_FILE_BYTES}-byte limit`),
    }));
    expect(listing.skipped).toContainEqual(expect.objectContaining({
      path: "memory/over-characters.md",
      reason: expect.stringContaining("2000 characters or fewer"),
    }));
  });

  it("rejects oversized sparse memory before reading or decoding it", async () => {
    const path = join(home.memoryDir, "sparse.md");
    await writeFile(path, "");
    await truncate(path, MAX_MEMORY_FILE_BYTES + 1);

    await expect(home.readMemory("sparse"))
      .rejects.toBeInstanceOf(MemoryFileFormatError);
    await expect(home.readMemorySource("sparse"))
      .rejects.toMatchObject({ code: "invalid_format" });
    expect((await home.listMemory()).skipped).toContainEqual(expect.objectContaining({
      path: "memory/sparse.md",
      reason: expect.stringContaining(`${MAX_MEMORY_FILE_BYTES}-byte limit`),
    }));
  });

  it("skips symlink, FIFO, and invalid UTF-8 entries while direct reads fail typed", async () => {
    const outside = join(fixture.root, "outside-memory.md");
    await writeFile(outside, "outside bytes must not be read\n");
    await symlink(outside, join(home.memoryDir, "linked.md"));
    execFileSync("mkfifo", [join(home.memoryDir, "blocking.md")]);
    await writeFile(join(home.memoryDir, "invalid-utf8.md"), new Uint8Array([0xc3, 0x28]));

    const started = Date.now();
    const listing = await home.listMemory();
    expect(Date.now() - started).toBeLessThan(1_000);
    for (const name of ["linked", "blocking", "invalid-utf8"]) {
      expect(listing.files.map((file) => file.slug)).not.toContain(name);
      expect(listing.skipped.map((entry) => entry.path)).toContain(`memory/${name}.md`);
      await expect(home.readMemory(name)).rejects.toBeInstanceOf(GhostError);
      await expect(home.readMemorySource(name)).rejects.toBeInstanceOf(GhostError);
    }
    await expect(home.readMemory("invalid-utf8"))
      .rejects.toBeInstanceOf(MemoryFileFormatError);
    expect(JSON.stringify(listing)).not.toContain("outside bytes");
  });

  it("skips descriptor-time mutation and fails direct reads on pathname replacement", async () => {
    const growing = join(home.memoryDir, "growing.md");
    await writeFile(growing, "stable fact\n");
    let grew = false;
    const listingHome = openGhostHome(fixture.dir, {
      memoryReadProbe: async (stage, path) => {
        if (!grew && stage === "read" && path === "memory/growing.md") {
          grew = true;
          await appendFile(growing, "growth");
        }
      },
    });
    const listing = await listingHome.listMemory();
    expect(listing.files.map((file) => file.slug)).not.toContain("growing");
    expect(listing.skipped).toContainEqual(expect.objectContaining({
      path: "memory/growing.md",
      reason: expect.stringContaining("changed while it was being read"),
    }));

    const swapped = join(home.memoryDir, "swapped.md");
    const displaced = join(home.memoryDir, ".swapped.displaced");
    await writeFile(swapped, "pinned fact\n");
    let replaced = false;
    const directHome = openGhostHome(fixture.dir, {
      memoryReadProbe: async (stage, path) => {
        if (!replaced && stage === "opened" && path === "memory/swapped.md") {
          replaced = true;
          await rename(swapped, displaced);
          await writeFile(swapped, "pinned fact\n");
        }
      },
    });
    await expect(directHome.readMemory("swapped"))
      .rejects.toMatchObject({ code: "conflict" });
    await unlink(displaced);
  });

  it("preserves exact admitted owner bytes at the maintenance receipt boundary", async () => {
    const path = join(home.memoryDir, "working-habit.md");
    const ownerBytes = "\uFEFF  Owner-authored spacing stays exact.  \n\n";
    await writeFile(path, ownerBytes);
    await expect(home.readMemorySource("working-habit")).resolves.toBe(ownerBytes);

    let journaledBefore: string | null | undefined;
    await home.writeMemoryWithReceipt({
      name: "working-habit",
      content: "Replacement fact.",
    }, async (intent) => {
      journaledBefore = intent.before;
    });
    expect(journaledBefore).toBe(ownerBytes);
  });

  it("serializes concurrent writes to the same file", async () => {
    // pi runs a batch of tool calls in parallel; the last write must win whole,
    // not interleave with the others.
    await Promise.all(
      Array.from({ length: 12 }, (_, position) =>
        home.writeMemory({
          name: "hot-file.md",
          content: `write ${position}`,
        })),
    );
    const file = await home.readMemory("hot-file");
    expect(file.content).toMatch(/^write \d+$/);
    const { files } = await home.listMemory();
    expect(files.filter((entry) => entry.slug === "hot-file")).toHaveLength(1);
  });

  it("serializes the directory-wide quota across different new names", async () => {
    const filler = "x\n";
    await Promise.all(Array.from({ length: 497 }, (_, index) =>
      writeFile(join(home.memoryDir, `filler-${index}.md`), filler, "utf8")
    ));

    const results = await Promise.allSettled([
      home.writeMemory({ name: "last-a", content: "a" }),
      home.writeMemory({ name: "last-b", content: "b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "limit_exceeded" }) }),
    ]);
    expect((await home.listMemory()).files).toHaveLength(500);
  });

  it("serializes the memory quota across separate Bun processes", async () => {
    const filler = "x\n";
    await Promise.all(Array.from({ length: 497 }, (_, index) =>
      writeFile(join(home.memoryDir, `process-filler-${index}.md`), filler, "utf8")
    ));

    const go = join(fixture.root, "process-go");
    const moduleUrl = new URL("../src/home.ts", import.meta.url).href;
    const spawnWriter = (name: string): ChildProcess => {
      const ready = join(fixture.root, `${name}.ready`);
      return spawn(process.execPath, [
        "-e",
        `
          const { openGhostHome } = await import(${JSON.stringify(moduleUrl)});
          await Bun.write(${JSON.stringify(ready)}, "ready");
          while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(5);
          await openGhostHome(${JSON.stringify(fixture.dir)}).writeMemory({
            name: ${JSON.stringify(name)},
            content: ${JSON.stringify(name)},
          });
        `,
      ], { stdio: ["ignore", "ignore", "pipe"] });
    };
    const first = spawnWriter("process-last-a");
    const second = spawnWriter("process-last-b");
    const firstResult = childResult(first);
    const secondResult = childResult(second);
    await Promise.all([
      waitForPath(join(fixture.root, "process-last-a.ready")),
      waitForPath(join(fixture.root, "process-last-b.ready")),
    ]);
    await writeFile(go, "go");

    const results = await Promise.all([firstResult, secondResult]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(results.find((result) => result.code !== 0)?.stderr)
      .toContain("limit_exceeded");
    expect((await home.listMemory()).files).toHaveLength(500);
  });
});
