import { describe, expect, it } from "vitest";
import { readGhostHomeDigest } from "../src/extensions.js";

describe("readGhostHomeDigest", () => {
  it("reads the character body through the injected reader", async () => {
    const digest = await readGhostHomeDigest("/not-read/ghost", {
      readers: { character: async () => ({ body: "CHARACTER_OK" }) },
    });
    expect(digest.character).toBe("CHARACTER_OK");
  });

  it("defaults the character to null and reports it when the read fails", async () => {
    const unavailable: string[] = [];
    const digest = await readGhostHomeDigest("/not-read/ghost", {
      readers: { character: () => Promise.reject(new Error("SENSITIVE-PATH")) },
      onUnavailable: (input) => unavailable.push(input),
    });
    expect(digest.character).toBeNull();
    expect(unavailable).toEqual(["character"]);
  });
});
