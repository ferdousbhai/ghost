import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_INDEX_MAX_ENTRIES } from "@ghost/extensions";
import { readGhostHomeDigest } from "../src/extensions.js";
import { makeTempGhosts, seedGhost } from "./helpers/fixtures.js";

describe("readGhostHomeDigest", () => {
  it("passes the newest memories to greeting input first", async () => {
    const digest = await readGhostHomeDigest("/not-read/ghost", "/not-read/Documents", {
      readers: {
        character: async () => null,
        memory: async () => ({
          files: [
            {
              slug: "stale",
              content: "stale",
              updated: "2026-08-26T08:00:00.000Z",
            },
            {
              slug: "fresh",
              content: "fresh",
              updated: "2026-08-27T08:00:00.000Z",
            },
          ],
          skipped: [],
        }),
        documents: async () => ({
          root: "/not-read/Documents",
          path: "",
          obsidianVault: false,
          entries: [],
          total: 0,
          fileCount: 0,
          directoryCount: 0,
          truncated: false,
          skipped: [],
        }),
      },
    });
    // The slug alone, newest first: no bullet and no `.md` repeated per entry.
    expect(digest.memoryLines).toEqual([
      "fresh",
      "stale",
    ]);
  });

  it("carries the complete Documents index semantics across the extension seam", async () => {
    const fixture = makeTempGhosts();
    try {
      const home = seedGhost(fixture.root, { name: "casper" });
      mkdirSync(fixture.documentsDir, { recursive: true });
      const total = DOCUMENT_INDEX_MAX_ENTRIES + 37;
      for (let index = 0; index < total; index += 1) {
        writeFileSync(
          join(fixture.documentsDir, `f${index.toString().padStart(3, "0")}`),
          "",
        );
      }

      const digest = await readGhostHomeDigest(home, fixture.documentsDir);

      expect(digest.documents.root).toBe(fixture.documentsDir);
      expect(digest.documents.obsidianVault).toBe(false);
      expect(digest.documents.lines).toHaveLength(DOCUMENT_INDEX_MAX_ENTRIES);
      expect(digest.documents.total).toBe(total);
      expect(digest.documents.omitted).toBe(37);
      expect(digest.documents.chars).toBe(
        digest.documents.lines.reduce((sum, line) => sum + line.length + 1, 0),
      );
    } finally {
      fixture.cleanup();
    }
  });

  for (const testCase of [
    { label: "character EACCES", failed: { character: "EACCES" } },
    { label: "character EIO", failed: { character: "EIO" } },
    { label: "memory EACCES", failed: { memory: "EACCES" } },
    { label: "memory EIO", failed: { memory: "EIO" } },
    { label: "Documents EACCES", failed: { documents: "EACCES" } },
    { label: "Documents EIO", failed: { documents: "EIO" } },
    {
      label: "combined character, memory, and Documents failures",
      failed: { character: "EACCES", memory: "EIO", documents: "EACCES" },
    },
  ] as const) {
    it(`defaults only the independently unavailable ${testCase.label} input`, async () => {
      const unavailable: string[] = [];
      const fail = async (input: keyof typeof testCase.failed): Promise<never> => {
        throw Object.assign(new Error(`SENSITIVE-${input}-PATH`), {
          code: testCase.failed[input],
        });
      };
      const digest = await readGhostHomeDigest("/not-read/ghost", "/not-read/Documents", {
        readers: {
          character: () => "character" in testCase.failed
            ? fail("character")
            : Promise.resolve({ title: "Casper", body: "CHARACTER_OK" }),
          memory: () => "memory" in testCase.failed
            ? fail("memory")
            : Promise.resolve({
              files: [{
                slug: "remembered",
                content: "remember this",
                updated: "2026-08-27",
              }],
              skipped: [],
            }),
          documents: () => "documents" in testCase.failed
            ? fail("documents")
            : Promise.resolve({
              root: "/owner/Documents",
              path: "",
              obsidianVault: false,
              entries: [{
                name: "DOCUMENT_OK",
                path: "DOCUMENT_OK",
                kind: "file" as const,
                size: 0,
                modifiedAt: "2026-08-27T00:00:00.000Z",
              }],
              total: 1,
              fileCount: 1,
              directoryCount: 0,
              truncated: false,
              skipped: [],
            }),
        },
        onUnavailable: (input) => unavailable.push(input),
      });

      expect(digest.character).toBe(
        "character" in testCase.failed ? null : "CHARACTER_OK",
      );
      expect(digest.memoryLines).toEqual(
        "memory" in testCase.failed ? [] : ["remembered"],
      );
      expect(digest.documents).toMatchObject(
        "documents" in testCase.failed
          ? { root: "", obsidianVault: false, lines: [], omitted: 0, total: 0 }
          : {
              root: "/owner/Documents",
              obsidianVault: false,
              lines: ["DOCUMENT_OK"],
              omitted: 0,
              total: 1,
            },
      );
      expect(new Set(unavailable)).toEqual(new Set(Object.keys(testCase.failed)));
    });
  }
});
