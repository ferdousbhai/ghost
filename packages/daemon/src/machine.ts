/**
 * What is straining the machine, read from the kernel the same way on every
 * Linux machine: CPU use across all cores (/proc/stat), memory pressure
 * (/proc/pressure/memory), CPU and memory per systemd unit (cgroup v2), and
 * whatever hwmon sensors report. Heat follows sustained CPU work, so CPU use
 * is the cause every machine can measure; sensors only raise the level where
 * they report limits. `ghost machine check`, run each minute by a timer,
 * turns a sustained condition into one `machine` event per episode.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HEAT_LEVELS = ["nominal", "fair", "serious", "critical"] as const;
export type HeatLevel = (typeof HEAT_LEVELS)[number];
export type MemoryLevel = "green" | "yellow" | "red";

export interface Sensor {
  chip: string;
  label: string;
  kind: "temp" | "fan";
  /** °C or RPM. */
  value: number;
  /** The sensor's own critical/max temperature or maximum fan speed, when it reports one. */
  limit: number | null;
  level: HeatLevel;
}

export interface UnitUsage {
  unit: string;
  /** `user` units answer `systemctl --user`; `system` units need the owner. */
  scope: "user" | "system";
  /** Its cgroup, relative to /sys/fs/cgroup. */
  path: string;
  cpuUsec: number;
  memoryBytes: number | null;
}

export interface MachineSample {
  at: number;
  cpu: { busy: number; total: number; cores: number };
  memoryPressure: { someAvg60: number; fullAvg60: number } | null;
  units: UnitUsage[];
  sensors: Sensor[];
}

export interface UnitReading {
  unit: string;
  scope: "user" | "system";
  path: string;
  /** Average cores used over the interval. */
  cores: number;
  /** Anonymous memory now. */
  memoryBytes: number | null;
}

export interface MachineReading {
  at: string;
  intervalSeconds: number;
  /** Share of all cores busy over the interval, 0–1. */
  utilization: number;
  cores: number;
  heat: HeatLevel;
  memory: MemoryLevel;
  memoryPressure: MachineSample["memoryPressure"];
  sensors: Sensor[];
  /** Busiest first. */
  units: UnitReading[];
}

