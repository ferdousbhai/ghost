/**
 * A scripted agent CLI. Tests never run a real harness: this one is a small
 * script the host spawns like any other row, printing one normalized
 * `HarnessEvent` per line for each turn and recording what it was launched
 * with (prompt, resume, cwd, conversation env, the AGENTS.md it found) so
 * assertions are made against what a harness actually receives.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, HarnessRow } from "../../src/harness-table.js";
import type { HarnessReport } from "../../src/harnesses.js";

/** One turn of the fake harness, in the order turns are launched. */
export interface FakeTurn {
  readonly events?: readonly HarnessEvent[];
  readonly exit?: number;
  readonly stderr?: string;
  /** Hold the turn until this file exists (see `release`). */
  readonly gate?: string;
}

export interface FakeCall {
  readonly n: number;
  readonly prompt: string;
  readonly resume: boolean;
  readonly sessionId: string | null;
  readonly cwd: string;
  readonly ghost: string | null;
  readonly session: string | null;
  readonly agents: string | null;
  readonly mcp: readonly string[];
}

export interface FakeHarness {
  readonly id: string;
  readonly row: HarnessRow;
  calls(): FakeCall[];
  /** Replace the script for the turns not yet launched. */
  setTurns(turns: readonly FakeTurn[]): void;
  /** A gate path for a turn to wait on, and the call that opens it. */
  gate(name: string): { path: string; release(): void };
  cleanup(): void;
}

const SCRIPT = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [turnsPath, counterPath, logPath, prompt, resume, sessionId, mcp] = process.argv.slice(2);
const n = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(n + 1));
appendFileSync(logPath, JSON.stringify({
  n, prompt, resume: resume === "resume", sessionId: sessionId || null, cwd: process.cwd(),
  ghost: process.env.GHOST ?? null, session: process.env.GHOST_SESSION ?? null,
  agents: existsSync("AGENTS.md") ? readFileSync("AGENTS.md", "utf8") : null,
  mcp: mcp ? mcp.split(",") : [],
}) + "\\n");
const turns = JSON.parse(readFileSync(turnsPath, "utf8"));
const turn = turns[Math.min(n, turns.length - 1)] ?? {};
if (turn.gate) while (!existsSync(turn.gate)) await new Promise((r) => setTimeout(r, 10));
for (const event of turn.events ?? []) process.stdout.write(JSON.stringify(event) + "\\n");
if (turn.stderr) process.stderr.write(turn.stderr);
process.exit(turn.exit ?? 0);
`;

/** Text events for the common case: each string is one reply. */
export function replies(...texts: string[]): FakeTurn[] {
  return texts.map((text) => ({ events: [{ type: "text", block: "reply", delta: text }] }));
}

export function fakeHarness(turns: readonly FakeTurn[], id = "fake"): FakeHarness {
  const dir = mkdtempSync(join(tmpdir(), "ghost-fake-harness-"));
  const script = join(dir, "harness.mjs");
  const turnsPath = join(dir, "turns.json");
  const counterPath = join(dir, "counter");
  const logPath = join(dir, "calls.jsonl");
  writeFileSync(script, SCRIPT);
  writeFileSync(turnsPath, JSON.stringify(turns));
  const row: HarnessRow = {
    id,
    launch: (turn) => ({
      argv: [
        process.execPath, script, turnsPath, counterPath, logPath,
        turn.prompt, turn.resume ? "resume" : "new", turn.sessionId ?? "",
        turn.mcp.map((server) => server.name).join(","),
      ],
    }),
    parser: () => (line) => {
      try {
        return [JSON.parse(line) as HarnessEvent];
      } catch {
        return [];
      }
    },
  };
  return {
    id,
    row,
    calls: () => existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeCall)
      : [],
    setTurns: (next) => writeFileSync(turnsPath, JSON.stringify(next)),
    gate: (name) => {
      const path = join(dir, `gate-${name}`);
      return { path, release: () => writeFileSync(path, "") };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** SessionHost options that make `harnesses` the only harnesses on the machine. */
export function onlyHarnesses(...harnesses: FakeHarness[]): {
  eligibleHarnesses: () => Promise<readonly string[]>;
  harnessReport: () => Promise<HarnessReport>;
  harnessRows: (id: string) => HarnessRow | null;
  defaultHarness: () => Promise<string | null>;
} {
  const rows = new Map(harnesses.map((harness) => [harness.id, harness.row]));
  return {
    eligibleHarnesses: async () => harnesses.map((harness) => harness.id),
    harnessReport: async () => ({
      harnesses: harnesses.map((harness) => ({ id: harness.id, eligible: true, reason: null, usage: null })),
      refresh: "omarchy agent usage update",
    }),
    harnessRows: (id) => rows.get(id) ?? null,
    defaultHarness: async () => null,
  };
}
