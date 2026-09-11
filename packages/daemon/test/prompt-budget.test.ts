/**
 * A size ratchet over the stable system-prompt policy text (#64).
 *
 * Every section below is rendered into every session under both runtimes, so it
 * is what a per-ghost adapter has to absorb before the ghost has said anything.
 * The system prompt is a budget, not a place to put things: growth has to be a
 * deliberate decision rather than the accumulated residue of unrelated commits.
 *
 * Each ceiling is the exact rendered size at the time it was set, so any added
 * character fails here. The way to raise one is to lower another or to justify
 * it in the commit message that raises it. Only the stable text is budgeted —
 * the memory index, the skills index, and the declarative project section are
 * derived per ghost and are out of scope.
 */
import { describe, expect, it } from "vitest";
import { buildGhostSystemPrompt } from "@ghost/extensions";
import { FIRST_MEETING_SECTION } from "../src/greeting.js";
import { CONTEXT_WINDOW_POLICY } from "../src/context-windows.js";
import {
  HARNESS_LIMITS_POLICY,
  OMARCHY_COMPUTER_USE_POLICY,
  OWNER_DELIVERABLE_POLICY,
  OWNER_HOOKS_POLICY,
  renderOwnerContextPolicy,
} from "../src/machine-skills.js";
import { renderScheduledWorkPolicy } from "../src/schedules.js";
import { renderSelfMaintenancePolicy } from "../src/self-maintenance.js";
import type { RunningSource } from "../src/running-source.js";

/** Fixed inputs: every ceiling is only meaningful against the same rendering. */
const GHOST_NAME = "casper";
const HOME_DIR = "/home/owner/ghosts/casper";
const UNIT_DIR = "/home/owner/.config/systemd/user";
const CHECKOUT = "/home/owner/src/ghost";
const DOCUMENTS = "/home/owner/Documents";
const SESSION_ID = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
const RUNNING: RunningSource = {
  version: "0.0.1",
  commit: "0".repeat(40),
  root: CHECKOUT,
};

/**
 * `characterPolicySection` and `memorySection` are internal to the prompt
 * builder, so they are measured where they are shipped: in a prompt built with
 * an unwritten character, split back into its `## `-headed sections.
 */
function promptSection(heading: string): string {
  const prompt = buildGhostSystemPrompt({
    ghostName: GHOST_NAME,
    character: null,
    homeDir: HOME_DIR,
  });
  const section = prompt.trimEnd()
    .split(/\n\n(?=## )/u)
    .find((candidate) => candidate.startsWith(heading));
  if (section === undefined) throw new Error(`The system prompt no longer renders ${heading}.`);
  return section.split("\n\n<untrusted")[0] ?? section;
}

function renderStablePolicy(): Record<string, string> {
  return {
    "Character file": promptSection("## Character file"),
    "Computer use": OMARCHY_COMPUTER_USE_POLICY,
    "Finished work": OWNER_DELIVERABLE_POLICY,
    "Other harnesses": HARNESS_LIMITS_POLICY,
    "Context windows": CONTEXT_WINDOW_POLICY,
    Hooks: OWNER_HOOKS_POLICY,
    "Owner context": renderOwnerContextPolicy(DOCUMENTS),
    "Scheduled work": renderScheduledWorkPolicy(GHOST_NAME, UNIT_DIR),
    "Self-maintenance": renderSelfMaintenancePolicy({
      ghostName: GHOST_NAME,
      checkout: CHECKOUT,
      running: RUNNING,
      sessionId: SESSION_ID,
    }),
    "First meeting": FIRST_MEETING_SECTION,
  };
}

/** The exact rendered size of each section when its ceiling was last set. */
const CEILINGS: Record<string, number> = {
  "Character file": 928,
  "Computer use": 415,
  "Finished work": 250,
  "Other harnesses": 829,
  "Context windows": 693,
  Hooks: 462,
  "Owner context": 822,
  "Scheduled work": 1399,
  "Self-maintenance": 2413,
  "First meeting": 431,
};

const TOTAL_CEILING = 8642;

function measureStablePolicy(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(renderStablePolicy()).map(([name, text]) => [name, text.length]),
  );
}

function total(sizes: Record<string, number>): number {
  return Object.values(sizes).reduce((sum, size) => sum + size, 0);
}

/** The whole budget, so a failure names the offender instead of one number. */
function budgetTable(sizes: Record<string, number>): string {
  const row = (name: string, size: number, ceiling: number | undefined): string => {
    const margin = ceiling === undefined ? "no ceiling" : `${size > ceiling ? "+" : ""}${size - ceiling}`;
    const limit = ceiling === undefined ? "-" : String(ceiling);
    return `  ${name.padEnd(18)}${String(size).padStart(6)} / ${limit.padStart(6)}  ${margin}`;
  };
  const rows = Object.entries(sizes).map(([name, size]) => row(name, size, CEILINGS[name]));
  rows.push(row("TOTAL", total(sizes), TOTAL_CEILING));
  return `stable prompt policy, chars / ceiling:\n${rows.join("\n")}`;
}

describe("the stable prompt policy budget", () => {
  it("keeps every section at or below its ceiling", () => {
    const sizes = measureStablePolicy();
    // Every budgeted section needs a ceiling, or a new one could reach the
    // prompt without ever being counted.
    expect(Object.keys(sizes).sort()).toEqual(Object.keys(CEILINGS).sort());

    const over = Object.entries(sizes)
      .filter(([name, size]) => size > (CEILINGS[name] ?? 0))
      .map(([name]) => name);
    expect(over, budgetTable(sizes)).toEqual([]);
  });

  it("keeps the whole stable policy at or below the total ceiling", () => {
    const sizes = measureStablePolicy();
    expect(total(sizes), budgetTable(sizes)).toBeLessThanOrEqual(TOTAL_CEILING);
  });
});
