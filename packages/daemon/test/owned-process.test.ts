import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OwnedProcessError,
  runOwnedCommand,
} from "../src/owned-process.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(source: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "ghost-owned-process-test-"));
  roots.push(root);
  const path = join(root, "probe");
  writeFileSync(path, source);
  chmodSync(path, 0o700);
  return { root, path };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statLine.lastIndexOf(")");
    const state = commandEnd < 0 ? "" : statLine.slice(commandEnd + 2, commandEnd + 3);
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("owned process probes", () => {
  it("uses a fresh mode-0700 scratch cwd and removes it without loading owner files", async () => {
    const { path } = executable(`#!/bin/sh
set -eu
printf '%s\\n' "$PWD"
stat -c '%a' .
find . -mindepth 1 -maxdepth 1 -printf '%f\\n'
`);
    const result = await runOwnedCommand(path, [], {
      environment: { HOME: "/home/owner", PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
    });
    const [scratch, mode, ...entries] = result.stdout.trimEnd().split("\n");

    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(mode).toBe("700");
    expect(entries).toEqual([]);
    expect(scratch).toMatch(/\/ghost-native-probe-/u);
    expect(existsSync(scratch!)).toBe(false);
  });

  it("TERM-then-KILLs its exact group and waits for a pipe-holding descendant", async () => {
    const { root, path } = executable(`#!/bin/sh
trap '' TERM
printf '%s\\n' "$$" > "$PID_FILE"
(
  trap '' TERM
  printf '%s\\n' "$$" >> "$PID_FILE"
  while :; do sleep 1; done
) &
while :; do sleep 1; done
`);
    const pidFile = join(root, "pids");
    const started = Date.now();
    let thrown: unknown;
    try {
      await runOwnedCommand(path, [], {
        environment: {
          PATH: "/usr/bin:/bin",
          PID_FILE: pidFile,
          SECRET_SENTINEL: "must-never-appear-in-error",
        },
        timeoutMs: 100,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OwnedProcessError);
    expect(String((thrown as Error).message)).toBe("Owned probe exceeded its hard deadline.");
    expect(String((thrown as Error).message)).not.toContain("must-never-appear-in-error");
    expect(Date.now() - started).toBeLessThan(2_000);
    const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/u).map(Number);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    expect(pids.filter(pidExists)).toEqual([]);
  });

  it("bounds stdout without returning child bytes", async () => {
    const sentinel = "credential-like-child-output";
    const { path } = executable(`#!/bin/sh
while :; do printf '%s' '${sentinel}'; done
`);
    await expect(runOwnedCommand(path, [], {
      environment: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
      maxStdoutBytes: 64,
    })).rejects.toMatchObject({
      name: "OwnedProcessError",
      message: "Owned probe produced too much output.",
    });
  });
});
