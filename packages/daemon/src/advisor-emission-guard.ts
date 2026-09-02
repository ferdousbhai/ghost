/**
 * Adapted from oh-my-pi's advisor emission guard
 * (`src/advisor/emission-guard.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

/**
 * Per-session policy gate for advisor notes.
 *
 * The advisor system prompt tells the watcher model to emit at most one note
 * per update and never repeat advice. Real advisor models violate this. Issue
 * #3520 captured a session with 309 calls covering 92 unique notes — 114×
 * `Stop.`, 52× `No issue; continue.`, and 41× `Done.` — flooding the primary
 * transcript after the task was complete. The fix is to make the rules
 * load-bearing in code instead of prose: silently drop duplicates,
 * content-free self-talk, and over-budget notes at the delivery boundary.
 *
 * The gate is intentionally invisible to the advisor model. Surfacing
 * "suppressed" risks the model rephrasing the same useless note to bypass the
 * dedupe ("Stop.", then "Halt.", then "Stop now.").
 */

export function normalizeAdvisorNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Normalized phrases that carry no concrete actionable content. The list is
 * conservative: a real blocker such as "Stop: await is missing" does not match.
 */
export const SUPPRESSED_NORMALIZED_PHRASES: Readonly<Record<string, true>> = {
  // Self-stop noise — telling the agent to stop without a reason is useless.
  stop: true,
  "stop here": true,
  "stop now": true,
  halt: true,
  abort: true,
  // Completion self-talk — the agent already finished the task.
  done: true,
  "task done": true,
  "task complete": true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  "ok done": true,
  // "Nothing to flag" — silence is the correct expression of no concerns.
  "no issue": true,
  "no issues": true,
  "no issue continue": true,
  "no concerns": true,
  "no concern": true,
  "nothing to add": true,
  "nothing to flag": true,
  "nothing to report": true,
  "no notes": true,
  "no further input": true,
  "no further input needed": true,
  "no further input required": true,
  "no further watcher input": true,
  "no further watcher input needed": true,
  "no further advice": true,
  "no further advice needed": true,
  // Endorsements — equivalent to silence.
  lgtm: true,
  "looks good": true,
  "all good": true,
  "agent is on track": true,
  "agent on track": true,
  "on track": true,
  continue: true,
  "carry on": true,
};

/**
 * The pathological #3520 session had 92 unique notes. 4096 leaves headroom
 * while bounding the session history to a small amount of memory.
 */
const DEFAULT_HISTORY_CAPACITY = 4096;

/**
 * Enforces, in order, the noise filter, normalized session-scoped FIFO dedupe,
 * and one accepted note per advisor model update. Suppressed calls never
 * consume the update budget, so noise cannot burn the slot for a real concern.
 */
export class AdvisorEmissionGuard {
  readonly #capacity: number;
  #seen = new Set<string>();
  #seenOrder: string[] = [];
  #consumedThisUpdate = false;

  constructor(options: { capacity?: number } = {}) {
    this.#capacity = options.capacity ?? DEFAULT_HISTORY_CAPACITY;
  }

  /** Drop dedupe and rate-limit state at a conversation boundary. */
  reset(): void {
    this.#seen.clear();
    this.#seenOrder.length = 0;
    this.#consumedThisUpdate = false;
  }

  /** Start one advisor model update with a fresh one-note budget. */
  beginUpdate(): void {
    this.#consumedThisUpdate = false;
  }

  /**
   * Whether this note may reach the primary. A true result has already consumed
   * the update budget and entered the FIFO history. Empty notes are suppressed.
   */
  accept(note: string): boolean {
    const key = normalizeAdvisorNote(note);
    if (!key) return false;
    if (SUPPRESSED_NORMALIZED_PHRASES[key]) return false;
    if (this.#seen.has(key)) return false;
    if (this.#consumedThisUpdate) return false;
    this.#consumedThisUpdate = true;
    this.#seen.add(key);
    this.#seenOrder.push(key);
    if (this.#seenOrder.length > this.#capacity) {
      const stale = this.#seenOrder.shift();
      if (stale !== undefined) this.#seen.delete(stale);
    }
    return true;
  }
}
