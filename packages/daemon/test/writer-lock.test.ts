import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWriterLock, releaseWriterLock } from "../src/writer-lock.js";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("writer lock reclaim", () => {
  it("retries when another contender reconciles its dead-owner claim", () => {
    directory = mkdtempSync(join(tmpdir(), "ghost-writer-lock-"));
    const path = join(directory, "models.json.lock");
    writeFileSync(path, `${JSON.stringify({
      token: "dead-owner",
      pid: process.pid,
      startTicks: "1",
    })}\n`, { mode: 0o600 });
    let contenderRan = false;

    const lease = acquireWriterLock(path, {
      waitMs: 100,
      pollMs: 1,
      reclaimProbe: () => {
        expect(contenderRan).toBe(false);
        contenderRan = true;
        const contender = acquireWriterLock(path, { waitMs: 100, pollMs: 1 });
        releaseWriterLock(contender);
      },
    });
    releaseWriterLock(lease);

    expect(contenderRan).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });
});
