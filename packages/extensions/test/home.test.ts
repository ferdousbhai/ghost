import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveDocCatalog } from "../src/catalog.js";
import { GhostError, MemoryFileFormatError } from "../src/errors.js";
import { type GhostHome, openGhostHome } from "../src/home.js";
import { deriveMemoryIndex } from "../src/memory-file.js";
import {
  ARCHIVED_DOC_PATH,
  createGhostFixture,
  FINANCE_DOC_PATH,
  PAPER_DOC_PATH,
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
    expect(home.memoryDir).toBe(join(fixture.dir, "memory"));
  });

  it("never writes a derived index", async () => {
    await home.writeMemory({ description: "a fact", content: "the body" });
    const listing = await home.listMemory();
    expect(deriveMemoryIndex(listing.files).lines.length).toBeGreaterThan(0);
    await expect(readFile(join(fixture.dir, "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it("atomically migrates an unambiguous legacy notes directory", async () => {
    const legacy = await createGhostFixture("legacy", {
      "character.md": "# Legacy\n",
      "notes/project.md": "legacy bytes\n",
    });
    try {
      const legacyHome = openGhostHome(legacy.dir);
      await legacyHome.ensure();
      expect(await readFile(join(legacyHome.docsDir, "project.md"), "utf8"))
        .toBe("legacy bytes\n");
      await expect(readFile(join(legacy.dir, "notes", "project.md"), "utf8"))
        .rejects.toThrow();
    } finally {
      await legacy.cleanup();
    }
  });

  it("refuses to guess when legacy notes and canonical docs both exist", async () => {
    const ambiguous = await createGhostFixture("ambiguous", {
      "character.md": "# Ambiguous\n",
      "notes/project.md": "legacy\n",
      "docs/project.md": "canonical\n",
    });
    try {
      await expect(openGhostHome(ambiguous.dir).ensure())
        .rejects.toMatchObject({ code: "conflict" });
      expect(await readFile(join(ambiguous.dir, "notes", "project.md"), "utf8"))
        .toBe("legacy\n");
      expect(await readFile(join(ambiguous.dir, "docs", "project.md"), "utf8"))
        .toBe("canonical\n");
    } finally {
      await ambiguous.cleanup();
    }
  });
});

describe("character", () => {
  it("reads the persona body without the frontmatter", async () => {
    const character = await home.readCharacter();
    expect(character?.title).toBe("Casper");
    expect(character?.body.startsWith("# Casper")).toBe(true);
  });

  it("returns null when there is no character file", async () => {
    expect(await openGhostHome(fixture.root).readCharacter()).toBeNull();
  });
});

describe("docs", () => {
  it("lists every doc with its frontmatter", async () => {
    const { docs, skipped } = await home.listDocs();
    expect(skipped).toEqual([]);
    expect(docs.map((doc) => doc.path)).toEqual([
      PAPER_DOC_PATH,
      FINANCE_DOC_PATH,
      ARCHIVED_DOC_PATH,
      "press-restoration.md",
    ].sort((a, b) => a.localeCompare(b)));

    const paper = docs.find((doc) => doc.path === PAPER_DOC_PATH);
    expect(paper?.tags).toEqual(["paper", "press"]);
    const archived = docs.find((doc) => doc.path === ARCHIVED_DOC_PATH);
    expect(archived?.archived).toBe(true);
  });

  it("reads a doc without frontmatter", async () => {
    await home.writeDoc("scratch.md", { body: "unmarked" });
    const doc = await home.readDoc("scratch");
    expect(doc.body).toBe("unmarked");
  });

  it("keeps the body byte-identical across a read/write round trip", async () => {
    const before = await readFile(join(home.docsDir, PAPER_DOC_PATH), "utf8");
    const doc = await home.readDoc(PAPER_DOC_PATH);
    await home.writeDoc(PAPER_DOC_PATH, {
      body: doc.body,
      ...(doc.meta.title === undefined ? {} : { title: doc.meta.title }),
      tags: doc.meta.tags,
    });
    expect(await readFile(join(home.docsDir, PAPER_DOC_PATH), "utf8")).toBe(before);
  });

  it("preserves unspecified frontmatter when rewriting a body", async () => {
    await home.writeDoc(PAPER_DOC_PATH, { body: "new body" });
    const doc = await home.readDoc(PAPER_DOC_PATH);
    expect(doc.body).toBe("new body");
    expect(doc.meta.tags).toEqual(["paper", "press"]);
  });

  it("refuses paths that escape the docs directory", async () => {
    await expect(home.readDoc("../../etc/passwd")).rejects.toThrow(GhostError);
    await expect(home.writeDoc("../outside.md", { body: "x" })).rejects.toThrow(GhostError);
  });

  it("throws not_found rather than returning an error payload", async () => {
    await expect(home.readDoc("missing.md")).rejects.toMatchObject({ code: "not_found" });
  });

  it("searches bodies and reports line numbers", async () => {
    const result = await home.searchDocs("carriage");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe("press-restoration.md");
    expect(result.matches[0]?.line).toBe(1);
  });

  it("refuses a catastrophic-backtracking regex fast instead of hanging", async () => {
    const started = Date.now();
    await expect(home.searchDocs("(a+)+$", { regex: true }))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.searchDocs("(.*a){30}", { regex: true }))
      .rejects.toMatchObject({ code: "invalid_format" });
    // The whole guard, analysis included, is bounded well under a second.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still runs an ordinary regex search", async () => {
    const result = await home.searchDocs("carr[a-z]+", { regex: true });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.path).toBe("press-restoration.md");
  });

  it("leaves the literal (non-regex) path untouched by the ReDoS guard", async () => {
    // The same string that is refused as a regex is a fine literal query: it is
    // escaped, so it can never backtrack, and it simply matches nothing here.
    const result = await home.searchDocs("(a+)+$");
    expect(result.matches).toEqual([]);
    expect(result.docsSearched).toBeGreaterThan(0);
  });

  it("caps title matches at max_results and reports truncation", async () => {
    for (let index = 0; index < 10; index += 1) {
      await home.writeDoc(`widgets/w${index}.md`, {
        body: "nothing to match in the body",
        title: `Widget number ${index}`,
      });
    }
    const result = await home.searchDocs("Widget number", { maxResults: 3 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // Every returned match is a title hit (line 0), the path that used to overrun.
    expect(result.matches.every((match) => match.line === 0)).toBe(true);
  });
});

describe("doc catalog", () => {
  it("lists every doc and marks archived entries", async () => {
    const { docs } = await home.listDocs();
    const catalog = deriveDocCatalog(docs);
    expect(catalog.total).toBe(4);
    expect(catalog.lines.join("\n")).toContain(`${FINANCE_DOC_PATH}: Estate and finances`);
    expect(catalog.lines.join("\n")).toContain(`${ARCHIVED_DOC_PATH}: Old plan (archived)`);
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
    expect(files[0]?.updated).toBe("2026-08-01");
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
