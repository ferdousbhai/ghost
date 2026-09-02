/**
 * Adapted from oh-my-pi's advisor emission guard
 * (`src/advisor/emission-guard.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

/**
 * Issue #3520 recorded 309 advisor calls for 92 unique notes. This gate makes
 * dedupe, useful-content filtering, and the one-note update budget load-bearing
 * in code instead of trusting the model to follow the prompt.
 */

export function normalizeAdvisorNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const SUPPRESSED_NORMALIZED_PHRASES: Readonly<Record<string, true>> = {
  stop: true,
  "stop here": true,
  "stop now": true,
  halt: true,
  abort: true,
  done: true,
  "task done": true,
  "task complete": true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  "ok done": true,
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
  lgtm: true,
  "looks good": true,
  "all good": true,
  "agent is on track": true,
  "agent on track": true,
  "on track": true,
  continue: true,
  "carry on": true,
};

const DEFAULT_HISTORY_CAPACITY = 4096;

export class AdvisorEmissionGuard {
  readonly #capacity: number;
  #seen = new Set<string>();
  #seenOrder: string[] = [];
  #consumedThisUpdate = false;

  constructor(options: { capacity?: number } = {}) {
    this.#capacity = options.capacity ?? DEFAULT_HISTORY_CAPACITY;
  }

  reset(): void {
    this.#seen.clear();
    this.#seenOrder.length = 0;
    this.#consumedThisUpdate = false;
  }

  beginUpdate(): void {
    this.#consumedThisUpdate = false;
  }

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
