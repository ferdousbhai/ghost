import { describe, expect, it } from "vitest";
import { MemoryFileFormatError } from "../src/errors.js";
import {
  assertWritableMemory,
  coerceMemorySlug,
  deriveMemoryIndex,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  MAX_MEMORY_FILE_DESCRIPTION_LENGTH,
  MEMORY_INDEX_BUDGET_CHARS,
  memorySlugForText,
  parseMemoryFile,
  parseMemoryFileName,
  serializeMemoryFile,
} from "../src/memory-file.js";

describe("memory file names", () => {
  it("accepts kebab-case slugs", () => {
    expect(parseMemoryFileName("preferred-tone.md")).toBe("preferred-tone");
    expect(coerceMemorySlug("preferred-tone")).toBe("preferred-tone");
  });

  it("rejects anything that is not a slug", () => {
    for (const name of ["Preferred-Tone.md", "preferred tone.md", "a/b.md", "under_score.md"]) {
      expect(() => coerceMemorySlug(name)).toThrow(MemoryFileFormatError);
    }
    // A bare name is not an error: the extension is implied.
    expect(coerceMemorySlug("no-ext")).toBe("no-ext");
  });

  it("refuses a path traversal dressed as a name", () => {
    expect(() => coerceMemorySlug("../../etc/passwd.md")).toThrow(MemoryFileFormatError);
  });

  it("derives a slug from fact text", () => {
    expect(memorySlugForText("Prefers concise replies, no preamble"))
      .toBe("prefers-concise-replies-no-preamble");
    expect(memorySlugForText("!!!")).toBe("memory");
  });
});

describe("serialize/parse", () => {
  it("round-trips a memory file", () => {
    const text = serializeMemoryFile({
      description: "I work in the morning",
      content: "The press is cold until ten.",
      updatedAt: new Date("2026-08-02T11:00:00.000Z"),
    });
    expect(text).toBe(
      "---\ndescription: I work in the morning\nupdated: 2026-08-02\n---\n\nThe press is cold until ten.\n",
    );
    const parsed = parseMemoryFile(text);
    expect(parsed.description).toBe("I work in the morning");
    expect(parsed.content).toBe("The press is cold until ten.");
    expect(parsed.updated).toBe("2026-08-02");
  });

  it("quotes and round-trips descriptions with YAML-sensitive characters", () => {
    for (const description of ["true", "likes: tea", 'says "hello"', String.raw`uses C:\ghost`]) {
      const text = serializeMemoryFile({
        description,
        content: "body",
        updatedAt: new Date("2026-08-02T11:00:00.000Z"),
      });
      expect(text.split("\n")[1]).toMatch(/^description: ".*"$/);
      expect(parseMemoryFile(text).description).toBe(description);
    }
  });

  it("checks the normalized description length that writeMemory persists", () => {
    expect(() =>
      assertWritableMemory(`  ${"x".repeat(MAX_MEMORY_FILE_DESCRIPTION_LENGTH)}  `, "body"),
    ).not.toThrow();
    expect(() =>
      assertWritableMemory(`  ${"x".repeat(MAX_MEMORY_FILE_DESCRIPTION_LENGTH + 1)}  `, "body"),
    ).toThrow(MemoryFileFormatError);
  });

  it("rejects every line separator in a one-line description", () => {
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(() => assertWritableMemory(`first${separator}second`, "body"))
        .toThrowError(/single line/);
    }
  });

  it("requires a description", () => {
    expect(() => parseMemoryFile("---\nupdated: 2026-08-02\n---\n\nbody\n"))
      .toThrow(MemoryFileFormatError);
  });

  it("requires frontmatter at all", () => {
    expect(() => parseMemoryFile("just a body")).toThrow(MemoryFileFormatError);
  });

  it("tolerates the retired type key", () => {
    const parsed = parseMemoryFile(
      "---\ndescription: kept\ntype: fact\n---\n\nbody\n",
    );
    expect(parsed.description).toBe("kept");
  });

  it("rejects an oversized body", () => {
    const body = "x".repeat(MAX_MEMORY_FILE_CONTENT_LENGTH + 1);
    expect(() => parseMemoryFile(`---\ndescription: big\n---\n\n${body}\n`))
      .toThrow(MemoryFileFormatError);
  });
});

describe("deriveMemoryIndex", () => {
  it("sorts by slug and formats one line per file", () => {
    const index = deriveMemoryIndex([
      { slug: "working-habit", description: "second" },
      { slug: "apprentice-question", description: "first" },
    ]);
    expect(index.lines).toEqual([
      "- apprentice-question.md: first",
      "- working-habit.md: second",
    ]);
    expect(index.omitted).toBe(0);
    expect(index.total).toBe(2);
  });

  it("cuts off at the injection budget and reports the remainder", () => {
    const files = Array.from({ length: 400 }, (_, position) => ({
      slug: `memory-${String(position).padStart(4, "0")}`,
      description: "x".repeat(40),
    }));
    const index = deriveMemoryIndex(files);
    expect(index.chars).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET_CHARS);
    expect(index.omitted).toBeGreaterThan(0);
    expect(index.lines.length + index.omitted).toBe(400);
  });
});
