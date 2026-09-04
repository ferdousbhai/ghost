/**
 * The runtime policy for a ghost changing its own source. Rendered from what
 * actually runs the process and the ghost's configured `self.checkout`, so the
 * prompt never claims a checkout is live when it is not.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GhostSettings } from "./ghost-settings.js";
import { pathIsWithin } from "./path-within.js";
import type { RunningSource } from "./running-source.js";

const GHOST_SOURCE_URL = "https://github.com/ferdousbhai/ghost";
const PACKAGED_ROOT = "/usr/lib/ghost/runtime";

/**
 * `self.checkout` is only usable when it is an absolute path under the owner
 * home; anything else is unwritable under the daemon's sandbox, so it is read
 * as unset rather than as an error.
 */
export function resolveSelfCheckout(
  settings: GhostSettings,
  ownerHome: string,
): string | null {
  const configured = settings.getString("self.checkout")?.trim();
  if (!configured || !isAbsolute(configured)) return null;
  const checkout = resolve(configured);
  if (checkout === resolve(ownerHome) || !pathIsWithin(ownerHome, checkout)) return null;
  return checkout;
}

/** Same directory on disk, following symlinks, without failing on a missing one. */
function sameDirectory(left: string, right: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(left) === real(right);
}

export interface SelfMaintenanceInput {
  readonly ghostName: string;
  readonly checkout: string | null;
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

function checkoutLines(input: SelfMaintenanceInput): string[] {
  const { checkout, running } = input;
  if (checkout === null) {
    return [
      `No self checkout is configured. Your source is ${GHOST_SOURCE_URL}; the owner can point you at a clone under their home by putting \`self:\` with a nested \`checkout: <absolute path>\` in your \`settings.yml\`.`,
      "Never edit a checkout you were not given.",
    ];
  }
  const isRunningRoot = running?.root != null && sameDirectory(checkout, running.root);
  return [
    `Your own checkout is ${JSON.stringify(checkout)}.`,
    "The owner has to bind it as this conversation's trusted project through the HUD project chip before you can edit it — you cannot bind it yourself, so ask.",
    "Read its `CLAUDE.md` and `CONTRACTS.md` first. They are your self map.",
    isRunningRoot
      ? "This checkout is what runs you: edits go live after build + restart."
      : "This checkout is not what runs you; adopting a change needs the owner to point the ghostd launcher or package at it. Say so instead of pretending it is live.",
    "A change to `self.checkout` in `settings.yml` applies to new conversations, not this one.",
    "Never edit a checkout you were not given.",
  ];
}

function loopLines(checkout: string | null): string[] {
  if (checkout === null) return [];
  return [
    "The loop: edit on a branch → run the touched package's tests and `typecheck` → commit with the reason in the message → `pnpm build` → restart.",
    "This is you working in your own Bash, not a delegated task, so the task rules about worktrees and branches do not apply here.",
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
  return [
    "## Self-maintenance",
    whatRunsYou(input.running),
    ...checkoutLines(input),
    ...loopLines(input.checkout),
    ...restartLines(input.ghostName, input.sessionId),
    "Your history lives in three places: `git log` in the checkout for what the code did, `journalctl --user -t ghostd` for what the daemon did, and your own transcript for why. Read them before retrying a change that failed.",
    "To undo: `git revert` plus a restart for code, Trash for a deleted ghost home, `omarchy-snapshot` or snapper to rewind the system. Never `rm -rf` a checkout.",
  ].join("\n");
}
