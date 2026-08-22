/**
 * Background-compaction policy and firing, against a fake session. No real
 * model is ever called: the fake stands in for pi's AgentSession surface
 * (`isCompacting`, `getContextUsage()`, `compact()`), so the threshold math,
 * the guard, the non-blocking firing, and the error handling are all exercised
 * without a provider round-trip.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_TOKEN_CAP,
  GHOST_COMPACTION_PROMPT,
  compactionThreshold,
  maybeCompact,
  shouldCompactNow,
  type CompactableSession,
  type CompactionConfig,
  type ContextUsageLike,
} from "../src/compaction.js";

const ENABLED: CompactionConfig = { enabled: true };

class FakeSession implements CompactableSession {
  isCompacting = false;
  usage: ContextUsageLike | undefined;
  readonly instructions: (string | undefined)[] = [];
  private settle?: { resolve: () => void; reject: (error: Error) => void };

  constructor(usage?: ContextUsageLike) {
    this.usage = usage;
  }

  getContextUsage(): ContextUsageLike | undefined {
    return this.usage;
  }

  compact(customInstructions?: string): Promise<unknown> {
    this.instructions.push(customInstructions);
    return new Promise((resolve, reject) => {
      this.settle = { resolve: () => resolve(undefined), reject };
    });
  }

  /** Complete the in-flight compact() call. */
  finish(): void {
    this.settle?.resolve();
  }

  /** Fail the in-flight compact() call. */
  fail(error: Error): void {
    this.settle?.reject(error);
  }
}

describe("compactionThreshold", () => {
  it("is min(0.8 × window, 100k) by default", () => {
    expect(compactionThreshold(60_000, ENABLED)).toBe(48_000); // 0.8 × 60k
    expect(compactionThreshold(200_000, ENABLED)).toBe(CONTEXT_TOKEN_CAP); // capped
  });

  it("honours an explicit thresholdTokens override", () => {
    expect(compactionThreshold(200_000, { enabled: true, thresholdTokens: 1_000 })).toBe(1_000);
  });

  it("honours a thresholdFraction override", () => {
    expect(compactionThreshold(50_000, { enabled: true, thresholdFraction: 0.5 })).toBe(25_000);
  });

  it("falls back to a 128k window when the model reports none", () => {
    expect(compactionThreshold(0, { enabled: true })).toBe(CONTEXT_TOKEN_CAP); // 0.8 × 128k capped to 100k
    expect(compactionThreshold(0, { enabled: true, thresholdFraction: 0.5 })).toBe(64_000);
  });
});

describe("shouldCompactNow", () => {
  it("fires at the threshold and not before", () => {
    const window = 100_000; // threshold = 80_000
    expect(shouldCompactNow({ tokens: 79_999, contextWindow: window }, ENABLED)).toBe(false);
    expect(shouldCompactNow({ tokens: 80_000, contextWindow: window }, ENABLED)).toBe(true);
    expect(shouldCompactNow({ tokens: 90_000, contextWindow: window }, ENABLED)).toBe(true);
  });

  it("never fires when disabled", () => {
    expect(shouldCompactNow({ tokens: 999_999, contextWindow: 100_000 }, { enabled: false })).toBe(false);
  });

  it("cannot decide with unknown tokens (null right after a compaction)", () => {
    expect(shouldCompactNow({ tokens: null, contextWindow: 100_000 }, ENABLED)).toBe(false);
    expect(shouldCompactNow(undefined, ENABLED)).toBe(false);
  });
});

describe("maybeCompact", () => {
  it("fires over threshold, passing our Anthropic-modeled prompt, without awaiting", async () => {
    const session = new FakeSession({ tokens: 90_000, contextWindow: 100_000 });
    const onError = vi.fn();
    const onStart = vi.fn();

    const promise = maybeCompact(session, ENABLED, { onError, onStart });

    // Fired synchronously with our prompt; the returned promise is still pending
    // (compact() has not settled), proving the call did not block on it.
    expect(promise).toBeInstanceOf(Promise);
    expect(session.instructions).toEqual([GHOST_COMPACTION_PROMPT]);
    expect(onStart).toHaveBeenCalledWith({ tokens: 90_000, contextWindow: 100_000, threshold: 80_000 });

    let settled = false;
    void promise!.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // concurrent work is not blocked by compaction

    session.finish();
    await promise;
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not fire below threshold", () => {
    const session = new FakeSession({ tokens: 10_000, contextWindow: 100_000 });
    const promise = maybeCompact(session, ENABLED, { onError: vi.fn() });
    expect(promise).toBeUndefined();
    expect(session.instructions).toEqual([]);
  });

  it("guards against a double run while one is already in progress", () => {
    const session = new FakeSession({ tokens: 90_000, contextWindow: 100_000 });
    session.isCompacting = true;
    const promise = maybeCompact(session, ENABLED, { onError: vi.fn() });
    expect(promise).toBeUndefined();
    expect(session.instructions).toEqual([]);
  });

  it("logs a compaction failure instead of throwing", async () => {
    const session = new FakeSession({ tokens: 90_000, contextWindow: 100_000 });
    const onError = vi.fn();
    const promise = maybeCompact(session, ENABLED, { onError });
    expect(promise).toBeInstanceOf(Promise);

    session.fail(new Error("summarizer exploded"));
    await expect(promise).resolves.toBeUndefined(); // never rejects into the caller
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("summarizer exploded");
  });

  it("does nothing when compaction is disabled", () => {
    const session = new FakeSession({ tokens: 999_999, contextWindow: 100_000 });
    const promise = maybeCompact(session, { enabled: false }, { onError: vi.fn() });
    expect(promise).toBeUndefined();
    expect(session.instructions).toEqual([]);
  });
});
