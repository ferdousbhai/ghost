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
 * So a ghost authors its own units through `bash`, and the daemon keeps exactly
 * one obligation the desktop-file precedent does not have: a stray `.desktop`
 * file is inert, but a stray `.timer` fires. Deletion removes the timers owned
 * by that ghost before deletion or rename publishes a reusable name.
 *
 * The versioned, length-delimited prefix and slug grammar are the ownership
 * contract. Units are swept by name, never by pattern-matching content, the
 * same rule screenshot retention follows.
 */
import { readdir, unlink } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isValidGhostName } from "./ghosts.js";
import {
  commandRunner,
  type CommandResult,
  type CommandRunner,
} from "./tailscale-identity.js";
import { silentLogger, type Logger } from "./log.js";

/** Versioned so the original ambiguous `ghost-timer-<ghost>-` form stays inert. */
const SCHEDULE_UNIT_PREFIX = "ghost-timer-v1-";
export const MAX_SCHEDULE_SLUG_LENGTH = 64;

const UNIT_SUFFIXES = [".timer", ".service"] as const;
const SCHEDULE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const base = configHome && isAbsolute(configHome)
    ? resolve(configHome)
    : resolve(ownerHome, ".config");
  return join(base, "systemd", "user");
}

/**
 * The `ghost` executable a timer unit must name. systemd needs an absolute
 * path and the packaged install puts it at /usr/bin/ghost, but a checkout
 * install runs a launcher elsewhere on PATH, so the running daemon's PATH is
 * consulted first.
 */
export function ghostCliPath(env: NodeJS.ProcessEnv = process.env): string {
  for (const directory of (env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(directory, "ghost");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return "/usr/bin/ghost";
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

export interface ScheduleSweepOptions {
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
  options: ScheduleSweepOptions,
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
