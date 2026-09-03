/**
 * Adapted from oh-my-pi's advisor delivery policy
 * (`src/advisor/advise-tool.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
  note: string;
  severity?: AdvisorSeverity;
  advisor?: string;
  /** Lint notes are deterministic findings, not model judgment. */
  authority?: "lint" | "advisor";
}

const ADVISOR_GUIDANCE = "weigh, don't blindly obey";
const LINT_GUIDANCE = "deterministic finding; fix or explicitly overrule";

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
  return notes
    .map((note) => {
      const severity = note.severity ? ` severity="${note.severity}"` : "";
      const who = note.advisor ? ` advisor="${escapeXmlAttribute(note.advisor)}"` : "";
      const authority = note.authority === "lint" ? ' authority="lint"' : "";
      const guidance = note.authority === "lint" ? LINT_GUIDANCE : ADVISOR_GUIDANCE;
      return `<advisory${who}${authority}${severity} guidance="${guidance}">\n${escapeXmlText(note.note)}\n</advisory>`;
    })
    .join("\n");
}

export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
  return severity === "concern" || severity === "blocker";
}

export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";

export function isAdvisorInterruptImmuneTurnActive(options: {
  completedTurns: number;
  immuneTurnStart: number | undefined;
  immuneTurns: number;
}): boolean {
  if (options.immuneTurnStart === undefined || options.immuneTurns <= 0) return false;
  return options.completedTurns < options.immuneTurnStart + options.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the primary
 *   is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` always rides the non-interrupting aside queue.
 * - An interrupting `concern`/`blocker` is normally steered into the agent: into
 *   the live turn while one is streaming, or (when idle) a triggered turn so the
 *   advice is acted on immediately.
 * - If the primary tail is already a terminal text answer and there is no queued
 *   work, a late `concern` is preserved as a visible card instead of waking the
 *   primary to restate completion. A `blocker` is the exception: it means the
 *   agent handed off broken or unexercised work, so it still steers a triggered
 *   turn to force the primary to acknowledge and continue before the turn is
 *   considered done (#5628) — deferring it to the next user turn is the bug.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor must
 *   not auto-resume the stopped run. While the agent is idle — or still tearing
 *   the interrupted turn down (`aborting`) — the note is preserved as a visible
 *   card instead of restarting the run. But once a turn is actively streaming
 *   again (a resume the user already drove), steering the note in does NOT
 *   auto-resume anything, so it is delivered live. Parking it during an active
 *   run instead strands it (it never reaches the running agent) and the withheld
 *   notes dump as one burst at the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window, further `concern` notes are
 *   downgraded to asides; preservation still wins. A `blocker` is exempt: it
 *   means the agent handed off broken or unexercised work, so it still steers a
 *   triggered turn even right after a prior interrupt (#5628).
 */
export function resolveAdvisorDeliveryChannel(options: {
  severity: AdvisorSeverity | undefined;
  autoResumeSuppressed: boolean;
  streaming: boolean;
  aborting: boolean;
  terminalAnswerNoQueuedWork?: boolean;
  interruptImmuneTurnActive?: boolean;
  preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
  if (options.preserveOnly && !options.streaming) return "preserve";
  if (!isInterruptingSeverity(options.severity)) return "aside";
  if (options.autoResumeSuppressed && (options.aborting || !options.streaming)) return "preserve";
  if (options.terminalAnswerNoQueuedWork
    && options.severity !== "blocker"
    && !options.streaming
    && !options.aborting) {
    return "preserve";
  }
  if (options.interruptImmuneTurnActive && options.severity !== "blocker") return "aside";
  return "steer";
}

export function advisorNoteDedupeKey(note: string): string {
  return note.trim().replace(/\s+/gu, " ");
}

const ADVISOR_SEVERITY_RANK: Readonly<Record<AdvisorSeverity, number>> = {
  nit: 1,
  concern: 2,
  blocker: 3,
};

export function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
  return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}