/** The rules: how long each condition must hold before it wakes the ghost. */
export const WATCH_RULES = {
  heatHoldMs: 5 * 60_000,
  memoryHoldMs: 2 * 60_000,
  runawayHoldMs: 15 * 60_000,
  runawayCores: 0.9,
  /** Calm time that ends an episode, so the next one is a new event. */
  coolMs: 5 * 60_000,
  /** A longer gap between samples is sleep or a paused timer, never a held condition. */
  maxGapMs: 3 * 60_000,
} as const;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readNumber(path: string): number | null {
  const text = readText(path)?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function parseProcStat(text: string): MachineSample["cpu"] {
  const lines = text.split("\n");
  const fields = (lines.find((line) => /^cpu\s/u.test(line)) ?? "").trim().split(/\s+/u).slice(1, 9).map(Number);
  // user nice system idle iowait irq softirq steal; guest time is already inside user.
  const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { busy: total - idle, total, cores: Math.max(1, lines.filter((line) => /^cpu\d+\s/u.test(line)).length) };
}

export function parsePressure(text: string): MachineSample["memoryPressure"] {
  const avg60 = (kind: string) => {
    const match = new RegExp(`^${kind} .*\\bavg60=([0-9.]+)`, "mu").exec(text);
    return match ? Number(match[1]) : null;
  };
  const some = avg60("some"), full = avg60("full");
  return some === null ? null : { someAvg60: some, fullAvg60: full ?? 0 };
}

/** A unit's own memory: anonymous pages, not the file cache `memory.current` also counts. */
function anonymousMemory(dir: string): number | null {
  const anon = /^anon (\d+)$/mu.exec(readText(join(dir, "memory.stat")) ?? "");
  return anon ? Number(anon[1]) : null;
}

/**
 * Every systemd unit's cgroup: slices are walked, units are leaves, except the
 * per-user manager (`user@UID.service`), whose apps and services are units of
 * their own.
 */
export function readUnits(cgroupRoot: string): UnitUsage[] {
  const units: UnitUsage[] = [];
  const walk = (relative: string) => {
    for (const name of directories(join(cgroupRoot, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      if (name.endsWith(".slice") || /^user@\d+\.service$/u.test(name)) {
        walk(path);
      } else if (name.endsWith(".service") || name.endsWith(".scope")) {
        const usage = /^usage_usec (\d+)$/mu.exec(readText(join(cgroupRoot, path, "cpu.stat")) ?? "");
        if (!usage) continue;
        units.push({
          unit: name,
          scope: path.includes("/user@") || path.startsWith("user@") ? "user" : "system",
          path,
          cpuUsec: Number(usage[1]),
          memoryBytes: anonymousMemory(join(cgroupRoot, path)),
        });
      }
    }
  };
  walk("");
  return units;
}

function sensorLevel(kind: Sensor["kind"], value: number, limit: number | null): HeatLevel {
  if (limit === null || limit <= 0) return "nominal";
  if (kind === "fan") return value >= 0.8 * limit ? "serious" : "nominal";
  return value >= limit ? "critical" : value >= limit - 10 ? "serious" : "nominal";
}

/** hwmon temperatures (millidegrees) and fans; a sensor that fails to read is left out. */
export function readSensors(hwmonRoot: string): Sensor[] {
  const sensors: Sensor[] = [];
  for (const device of directories(hwmonRoot).sort()) {
    const dir = join(hwmonRoot, device);
    const chip = readText(join(dir, "name"))?.trim() || device;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const match = /^(temp|fan)(\d+)_input$/u.exec(file);
      if (!match) continue;
      const kind = match[1] === "temp" ? "temp" : "fan";
      const stem = `${match[1]}${match[2]}`;
      const scale = kind === "temp" ? 1000 : 1;
      const raw = readNumber(join(dir, file));
      if (raw === null) continue;
      const rawLimit = kind === "temp"
        ? readNumber(join(dir, `${stem}_crit`)) ?? readNumber(join(dir, `${stem}_max`))
        : readNumber(join(dir, `${stem}_max`));
      const value = raw / scale, limit = rawLimit === null ? null : rawLimit / scale;
      sensors.push({ chip, label: readText(join(dir, `${stem}_label`))?.trim() || `${chip} ${stem}`, kind, value, limit, level: sensorLevel(kind, value, limit) });
    }
  }
  return sensors;
}

/** One reading of the machine; `root` is "/" except in tests. */
export function readMachineSample(root = "/", at = Date.now()): MachineSample {
  return {
    at,
    cpu: parseProcStat(readText(join(root, "proc/stat")) ?? ""),
    memoryPressure: parsePressure(readText(join(root, "proc/pressure/memory")) ?? ""),
    units: readUnits(join(root, "sys/fs/cgroup")),
    sensors: readSensors(join(root, "sys/class/hwmon")),
  };
}

function maxLevel(levels: HeatLevel[]): HeatLevel {
  return HEAT_LEVELS[Math.max(0, ...levels.map((level) => HEAT_LEVELS.indexOf(level)))] ?? "nominal";
}

export function heatLevel(utilization: number, sensors: readonly Sensor[]): HeatLevel {
  const load: HeatLevel = utilization >= 0.85 ? "critical" : utilization >= 0.6 ? "serious" : utilization >= 0.4 ? "fair" : "nominal";
  return maxLevel([load, ...sensors.map((sensor) => sensor.level)]);
}

export function memoryLevel(pressure: MachineSample["memoryPressure"]): MemoryLevel {
  if (!pressure) return "green";
  return pressure.fullAvg60 >= 10 ? "red" : pressure.someAvg60 >= 10 ? "yellow" : "green";
}

/** What changed between two samples; a unit new in `next` is measured from zero only if it started inside the interval. */
export function compareSamples(previous: Pick<MachineSample, "at" | "cpu" | "units">, next: MachineSample): MachineReading {
  const intervalMs = Math.max(1, next.at - previous.at);
  const total = next.cpu.total - previous.cpu.total;
  const utilization = total > 0 ? Math.min(1, Math.max(0, (next.cpu.busy - previous.cpu.busy) / total)) : 0;
  const before = new Map(previous.units.map((unit) => [unit.path, unit.cpuUsec]));
  const units = next.units.flatMap((unit) => {
    const start = before.get(unit.path);
    const used = start === undefined ? unit.cpuUsec : unit.cpuUsec - start;
    // A counter that went backwards is a different unit under the same name.
    if (used < 0 || (start === undefined && used > intervalMs * 1000 * next.cpu.cores)) return [];
    return [{ unit: unit.unit, scope: unit.scope, path: unit.path, cores: used / 1000 / intervalMs, memoryBytes: unit.memoryBytes }];
  }).sort((a, b) => b.cores - a.cores);
  return {
    at: new Date(next.at).toISOString(),
    intervalSeconds: intervalMs / 1000,
    utilization,
    cores: next.cpu.cores,
    heat: heatLevel(utilization, next.sensors),
    memory: memoryLevel(next.memoryPressure),
    memoryPressure: next.memoryPressure,
    sensors: next.sensors,
    units,
  };
}

interface Condition {
  /** When the condition was first seen holding, ms. */
  since: number;
  /** When it was first seen calm after an alert, ms. */
  calmSince: number | null;
  /** The event id delivered for this episode. */
  alerted: string | null;
}

export interface WatchState {
  v: 1;
  sample: Pick<MachineSample, "at" | "cpu" | "units">;
  conditions: Record<string, Condition>;
}

export interface WatchAlert {
  /** `heat`, `memory`, or `runaway:<unit path>`. */
  key: string;
  /** The event id: the condition and when it began, so an episode is one conversation. */
  id: string;
  kind: "heat" | "memory" | "runaway";
  since: string;
  reading: MachineReading;
}

function activeConditions(reading: MachineReading): Map<string, { kind: WatchAlert["kind"]; holdMs: number }> {
  const active = new Map<string, { kind: WatchAlert["kind"]; holdMs: number }>();
  if (HEAT_LEVELS.indexOf(reading.heat) >= HEAT_LEVELS.indexOf("serious")) active.set("heat", { kind: "heat", holdMs: WATCH_RULES.heatHoldMs });
  if (reading.memory === "red") active.set("memory", { kind: "memory", holdMs: WATCH_RULES.memoryHoldMs });
  for (const unit of reading.units) {
    if (unit.cores >= WATCH_RULES.runawayCores) active.set(`runaway:${unit.path}`, { kind: "runaway", holdMs: WATCH_RULES.runawayHoldMs });
  }
  return active;
}

/**
 * One watch step: fold a new sample into the state and return the conditions
 * that have now held long enough and were not yet alerted this episode.
 */
export function watchStep(state: WatchState | null, sample: MachineSample): { state: WatchState; alerts: WatchAlert[]; reading: MachineReading | null } {
  const slim = { at: sample.at, cpu: sample.cpu, units: sample.units.map(({ unit, scope, path, cpuUsec }) => ({ unit, scope, path, cpuUsec, memoryBytes: null })) };
  const conditions = { ...state?.conditions };
  if (!state || sample.at <= state.sample.at || sample.at - state.sample.at > WATCH_RULES.maxGapMs) {
    // No continuous evidence: unalerted conditions start over; alerted episodes still need their calm.
    for (const [key, condition] of Object.entries(conditions)) if (!condition.alerted) delete conditions[key];
    return { state: { v: 1, sample: slim, conditions }, alerts: [], reading: null };
  }
  const reading = compareSamples(state.sample, sample);
  const active = activeConditions(reading);
  const alerts: WatchAlert[] = [];
  for (const [key, rule] of active) {
    const condition = conditions[key] ?? { since: state.sample.at, calmSince: null, alerted: null };
    condition.calmSince = null;
    if (!condition.alerted && sample.at - condition.since >= rule.holdMs) {
      const since = new Date(condition.since).toISOString();
      condition.alerted = `${key}:${since}`;
      alerts.push({ key, id: condition.alerted, kind: rule.kind, since, reading });
    }
    conditions[key] = condition;
  }
  for (const [key, condition] of Object.entries(conditions)) {
    if (active.has(key)) continue;
    if (!condition.alerted) {
      delete conditions[key];
      continue;
    }
    condition.calmSince ??= state.sample.at;
    if (sample.at - condition.calmSince >= WATCH_RULES.coolMs) delete conditions[key];
  }
  return { state: { v: 1, sample: slim, conditions }, alerts, reading };
}

export function parseWatchState(text: string | null): WatchState | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as WatchState;
    return value?.v === 1 && value.sample && typeof value.sample.at === "number" && value.conditions ? value : null;
  } catch {
    return null;
  }
}

