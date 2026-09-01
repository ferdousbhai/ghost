import { describe, expect, it } from "vitest";
import { readGhostHomeDigest } from "../src/extensions.js";

describe("readGhostHomeDigest", () => {
  it("passes the newest memories to greeting input first", async () => {
    const digest = await readGhostHomeDigest("/not-read/ghost", {
      readers: {
        character: async () => null,
        memory: async () => ({
          files: [
            { slug: "stale", content: "stale", updated: "2026-08-26T08:00:00.000Z" },
            { slug: "fresh", content: "fresh", updated: "2026-08-27T08:00:00.000Z" },
          ],
          skipped: [],
        }),
      },
    });
    expect(digest.memoryLines).toEqual(["fresh", "stale"]);
  });

  for (const failed of ["character", "memory"] as const) {
    it(`defaults only the unavailable ${failed} input`, async () => {
      const unavailable: string[] = [];
      const digest = await readGhostHomeDigest("/not-read/ghost", {
        readers: {
          character: () => failed === "character"
            ? Promise.reject(new Error("SENSITIVE-PATH"))
            : Promise.resolve({ title: "Casper", body: "CHARACTER_OK" }),
          memory: () => failed === "memory"
            ? Promise.reject(new Error("SENSITIVE-PATH"))
            : Promise.resolve({
              files: [{ slug: "remembered", content: "remember this", updated: "2026-08-27" }],
              skipped: [],
            }),
        },
        onUnavailable: (input) => unavailable.push(input),
      });

      expect(digest.character).toBe(failed === "character" ? null : "CHARACTER_OK");
      expect(digest.memoryLines).toEqual(failed === "memory" ? [] : ["remembered"]);
      expect(unavailable).toEqual([failed]);
    });
  }
});
