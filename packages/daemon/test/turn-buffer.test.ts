import { readdirSync, readlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TurnBuffer } from "../src/turn-buffer.js";

describe("turn replay buffer", () => {
  it("spills to unlinked files and releases their descriptors on disposal", () => {
    const replayFiles = () => readdirSync("/proc/self/fd").flatMap(fd => {
      try {
        const path = readlinkSync(`/proc/self/fd/${fd}`);
        return path.includes("/ghost-turn-") ? [path] : [];
      } catch { return []; }
    });
    const before = replayFiles();
    const buffer = new TurnBuffer(10);
    try {
      for (let index = 0; index < 100; index++) buffer.push("x".repeat(8192));
      const added = replayFiles().filter(path => !before.includes(path));
      expect(added.length).toBeGreaterThan(0);
      expect(added.every(path => path.endsWith(" (deleted)"))).toBe(true);
      expect(buffer.at(99)).toBe("x".repeat(8192));
    } finally { buffer.dispose(); }
    expect(replayFiles()).toEqual(before);
  });

  it.each([0, 20, 1_048_576])("replays arbitrary event positions across a %i-byte memory limit", (limit) => {
    const buffer = new TurnBuffer(limit);
    const frames = ["data: hello\n\n", "data: 🐈 café\n\n", "x".repeat(100), "data: done\n\n"];
    try {
      for (const frame of frames) buffer.push(frame);
      expect(buffer.length).toBe(frames.length);
      for (const index of [3, 0, 2, 1, 3]) expect(buffer.at(index)).toBe(frames[index]);
      buffer.push("late");
      expect(buffer.at(4)).toBe("late");
      expect(() => buffer.at(-1)).toThrow(RangeError);
      expect(() => buffer.at(5)).toThrow(RangeError);
    } finally {
      buffer.dispose();
    }
    buffer.dispose();
    expect(() => buffer.push("closed")).toThrow();
    expect(() => buffer.at(0)).toThrow();
  });
});
