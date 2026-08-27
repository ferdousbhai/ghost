import { describe, expect, it } from "vitest";
import { MemoryFileFormatError } from "../src/errors.js";
import {
  assertWritableMemory,
  coerceMemorySlug,
  deriveMemoryIndex,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  MEMORY_INDEX_BUDGET_CHARS,
  MEMORY_INDEX_PREVIEW_CHARS,
  memoryIndexPreview,
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

describe("plain Markdown memory", () => {
  it("serializes and parses only the fact", () => {
    const text = serializeMemoryFile("  The press is cold until ten.  ");
    expect(text).toBe("The press is cold until ten.\n");
    expect(parseMemoryFile(text)).toEqual({ content: "The press is cold until ten." });
  });

  it("requires non-empty content", () => {
    expect(() => assertWritableMemory(" \n ")).toThrow(MemoryFileFormatError);
    expect(() => parseMemoryFile("\n")).toThrow(MemoryFileFormatError);
  });

  it("rejects oversized content", () => {
    const body = "x".repeat(MAX_MEMORY_FILE_CONTENT_LENGTH + 1);
    expect(() => parseMemoryFile(body)).toThrow(MemoryFileFormatError);
  });

  it("pins the canonical UTF-8 byte ceiling and rejects unpaired surrogates", () => {
    const widest = "\u0800".repeat(MAX_MEMORY_FILE_CONTENT_LENGTH);
    expect(Buffer.byteLength(serializeMemoryFile(widest))).toBe(MAX_MEMORY_FILE_BYTES);
    expect(() => serializeMemoryFile("owner \ud800 fact"))
      .toThrow(MemoryFileFormatError);
  });

  it("does not interpret YAML-looking content", () => {
    const content = "---\ndescription: ordinary text\n---";
    expect(parseMemoryFile(content)).toEqual({ content });
  });
});

describe("memoryIndexPreview", () => {
  it("keeps a concise fact whole", () => {
    expect(memoryIndexPreview("Owner likes tea.")).toBe("Owner likes tea.");
  });

  it("matches the word-aware truncation contract", () => {
    expect(memoryIndexPreview("Owner prefers concise answers and wants the decision first."))
      .toBe("Owner prefers concise answers...");
    expect(memoryIndexPreview("Owner prefers concise answers...")).toHaveLength(
      MEMORY_INDEX_PREVIEW_CHARS,
    );
  });

  it("normalizes whitespace and hard-cuts a long first word", () => {
    expect(memoryIndexPreview("Owner\nlikes   jasmine tea.")).toBe("Owner likes jasmine tea.");
    expect(memoryIndexPreview("x".repeat(100)))
      .toBe(`${"x".repeat(MEMORY_INDEX_PREVIEW_CHARS - 3)}...`);
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
      description: "x".repeat(32),
    }));
    const index = deriveMemoryIndex(files);
    expect(index.chars).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET_CHARS);
    expect(index.omitted).toBeGreaterThan(0);
    expect(index.lines.length + index.omitted).toBe(400);
  });
});