export interface ProcessInfo {
  pid: number;
  command: string;
  /** Lifetime CPU time. */
  cpuSeconds: number;
  rssBytes: number | null;
}

/** The busiest processes in one unit's cgroup tree, by lifetime CPU time. */
export function readUnitProcesses(root: string, unitPath: string, limit = 5): ProcessInfo[] {
  const pids = new Set<number>();
  const walk = (dir: string) => {
    for (const line of (readText(join(dir, "cgroup.procs")) ?? "").split("\n")) if (/^\d+$/u.test(line)) pids.add(Number(line));
    for (const child of directories(dir)) walk(join(dir, child));
  };
  walk(join(root, "sys/fs/cgroup", unitPath));
  const processes = [...pids].flatMap((pid) => {
    const stat = readText(join(root, "proc", String(pid), "stat"));
    if (!stat) return [];
    // Fields after the parenthesized command; utime and stime are the 12th and 13th of them, in USER_HZ (100).
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpuSeconds = (Number(after[11]) + Number(after[12])) / 100;
    const command = (readText(join(root, "proc", String(pid), "cmdline")) ?? "").split("\0").filter(Boolean).join(" ")
      || stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const rss = /^VmRSS:\s+(\d+) kB$/mu.exec(readText(join(root, "proc", String(pid), "status")) ?? "");
    return [{ pid, command: command.slice(0, 300), cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0, rssBytes: rss ? Number(rss[1]) * 1024 : null }];
  });
  return processes.sort((a, b) => b.cpuSeconds - a.cpuSeconds).slice(0, limit);
}

