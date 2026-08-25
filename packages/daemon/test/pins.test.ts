/**
 * The pin sidecar on its own: it must read as empty rather than throw for
 * anything a user could have left in `.sessions/pins.json`, and it must never
 * leave a partially written file behind for the listing to read.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PINS_FILENAME,
  PINS_VERSION,
  pinsPath,
  readPinState,
  readPins,
  writePins,
} from "../src/pins.js";

let sessionDir: string | null = null;

afterEach(() => {
  if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = null;
});

function makeSessionDir(): string {
  sessionDir = mkdtempSync(join(tmpdir(), "ghostd-pins-"));
  return sessionDir;
}

describe("pins.json", () => {
  it("reads as empty when the file does not exist", async () => {
    expect(await readPins(makeSessionDir())).toEqual([]);
  });

  it("round-trips ids and stores them under the contract's key", async () => {
    const dir = makeSessionDir();
    await writePins(dir, ["conv-1", "conv-2"]);
    expect(await readPins(dir)).toEqual(["conv-1", "conv-2"]);
    expect(JSON.parse(readFileSync(pinsPath(dir), "utf8")))
      .toEqual({ version: PINS_VERSION, pinned: ["conv-1", "conv-2"] });
    expect(await readPinState(dir)).toEqual({
      version: PINS_VERSION,
      pinned: ["conv-1", "conv-2"],
    });
  });

  it("creates the session dir and writes the file private", async () => {
    const dir = join(makeSessionDir(), "nested", ".sessions");
    await writePins(dir, ["conv-1"]);
    expect(statSync(pinsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("tolerates a malformed or hand-edited file", async () => {
    const dir = makeSessionDir();
    for (const body of ["", "{", "null", "[]", "\"conv-1\"", "{}", "{\"pinned\":\"conv-1\"}"]) {
      writeFileSync(pinsPath(dir), body, "utf8");
      expect(await readPins(dir), JSON.stringify(body)).toEqual([]);
    }
    writeFileSync(pinsPath(dir), JSON.stringify({ version: 99, pinned: ["pi:conv-1"] }), "utf8");
    expect(await readPinState(dir)).toEqual({ version: PINS_VERSION, pinned: [] });
  });

  it("drops non-string, empty, and duplicate entries", async () => {
    const dir = makeSessionDir();
    writeFileSync(
      pinsPath(dir),
      JSON.stringify({ pinned: ["conv-1", "", 7, null, "conv-1", "conv-2"] }),
      "utf8",
    );
    expect(await readPins(dir)).toEqual(["conv-1", "conv-2"]);
    expect((await readPinState(dir)).version).toBe(1);
  });

  it("replaces atomically: concurrent writers leave one whole file, no debris", async () => {
    const dir = makeSessionDir();
    await Promise.all([
      writePins(dir, ["a"]),
      writePins(dir, ["b"]),
      writePins(dir, ["c"]),
    ]);
    expect(readdirSync(dir)).toEqual([PINS_FILENAME]);
    expect(["a", "b", "c"]).toContain((await readPins(dir))[0]);
  });
});
