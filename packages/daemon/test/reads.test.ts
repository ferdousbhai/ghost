/** Owner read state uses the same tolerant, atomic sidecar policy as pins. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  READS_FILENAME,
  READS_VERSION,
  readReadState,
  readsPath,
  writeReads,
} from "../src/reads.js";

let sessionDir: string | null = null;

afterEach(() => {
  if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = null;
});

function makeSessionDir(): string {
  sessionDir = mkdtempSync(join(tmpdir(), "ghostd-reads-"));
  return sessionDir;
}

describe("reads.json", () => {
  it("reads missing and malformed state as empty", async () => {
    const dir = makeSessionDir();
    expect((await readReadState(dir)).reads).toEqual({});
    for (const body of ["", "{", "null", "[]", "{}", '{"reads":[]}']) {
      writeFileSync(readsPath(dir), body, "utf8");
      expect((await readReadState(dir)).reads, JSON.stringify(body)).toEqual({});
    }
    writeFileSync(
      readsPath(dir),
      JSON.stringify({ version: 99, reads: { "pi:conv-1": "2026-08-25T10:11:12.000Z" } }),
      "utf8",
    );
    expect(await readReadState(dir)).toEqual({ version: READS_VERSION, reads: {} });
  });

  it("round-trips valid ISO timestamps and drops invalid entries", async () => {
    const dir = makeSessionDir();
    writeFileSync(readsPath(dir), JSON.stringify({ reads: {
      "conv-1": "2026-08-25T10:11:12.000Z",
      "": "2026-08-25T10:11:12.000Z",
      bad: "yesterday",
      number: 7,
    } }), "utf8");
    expect((await readReadState(dir)).reads).toEqual({
      "conv-1": "2026-08-25T10:11:12.000Z",
    });
    expect((await readReadState(dir)).version).toBe(1);
  });

  it("writes privately by atomic replacement without temporary debris", async () => {
    const dir = join(makeSessionDir(), "nested", "sessions");
    await Promise.all([
      writeReads(dir, { a: "2026-08-25T10:00:00.000Z" }),
      writeReads(dir, { b: "2026-08-25T11:00:00.000Z" }),
    ]);
    expect(readdirSync(dir)).toEqual([READS_FILENAME]);
    expect(statSync(readsPath(dir)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(readsPath(dir), "utf8"));
    expect(stored.version).toBe(READS_VERSION);
    expect(["a", "b"]).toContain(Object.keys(stored.reads)[0]);
  });
});
