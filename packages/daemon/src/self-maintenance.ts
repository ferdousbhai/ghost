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

function checkoutLines(checkout: string | null, running: RunningSource | null): string[] {
  if (checkout === null) {
    return [
      `${running ? `You run from a packaged install under ${PACKAGED_ROOT}; there is no checkout.` : "No checkout is known to this process."} Your source is ${GHOST_SOURCE_URL}; a ghost works on its own code only when the owner runs ghostd from a clone. Never edit a checkout you were not given.`,
    ];
  }
  return [
    `Your checkout is ${JSON.stringify(checkout)}: the clone this daemon was built from, shared by every ghost on this machine. Edit it directly after reading its \`CLAUDE.md\` and \`CONTRACTS.md\`; never edit a checkout you were not given.`,
  ];
}

/** The exact policy a ghost is given for changing and restarting its own software. */
export function renderSelfMaintenancePolicy(input: SelfMaintenanceInput): string {
  const checkout = input.running?.root ?? null;
  return [
    "## Self-maintenance",
    ...checkoutLines(checkout, input.running),
    "Read `ghost help self` before editing, restarting, or updating yourself; `ghost help` lists the rest of your CLI (hooks, MCP servers, timers).",
  ].join("\n");
}
