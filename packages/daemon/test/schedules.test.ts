import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  listGhostScheduleUnits,
  scheduleUnitPrefix,
  sweepGhostSchedules,
  userUnitDirectory,
} from "../src/schedules.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function unitDir(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ghost-schedules-"));
  dirs.push(dir);
  for (const name of names) await writeFile(join(dir, name), "[Unit]\n", "utf8");
  return dir;
}

describe("where a schedule's units live", () => {
  it("prefers XDG_CONFIG_HOME, and only when it is absolute", () => {
    expect(userUnitDirectory("/home/o", { XDG_CONFIG_HOME: "/xdg" }))
      .toBe("/xdg/systemd/user");
    // A relative XDG_CONFIG_HOME is what a broken login shell exports; the
    // owner's home is the honest answer rather than a path relative to cwd.
    expect(userUnitDirectory("/home/o", { XDG_CONFIG_HOME: "relative/config" }))
      .toBe("/home/o/.config/systemd/user");
    expect(userUnitDirectory("/home/o", {})).toBe("/home/o/.config/systemd/user");
  });
});

describe("which units belong to a ghost", () => {
  it("claims its own prefix and nothing else", async () => {
    const dir = await unitDir([
      "ghost-timer-aria-standup.timer",
      "ghost-timer-aria-standup.service",
      // Another ghost's, a ghost whose name merely starts the same way, the
      // owner's own timer, and a stray file: none of these are ours.
      "ghost-timer-bruno-standup.timer",
      "ghost-timer-arianna-standup.timer",
      "spice-catalyst-research.timer",
      "ghost-timer-aria-notes.txt",
    ]);

    expect(await listGhostScheduleUnits("aria", dir)).toEqual([
      "ghost-timer-aria-standup.service",
      "ghost-timer-aria-standup.timer",
    ]);
  });

  it("answers empty for a ghost with no schedules and for no unit directory", async () => {
    expect(await listGhostScheduleUnits("aria", await unitDir([]))).toEqual([]);
    expect(await listGhostScheduleUnits("aria", "/nonexistent/unit/dir")).toEqual([]);
  });

  it("names the prefix a ghost's units must carry", () => {
    expect(scheduleUnitPrefix("aria")).toBe("ghost-timer-aria-");
  });
});

describe("sweeping a deleted ghost's schedules", () => {
  it("disables the timers, removes both units, and reloads once", async () => {
    const dir = await unitDir([
      "ghost-timer-aria-standup.timer",
      "ghost-timer-aria-standup.service",
      "ghost-timer-bruno-standup.timer",
      "spice-catalyst-research.timer",
    ]);
    const calls: string[][] = [];

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(result.removed).toEqual([
      "ghost-timer-aria-standup.service",
      "ghost-timer-aria-standup.timer",
    ]);
    // Only the timer is disabled — disabling a .service a timer activates is
    // not a thing — and the reload happens once, after the files are gone.
    expect(calls).toEqual([
      ["--user", "disable", "--now", "ghost-timer-aria-standup.timer"],
      ["--user", "daemon-reload"],
    ]);
    expect((await readdir(dir)).sort())
      .toEqual(["ghost-timer-bruno-standup.timer", "spice-catalyst-research.timer"]);
  });

  it("touches nothing and runs no command when the ghost had no schedules", async () => {
    const dir = await unitDir(["spice-catalyst-research.timer"]);
    const calls: string[][] = [];

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(result.removed).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual(["spice-catalyst-research.timer"]);
  });

  it("still removes the unit files when systemctl refuses to disable them", async () => {
    // The ghost is going away either way. A timer left on disk after its ghost
    // is gone would keep firing, which is worse than a failed disable.
    const dir = await unitDir(["ghost-timer-aria-standup.timer"]);

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async () => {
        throw new Error("systemctl is not on PATH");
      },
    });

    expect(result.removed).toEqual(["ghost-timer-aria-standup.timer"]);
    expect(await readdir(dir)).toEqual([]);
  });
});
