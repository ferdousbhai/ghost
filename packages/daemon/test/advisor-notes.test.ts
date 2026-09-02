import { describe, expect, it } from "vitest";
import { AdvisorNoteLedger } from "../src/advisor-notes.js";
import type { AdvisorNote } from "../src/advisor-severity.js";

describe("AdvisorNoteLedger", () => {
  it("delivers only a strict severity escalation for the same note", () => {
    const delivered: AdvisorNote[] = [];
    const ledger = new AdvisorNoteLedger((note) => delivered.push(note));
    expect(ledger.add({ note: "Fix the race." })).toBe("delivered");
    expect(ledger.add({ note: " Fix  the race. ", severity: "nit" })).toBe("duplicate");
    expect(ledger.add({ note: "Fix the race.", severity: "concern" })).toBe("delivered");
    expect(ledger.add({ note: "Fix the race.", severity: "concern" })).toBe("duplicate");
    expect(ledger.add({ note: "Fix the race.", severity: "blocker" })).toBe("delivered");
    expect(delivered.map((note) => note.severity)).toEqual([undefined, "concern", "blocker"]);
  });

  it("withholds non-blockers mid-turn and flushes oldest first", () => {
    const delivered: AdvisorNote[] = [];
    const ledger = new AdvisorNoteLedger((note) => delivered.push(note));
    ledger.beginUpdate(true);
    expect(ledger.add({ note: "First", severity: "nit" })).toBe("deferred");
    expect(ledger.add({ note: "Second", severity: "concern" })).toBe("deferred");
    expect(delivered).toEqual([]);
    ledger.beginUpdate(false);
    expect(delivered.map((note) => note.note)).toEqual(["First", "Second"]);
  });

  it("delivers blockers immediately and keeps the highest deferred severity", () => {
    const delivered: AdvisorNote[] = [];
    const ledger = new AdvisorNoteLedger((note) => delivered.push(note));
    ledger.beginUpdate(true);
    ledger.add({ note: "Same issue" });
    ledger.add({ note: "Same issue", severity: "concern" });
    ledger.add({ note: "Immediate", severity: "blocker" });
    expect(delivered.map((note) => note.note)).toEqual(["Immediate"]);
    ledger.beginUpdate(false);
    expect(delivered[1]).toEqual({ note: "Same issue", severity: "concern" });
  });
});
