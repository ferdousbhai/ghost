import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { report } from "./handoff-report.ts";

test("reports the fixture log deterministically", () => {
  const text = readFileSync(join(import.meta.dir, "fixtures", "handoffs.jsonl"), "utf8");
  expect(report(text)).toBe(`8 handoffs, 2026-09-27T14:00:00.000Z to 2026-09-27T17:20:00.000Z (1 malformed skipped)

harness  attempts  owner picks  refused  ok  failed  unmeasured  median run
claude   4         1            2        1   1       0           0.4s
codex    2         0            1        0   1       0           25.6s
omp      1         0            1        0   0       0           -
pi       1         0            0        0   1       1           1.2s

Refusals:
  2  claude: Session (5-hour) full
  1  codex: Weekly (7-day) ahead of pace
  1  omp: not installed

Limits hit:
  1  codex: usage_limit
`);
});

test("a since cutoff leaves out earlier receipts and keeps one exactly at it", () => {
  const text = readFileSync(join(import.meta.dir, "fixtures", "handoffs.jsonl"), "utf8");
  expect(report(text, { since: Date.parse("2026-09-27T16:30:00.000Z") })).toBe(`4 handoffs, 2026-09-27T16:30:00.000Z to 2026-09-27T17:20:00.000Z (1 malformed skipped)

harness  attempts  owner picks  refused  ok  failed  unmeasured  median run
claude   1         0            1        0   0       0           -
codex    1         0            1        0   0       0           -
omp      1         0            1        0   0       0           -
pi       1         0            0        0   1       1           1.2s

Refusals:
  1  claude: Session (5-hour) full
  1  codex: Weekly (7-day) ahead of pace
  1  omp: not installed
`);
});

test("a cutoff after every receipt reports nothing but still counts malformed lines", () => {
  const text = readFileSync(join(import.meta.dir, "fixtures", "handoffs.jsonl"), "utf8");
  expect(report(text, { since: Date.parse("2026-09-28") })).toBe("No handoff receipts (1 malformed).\n");
});

test("says so when there is nothing to report", () => {
  expect(report("")).toBe("No handoff receipts.\n");
});
