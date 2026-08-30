import { describe, expect, it } from "vitest";
import { MemoryFileFormatError } from "../src/errors.js";
import {
  assertWritableMemory,
  coerceMemorySlug,
  deriveMemoryIndex,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  MEMORY_INDEX_BUDGET_CHARS,
  MEMORY_INDEX_MAX_ENTRIES,
  memorySlugForText,
  parseMemoryFile,
  parseMemoryFileName,
  redactMemorySecrets,
  REDACTED_MEMORY_SECRET,
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

describe("redactMemorySecrets", () => {
  it("redacts private keys, provider tokens, bearer credentials, and assigned secrets", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----\nvery-private-bytes\n-----END PRIVATE KEY-----",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "xoxb-1234567890-secret-value",
      "Authorization: Bearer eyJhbGciOi.secret.signature",
      "api_key = open-sesame",
      "password: \"correct horse battery staple\"",
    ].join("\n");
    const redacted = redactMemorySecrets(input);
    expect(redacted).not.toMatch(/very-private|sk-|ghp_|xoxb-|eyJhbGci|open-sesame|correct horse/u);
    expect(redacted.match(/\[REDACTED_SECRET\]/gu)?.length).toBe(7);
    expect(redacted).toContain(`Bearer ${REDACTED_MEMORY_SECRET}`);
    expect(redacted).toContain(`api_key = ${REDACTED_MEMORY_SECRET}`);
  });
});

describe("deriveMemoryIndex", () => {
  it("sorts newest first with slug as the deterministic tie-break", () => {
    const index = deriveMemoryIndex([
      { slug: "working-habit", updated: "2026-08-26" },
      { slug: "zebra", updated: "2026-08-27" },
      { slug: "apprentice-question", updated: "2026-08-27" },
    ]);
    // The slug alone: no bullet, no `.md`, nothing repeated per entry.
    expect(index.lines).toEqual([
      "apprentice-question",
      "zebra",
      "working-habit",
    ]);
    expect(index.omitted).toBe(0);
    expect(index.total).toBe(3);
  });

  it("cuts off at the entry cap and omits the stalest remainder", () => {
    const files = Array.from({ length: 400 }, (_, position) => ({
      slug: `memory-${String(position).padStart(4, "0")}-${"x".repeat(40)}`,
      updated: position === 0 ? "2020-01-01" : "2026-08-27",
    }));
    const index = deriveMemoryIndex(files);
    expect(index.lines).toHaveLength(MEMORY_INDEX_MAX_ENTRIES);
    expect(index.chars).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET_CHARS);
    // `omitted` counts every memory the cut-off left out, not just the tail the
    // character budget would have trimmed, and `total` still counts them all.
    expect(index.omitted).toBe(400 - MEMORY_INDEX_MAX_ENTRIES);
    expect(index.total).toBe(400);
    expect(index.lines.some((line) => line.startsWith("memory-0000-"))).toBe(false);
    expect(index.lines[0]).toBe(`memory-0001-${"x".repeat(40)}`);
  });
});
