import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinsPath, readPins, readReads, readsPath, writePins, writeReads } from "../src/sidecars.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ghostd-sidecars-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pins.json", () => {
  it("round-trips ids under the contract's key, creating the directory privately", async () => {
    const dir = join(root, "nested", "sessions");
    await writePins(dir, ["conv-1", "conv-2"]);
    expect(await readPins(dir)).toEqual(["conv-1", "conv-2"]);
    expect(JSON.parse(readFileSync(pinsPath(dir), "utf8"))).toEqual({ version: 2, pinned: ["conv-1", "conv-2"] });
    expect(statSync(pinsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("reads a missing, malformed, or hand-edited file as empty, and drops bad entries", async () => {
    expect(await readPins(root)).toEqual([]);
    for (const body of ["", "{", "null", "[]", "\"conv-1\"", "{}", "{\"pinned\":\"conv-1\"}"]) {
      writeFileSync(pinsPath(root), body, "utf8");
      expect(await readPins(root), JSON.stringify(body)).toEqual([]);
    }
    writeFileSync(pinsPath(root), JSON.stringify({ pinned: ["conv-1", "", 7, null, "conv-1", "conv-2"] }));
    expect(await readPins(root)).toEqual(["conv-1", "conv-2"]);
  });

  it("replaces atomically: concurrent writers leave one whole file, no debris", async () => {
    await Promise.all([writePins(root, ["a"]), writePins(root, ["b"]), writePins(root, ["c"])]);
    expect(readdirSync(root)).toEqual(["pins.json"]);
    expect(["a", "b", "c"]).toContain((await readPins(root))[0]);
  });
});

describe("reads.json", () => {
  it("reads missing and malformed state as empty", async () => {
    expect(await readReads(root)).toEqual({});
    for (const body of ["", "{", "null", "[]", "{}", '{"reads":[]}']) {
      writeFileSync(readsPath(root), body, "utf8");
      expect(await readReads(root), JSON.stringify(body)).toEqual({});
    }
  });

  it("round-trips valid timestamps, drops invalid entries, and writes privately", async () => {
    writeFileSync(readsPath(root), JSON.stringify({ reads: {
      "conv-1": "2026-08-25T10:11:12.000Z", "": "2026-08-25T10:11:12.000Z", bad: "yesterday", number: 7,
    } }));
    expect(await readReads(root)).toEqual({ "conv-1": "2026-08-25T10:11:12.000Z" });
    await writeReads(root, { a: "2026-08-25T10:00:00.000Z" });
    expect(JSON.parse(readFileSync(readsPath(root), "utf8"))).toEqual({ version: 2, reads: { a: "2026-08-25T10:00:00.000Z" } });
    expect(statSync(readsPath(root)).mode & 0o777).toBe(0o600);
  });
});
