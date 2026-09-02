import { describe, expect, it } from "vitest";
import {
  AdvisorEmissionGuard,
  normalizeAdvisorNote,
} from "../src/advisor-emission-guard.js";

describe("AdvisorEmissionGuard", () => {
  it("folds punctuation, markup, whitespace, and case", () => {
    expect(["Stop.", "*Stop*", "  stop  "].map(normalizeAdvisorNote)).toEqual([
      "stop",
      "stop",
      "stop",
    ]);
  });

  it("suppresses content-free phrases without burning the update budget", () => {
    const guard = new AdvisorEmissionGuard();
    guard.beginUpdate();
    expect(guard.accept("Stop.")).toBe(false);
    expect(guard.accept("Missing await can drop buffered writes.")).toBe(true);
    expect(guard.accept("A second concrete issue.")).toBe(false);
  });

  it("deduplicates across updates", () => {
    const guard = new AdvisorEmissionGuard();
    expect(guard.accept("Exercise the failure path.")).toBe(true);
    guard.beginUpdate();
    expect(guard.accept("Exercise the failure path!")).toBe(false);
  });

  it("evicts history in FIFO order", () => {
    const guard = new AdvisorEmissionGuard({ capacity: 2 });
    expect(guard.accept("First concrete issue")).toBe(true);
    guard.beginUpdate();
    expect(guard.accept("Second concrete issue")).toBe(true);
    guard.beginUpdate();
    expect(guard.accept("Third concrete issue")).toBe(true);
    guard.beginUpdate();
    expect(guard.accept("First concrete issue")).toBe(true);
    guard.beginUpdate();
    expect(guard.accept("Second concrete issue")).toBe(true);
  });

  it("reset clears both history and the current update budget", () => {
    const guard = new AdvisorEmissionGuard();
    expect(guard.accept("Concrete issue")).toBe(true);
    guard.reset();
    expect(guard.accept("Concrete issue")).toBe(true);
  });
});
