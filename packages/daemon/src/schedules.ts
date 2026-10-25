/**
 * Scheduled work is a systemd user timer, and the timer is the only record of it.
 *
 * Ghost writes no scheduler. A schedule the owner can see in
 * `systemctl --user list-timers`, disable with `systemctl --user disable --now`,
 * and edit in an ordinary text file is more legible than one that lives inside
 * ghostd and is invisible until the HUD is open. Omarchy reaches the same
 * conclusion for its own artifacts: `omarchy-games-retro-install` writes one
 * `.desktop` file into the standard user directory, tells the system that owns
 * that directory, and stops — no daemon reconciles it afterwards.
 *
 * So a ghost authors its own units through `bash`, and the daemon only projects
 * and controls them for the owner. It keeps one obligation the desktop-file
 * precedent does not have: a stray `.desktop` file is inert, but a stray
 * `.timer` fires. Deletion removes the timers owned by that ghost before
 * deletion or rename publishes a reusable name.
 *
 * The versioned, length-delimited prefix and slug grammar are the ownership
 * contract. Units are swept by name, never by pattern-matching content.
 */
import { readdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { errorMessage, GhostError } from "./errors.js";
import { ACCEPTED_EVENT_LINE } from "./external-events.js";
import { isValidGhostName } from "./ghosts.js";
import { which } from "./harnesses.js";
import {
  commandRunner,
  type CommandResult,
  type CommandRunner,
} from "./tailscale-identity.js";
import { silentLogger, type Logger } from "./log.js";
import { xdgBaseDir } from "./xdg-user-dirs.js";

/** Versioned so the original ambiguous `ghost-timer-<ghost>-` form stays inert. */
const SCHEDULE_UNIT_PREFIX = "ghost-timer-v1-";
export const MAX_SCHEDULE_SLUG_LENGTH = 64;

const UNIT_SUFFIXES = [".timer", ".service"] as const;
/** A routine slug's grammar, as the ghost's help recipe states it. */
export const SCHEDULE_SLUG_GRAMMAR = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SCHEDULE_SLUG_PATTERN = new RegExp(`^${SCHEDULE_SLUG_GRAMMAR}$`, "u");

export function isValidScheduleSlug(slug: string): boolean {
  return slug.length >= 1
    && slug.length <= MAX_SCHEDULE_SLUG_LENGTH
    && SCHEDULE_SLUG_PATTERN.test(slug);
}

/** The unit-name prefix that belongs to one ghost, and to no other. */
export function scheduleUnitPrefix(ghostName: string): string {
  if (!isValidGhostName(ghostName)) {
    throw new TypeError(`Invalid ghost name for schedule ownership: ${JSON.stringify(ghostName)}`);
  }
  // Ghost names are ASCII by contract, so string length is the encoded byte
  // length. The delimiter cannot alias a longer name such as aria-ops to aria.
  return `${SCHEDULE_UNIT_PREFIX}${ghostName.length}-${ghostName}-`;
}

/** One routine's unit-name stem, refusing an invalid slug. */
export function routineStem(ghost: string, slug: string): string {
  if (!isValidScheduleSlug(slug)) throw new GhostError("invalid_routine", "Invalid routine slug.", 400);
  return `${scheduleUnitPrefix(ghost)}${slug}`;
}

function isOwnedScheduleUnit(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  return UNIT_SUFFIXES.some((suffix) => (
    name.endsWith(suffix)
    && isValidScheduleSlug(name.slice(prefix.length, -suffix.length))
  ));
}

function requireCommandSuccess(result: CommandResult, action: string): void {
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || result.stdout.trim() || `${action} exited with code ${result.code}`);
}

/** `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. */
export function resolveScheduleUnitDirectory(
  ownerHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isAbsolute(ownerHome)) throw new TypeError("ownerHome must be absolute");
  return join(xdgBaseDir(env, "XDG_CONFIG_HOME", ownerHome), "systemd", "user");
}

