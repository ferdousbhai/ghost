import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
      ["--user", "list-units", "--type=timer", "--all", "--full", "--plain", "--no-legend", "--no-pager"],
      ["--user", "list-unit-files", "--type=timer", "--state=enabled,enabled-runtime", "--full", "--no-legend", "--no-pager"],
      ["--user", "disable", "--now", "ghost-timer-v1-4-aria-standup.timer"],
      ["--user", "daemon-reload"],
      ["--user", "list-units", "--type=timer", "--all", "--full", "--plain", "--no-legend", "--no-pager"],
      ["--user", "list-unit-files", "--type=timer", "--state=enabled,enabled-runtime", "--full", "--no-legend", "--no-pager"],
    ]);
    expect((await readdir(dir)).sort())
      .toEqual([
        "ghost-timer-aria-legacy.timer",
        "ghost-timer-v1-8-aria-ops-standup.timer",
        "spice-catalyst-research.timer",
      ]);
  });

  it("inspects the manager but touches nothing when the ghost had no schedules", async () => {
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
    expect(calls.map((args) => args[1])).toEqual(["list-units", "list-unit-files"]);
    expect(await readdir(dir)).toEqual(["spice-catalyst-research.timer"]);
  });

  it("leaves the unit files for retry when systemctl cannot stop the timer", async () => {
    const dir = await unitDir(["ghost-timer-v1-4-aria-standup.timer"]);

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => args[1] === "disable"
        ? { stdout: "", stderr: "user manager unavailable", code: 1 }
        : { stdout: "", stderr: "", code: 0 },
    })).rejects.toThrow("user manager unavailable");

    expect(await readdir(dir)).toEqual(["ghost-timer-v1-4-aria-standup.timer"]);
  });

  it("keeps partial removals as retry progress and reloads before reporting failure", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const service = "ghost-timer-v1-4-aria-standup.service";
    const dir = await unitDir([timer, service]);
    const calls: string[][] = [];
    let rejectService = true;
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run,
      unlinkUnit: async (path) => {
        if (rejectService && path.endsWith(service)) throw new Error("unit directory is read-only");
        await unlink(path);
      },
    })).rejects.toThrow("unit directory is read-only");

    expect(await readdir(dir)).toEqual([service]);
    expect(calls).toContainEqual(["--user", "disable", "--now", timer]);
    expect(calls).toContainEqual(["--user", "daemon-reload"]);

    rejectService = false;
    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run,
      unlinkUnit: unlink,
    })).resolves.toEqual({ removed: [service] });
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toContainEqual(["--user", "daemon-reload"]);
  });

  it("does not roll back safe cleanup when daemon-reload fails", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([timer]);
    const calls: string[][] = [];

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        calls.push([...args]);
        return args.includes("daemon-reload")
          ? { stdout: "", stderr: "reload failed", code: 1 }
          : { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(result.removed).toEqual([timer]);
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toContainEqual(["--user", "disable", "--now", timer]);
    expect(calls).toContainEqual(["--user", "daemon-reload"]);
  });

  it("retires loaded-only and enabled-only timers whose source files are absent", async () => {
    const loadedTimer = "ghost-timer-v1-4-aria-standup.timer";
    const enabledTimer = "ghost-timer-v1-4-aria-weekly.timer";
    const dir = await unitDir([]);
    let retired = false;
    const calls: string[][] = [];

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        calls.push([...args]);
        if (args[1] === "list-units") {
          return {
            stdout: `${loadedTimer} loaded ${retired ? "inactive dead" : "active waiting"} Standup\n`,
            stderr: "",
            code: 0,
          };
        }
        if (args[1] === "list-unit-files") {
          return {
            stdout: retired ? "" : `${enabledTimer} enabled enabled\n`,
            stderr: "",
            code: 0,
          };
        }
        if (args[1] === "disable") retired = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(result).toEqual({ removed: [] });
    expect(calls).toContainEqual([
      "--user",
      "disable",
      "--now",
      loadedTimer,
      enabledTimer,
    ]);
  });

  it("fails closed when manager inventory is unavailable despite an empty source directory", async () => {
    const dir = await unitDir([]);

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async () => ({ stdout: "", stderr: "manager unavailable", code: 1 }),
    })).rejects.toThrow("manager unavailable");
  });

  it("fails verification when systemctl leaves a source-less timer active or enabled", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([]);

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        if (args[1] === "list-units") {
          return { stdout: `${timer} loaded active waiting Standup\n`, stderr: "", code: 0 };
        }
        if (args[1] === "list-unit-files") {
          return { stdout: `${timer} enabled enabled\n`, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    })).rejects.toThrow("left an owned timer active, enabled, or on disk");
  });

  it("keeps manager inventory prefix-free and ignores ambiguous or malformed names", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const foreign = "ghost-timer-v1-8-aria-ops-standup.timer";
    const dir = await unitDir([]);
    let retired = false;
    const disabled: string[][] = [];
    const listed = [
      timer,
      foreign,
      "ghost-timer-aria-legacy.timer",
      "ghost-timer-v1-4-aria-Bad.timer",
    ];

    await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        if (args[1] === "list-units") {
          return {
            stdout: listed.map((name) => (
              `${name} loaded ${name === timer && retired ? "inactive dead" : "active waiting"} Timer`
            )).join("\n"),
            stderr: "",
            code: 0,
          };
        }
        if (args[1] === "list-unit-files") {
          return {
            stdout: listed
              .filter((name) => name !== timer || !retired)
              .map((name) => `${name} enabled enabled`)
              .join("\n"),
            stderr: "",
            code: 0,
          };
        }
        if (args[1] === "disable") {
          disabled.push([...args]);
          retired = true;
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(disabled).toEqual([["--user", "disable", "--now", timer]]);
  });
});
