import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveNoteCatalog } from "../src/catalog.js";
import { GhostError, MemoryFileFormatError } from "../src/errors.js";
import { GhostHome, openGhostHome } from "../src/home.js";
import { deriveMemoryIndex } from "../src/memory-file.js";
import { CREATOR_SCOPE, visitorScope } from "../src/scope.js";
import {
  ARCHIVED_NOTE_PATH,
  createGhostFixture,
  PRIVATE_NOTE_PATH,
  PUBLIC_NOTE_PATH,
  type GhostFixture,
} from "./support/fixture.js";

let fixture: GhostFixture;
let home: GhostHome;

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
    expect(home.memoryDirFor(CREATOR_SCOPE)).toBe(join(fixture.dir, "memory"));
    expect(home.memoryDirFor(visitorScope("visitor-1")))
      .toBe(join(fixture.dir, "memory", ".visitors", "visitor-1"));
  });

  it("refuses a visitor id that is not a single path segment", () => {
    expect(() => visitorScope("../escape")).toThrow(GhostError);
    expect(() => visitorScope("a/b")).toThrow(GhostError);
    expect(() => visitorScope("")).toThrow(GhostError);
  });

  it("never writes a derived index", async () => {
    await home.writeMemory({ description: "a fact", content: "the body" });
    const listing = await home.listMemory();
    expect(deriveMemoryIndex(listing.files).lines.length).toBeGreaterThan(0);
    await expect(readFile(join(fixture.dir, "MEMORY.md"), "utf8")).rejects.toThrow();
  });
});

describe("character", () => {
  it("reads the persona body without the frontmatter", async () => {
    const character = await home.readCharacter();
    expect(character?.title).toBe("Casper");
    expect(character?.public).toBe(true);
    expect(character?.body.startsWith("# Casper")).toBe(true);
  });

  it("returns null when there is no character file", async () => {
    expect(await openGhostHome(fixture.root).readCharacter()).toBeNull();
  });
});

describe("notes", () => {
  it("lists every note with its frontmatter", async () => {
    const { notes, skipped } = await home.listNotes();
    expect(skipped).toEqual([]);
    expect(notes.map((note) => note.path)).toEqual([
      PUBLIC_NOTE_PATH,
      PRIVATE_NOTE_PATH,
      ARCHIVED_NOTE_PATH,
      "press-restoration.md",
    ].sort((a, b) => a.localeCompare(b)));

    const paper = notes.find((note) => note.path === PUBLIC_NOTE_PATH);
    expect(paper?.public).toBe(true);
    expect(paper?.tags).toEqual(["paper", "press"]);
    const finances = notes.find((note) => note.path === PRIVATE_NOTE_PATH);
    expect(finances?.public).toBe(false);
    const archived = notes.find((note) => note.path === ARCHIVED_NOTE_PATH);
    expect(archived?.archived).toBe(true);
  });

  it("treats a note without frontmatter as private", async () => {
    await home.writeNote("scratch.md", { body: "unmarked" });
    const note = await home.readNote("scratch");
    expect(note.meta.public).toBe(false);
  });

  it("keeps the body byte-identical across a read/write round trip", async () => {
    const before = await readFile(join(home.notesDir, PUBLIC_NOTE_PATH), "utf8");
    const note = await home.readNote(PUBLIC_NOTE_PATH);
    await home.writeNote(PUBLIC_NOTE_PATH, {
      body: note.body,
      public: note.meta.public,
      ...(note.meta.title === undefined ? {} : { title: note.meta.title }),
      tags: note.meta.tags,
    });
    expect(await readFile(join(home.notesDir, PUBLIC_NOTE_PATH), "utf8")).toBe(before);
  });

  it("preserves unspecified frontmatter when rewriting a body", async () => {
    await home.writeNote(PUBLIC_NOTE_PATH, { body: "new body" });
    const note = await home.readNote(PUBLIC_NOTE_PATH);
    expect(note.body).toBe("new body");
    expect(note.meta.public).toBe(true);
    expect(note.meta.tags).toEqual(["paper", "press"]);
  });

  it("refuses paths that escape the notes directory", async () => {
    await expect(home.readNote("../../etc/passwd")).rejects.toThrow(GhostError);
    await expect(home.writeNote("../outside.md", { body: "x" })).rejects.toThrow(GhostError);
  });

  it("throws not_found rather than returning an error payload", async () => {
    await expect(home.readNote("missing.md")).rejects.toMatchObject({ code: "not_found" });
  });

  it("searches bodies and reports line numbers", async () => {
    const result = await home.searchNotes("carriage");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe("press-restoration.md");
    expect(result.matches[0]?.line).toBe(1);
  });

  it("keeps private and archived notes out of a visitor search", async () => {
    const scope = visitorScope("visitor-1");
    expect((await home.searchNotes("lease", { scope })).matches).toEqual([]);
    expect((await home.searchNotes("Superseded", { scope })).matches).toEqual([]);
    expect((await home.searchNotes("Damp", { scope })).matches).toHaveLength(1);
  });
});