/**
 * The `ghost` executable a timer unit must name. systemd needs an absolute
 * path and the packaged install puts it at /usr/bin/ghost, but a checkout
 * install runs a launcher elsewhere on PATH, so the running daemon's PATH is
 * consulted first.
 */
export function ghostCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return which("ghost", env) ?? "/usr/bin/ghost";
}

export const SCHEDULED_WORK_POLICY = [
  "## Scheduled work",
  "Clock work is a systemd user timer you write from Bash; Ghost has no scheduler. Read `ghost help timers` first. Timers fire only while the owner is logged in, so promise no check-ins while they are away.",
].join("\n");

/**
 * The units belonging to one ghost. A name must start with that ghost's exact
 * prefix, contain a valid slug, and end in a unit suffix Ghost creates, so a
 * file the owner wrote for something else is never a candidate however it is
 * named.
 */
export async function listGhostScheduleUnits(
  ghostName: string,
  unitDir: string,
): Promise<string[]> {
  const prefix = scheduleUnitPrefix(ghostName);
  let entries: string[];
  try {
    entries = await readdir(unitDir);
  } catch (error) {
    // No unit directory means no schedules, which is the common case.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((name) => isOwnedScheduleUnit(name, prefix))
    .sort();
}

export interface ScheduleOptions {
  readonly unitDir: string;
  /** Test seam over `systemctl --user`. */
  readonly run?: CommandRunner;
  readonly logger?: Logger;
}

export interface ScheduleSweepResult {
  readonly removed: string[];
}

/**
 * Stop, disable, and delete every timer a ghost owned. A failure throws, and
 * the caller retries before moving the ghost home. The final glob stop catches
 * a timer still loaded after its file was removed by hand; an enablement link
 * left for a unit that is no longer loaded is inert and may survive.
 */
export async function sweepGhostSchedules(
  ghostName: string,
  options: ScheduleOptions,
): Promise<ScheduleSweepResult> {
  const logger = options.logger ?? silentLogger;
  const run = options.run ?? commandRunner("systemctl");
  const prefix = scheduleUnitPrefix(ghostName);
  const units = await listGhostScheduleUnits(ghostName, options.unitDir);
  const timers = units.filter((name) => name.endsWith(".timer"));
  if (timers.length > 0) {
    requireCommandSuccess(await run(["--user", "disable", "--now", ...timers]), "systemctl disable --now");
  }
  for (const name of units) {
    try {
      await unlink(join(options.unitDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (units.length > 0) {
    requireCommandSuccess(await run(["--user", "daemon-reload"]), "systemctl daemon-reload");
  }
  requireCommandSuccess(await run(["--user", "stop", `${prefix}*.timer`]), "systemctl stop");
  logger.info("swept ghost schedules", { ghost: ghostName, removed: units.length });
  return { removed: units };
}

export interface Routine {
  ghost: string;
  slug: string;
  unit: string;
  service: string;
  timerPath: string;
  servicePath: string;
  description: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  enabled: string;
  active: string;
  command: string;
  result: string;
  serviceActive: string;
}

export async function scheduleCommand(run: CommandRunner, args: string[]): Promise<string> {
  try {
    const result = await run(["--user", ...args]);
    requireCommandSuccess(result, "systemctl");
    return result.stdout;
  } catch (error) {
    throw new GhostError("routines_unavailable", `Could not access systemd routines: ${errorMessage(error)}`, 503);
  }
}

export function unitProperties(output: string): Map<string, Record<string, string>> {
  const units = new Map<string, Record<string, string>>();
  for (const block of output.trim().split(/\n\s*\n/u)) {
    const props: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const equal = line.indexOf("=");
      if (equal > 0) props[line.slice(0, equal)] = line.slice(equal + 1);
    }
    if (props.Id) units.set(props.Id, props);
  }
  return units;
}

export async function listGhostRoutines(ghost: string, options: ScheduleOptions): Promise<Routine[]> {
  const prefix = scheduleUnitPrefix(ghost);
  const timers = (await listGhostScheduleUnits(ghost, options.unitDir)).filter((unit) => unit.endsWith(".timer"));
  if (!timers.length) return [];
  const run = options.run ?? commandRunner("systemctl");
  const timerProps = unitProperties(await scheduleCommand(run, [
    "show", "--all", "--property=Id,Description,Unit,UnitFileState,ActiveState,TimersCalendar,TimersMonotonic,NextElapseUSecRealtime", ...timers,
  ]));
  const services = timers.map((unit) => unit.replace(/\.timer$/u, ".service"));
  const serviceProps = unitProperties(await scheduleCommand(run, [
    "show", "--all", "--property=Id,ExecStart,Result,ActiveState,ExecMainStartTimestamp", ...services,
  ]));
  return timers.map((unit, index) => {
    const timer = timerProps.get(unit) ?? {};
    const service = services[index] as string;
    const state = (!timer.Unit || timer.Unit === service) ? serviceProps.get(service) ?? {} : {};
    const timestamp = (value: string | undefined) => !value || value === "0" || value === "n/a" ? null : value;
    return {
      ghost, slug: unit.slice(prefix.length, -6), unit,
      service: timer.Unit || service,
      timerPath: join(options.unitDir, unit), servicePath: timer.Unit && timer.Unit !== service ? "" : join(options.unitDir, service),
      description: timer.Description ?? "", schedule: [timer.TimersCalendar, timer.TimersMonotonic].filter(Boolean).join("; "),
      nextRun: timestamp(timer.NextElapseUSecRealtime), lastRun: timestamp(state.ExecMainStartTimestamp),
      enabled: timer.UnitFileState ?? "", active: timer.ActiveState ?? "",
      command: state.ExecStart ?? "", result: timestamp(state.ExecMainStartTimestamp) && ["inactive", "failed"].includes(state.ActiveState ?? "") ? state.Result ?? "" : "", serviceActive: state.ActiveState ?? "",
    };
  });
}

export async function controlGhostRoutine(
  ghost: string, slug: string, action: string, options: ScheduleOptions,
): Promise<void> {
  if (!["pause", "resume", "run"].includes(action)) throw new GhostError("invalid_routine", "Use pause, resume, or run.", 400);
  const stem = routineStem(ghost, slug), unit = `${stem}.timer`, service = `${stem}.service`;
  const units = await listGhostScheduleUnits(ghost, options.unitDir);
  if (!units.includes(unit)) {
    throw new GhostError("not_found", "No such routine for this ghost.", 404);
  }
  const run = options.run ?? commandRunner("systemctl");
  if (action === "run") {
    const target = (await scheduleCommand(run, ["show", "--property=Unit", "--value", unit])).trim();
    if (target !== service || !units.includes(service)) throw new GhostError("invalid_routine", "Run requires the timer's same-name owned service.", 400);
    await scheduleCommand(run, ["start", "--no-block", service]);
  } else {
    await scheduleCommand(run, [action === "pause" ? "disable" : "enable", "--now", unit]);
  }
}

export async function readRoutineLogs(ghost: string, slug: string, options: ScheduleOptions, journal: CommandRunner = commandRunner("journalctl")) {
  const stem = routineStem(ghost, slug);
  if (!(await listGhostScheduleUnits(ghost, options.unitDir)).includes(`${stem}.timer`)) throw new GhostError("not_found", "No such routine.", 404);
  let output: string;
  try {
    const result = await journal(["--user", "--unit", `${stem}.service`, "--no-pager", "--output=short-iso", "--lines=100"]);
    requireCommandSuccess(result, "journalctl"); output = result.stdout;
  } catch (error) { throw new GhostError("routine_logs_unavailable", `Could not read routine logs: ${errorMessage(error)}`, 503); }
  const text = output.slice(-64000), sessions = new Set<string>();
  for (const line of text.split("\n")) {
    const match = ACCEPTED_EVENT_LINE.exec(line);
    if (match?.[1] === ghost && match[2]) sessions.add(match[2]);
  }
  return { text, truncated: output.length > text.length, sessions: [...sessions] };
}
