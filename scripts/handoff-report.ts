#!/usr/bin/env bun
/**
 * The owner's report over `ghost delegate`'s handoff log (receipt schema in
 * CONTRACTS.md). Outside the core on purpose: Ghost never reads the log back.
 *
 *   bun scripts/handoff-report.ts [--since <ISO date>] [file...]
 *
 * With no files it reads `handoffs.jsonl.1` then `handoffs.jsonl` under
 * `$XDG_STATE_HOME/ghost` (falling back to `~/.local/state`), skipping missing ones.
 * `--since` drops receipts whose `at` is before that instant; a bare date is UTC midnight.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

interface Receipt {
  at: string;
  harness: string;
  /** Absent before receipts recorded who picked. */
  pick?: "owner" | "ghost";
  status: string | null;
  outcome: { refused: string } | { exit: number | null; signal: string | null; durationMs: number; limit: string | null };
}

interface Row {
  attempts: number;
  ownerPicks: number;
  refused: number;
  ok: number;
  failed: number;
  unmeasured: number;
  durations: number[];
}

function parse(text: string): { receipts: Receipt[]; malformed: number } {
  const receipts: Receipt[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Receipt;
      if (typeof value.harness !== "string" || typeof value.at !== "string" || !value.outcome) throw new Error();
      receipts.push(value);
    } catch {
      malformed += 1;
    }
  }
  return { receipts, malformed };
}

/** A refusal reason without its numbers, so like refusals count together. */
function refusalKind(reason: string): string {
  if (reason.includes("ahead of weekly pace")) return `${reason.replace(/ \d+% used.*$/u, "")} ahead of pace`;
  const full = / \d+% used/u.exec(reason);
  return full ? `${reason.slice(0, full.index)} full` : reason;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const low = sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;
  return (low + high) / 2;
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, column) => {
    widths[column] = Math.max(widths[column] ?? 0, cell.length);
  });
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n");
}

function counts(map: Map<string, number>): string[] {
  return [...map].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([key, n]) => `  ${n}  ${key}`);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** `since` is an epoch-ms cutoff: receipts whose `at` is earlier are left out entirely. */
export function report(text: string, options: { since?: number } = {}): string {
  const parsed = parse(text);
  const { since } = options;
  const receipts = since === undefined ? parsed.receipts : parsed.receipts.filter((receipt) => !(Date.parse(receipt.at) < since));
  const { malformed } = parsed;
  if (receipts.length === 0) return `No handoff receipts${malformed ? ` (${malformed} malformed)` : ""}.\n`;
  const byHarness = new Map<string, Row>();
  const refusals = new Map<string, number>();
  const limits = new Map<string, number>();
  for (const receipt of receipts) {
    const row = byHarness.get(receipt.harness) ?? { attempts: 0, ownerPicks: 0, refused: 0, ok: 0, failed: 0, unmeasured: 0, durations: [] };
    byHarness.set(receipt.harness, row);
    row.attempts += 1;
    if (receipt.pick === "owner") row.ownerPicks += 1;
    if (receipt.status) row.unmeasured += 1;
    const outcome = receipt.outcome;
    if ("refused" in outcome) {
      row.refused += 1;
      bump(refusals, `${receipt.harness}: ${refusalKind(outcome.refused)}`);
      continue;
    }
    if (outcome.exit === 0) row.ok += 1;
    else row.failed += 1;
    row.durations.push(outcome.durationMs);
    if (outcome.limit) bump(limits, `${receipt.harness}: ${outcome.limit}`);
  }
  const ats = receipts.map((receipt) => receipt.at).sort();
  const header = ["harness", "attempts", "owner picks", "refused", "ok", "failed", "unmeasured", "median run"];
  const rows = [...byHarness].sort(([a], [b]) => a.localeCompare(b)).map(([harness, row]) => {
    const middle = median(row.durations);
    return [harness, row.attempts, row.ownerPicks, row.refused, row.ok, row.failed, row.unmeasured]
      .map(String)
      .concat(middle === null ? "-" : `${(middle / 1000).toFixed(1)}s`);
  });
  const lines = [
    `${receipts.length} handoffs, ${ats[0]} to ${ats.at(-1)}${malformed ? ` (${malformed} malformed skipped)` : ""}`,
    "",
    table([header, ...rows]),
  ];
  if (refusals.size) lines.push("", "Refusals:", ...counts(refusals));
  if (limits.size) lines.push("", "Limits hit:", ...counts(limits));
  return `${lines.join("\n")}\n`;
}

function defaultFiles(env: NodeJS.ProcessEnv): string[] {
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "ghost", "handoffs.jsonl");
  return [`${base}.1`, base].filter((path) => existsSync(path));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let since: number | undefined;
  const at = args.indexOf("--since");
  if (at !== -1) {
    const value = args[at + 1];
    since = value === undefined ? Number.NaN : Date.parse(value);
    if (Number.isNaN(since)) {
      process.stderr.write(value === undefined ? "--since needs an ISO-8601 date\n" : `--since: not an ISO-8601 date: ${value}\n`);
      process.exit(2);
    }
    args.splice(at, 2);
  }
  const files = args.length > 0 ? args : defaultFiles(process.env);
  process.stdout.write(report(files.map((path) => readFileSync(path, "utf8")).join("\n"), { since }));
}
