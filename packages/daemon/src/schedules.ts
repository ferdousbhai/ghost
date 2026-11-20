/**
 * How the watch recipes (`ghost help machine`, `ghost help crashes`) name the
 * systemd user units a ghost writes for them.
 */
import { isAbsolute, join } from "node:path";
import { isValidGhostName } from "./ghosts.js";
import { which } from "./harnesses.js";
import { xdgBaseDir } from "./xdg-user-dirs.js";

export const SCHEDULE_UNIT_PREFIX = "ghost-timer-v1-";

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
  return join(xdgBaseDir(env, "XDG_CONFIG_HOME", ownerHome), "systemd", "user");
}

/**
 * The `ghost` executable a unit must name. systemd needs an absolute path and
 * the packaged install puts it at /usr/bin/ghost, but a checkout install runs
 * a launcher elsewhere on PATH, so the caller's PATH is consulted first.
 */
export function ghostCliPath(env: NodeJS.ProcessEnv): string {
  return which("ghost", env) ?? "/usr/bin/ghost";
}
