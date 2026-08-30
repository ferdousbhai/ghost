import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isValidScheduleSlug,
  listGhostScheduleUnits,
  renderScheduledWorkPolicy,
  resolveScheduleUnitDirectory,
  scheduleUnitPrefix,
  sweepGhostSchedules,
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
  it("uses absolute XDG_CONFIG_HOME and ignores a relative override", () => {
    expect(resolveScheduleUnitDirectory("/home/o", {
      XDG_CONFIG_HOME: "/xdg/../owner-config",
    })).toBe("/owner-config/systemd/user");
    // A relative XDG_CONFIG_HOME is what a broken login shell exports; the
    // owner's home is the honest answer rather than a path relative to cwd.
    expect(resolveScheduleUnitDirectory("/home/o", {
      XDG_CONFIG_HOME: "relative/config",
    }))
      .toBe("/home/o/.config/systemd/user");
    expect(resolveScheduleUnitDirectory("/home/o", {}))
      .toBe("/home/o/.config/systemd/user");
    expect(() => resolveScheduleUnitDirectory("relative/home", {}))
      .toThrow("ownerHome must be absolute");
  });
});

describe("which units belong to a ghost", () => {
  it("distinguishes aria from aria-ops and ignores ambiguous old units", async () => {
    const dir = await unitDir([
      "ghost-timer-v1-4-aria-standup.timer",
      "ghost-timer-v1-4-aria-standup.service",
      "ghost-timer-v1-8-aria-ops-standup.timer",
      "ghost-timer-v1-5-bruno-standup.timer",
      // Pre-v1 names cannot be assigned safely and are never inferred.
      "ghost-timer-aria-standup.timer",
      "ghost-timer-aria-ops-standup.timer",
      "spice-catalyst-research.timer",
      "ghost-timer-v1-4-aria-notes.txt",
      "ghost-timer-v1-4-aria-Bad.timer",
      "ghost-timer-v1-4-aria-double--dash.timer",
    ]);

    expect(await listGhostScheduleUnits("aria", dir)).toEqual([
      "ghost-timer-v1-4-aria-standup.service",
      "ghost-timer-v1-4-aria-standup.timer",
    ]);
    expect(await listGhostScheduleUnits("aria-ops", dir)).toEqual([
      "ghost-timer-v1-8-aria-ops-standup.timer",
    ]);
  });

  it("answers empty for a ghost with no schedules and for no unit directory", async () => {
    expect(await listGhostScheduleUnits("aria", await unitDir([]))).toEqual([]);
    expect(await listGhostScheduleUnits("aria", "/nonexistent/unit/dir")).toEqual([]);
  });

  it("length-delimits and lists the full 64-character ghost-name boundary", async () => {
    const longestName = `a${"b".repeat(63)}`;
    const longestPrefix = `ghost-timer-v1-64-${longestName}-`;
    expect(scheduleUnitPrefix("aria")).toBe("ghost-timer-v1-4-aria-");
    expect(scheduleUnitPrefix(longestName)).toBe(longestPrefix);
    const dir = await unitDir([`${longestPrefix}daily.timer`]);
    expect(await listGhostScheduleUnits(longestName, dir))
      .toEqual([`${longestPrefix}daily.timer`]);
    expect(() => scheduleUnitPrefix(`${longestName}x`)).toThrow("Invalid ghost name");
  });

  it("admits only the documented safe slug grammar", () => {
    expect(isValidScheduleSlug("weekday-check-in")).toBe(true);
    expect(isValidScheduleSlug("a".repeat(64))).toBe(true);
    for (const invalid of ["", "A", "-start", "end-", "two--parts", "a_b", "a".repeat(65)]) {
      expect(isValidScheduleSlug(invalid), invalid).toBe(false);
    }
  });

  it("renders the actual ghost namespace and nondefault unit directory", () => {
    const policy = renderScheduledWorkPolicy("aria-ops", "/srv/owner config/systemd/user");
    expect(policy).toContain('"/srv/owner config/systemd/user"');
    expect(policy).toContain("ghost-timer-v1-8-aria-ops-<slug>");
    expect(policy).toContain("[a-z0-9]+(?:-[a-z0-9]+)*");
    expect(policy).not.toContain("~/.config/systemd/user");
  });
});

describe("sweeping a deleted ghost's schedules", () => {
  it("disables the timers, removes both units, and reloads once", async () => {
    const dir = await unitDir([
      "ghost-timer-v1-4-aria-standup.timer",
      "ghost-timer-v1-4-aria-standup.service",
      "ghost-timer-v1-8-aria-ops-standup.timer",
      "ghost-timer-aria-legacy.timer",
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
      "ghost-timer-v1-4-aria-standup.service",
      "ghost-timer-v1-4-aria-standup.timer",
    ]);
    // Only the timer is disabled — disabling a .service a timer activates is
    // not a thing — and the reload happens once, after the files are gone.
    expect(calls).toEqual([
      ["--user", "disable", "--now", "ghost-timer-v1-4-aria-standup.timer"],
      ["--user", "daemon-reload"],
    ]);
    expect((await readdir(dir)).sort())
      .toEqual([
        "ghost-timer-aria-legacy.timer",
        "ghost-timer-v1-8-aria-ops-standup.timer",
        "spice-catalyst-research.timer",
      ]);
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
    const dir = await unitDir(["ghost-timer-v1-4-aria-standup.timer"]);

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async () => {
        throw new Error("systemctl is not on PATH");
      },
    });

    expect(result.removed).toEqual(["ghost-timer-v1-4-aria-standup.timer"]);
    expect(await readdir(dir)).toEqual([]);
  });
});
