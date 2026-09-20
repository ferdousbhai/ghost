/**
 * The runtime policy for a ghost changing its own source. Rendered from what
 * actually runs the process: the clone the daemon was built from is the one
 * checkout, shared by every ghost on the machine, so a change there powers all
 * of them after a build and restart. A packaged install has no checkout.
 */
import type { RunningSource } from "./running-source.js";

const GHOST_SOURCE_URL = "https://github.com/ferdousbhai/ghost";
const PACKAGED_ROOT = "/usr/lib/ghost/runtime";

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

function checkoutLines(checkout: string | null, running: RunningSource | null): string[] {
  if (checkout === null) {
    return [
      `${running ? "There is no checkout: you run from a packaged install." : "No checkout is known to this process."} Your source is ${GHOST_SOURCE_URL}; a ghost works on its own code only when the owner runs ghostd from a clone (docs/self-maintenance.md there).`,
      "Never edit a checkout you were not given.",
    ];
  }
  return [
    `Your checkout is ${JSON.stringify(checkout)}: the clone this daemon was built from, shared by every ghost on this machine, so a change there powers all of them after build + restart. Edit it directly; read its \`CLAUDE.md\` and \`CONTRACTS.md\` first. Never edit a checkout you were not given.`,
  ];
}

/** The exact policy a ghost is given for changing and restarting its own software. */
export function renderSelfMaintenancePolicy(input: SelfMaintenanceInput): string {
  const checkout = input.running?.root ?? null;
  return [
    "## Self-maintenance",
    whatRunsYou(input.running),
    ...checkoutLines(checkout, input.running),
    "Read `ghost help self` before editing, restarting, or updating yourself. `ghost status` names a newer release when one exists; install it only when the owner asks.",
  ].join("\n");
}
