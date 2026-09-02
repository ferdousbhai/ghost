/**
 * Adapted from oh-my-pi's AdviseTool note ledger
 * (`src/advisor/advise-tool.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

import {
  advisorNoteDedupeKey,
  advisorSeverityRank,
  type AdvisorNote,
} from "./advisor-severity.js";

export type AdvisorNoteDisposition = "delivered" | "deferred" | "duplicate";

export class AdvisorNoteLedger {
  #deliveredNoteSeverities = new Map<string, number>();
  #inProgressUpdate = false;
  #deferredNotes: Array<{ key: string; note: AdvisorNote }> = [];

  constructor(private readonly onAdvice: (note: AdvisorNote) => void) {}

  beginUpdate(inProgress: boolean): void {
    const wasInProgress = this.#inProgressUpdate;
    this.#inProgressUpdate = inProgress;
    if (wasInProgress && !inProgress && this.#deferredNotes.length > 0) {
      const pending = this.#deferredNotes;
      this.#deferredNotes = [];
      for (const { note } of pending) this.#deliver(note);
    }
  }

  reset(): void {
    this.#deliveredNoteSeverities.clear();
    this.#inProgressUpdate = false;
    this.#deferredNotes = [];
  }

  add(note: AdvisorNote): AdvisorNoteDisposition {
    if (this.#inProgressUpdate && note.severity !== "blocker") {
      const key = advisorNoteDedupeKey(note.note);
      const pending = this.#deferredNotes.find((item) => item.key === key);
      if (!pending) {
        this.#deferredNotes.push({ key, note: { ...note } });
      } else if (advisorSeverityRank(note.severity) > advisorSeverityRank(pending.note.severity)) {
        pending.note = { ...note };
      }
      return "deferred";
    }
    return this.#deliver(note) ? "delivered" : "duplicate";
  }

  #deliver(note: AdvisorNote): boolean {
    const key = advisorNoteDedupeKey(note.note);
    const rank = advisorSeverityRank(note.severity);
    const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
    if (rank <= previousRank) return false;
    this.#deliveredNoteSeverities.set(key, rank);
    this.onAdvice(note);
    return true;
  }
}
