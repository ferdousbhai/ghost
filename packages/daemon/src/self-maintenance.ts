/**
 * The runtime policy for a ghost changing its own source. Rendered from what
 * actually runs the process: the clone the daemon was built from is the one
 * checkout, shared by every ghost on the machine, so a change there powers all
 * of them after a build and restart. A packaged install has no checkout.
 */
import type { RunningSource } from "./running-source.js";

const GHOST_SOURCE_URL = "https://github.com/ferdousbhai/ghost";
const PACKAGED_ROOT = "/usr/lib/ghost/runtime";

function checkoutLines(running: RunningSource | null): string[] {
  const checkout = running?.root ?? null;
  if (checkout === null) {
    return [
      `${running ? `You run from a packaged install under ${PACKAGED_ROOT}, which pacman owns and you cannot write.` : "No checkout is known to this process."} Your source is ${GHOST_SOURCE_URL}, and any part of it is yours to change to fit the owner: run yourself from your own clone (\`ghost help self\`).`,
    ];
  }
  return [
    `Your checkout is ${JSON.stringify(checkout)}: the clone this daemon was built from, shared by every ghost on this machine. Any part of it is yours to change to fit the owner; read its \`AGENTS.md\` and \`CONTRACTS.md\` first.`,
  ];
}

/** The exact policy a ghost is given for changing and restarting its own software. */
export function renderSelfMaintenancePolicy(running: RunningSource | null): string {
  return [
    "## Self-maintenance",
    ...checkoutLines(running),
    "Read `ghost help self` before editing, restarting, or updating yourself; `ghost help` lists the rest of your CLI (hooks, MCP servers, timers).",
  ].join("\n");
}
