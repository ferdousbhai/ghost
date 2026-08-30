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
 * file is inert, but a stray `.timer` fires. When a ghost is deleted or renamed,
 * its timers must go with it — which is what this module is for.
 *
 * The prefix is the whole contract. Units are swept by exact name, never by
 * pattern-matching content, the same rule screenshot retention follows.
 */
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { commandRunner, type CommandRunner } from "./tailscale-identity.js";
import { silentLogger, type Logger } from "./log.js";

/** Every unit a ghost's schedules produce starts with this. */
export const SCHEDULE_UNIT_PREFIX = "ghost-timer-";

const UNIT_SUFFIXES = [".timer", ".service"] as const;

/** The unit-name prefix that belongs to one ghost, and to no other. */
export function scheduleUnitPrefix(ghostName: string): string {
  return `${SCHEDULE_UNIT_PREFIX}${ghostName}-`;
}

/** `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. */
export function userUnitDirectory(
  ownerHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const base = configHome?.startsWith("/") ? configHome : join(ownerHome, ".config");
  return join(base, "systemd", "user");
}

/**
 * The units belonging to one ghost. A name must start with that ghost's exact
 * prefix and end in a unit suffix Ghost creates, so a file the owner wrote for
 * something else is never a candidate however it is named.
 */
export async function listGhostScheduleUnits(
  ghostName: string,
  unitDir: string,
): Promise<string[]> {
  const prefix = scheduleUnitPrefix(ghostName);
  let entries: string[];
  try {
    entries = await readdir(unitDir);
  } catch {
    // No unit directory means no schedules, which is the common case.
    return [];
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .filter((name) => UNIT_SUFFIXES.some((suffix) => name.endsWith(suffix)))
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
 * Stop, disable, and delete every timer a ghost owned, then reload so systemd
 * forgets them too. Best-effort by design: a unit that will not disable must
 * still have its file removed, or the ghost is gone and its schedule is not.
 */
export async function sweepGhostSchedules(
  ghostName: string,
  options: ScheduleSweepOptions,
): Promise<ScheduleSweepResult> {
  const logger = options.logger ?? silentLogger;
  const units = await listGhostScheduleUnits(ghostName, options.unitDir);
  if (units.length === 0) return { removed: [] };

  const run = options.run ?? commandRunner("systemctl");
  const timers = units.filter((unit) => unit.endsWith(".timer"));
  if (timers.length > 0) {
    await run(["--user", "disable", "--now", ...timers]).catch(() => undefined);
  }

  const removed: string[] = [];
  for (const unit of units) {
    try {
      await unlink(join(options.unitDir, unit));
      removed.push(unit);
    } catch (error) {
      logger.warn("could not remove a ghost's timer unit", {
        ghost: ghostName,
        unit,
        error: (error as Error).message,
      });
    }
  }
  if (removed.length > 0) await run(["--user", "daemon-reload"]).catch(() => undefined);
  logger.info("swept ghost schedules", { ghost: ghostName, removed: removed.length });
  return { removed };
}
