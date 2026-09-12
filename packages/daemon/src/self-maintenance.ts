/**
 * The runtime policy for a ghost changing its own source. Rendered from what
 * actually runs the process: the clone the daemon was built from is the one
 * checkout, shared by every ghost on the machine, so a change there powers all
 * of them after a build and restart. A packaged install has no checkout.
 */
import { isAbsolute, resolve } from "node:path";
import type { GhostSettings } from "./ghost-settings.js";
import { pathIsWithin } from "./path-within.js";
import type { RunningSource } from "./running-source.js";

const GHOST_SOURCE_URL = "https://github.com/ferdousbhai/ghost";
const PACKAGED_ROOT = "/usr/lib/ghost/runtime";

/**
 * `cwd` names where a new conversation starts, the owner home when unset. It
 * is only usable as an absolute path under the owner home; anything else is
 * unwritable under the daemon's sandbox, so it reads as unset, not an error.
 */
export function resolveSettingsCwd(settings: GhostSettings, ownerHome: string): string | null {
  const trimmed = settings.getString("cwd")?.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  const path = resolve(trimmed);
  if (path === resolve(ownerHome) || !pathIsWithin(ownerHome, path)) return null;
  return path;
}

export interface SelfMaintenanceInput {
  readonly ghostName: string;
  readonly running: RunningSource | null;
  readonly sessionId?: string;
}

function whatRunsYou(running: RunningSource | null): string {
  if (!running) return "What runs you is unknown to this process: no version, commit, or source root resolved.";
  const where = running.root !== null
    ? `from ${JSON.stringify(running.root)}`
    : `from a packaged, read-only install under ${PACKAGED_ROOT}`;
  return `You are ghostd ${running.version}, commit ${running.commit ?? "unknown"}, running ${where}.`;
}

function checkoutLines(checkout: string | null): string[] {
  if (checkout === null) {
    return [
      `There is no checkout to edit: you run from a packaged install. Your source is ${GHOST_SOURCE_URL}; a ghost works on its own code only when the owner runs ghostd from a clone (docs/self-maintenance.md in that repository).`,
      "Never edit a checkout you were not given.",
    ];
  }
  return [
    `Your checkout is ${JSON.stringify(checkout)}: the clone this daemon was built from, shared by every ghost on this machine, so a change there powers all of them after build + restart. Edit it directly with your file tools and Bash; no binding or approval comes first.`,
    "Read its `CLAUDE.md` and `CONTRACTS.md` first. They are your self map.",
    "Never edit a checkout you were not given.",
  ];
}

function loopLines(checkout: string | null): string[] {
  if (checkout === null) return [];
  return [
    "The loop: `git fetch` and branch from upstream master → edit → run the touched package's tests and `typecheck` → commit with the reason in the message → `pnpm build` → restart.",
    "This is you working in your own Bash, not a delegated task, so the task rules about worktrees and branches do not apply here.",
    "Your home is yours alone; `packages/` and `CONTRACTS.md` are every ghost's. A fix there is worth sending upstream: the recipe is `CONTRIBUTING.md` in the checkout. The PR goes out under the owner's GitHub account, so show them the branch and ask before you push.",
  ];
}

function restartLines(ghostName: string, sessionId: string | undefined): string[] {
  const session = sessionId === undefined ? "" : ` --session ${sessionId}`;
  return [
    "To restart yourself, finish the turn and tell the owner first — the daemon drains for 5 seconds and then forces. Then:",
    "```sh",
    'systemd-run --user --on-active=5 --unit="ghost-restart-$(date +%s)" \\',
    '  --description="<reason>" \\',
    "  sh -c 'systemctl --user restart ghostd.service; \\",
    "         for i in $(seq 30); do ghost status -q >/dev/null 2>&1 && break; sleep 1; done; \\",
    `         ghost say --ghost ${ghostName}${session} "You restarted ghostd for: <reason>. Check journalctl --user -t ghostd and report."'`,
    "```",
    "The timestamp keeps two restarts from colliding on the same transient unit name.",
    "The wait loop covers the daemon not listening yet when systemd already considers it started.",
    "The transient unit survives the restart because it is its own unit, not a child of yours.",
    ...(sessionId === undefined
      ? ["Without a session id the wake lands in your latest conversation, not necessarily this one."]
      : []),
    "A HUD change needs `systemctl --user restart ghost-shell.service` instead; reloading that unit only refetches daemon data, it does not reload QML.",
  ];
}

/** The exact policy a ghost is given for changing and restarting its own software. */
export function renderSelfMaintenancePolicy(input: SelfMaintenanceInput): string {
  const checkout = input.running?.root ?? null;
  return [
    "## Self-maintenance",
    whatRunsYou(input.running),
    ...checkoutLines(checkout),
    ...loopLines(checkout),
    ...restartLines(input.ghostName, input.sessionId),
    "`ghost status` names a newer Ghost release when one exists, with the exact command that installs it here; tell the owner it is available, and run that command only when they ask for the update.",
    "Your history lives in three places: `git log` in the checkout for what the code did, `journalctl --user -t ghostd` for what the daemon did, and your own transcript for why. Read them before retrying a change that failed.",
    "To undo: `git revert` plus a restart for code, Trash for a deleted ghost home, `omarchy-snapshot` or snapper to rewind the system. Never `rm -rf` a checkout.",
  ].join("\n");
}
