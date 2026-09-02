import { describe, expect, it } from "vitest";
import {
  advisorNoteDedupeKey,
  advisorSeverityRank,
  formatAdvisorBatchContent,
  isAdvisorInterruptImmuneTurnActive,
  resolveAdvisorDeliveryChannel,
  type AdvisorSeverity,
} from "../src/advisor-severity.js";

describe("advisor severity policy", () => {
  it("renders byte-stable escaped advisory blocks with behavioral guidance", () => {
    expect(formatAdvisorBatchContent([
      { note: "Use <safe> & tested output.", severity: "blocker", advisor: 'red & "blue"' },
      { note: "Name the assertion." },
    ])).toBe([
      '<advisory advisor="red &amp; &quot;blue&quot;" severity="blocker" guidance="weigh, don\'t blindly obey">',
      "Use &lt;safe&gt; &amp; tested output.",
      "</advisory>",
      '<advisory guidance="weigh, don\'t blindly obey">',
      "Name the assertion.",
      "</advisory>",
    ].join("\n"));
  });

  const cases: Array<{
    name: string;
    severity?: AdvisorSeverity;
    input?: Partial<Parameters<typeof resolveAdvisorDeliveryChannel>[0]>;
    expected: "aside" | "steer" | "preserve";
  }> = [
    { name: "nit rides the aside queue", severity: "nit", expected: "aside" },
    { name: "an omitted severity is a nit", expected: "aside" },
    { name: "a concern interrupts a live turn", severity: "concern", input: { streaming: true }, expected: "steer" },
    { name: "an idle concern normally triggers a turn", severity: "concern", expected: "steer" },
    { name: "a terminal late concern is preserved", severity: "concern", input: { terminalAnswerNoQueuedWork: true }, expected: "preserve" },
    { name: "a terminal late blocker still steers per #5628", severity: "blocker", input: { terminalAnswerNoQueuedWork: true }, expected: "steer" },
    { name: "a user-stopped idle run is not resumed", severity: "concern", input: { autoResumeSuppressed: true }, expected: "preserve" },
    { name: "a run still aborting is not resumed", severity: "blocker", input: { autoResumeSuppressed: true, aborting: true }, expected: "preserve" },
    { name: "a user-resumed streaming run accepts steering", severity: "concern", input: { autoResumeSuppressed: true, streaming: true }, expected: "steer" },
    { name: "an immune concern is downgraded", severity: "concern", input: { interruptImmuneTurnActive: true }, expected: "aside" },
    { name: "an immune blocker remains interrupting", severity: "blocker", input: { interruptImmuneTurnActive: true }, expected: "steer" },
    { name: "preserve-only wins while idle", severity: "blocker", input: { preserveOnly: true }, expected: "preserve" },
    { name: "preserve-only does not strand a streaming run", severity: "blocker", input: { preserveOnly: true, streaming: true }, expected: "steer" },
  ];

  for (const row of cases) {
    it(row.name, () => {
      expect(resolveAdvisorDeliveryChannel({
        severity: row.severity,
        autoResumeSuppressed: false,
        streaming: false,
        aborting: false,
        ...row.input,
      })).toBe(row.expected);
    });
  }

  it("uses a half-open turn-count immunity fence", () => {
    expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 4, immuneTurnStart: 4, immuneTurns: 3 })).toBe(true);
    expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 6, immuneTurnStart: 4, immuneTurns: 3 })).toBe(true);
    expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 7, immuneTurnStart: 4, immuneTurns: 3 })).toBe(false);
    expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 4, immuneTurnStart: undefined, immuneTurns: 3 })).toBe(false);
  });

  it("normalizes dedupe whitespace and ranks omitted severity as nit", () => {
    expect(advisorNoteDedupeKey("  fix\n this  ")).toBe("fix this");
    expect([undefined, "nit", "concern", "blocker"].map((severity) =>
      advisorSeverityRank(severity as AdvisorSeverity | undefined)
    )).toEqual([1, 1, 2, 3]);
  });
});
