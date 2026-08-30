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
 * by that ghost; rename leaves them visible under the old name for the owner to
 * repair.
 *
 * The versioned, length-delimited prefix and slug grammar are the ownership
 * contract. Units are swept by exact name, never by pattern-matching content,
 * the same rule screenshot retention follows.
 */
import { readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isValidGhostName } from "./ghosts.js";
import { commandRunner, type CommandRunner } from "./tailscale-identity.js";
import { silentLogger, type Logger } from "./log.js";

/** Versioned so the original ambiguous `ghost-timer-<ghost>-` form stays inert. */
export const SCHEDULE_UNIT_PREFIX = "ghost-timer-v1-";
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

/** The exact runtime policy rendered from schedule ownership, not a second copy. */
export function renderScheduledWorkPolicy(
  ghostName: string,
  unitDir: string,
): string {
  if (!isAbsolute(unitDir)) throw new TypeError("schedule unit directory must be absolute");
  const unit = `${scheduleUnitPrefix(ghostName)}<slug>`;
  return [
    "## Scheduled work",
    "To do something on a clock, write a systemd **user timer** through Bash — Ghost has no scheduler of its own, and a timer is something the owner can see in `systemctl --user list-timers`, stop with `systemctl --user disable --now`, and edit in a text file.",
    `Write both unit files in this exact absolute directory: ${JSON.stringify(resolve(unitDir))}.`,
    `Name both units \`${unit}\`. The \`<slug>\` must be 1–${MAX_SCHEDULE_SLUG_LENGTH} characters matching \`[a-z0-9]+(?:-[a-z0-9]+)*\`: lowercase ASCII letters or digits, separated only by single hyphens. That exact versioned prefix is how your timers are found and removed if your ghost is deleted; an older or differently named unit is left untouched.`,
    "The service runs the `ghost` CLI, which authenticates itself:",
    "```ini",
    `# ${unit}.service`,
    "[Service]",
    "Type=oneshot",
    "# Without this the turn is SIGTERMed after ~90s and dies mid-answer.",
    "TimeoutStartSec=infinity",
    `ExecStart=/usr/bin/ghost say --new --ghost ${ghostName} "<the prompt>"`,
    "```",
    "```ini",
    `# ${unit}.timer`,
    "[Timer]",
    "OnCalendar=Mon..Fri 09:00 America/New_York",
    "# Catch up after the laptop was asleep or off at the scheduled moment.",
    "Persistent=true",
    "[Install]",
    "WantedBy=timers.target",
    "```",
    "Then `systemctl --user daemon-reload && systemctl --user enable --now <unit>.timer`, and confirm with `systemctl --user list-timers`.",
    "Timers only fire while the owner is logged in, because the daemon runs with their graphical session. Do not promise check-ins overnight or while they are away.",
  ].join("\n");
}

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
    .filter((name) => name.startsWith(prefix))
    .filter((name) => UNIT_SUFFIXES.some((suffix) => (
      name.endsWith(suffix)
      && isValidScheduleSlug(name.slice(prefix.length, -suffix.length))
    )))
    .sort();
}

export interface ScheduleSweepOptions {
  readonly unitDir: string;
  /** Test seam over `systemctl --user`. */
  readonly run?: CommandRunner;
  /** Test seam over `fs.unlink`. */
  readonly unlinkUnit?: (path: string) => Promise<void>;
  readonly logger?: Logger;
}

export interface ScheduleSweepResult {
  readonly removed: string[];
}

/**
 * Stop, disable, and delete every timer a ghost owned. Failure leaves the
 * caller free to retry before moving the ghost home. Reload is best-effort
 * after the safety boundary: stopped triggers plus absent unit files.
 */
export async function sweepGhostSchedules(
  ghostName: string,
  options: ScheduleSweepOptions,
): Promise<ScheduleSweepResult> {
  const logger = options.logger ?? silentLogger;
  const units = await listGhostScheduleUnits(ghostName, options.unitDir);
  if (units.length === 0) return { removed: [] };

  const run = options.run ?? commandRunner("systemctl");
  const unlinkUnit = options.unlinkUnit ?? unlink;
  const timers = units.filter((unit) => unit.endsWith(".timer"));
  if (timers.length > 0) {
    const result = await run(["--user", "disable", "--now", ...timers]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim()
          || result.stdout.trim()
          || `systemctl disable exited with code ${result.code}`,
      );
    }
  }

  const removed: string[] = [];
  let removalFailure: unknown;
  for (const unit of units) {
    try {
      await unlinkUnit(join(options.unitDir, unit));
      removed.push(unit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      removalFailure ??= error;
      logger.warn("could not remove a ghost's timer unit", {
        ghost: ghostName,
        unit,
        error: (error as Error).message,
      });
    }
  }

  try {
    const result = await run(["--user", "daemon-reload"]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim()
          || result.stdout.trim()
          || `systemctl daemon-reload exited with code ${result.code}`,
      );
    }
  } catch (error) {
    logger.warn("could not reload systemd after removing a ghost's timer units", {
      ghost: ghostName,
      error: (error as Error).message,
    });
  }

  const remaining = await listGhostScheduleUnits(ghostName, options.unitDir);
  if (removalFailure !== undefined) throw removalFailure;
  if (remaining.length > 0) {
    throw new Error(`Ghost schedule cleanup left ${remaining.length} owned unit(s).`);
  }
  logger.info("swept ghost schedules", { ghost: ghostName, removed: removed.length });
  return { removed };
}
