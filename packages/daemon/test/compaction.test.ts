import { describe, expect, it } from "vitest";
import {
  GHOST_COMPACTION_PROMPT,
  nativeCompactionSettings,
} from "../src/compaction.js";

describe("nativeCompactionSettings", () => {
  it("reserves the last 20% of the model's window by default", () => {
    expect(nativeCompactionSettings({ enabled: true }, 100_000)).toEqual({
      enabled: true,
      reserveTokens: 20_000,
    });
  });

  it("projects the owner-facing fraction onto pi's reserve", () => {
    expect(nativeCompactionSettings({ enabled: true, thresholdFraction: 0.625 }, 80_000)).toEqual({
      enabled: true,
      reserveTokens: 30_000,
    });
  });

  it("gives the owner-facing fixed threshold precedence", () => {
    expect(nativeCompactionSettings({
      enabled: true,
      thresholdTokens: 50_000,
      thresholdFraction: 0.5,
    }, 200_000)).toEqual({ enabled: true, reserveTokens: 150_000 });
  });

  it("keeps only the master switch when the window is unknown or compaction is off", () => {
    expect(nativeCompactionSettings({ enabled: true }, undefined)).toEqual({ enabled: true });
    expect(nativeCompactionSettings({ enabled: false }, 100_000)).toEqual({ enabled: false });
  });
});

describe("GHOST_COMPACTION_PROMPT", () => {
  it("is a summary hand-off rather than a continuation instruction", () => {
    expect(GHOST_COMPACTION_PROMPT).toContain("only produce the briefing");
    expect(GHOST_COMPACTION_PROMPT).toContain("Open threads and next steps");
  });
});