describe("note catalog", () => {
  it("marks visibility for the creator and hides private notes from a visitor", async () => {
    const { notes } = await home.listNotes();
    const creator = deriveNoteCatalog(notes, CREATOR_SCOPE);
    expect(creator.total).toBe(4);
    expect(creator.lines.join("\n")).toContain(`${PRIVATE_NOTE_PATH}: Estate and finances (private)`);

    const visitor = deriveNoteCatalog(notes, visitorScope("visitor-1"));
    expect(visitor.lines.join("\n")).not.toContain(PRIVATE_NOTE_PATH);
    expect(visitor.lines.join("\n")).not.toContain(ARCHIVED_NOTE_PATH);
    expect(visitor.total).toBe(2);
  });
});

describe("memory", () => {
  it("lists creator memory in slug order", async () => {
    const { files, skipped } = await home.listMemory();
    expect(skipped).toEqual([]);
    expect(files.map((file) => file.slug)).toEqual([
      "apprentice-question",
      "working-habit",
    ]);
    expect(files[0]?.updated).toBe("2026-08-01");
  });

  it("keeps visitor memory in its own scope", async () => {
    const scope = visitorScope("visitor-1");
    const creator = await home.listMemory();
    expect(creator.files.some((file) => file.slug === "asked-about-press")).toBe(false);

    const visitor = await home.listMemory(scope);
    expect(visitor.files.map((file) => file.slug)).toEqual(["asked-about-press"]);
    expect(await home.listVisitors()).toEqual(["visitor-1"]);
  });

  it("writes a visitor memory under memory/.visitors/<id>/", async () => {
    const scope = visitorScope("visitor-2");
    const written = await home.writeMemory(
      { description: "They print letterpress too", content: "Restoring a Vandercook." },
      scope,
    );
    expect(written.path).toBe("memory/.visitors/visitor-2/they-print-letterpress-too.md");
    expect(written.created).toBe(true);
    expect(await home.listVisitors()).toEqual(["visitor-1", "visitor-2"]);
    // And it stays out of the creator's index.
    const creator = await home.listMemory();
    expect(creator.files.some((file) => file.slug === "they-print-letterpress-too")).toBe(false);
  });

  it("replaces an existing file rather than appending a second one", async () => {
    await home.writeMemory({
      name: "working-habit.md",
      description: "I work in the morning",
      content: "Updated: the press is cold until nine.",
    });
    const { files } = await home.listMemory();
    expect(files).toHaveLength(2);
    expect((await home.readMemory("working-habit")).content)
      .toBe("Updated: the press is cold until nine.");
  });

  it("rejects a malformed write with instructional guidance", async () => {
    await expect(home.writeMemory({ description: "", content: "x" }))
      .rejects.toThrow(MemoryFileFormatError);
    await expect(home.writeMemory({ description: "d", content: "x".repeat(2_001) }))
      .rejects.toThrow(MemoryFileFormatError);
  });

  it("reports an unreadable memory file instead of dropping it silently", async () => {
    await writeFile(join(home.memoryDir, "broken.md"), "no frontmatter", "utf8");
    const { files, skipped } = await home.listMemory();
    expect(files.map((file) => file.slug)).not.toContain("broken");
    expect(skipped[0]?.path).toBe("memory/broken.md");
  });

  it("serializes concurrent writes to the same file", async () => {
    // pi runs a batch of tool calls in parallel; the last write must win whole,
    // not interleave with the others.
    await Promise.all(
      Array.from({ length: 12 }, (_, position) =>
        home.writeMemory({
          name: "hot-file.md",
          description: `write ${position}`,
          content: `body ${position}`,
        })),
    );
    const file = await home.readMemory("hot-file");
    expect(file.description).toMatch(/^write \d+$/);
    expect(file.content).toBe(`body ${file.description.slice("write ".length)}`);
    const { files } = await home.listMemory();
    expect(files.filter((entry) => entry.slug === "hot-file")).toHaveLength(1);
  });
});

describe("conversations", () => {
  it("lists imported transcripts", async () => {
    expect(await home.listConversations()).toEqual(["conv-1"]);
  });
});
