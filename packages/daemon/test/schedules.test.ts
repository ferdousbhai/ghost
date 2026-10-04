import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHelpTopic } from "../src/help-topics.js";
import {
  ghostCliPath,
  isValidScheduleSlug,
  listGhostScheduleUnits,
  SCHEDULED_WORK_POLICY,
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

  it("does not mistake an unreadable unit location for an empty one", async () => {
    const dir = await unitDir([]);
    const notDirectory = join(dir, "not-a-directory");
    await writeFile(notDirectory, "ordinary file", "utf8");

    await expect(listGhostScheduleUnits("aria", notDirectory)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
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

  it("points the prompt at `ghost help timers`, which carries the unit names", () => {
    expect(SCHEDULED_WORK_POLICY).toContain("`ghost help timers`");
    expect(SCHEDULED_WORK_POLICY).not.toContain("ghost-timer-v1");
  });
});

describe("sweeping a deleted ghost's schedules", () => {
  const ok = { stdout: "", stderr: "", code: 0 };
  const stopGlob = ["--user", "stop", "ghost-timer-v1-4-aria-*.timer"];

  it("disables the timers, removes both units, reloads, and stops anything still loaded", async () => {
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
        return ok;
      },
    });

    expect(result.removed).toEqual([
      "ghost-timer-v1-4-aria-standup.service",
      "ghost-timer-v1-4-aria-standup.timer",
    ]);
    expect(calls).toEqual([
      ["--user", "disable", "--now", "ghost-timer-v1-4-aria-standup.timer"],
      ["--user", "daemon-reload"],
      stopGlob,
    ]);
    expect((await readdir(dir)).sort()).toEqual([
      "ghost-timer-aria-legacy.timer",
      "ghost-timer-v1-8-aria-ops-standup.timer",
      "spice-catalyst-research.timer",
    ]);
  });

  it("only stops loaded owned timers when the ghost has no unit files", async () => {
    const dir = await unitDir(["spice-catalyst-research.timer"]);
    const calls: string[][] = [];

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        calls.push([...args]);
        return ok;
      },
    });

    expect(result.removed).toEqual([]);
    expect(calls).toEqual([stopGlob]);
    expect(await readdir(dir)).toEqual(["spice-catalyst-research.timer"]);
  });

  it("leaves the unit files for retry when systemctl cannot disable the timer", async () => {
    const dir = await unitDir(["ghost-timer-v1-4-aria-standup.timer"]);

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => args[1] === "disable"
        ? { stdout: "", stderr: "user manager unavailable", code: 1 }
        : ok,
    })).rejects.toThrow("user manager unavailable");

    expect(await readdir(dir)).toEqual(["ghost-timer-v1-4-aria-standup.timer"]);
  });

  it("fails when a unit file cannot be removed, and completes on retry", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([timer]);
    const run = async () => ok;

    await chmod(dir, 0o500);
    try {
      await expect(sweepGhostSchedules("aria", { unitDir: dir, run }))
        .rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(dir, 0o700);
    }
    expect(await readdir(dir)).toEqual([timer]);

    await expect(sweepGhostSchedules("aria", { unitDir: dir, run }))
      .resolves.toEqual({ removed: [timer] });
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails when systemctl cannot stop a loaded timer", async () => {
    const dir = await unitDir([]);

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async () => ({ stdout: "", stderr: "manager unavailable", code: 1 }),
    })).rejects.toThrow("manager unavailable");
  });
});

describe("ghostCliPath", () => {
  it("names the ghost executable on PATH and falls back to the packaged path", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "ghost-cli-path-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ghost"), "#!/bin/sh\n");
    chmodSync(join(bin, "ghost"), 0o755);
    expect(ghostCliPath({ PATH: `${join(root, "empty")}:${bin}` })).toBe(join(bin, "ghost"));
    expect(ghostCliPath({ PATH: join(root, "empty") })).toBe("/usr/bin/ghost");
    expect(renderHelpTopic("timers", { ghostName: "casper", unitDir: "/tmp/units", cliPath: join(bin, "ghost") }))
      .toContain(`ExecStart=${join(bin, "ghost")} say --new --ghost casper`);
  });
});
