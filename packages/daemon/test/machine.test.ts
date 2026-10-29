import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineStatePath, runMachineCheck } from "../src/cli/machine.js";
import { runCli } from "./helpers/cli.js";
import {
  alertPayload,
  compareSamples,
  heatLevel,
  memoryLevel,
  parsePressure,
  parseProcStat,
  readMachineSample,
  readSensors,
  readUnits,
  renderReading,
  watchStep,
  WATCH_RULES,
  type MachineSample,
  type WatchAlert,
  type WatchState,
} from "../src/machine.js";

const USER = "user.slice/user-1000.slice/user@1000.service";
const MINUTE = 60_000;

let root: string;

function put(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A machine with `cores` cores whose cumulative busy and total jiffies are given. */
function procStat(busy: number, total: number, cores = 4): string {
  return [`cpu  ${busy} 0 0 ${total - busy} 0 0 0 0 0 0`, ...Array.from({ length: cores }, (_, i) => `cpu${i} 0 0 0 0 0 0 0 0 0 0`), "intr 1"].join("\n");
}

function sample(at: number, busy: number, units: Record<string, number> = {}, pressure: MachineSample["memoryPressure"] = null): MachineSample {
  return {
    at,
    cpu: { busy, total: at / 10, cores: 4 },
    memoryPressure: pressure,
    units: Object.entries(units).map(([unit, cpuUsec]) => ({ unit, scope: "user", path: `${USER}/app.slice/${unit}`, cpuUsec, memoryBytes: null })),
    sensors: [],
  };
}

/** Feeds minute samples where `busyShare` of the machine and `cores` per unit are used, returning every alert. */
function run(minutes: number, start: { state: WatchState | null; at: number; busy: number; usec: Record<string, number> }, busyShare: number, unitCores: Record<string, number> = {}, pressure: MachineSample["memoryPressure"] = null) {
  const alerts: WatchAlert[] = [];
  for (let i = 0; i < minutes; i += 1) {
    start.at += MINUTE;
    start.busy += (MINUTE / 10) * busyShare;
    for (const [unit, cores] of Object.entries(unitCores)) start.usec[unit] = (start.usec[unit] ?? 0) + cores * MINUTE * 1000;
    const step = watchStep(start.state, sample(start.at, start.busy, { ...start.usec }, pressure));
    start.state = step.state;
    alerts.push(...step.alerts);
  }
  return alerts;
}

function fresh() {
  const begin = { state: null as WatchState | null, at: 1_800_000_000_000, busy: 0, usec: {} as Record<string, number> };
  begin.state = watchStep(null, sample(begin.at, 0)).state;
  return begin;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ghost-machine-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("kernel readers", () => {
  it("reads busy and total jiffies, counting iowait as idle and guest time once", () => {
    expect(parseProcStat("cpu  10 2 3 80 5 0 0 0 7 0\ncpu0 1\ncpu1 1\n")).toEqual({ busy: 15, total: 100, cores: 2 });
  });

  it("reads memory pressure, and nothing on a kernel without PSI", () => {
    expect(parsePressure("some avg10=1.00 avg60=12.50 avg300=3.00 total=1\nfull avg10=0.00 avg60=4.25 avg300=0.00 total=1\n"))
      .toEqual({ someAvg60: 12.5, fullAvg60: 4.25 });
    expect(parsePressure("")).toBeNull();
  });

  it("finds units under slices and the user manager, never inside a unit, and only with CPU accounting", () => {
    const cg = "sys/fs/cgroup";
    put(`${cg}/init.scope/cpu.stat`, "usage_usec 5\n");
    put(`${cg}/system.slice/sshd.service/cpu.stat`, "usage_usec 10\nuser_usec 4\n");
    put(`${cg}/system.slice/sshd.service/memory.stat`, "anon 4096\nfile 999999\n");
    put(`${cg}/system.slice/sshd.service/inner.scope/cpu.stat`, "usage_usec 1\n");
    put(`${cg}/${USER}/cpu.stat`, "usage_usec 999\n");
    put(`${cg}/${USER}/app.slice/app-chromium-1.scope/cpu.stat`, "usage_usec 30\n");
    put(`${cg}/${USER}/session.slice/ghostd.service/cpu.stat`, "usage_usec 20\n");
    put(`${cg}/system.slice/no-accounting.service/memory.stat`, "anon 1\n");
    const units = readUnits(join(root, cg)).sort((a, b) => a.unit.localeCompare(b.unit));
    expect(units).toEqual([
      { unit: "app-chromium-1.scope", scope: "user", path: `${USER}/app.slice/app-chromium-1.scope`, cpuUsec: 30, memoryBytes: null },
      { unit: "ghostd.service", scope: "user", path: `${USER}/session.slice/ghostd.service`, cpuUsec: 20, memoryBytes: null },
      { unit: "init.scope", scope: "system", path: "init.scope", cpuUsec: 5, memoryBytes: null },
      { unit: "sshd.service", scope: "system", path: "system.slice/sshd.service", cpuUsec: 10, memoryBytes: 4096 },
    ]);
  });

  it("levels temperatures against their own limits and fans against their maximum, skipping faulted reads", () => {
    put("hwmon0/name", "coretemp\n");
    put("hwmon0/temp1_input", "95000\n");
    put("hwmon0/temp1_crit", "100000\n");
    put("hwmon0/temp1_label", "Package\n");
    put("hwmon0/temp2_input", "101000\n");
    put("hwmon0/temp2_max", "100000\n");
    put("hwmon0/temp3_input", "50000\n");
    put("hwmon0/temp4_input", "FAULT\n");
    put("hwmon1/name", "macsmc_hwmon\n");
    put("hwmon1/fan1_input", "4500\n");
    put("hwmon1/fan1_max", "5000\n");
    put("hwmon1/fan2_input", "2000\n");
    expect(readSensors(root).map(({ label, value, limit, level }) => [label, value, limit, level])).toEqual([
      ["Package", 95, 100, "serious"],
      ["coretemp temp2", 101, 100, "critical"],
      ["coretemp temp3", 50, null, "nominal"],
      ["macsmc_hwmon fan1", 4500, 5000, "serious"],
      ["macsmc_hwmon fan2", 2000, null, "nominal"],
    ]);
  });

  it("samples a whole machine from one root", () => {
    put("proc/stat", procStat(10, 100, 8));
    put("proc/pressure/memory", "some avg10=0 avg60=0.5 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n");
    put("sys/fs/cgroup/system.slice/a.service/cpu.stat", "usage_usec 1\n");
    const machine = readMachineSample(root, 5);
    expect(machine).toMatchObject({ at: 5, cpu: { busy: 10, total: 100, cores: 8 }, memoryPressure: { someAvg60: 0.5, fullAvg60: 0 }, sensors: [] });
    expect(machine.units.map((unit) => unit.unit)).toEqual(["a.service"]);
  });
});

describe("levels", () => {
  it("rates heat by the share of all cores busy, raised by any sensor", () => {
    expect([0.1, 0.4, 0.6, 0.85].map((share) => heatLevel(share, []))).toEqual(["nominal", "fair", "serious", "critical"]);
    expect(heatLevel(0.1, [{ chip: "c", label: "l", kind: "temp", value: 99, limit: 100, level: "serious" }])).toBe("serious");
  });

  it("rates memory by stalls, not by use", () => {
    expect(memoryLevel(null)).toBe("green");
    expect(memoryLevel({ someAvg60: 12, fullAvg60: 1 })).toBe("yellow");
    expect(memoryLevel({ someAvg60: 40, fullAvg60: 10 })).toBe("red");
  });

  it("measures each unit's cores over the interval and drops a counter that went backwards", () => {
    const reading = compareSamples(sample(0, 0, { busy: 0, restarted: 5_000_000 }), sample(10_000, 700, { busy: 15_000_000, restarted: 10, born: 2_000_000 }));
    expect(reading.utilization).toBeCloseTo(0.7);
    expect(reading.heat).toBe("serious");
    expect(reading.units.map((unit) => [unit.unit, unit.cores])).toEqual([["busy", 1.5], ["born", 0.2]]);
    expect(renderReading(reading)).toContain("Heat: serious · CPU 70% of 4 cores over 10s");
  });
});

describe("watch", () => {
  it("wakes once after heat holds five minutes, and again only after a calm episode ends", () => {
    const watch = fresh();
    expect(run(4, watch, 0.7)).toEqual([]);
    const [first, ...rest] = run(1, watch, 0.7);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ kind: "heat", key: "heat", id: `heat:${new Date(1_800_000_000_000).toISOString()}` });
    expect(run(30, watch, 0.9)).toEqual([]);
    // Four calm minutes do not end the episode; heat resuming stays the same episode.
    expect(run(4, watch, 0.1)).toEqual([]);
    expect(run(10, watch, 0.7)).toEqual([]);
    expect(run(Math.ceil(WATCH_RULES.coolMs / MINUTE), watch, 0.1)).toEqual([]);
    const [second] = run(5, watch, 0.7);
    expect(second?.id).not.toBe(first?.id);
  });

  it("forgets a condition that broke before it held, and never bridges a gap", () => {
    const watch = fresh();
    run(4, watch, 0.7);
    run(1, watch, 0.1);
    expect(run(4, watch, 0.7)).toEqual([]);
    watch.at += WATCH_RULES.maxGapMs + MINUTE;
    watch.state = watchStep(watch.state, sample(watch.at, watch.busy, watch.usec)).state;
    expect(run(4, watch, 0.7)).toEqual([]);
    expect(run(1, watch, 0.7)).toHaveLength(1);
  });

  it("names one unit holding a full core for fifteen minutes even when the machine is mostly idle", () => {
    const watch = fresh();
    expect(run(14, watch, 0.25, { "stuck.service": 1, "busy.service": 0.5 })).toEqual([]);
    const alerts = run(1, watch, 0.25, { "stuck.service": 1, "busy.service": 0.5 });
    expect(alerts.map((alert) => [alert.kind, alert.key])).toEqual([["runaway", `runaway:${USER}/app.slice/stuck.service`]]);
  });

  it("wakes after memory stays red for two minutes", () => {
    const watch = fresh();
    const red = { someAvg60: 50, fullAvg60: 20 };
    expect(run(1, watch, 0.1, {}, red)).toEqual([]);
    expect(run(1, watch, 0.1, {}, red).map((alert) => alert.kind)).toEqual(["memory"]);
  });
});

