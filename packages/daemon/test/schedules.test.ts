import { mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isValidScheduleSlug,
  listGhostScheduleUnits,
  renderScheduledWorkPolicy,
  resolveScheduleRuntimeUnitDirectory,
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

  it("uses absolute XDG_RUNTIME_DIR and falls back to systemd's uid path", () => {
    expect(resolveScheduleRuntimeUnitDirectory({ XDG_RUNTIME_DIR: "/run/custom/../owner" }, 1000))
      .toBe("/run/owner/systemd/user");
    expect(resolveScheduleRuntimeUnitDirectory({ XDG_RUNTIME_DIR: "relative" }, 1000))
      .toBe("/run/user/1000/systemd/user");
    expect(() => resolveScheduleRuntimeUnitDirectory({}, null))
      .toThrow("XDG_RUNTIME_DIR must be absolute");
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
    // Only the timer is stopped — stopping a .service a timer activates is not
    // needed here — and the reload happens once, after the files are gone.
    expect(calls).toEqual([
      ["--user", "list-units", "--type=timer", "--all", "--full", "--plain", "--no-legend", "--no-pager"],
      ["--user", "list-unit-files", "--type=timer", "--state=enabled,enabled-runtime", "--full", "--no-legend", "--no-pager"],
      ["--user", "stop", "ghost-timer-v1-4-aria-standup.timer"],
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

  it("removes exact-owned source files from the runtime user-unit scope", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const service = "ghost-timer-v1-4-aria-standup.service";
    const foreign = "ghost-timer-v1-8-aria-ops-standup.timer";
    const legacy = "ghost-timer-aria-standup.timer";
    const dir = await unitDir([]);
    const runtimeUnitDir = join(dir, "runtime-user");
    await mkdir(runtimeUnitDir, { recursive: true });
    for (const name of [timer, service, foreign, legacy]) {
      await writeFile(join(runtimeUnitDir, name), "[Unit]\n", "utf8");
    }
    const calls: string[][] = [];

    const result = await sweepGhostSchedules("aria", {
      unitDir: dir,
      runtimeUnitDir,
      run: async (args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(result.removed).toEqual([service, timer]);
    expect(calls).toContainEqual(["--user", "stop", timer]);
    expect((await readdir(runtimeUnitDir)).sort()).toEqual([legacy, foreign]);
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
      run: async (args) => args[1] === "stop"
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
    expect(calls).toContainEqual(["--user", "stop", timer]);
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
    expect(calls).toContainEqual(["--user", "stop", timer]);
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
    expect(calls).toContainEqual(["--user", "stop", loadedTimer]);
    expect(calls).toContainEqual(["--user", "disable", enabledTimer]);
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

  it("stops a loaded-only missing-file timer without trying to disable it", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([]);
    let stopped = false;
    const calls: string[][] = [];

    await sweepGhostSchedules("aria", {
      unitDir: dir,
      run: async (args) => {
        calls.push([...args]);
        if (args[1] === "list-units") {
          return {
            stdout: `${timer} loaded ${stopped ? "inactive dead" : "active waiting"} Standup\n`,
            stderr: "",
            code: 0,
          };
        }
        if (args[1] === "list-unit-files") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[1] === "stop") stopped = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(calls).toContainEqual(["--user", "stop", timer]);
    expect(calls.some((args) => args[1] === "disable")).toBe(false);
  });

  it("uses runtime disable for enabled-runtime and preserves retry after failure", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([]);
    let disableAvailable = false;
    let enabled = true;
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === "list-units") return { stdout: "", stderr: "", code: 0 };
      if (args[1] === "list-unit-files") {
        return {
          stdout: enabled ? `${timer} enabled-runtime enabled\n` : "",
          stderr: "",
          code: 0,
        };
      }
      if (args[1] === "disable") {
        if (!disableAvailable) return { stdout: "", stderr: "runtime disable failed", code: 1 };
        enabled = false;
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(sweepGhostSchedules("aria", { unitDir: dir, run }))
      .rejects.toThrow("runtime disable failed");
    expect(enabled).toBe(true);

    disableAvailable = true;
    await expect(sweepGhostSchedules("aria", { unitDir: dir, run }))
      .resolves.toEqual({ removed: [] });
    expect(calls.filter((args) => args[1] === "disable")).toEqual([
      ["--user", "disable", "--runtime", timer],
      ["--user", "disable", "--runtime", timer],
    ]);
  });

  it("retires dangling persistent and runtime enablement in both scopes", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const foreign = "ghost-timer-v1-8-aria-ops-standup.timer";
    const dir = await unitDir([]);
    const runtimeUnitDir = join(dir, "runtime-user");
    const persistentWants = join(dir, "timers.target.wants");
    const runtimeWants = join(runtimeUnitDir, "timers.target.wants");
    await mkdir(persistentWants, { recursive: true });
    await mkdir(runtimeWants, { recursive: true });
    await symlink(`../${timer}`, join(persistentWants, timer));
    await symlink(`../${timer}`, join(runtimeWants, timer));
    await symlink(`../${foreign}`, join(persistentWants, foreign));
    const calls: string[][] = [];

    await sweepGhostSchedules("aria", {
      unitDir: dir,
      runtimeUnitDir,
      run: async (args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    expect(calls).toContainEqual(["--user", "disable", timer]);
    expect(calls).toContainEqual(["--user", "disable", "--runtime", timer]);
    expect(await readdir(persistentWants)).toEqual([foreign]);
    expect(await readdir(runtimeWants)).toEqual([]);
  });

  it("fails closed on an enablement-link removal error and completes on retry", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([]);
    const runtimeUnitDir = join(dir, "runtime-user");
    const link = join(runtimeUnitDir, "timers.target.wants", timer);
    await mkdir(join(runtimeUnitDir, "timers.target.wants"), { recursive: true });
    await symlink(`../${timer}`, link);

    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      runtimeUnitDir,
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
      unlinkUnit: async (path) => {
        if (path === link) throw new Error("runtime wants directory is read-only");
        await unlink(path);
      },
    })).rejects.toThrow("runtime wants directory is read-only");

    expect(await readdir(join(runtimeUnitDir, "timers.target.wants"))).toEqual([timer]);
    await expect(sweepGhostSchedules("aria", {
      unitDir: dir,
      runtimeUnitDir,
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
    })).resolves.toEqual({ removed: [] });
    expect(await readdir(join(runtimeUnitDir, "timers.target.wants"))).toEqual([]);
  });

  it("keeps a loaded-only stop failure retryable without a disable attempt", async () => {
    const timer = "ghost-timer-v1-4-aria-standup.timer";
    const dir = await unitDir([]);
    let stopAvailable = false;
    let stopped = false;
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === "list-units") {
        return {
          stdout: `${timer} loaded ${stopped ? "inactive dead" : "active waiting"} Standup\n`,
          stderr: "",
          code: 0,
        };
      }
      if (args[1] === "list-unit-files") return { stdout: "", stderr: "", code: 0 };
      if (args[1] === "stop") {
        if (!stopAvailable) return { stdout: "", stderr: "stop failed", code: 1 };
        stopped = true;
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(sweepGhostSchedules("aria", { unitDir: dir, run }))
      .rejects.toThrow("stop failed");
    expect(calls.some((args) => args[1] === "disable")).toBe(false);

    stopAvailable = true;
    await expect(sweepGhostSchedules("aria", { unitDir: dir, run }))
      .resolves.toEqual({ removed: [] });
    expect(stopped).toBe(true);
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

    expect(disabled).toEqual([["--user", "disable", timer]]);
  });
});