/** The event payload: the reading, and for the units that matter, who is inside them. */
export function alertPayload(alert: WatchAlert, root = "/"): string {
  const { reading } = alert;
  const ranked = alert.kind === "memory"
    ? [...reading.units].sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
    : alert.kind === "runaway"
      ? reading.units.filter((unit) => `runaway:${unit.path}` === alert.key)
      : reading.units;
  const units = ranked.slice(0, 8).map((unit, index) => ({
    ...unit,
    cores: Math.round(unit.cores * 100) / 100,
    ...(index < 3 ? { processes: readUnitProcesses(root, unit.path) } : {}),
  }));
  return JSON.stringify({
    kind: alert.kind,
    since: alert.since,
    at: reading.at,
    heat: reading.heat,
    memory: reading.memory,
    utilization: Math.round(reading.utilization * 100) / 100,
    cores: reading.cores,
    intervalSeconds: reading.intervalSeconds,
    memoryPressure: reading.memoryPressure,
    sensors: reading.sensors.slice(0, 40),
    units,
  }, null, 2);
}

function bytes(value: number | null): string {
  return value === null ? "-" : `${Math.round(value / 1_048_576)} MB`;
}

/** `ghost machine`'s text: the levels, the sensors, and the busiest units. */
export function renderReading(reading: MachineReading, top = 10): string {
  const pressure = reading.memoryPressure
    ? ` (pressure some ${reading.memoryPressure.someAvg60}%, full ${reading.memoryPressure.fullAvg60}%)`
    : "";
  const lines = [
    `Heat: ${reading.heat} · CPU ${Math.round(reading.utilization * 100)}% of ${reading.cores} cores over ${reading.intervalSeconds}s`,
    `Memory: ${reading.memory}${pressure}`,
  ];
  if (reading.sensors.length) {
    lines.push(`Sensors: ${reading.sensors.map((sensor) => `${sensor.label} ${Math.round(sensor.value)}${sensor.kind === "temp" ? "°C" : " RPM"}${sensor.limit === null ? "" : `/${Math.round(sensor.limit)}`}${sensor.level === "nominal" ? "" : ` (${sensor.level})`}`).join(", ")}`);
  }
  lines.push("Busiest units (cores, memory, scope, unit):");
  for (const unit of reading.units.slice(0, top)) {
    lines.push(`  ${unit.cores.toFixed(2).padStart(5)}  ${bytes(unit.memoryBytes).padStart(8)}  ${unit.scope.padEnd(6)}  ${unit.unit}`);
  }
  return `${lines.join("\n")}\n`;
}
