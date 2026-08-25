import { describe, expect, it } from "vitest";
import {
  GHOST_COMPACTION_PROMPT,
  nativeCompactionSettings,
} from "../src/compaction.js";

describe("nativeCompactionSettings", () => {
  it("enables OMP asynchronous compaction at 80% by default", () => {
    expect(nativeCompactionSettings({ enabled: true })).toEqual({
      "compaction.enabled": true,
      "compaction.asyncEnabled": true,
      "compaction.thresholdTokens": -1,
      "compaction.thresholdPercent": 80,
    });
  });

  it("projects the owner-facing fraction onto OMP's percentage", () => {
    expect(nativeCompactionSettings({ enabled: true, thresholdFraction: 0.625 })).toEqual({
      "compaction.enabled": true,
      "compaction.asyncEnabled": true,
      "compaction.thresholdTokens": -1,
      "compaction.thresholdPercent": 62.5,
    });
  });

  it("gives the owner-facing fixed threshold precedence", () => {
    expect(nativeCompactionSettings({
      enabled: true,
      thresholdTokens: 50_000,
      thresholdFraction: 0.5,
    })).toEqual({
      "compaction.enabled": true,
      "compaction.asyncEnabled": true,
      "compaction.thresholdTokens": 50_000,
      "compaction.thresholdPercent": 50,
    });
  });

  it("projects the master switch without dropping the native threshold policy", () => {
    expect(nativeCompactionSettings({ enabled: false })).toEqual({
      "compaction.enabled": false,
      "compaction.asyncEnabled": true,
      "compaction.thresholdTokens": -1,
      "compaction.thresholdPercent": 80,
    });
  });
});

describe("GHOST_COMPACTION_PROMPT", () => {
  it("is a summary hand-off rather than a continuation instruction", () => {
    expect(GHOST_COMPACTION_PROMPT).toContain("only produce the briefing");
    expect(GHOST_COMPACTION_PROMPT).toContain("Open threads and next steps");
  });
});
