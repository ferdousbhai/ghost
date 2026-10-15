import { describe, expect, it } from "vitest";
import { BoundedCache } from "../src/bounded-cache.js";

describe("bounded lookup cache", () => {
  it("evicts the least recently read entry and handles replacement and deletion", () => {
    const cache = new BoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    cache.set("a", 4);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("a")).toBe(4);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    cache.set("d", 5);
    expect(cache.get("c")).toBe(3);
  });

  it.each([0, -1, 1.5, Infinity])("rejects an invalid limit %s", (limit) => {
    expect(() => new BoundedCache(limit)).toThrow(RangeError);
  });
});