describe("ghost machine check", () => {
  /** Minute `minute` of a machine 90% busy, one core of it in hot.scope. */
  function machineAt(minute: number): void {
    put("proc/stat", procStat(minute * 5400, minute * 6000));
    put(`sys/fs/cgroup/${USER}/app.slice/hot.scope/cpu.stat`, `usage_usec ${minute * 60_000_000}\n`);
    put(`sys/fs/cgroup/${USER}/app.slice/hot.scope/cgroup.procs`, "42\n");
    put("proc/42/stat", "42 (node worker) R 1 1 1 0 -1 0 0 0 0 0 1500 500 0 0 20 0 1 0 1 1 1");
    put("proc/42/cmdline", "node\0test.js\0");
    put("proc/42/status", "Name:\tnode\nVmRSS:\t  2048 kB\n");
  }

  it("keeps state between runs, delivers a due alert once with its culprits, and retries one that failed", async () => {
    const statePath = machineStatePath({ XDG_STATE_HOME: join(root, "state") }, "/nowhere", "casper");
    expect(statePath).toBe(join(root, "state", "ghost", "machine-casper.json"));
    const delivered: Array<{ id: string; payload: string }> = [];
    let refuse = true;
    const deliver = async (alert: WatchAlert, payload: string) => {
      if (refuse) throw new Error("daemon down");
      delivered.push({ id: alert.id, payload });
    };
    const t0 = 1_800_000_000_000;
    let failedOnce = false;
    for (let minute = 0; minute <= 7; minute += 1) {
      machineAt(minute);
      const result = await runMachineCheck({ root, statePath, now: t0 + minute * MINUTE, deliver });
      if (result.failed.length) {
        failedOnce = true;
        refuse = false;
      }
    }
    expect(failedOnce).toBe(true);
    // The refused delivery came back the next minute, and only once.
    expect(delivered.map((alert) => alert.id.split(":")[0]).sort()).toEqual(["heat"]);
    const payload = JSON.parse(delivered[0]?.payload ?? "{}");
    expect(payload).toMatchObject({ kind: "heat", heat: "critical", cores: 4 });
    expect(payload.units[0]).toMatchObject({ unit: "hot.scope", cores: 1, processes: [{ pid: 42, command: "node test.js", cpuSeconds: 20, rssBytes: 2_097_152 }] });
    expect(JSON.parse(readFileSync(statePath, "utf8")).conditions.heat.alerted).toBe(delivered[0]?.id);
  });

  it("puts only the runaway unit in its payload", () => {
    const watch = fresh();
    const [alert] = run(15, watch, 0.25, { "stuck.service": 1, "other.service": 0.2 });
    if (!alert) throw new Error("expected a runaway alert");
    expect(JSON.parse(alertPayload(alert, root)).units.map((unit: { unit: string }) => unit.unit)).toEqual(["stuck.service"]);
  });
});

describe("ghost machine check from the CLI", () => {
  it("refuses an unknown action or missing instructions before touching state or the daemon", async () => {
    const fetch = async () => {
      throw new Error("no daemon call expected");
    };
    expect(await runCli(["machine", "watch"], { env: {}, fetch })).toMatchObject({ code: 2, stderr: expect.stringContaining("check --instructions") });
    expect(await runCli(["machine", "check", "-g", "casper"], { env: {}, fetch })).toMatchObject({ code: 2, stderr: expect.stringContaining("needs --instructions") });
  });

  it("saves its first sample for the named ghost and delivers nothing, since nothing has held yet", async () => {
    const calls: string[] = [];
    const result = await runCli(["machine", "check", "-g", "casper", "--instructions", "Handle it."], {
      env: { XDG_STATE_HOME: join(root, "state"), GHOSTD_PORT: "7718" },
      home: root,
      fetch: async (input) => {
        calls.push(String(input));
        throw new Error("no daemon call expected");
      },
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "state", "ghost", "machine-casper.json"), "utf8"))).toMatchObject({ v: 1, conditions: {} });
  });
});
