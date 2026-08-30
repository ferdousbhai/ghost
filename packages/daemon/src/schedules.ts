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
import type { Dirent } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isValidGhostName } from "./ghosts.js";
import {
  commandRunner,
  type CommandResult,
  type CommandRunner,
} from "./tailscale-identity.js";
import { silentLogger, type Logger } from "./log.js";

/** Versioned so the original ambiguous `ghost-timer-<ghost>-` form stays inert. */
export const SCHEDULE_UNIT_PREFIX = "ghost-timer-v1-";
export const MAX_SCHEDULE_SLUG_LENGTH = 64;

const TIMER_SUFFIXES = [".timer"] as const;
const UNIT_SUFFIXES = [...TIMER_SUFFIXES, ".service"] as const;
const SCHEDULE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LIST_LOADED_TIMERS = [
  "--user",
  "list-units",
  "--type=timer",
  "--all",
  "--full",
  "--plain",
  "--no-legend",
  "--no-pager",
] as const;
const LIST_ENABLED_TIMERS = [
  "--user",
  "list-unit-files",
  "--type=timer",
  "--state=enabled,enabled-runtime",
  "--full",
  "--no-legend",
  "--no-pager",
] as const;
const TIMER_WANTS_DIRECTORY = "timers.target.wants";

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

function isOwnedScheduleUnit(
  name: string,
  prefix: string,
  suffixes: readonly string[] = UNIT_SUFFIXES,
): boolean {
  if (!name.startsWith(prefix)) return false;
  return suffixes.some((suffix) => (
    name.endsWith(suffix)
    && isValidScheduleSlug(name.slice(prefix.length, -suffix.length))
  ));
}

function commandOutput(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function requireCommandSuccess(result: CommandResult, action: string): void {
  if (result.code === 0) return;
  throw new Error(commandOutput(result, `${action} exited with code ${result.code}`));
}

interface LoadedTimer {
  name: string;
  activeState: string;
}

type TimerEnablement = "enabled" | "enabled-runtime";

interface EnabledTimer {
  name: string;
  state: TimerEnablement;
}

interface ManagedScheduleTimers {
  loaded: LoadedTimer[];
  enabled: EnabledTimer[];
}

function listedUnitFields(line: string): string[] {
  const fields = line.trim().split(/\s+/u);
  return fields[0] === "●" ? fields.slice(1) : fields;
}

async function inspectManagedScheduleTimers(
  prefix: string,
  run: CommandRunner,
): Promise<ManagedScheduleTimers> {
  const loadedResult = await run(LIST_LOADED_TIMERS);
  requireCommandSuccess(loadedResult, "systemctl list-units");
  const loaded: LoadedTimer[] = [];
  for (const line of loadedResult.stdout.split("\n")) {
    const [name, , activeState] = listedUnitFields(line);
    if (!name || !isOwnedScheduleUnit(name, prefix, TIMER_SUFFIXES)) continue;
    if (!activeState) throw new Error(`systemctl list-units returned no state for ${name}.`);
    loaded.push({ name, activeState });
  }

  const enabledResult = await run(LIST_ENABLED_TIMERS);
  requireCommandSuccess(enabledResult, "systemctl list-unit-files");
  const enabled: EnabledTimer[] = [];
  for (const line of enabledResult.stdout.split("\n")) {
    const [name, state] = listedUnitFields(line);
    if (!name || !isOwnedScheduleUnit(name, prefix, TIMER_SUFFIXES)) continue;
    if (state !== "enabled" && state !== "enabled-runtime") {
      throw new Error(`systemctl list-unit-files returned an unexpected state for ${name}.`);
    }
    enabled.push({ name, state });
  }

  return { loaded, enabled };
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

/** `$XDG_RUNTIME_DIR/systemd/user`, with systemd's standard uid fallback. */
export function resolveScheduleRuntimeUnitDirectory(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null | undefined = process.getuid?.(),
): string {
  const runtimeHome = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeHome && isAbsolute(runtimeHome)) {
    return join(resolve(runtimeHome), "systemd", "user");
  }
  if (uid != null && Number.isInteger(uid) && uid >= 0) {
    return join("/run/user", String(uid), "systemd", "user");
  }
  throw new TypeError("XDG_RUNTIME_DIR must be absolute when the uid is unavailable");
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
    .filter((name) => isOwnedScheduleUnit(name, prefix))
    .sort();
}

export interface ScheduleSweepOptions {
  readonly unitDir: string;
  /** Production supplies the XDG runtime scope; direct tests stay under unitDir. */
  readonly runtimeUnitDir?: string;
  /** Test seam over `systemctl --user`. */
  readonly run?: CommandRunner;
  /** Test seam over `fs.unlink`. */
  readonly unlinkUnit?: (path: string) => Promise<void>;
  readonly logger?: Logger;
}

export interface ScheduleSweepResult {
  readonly removed: string[];
}

interface ScheduleEnablementLink {
  name: string;
  path: string;
}

async function listScheduleEnablementLinks(
  prefix: string,
  unitDir: string,
): Promise<ScheduleEnablementLink[]> {
  const wantsDir = join(unitDir, TIMER_WANTS_DIRECTORY);
  let entries: Dirent[];
  try {
    entries = await readdir(wantsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isSymbolicLink())
    .filter((entry) => isOwnedScheduleUnit(entry.name, prefix, TIMER_SUFFIXES))
    .map((entry) => ({ name: entry.name, path: join(wantsDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Stop, disable, and delete every timer a ghost owned. Failure leaves the
 * caller free to retry before moving the ghost home. The systemd manager is
 * authoritative alongside source files: it can retain a loaded timer or an
 * enablement symlink after the source disappeared.
 */
export async function sweepGhostSchedules(
  ghostName: string,
  options: ScheduleSweepOptions,
): Promise<ScheduleSweepResult> {
  const logger = options.logger ?? silentLogger;
  const run = options.run ?? commandRunner("systemctl");
  const prefix = scheduleUnitPrefix(ghostName);
  const runtimeUnitDir = options.runtimeUnitDir ?? join(options.unitDir, ".runtime");
  const units = await listGhostScheduleUnits(ghostName, options.unitDir);
  const managed = await inspectManagedScheduleTimers(prefix, run);
  const persistentLinks = await listScheduleEnablementLinks(prefix, options.unitDir);
  const runtimeLinks = await listScheduleEnablementLinks(prefix, runtimeUnitDir);

  const unlinkUnit = options.unlinkUnit ?? unlink;
  if (
    units.length === 0
    && managed.loaded.length === 0
    && managed.enabled.length === 0
    && persistentLinks.length === 0
    && runtimeLinks.length === 0
  ) {
    return { removed: [] };
  }

  const stopTargets = [...new Set([
    ...units.filter((unit) => unit.endsWith(".timer")),
    ...managed.loaded.map((unit) => unit.name),
  ])].sort();
  if (stopTargets.length > 0) {
    const result = await run(["--user", "stop", ...stopTargets]);
    requireCommandSuccess(result, "systemctl stop");
  }
  const persistent = [...new Set([
    ...managed.enabled
      .filter((unit) => unit.state === "enabled")
      .map((unit) => unit.name),
    ...persistentLinks.map((link) => link.name),
  ])].sort();
  const disableFailures: unknown[] = [];
  if (persistent.length > 0) {
    try {
      const result = await run(["--user", "disable", ...persistent]);
      requireCommandSuccess(result, "systemctl disable");
    } catch (error) {
      disableFailures.push(error);
    }
  }
  const runtime = [...new Set([
    ...managed.enabled
      .filter((unit) => unit.state === "enabled-runtime")
      .map((unit) => unit.name),
    ...runtimeLinks.map((link) => link.name),
  ])].sort();
  if (runtime.length > 0) {
    try {
      const result = await run(["--user", "disable", "--runtime", ...runtime]);
      requireCommandSuccess(result, "systemctl disable --runtime");
    } catch (error) {
      disableFailures.push(error);
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
  for (const link of [...persistentLinks, ...runtimeLinks]) {
    try {
      await unlinkUnit(link.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      removalFailure ??= error;
      logger.warn("could not remove a ghost's timer enablement link", {
        ghost: ghostName,
        unit: link.name,
        error: (error as Error).message,
      });
    }
  }

  try {
    const result = await run(["--user", "daemon-reload"]);
    requireCommandSuccess(result, "systemctl daemon-reload");
  } catch (error) {
    logger.warn("could not reload systemd after removing a ghost's timer units", {
      ghost: ghostName,
      error: (error as Error).message,
    });
  }

  const remaining = await listGhostScheduleUnits(ghostName, options.unitDir);
  const remainingManaged = await inspectManagedScheduleTimers(prefix, run);
  const remainingPersistentLinks = await listScheduleEnablementLinks(prefix, options.unitDir);
  const remainingRuntimeLinks = await listScheduleEnablementLinks(prefix, runtimeUnitDir);
  const active = remainingManaged.loaded
    .filter((unit) => unit.activeState !== "inactive" && unit.activeState !== "failed");
  if (removalFailure !== undefined) throw removalFailure;
  if (
    remaining.length > 0
    || remainingManaged.enabled.length > 0
    || remainingPersistentLinks.length > 0
    || remainingRuntimeLinks.length > 0
    || active.length > 0
  ) {
    if (disableFailures.length > 0) throw disableFailures[0];
    throw new Error("Ghost schedule cleanup left an owned timer active, enabled, or on disk.");
  }
  logger.info("swept ghost schedules", { ghost: ghostName, removed: removed.length });
  return { removed };
}
