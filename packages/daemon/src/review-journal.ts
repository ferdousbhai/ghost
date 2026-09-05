import { join } from "node:path";
import { redactMemorySecrets } from "@ghost/extensions";
import type { AdvisorNote, AdvisorSeverity } from "./advisor-severity.js";
import type { AdvisorTurnDelta } from "./advisor-transcript.js";
import { readDaemonControlFile, writeDaemonControlFile } from "./control-file.js";
import type { ConversationRuntime } from "./conversation-identity.js";
import type { LintFinding } from "./lint.js";
import { silentLogger, type Logger } from "./log.js";
import { serializeByKey } from "./promise-chain.js";
import { sessionFileNameFor } from "./session-files.js";

export const REVIEW_JOURNAL_VERSION = "review-journal/v1";
export const REVIEW_JOURNAL_MAX_BYTES = 16 * 1_048_576;
export const REVIEW_JOURNAL_MAX_ENTRIES = 1_000;
export const REVIEW_JOURNAL_MAX_TEXT_CHARS = 32_000;

/** Where the reviewed turn's notes went, `none` when the turn was clean. */
export type ReviewJournalDelivery = "continuation" | "next-turn" | "none";

export interface ReviewJournalLintFinding {
  ruleId: string;
  severity: LintFinding["severity"];
  message: string;
}

export interface ReviewJournalEntry {
  sequence: number;
  turnId: number;
  recordedAt: string;
  mode: "lint" | "advisory" | "strict";
  delta: Pick<
    AdvisorTurnDelta,
    "text" | "commands" | "paths" | "source" | "delegations" | "ownerRecordId"
  >;
  lint: ReviewJournalLintFinding[];
  notes: AdvisorNote[];
  severity?: AdvisorSeverity;
  delivered: ReviewJournalDelivery;
  /** True when this turn is the rewrite a strict continuation asked for. */
  continuationPass: boolean;
  /** Some text field hit `REVIEW_JOURNAL_MAX_TEXT_CHARS` and was cut. */
  truncated: boolean;
  /** The rewrite this turn's critique produced, once it arrives. */
  continuation?: { turnId: number; text: string };
}

/** One reviewed turn as the caller has it, before redaction and numbering. */
export type NewReviewJournalEntry = Omit<
  ReviewJournalEntry,
  "sequence" | "recordedAt" | "truncated" | "continuation"
>;

/**
 * A conversation's review journal: one entry per reviewed turn, holding the
 * turn delta, the lint findings and advisor notes it drew, and where they were
 * delivered. Training data for a per-ghost adapter and nothing else — it is
 * never read back as runtime state, so losing it loses only samples.
 */
export interface ReviewJournalV1 {
  version: typeof REVIEW_JOURNAL_VERSION;
  runtime: ConversationRuntime;
  conversationId: string;
  lastSequence: number;
  droppedThroughSequence: number;
  entries: ReviewJournalEntry[];
}

export interface ReviewJournalIdentity {
  runtime: ConversationRuntime;
  conversationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEntry(value: unknown): value is ReviewJournalEntry {
  return isRecord(value)
    && Number.isSafeInteger(value.sequence)
    && Number.isSafeInteger(value.turnId)
    && typeof value.recordedAt === "string"
    && isRecord(value.delta)
    && Array.isArray(value.lint)
    && Array.isArray(value.notes)
    && (value.delivered === "continuation"
      || value.delivered === "next-turn"
      || value.delivered === "none");
}

/**
 * A journal read back off disk, identity taken from the file itself. The
 * exporter walks `sessions/` without knowing which conversations it will find,
 * so it needs the shape check without the identity check.
 */
export function parseReviewJournal(value: unknown): ReviewJournalV1 | null {
  return isRecord(value)
      && value.version === REVIEW_JOURNAL_VERSION
      && (value.runtime === "pi" || value.runtime === "claude-code")
      && typeof value.conversationId === "string"
      && value.conversationId !== ""
      && Number.isSafeInteger(value.lastSequence)
      && Number.isSafeInteger(value.droppedThroughSequence)
      && Array.isArray(value.entries)
      && value.entries.length <= REVIEW_JOURNAL_MAX_ENTRIES
      && value.entries.every(validEntry)
    ? value as unknown as ReviewJournalV1
    : null;
}

function parseJournal(identity: ReviewJournalIdentity, value: unknown): ReviewJournalV1 | null {
  const journal = parseReviewJournal(value);
  return journal
      && journal.runtime === identity.runtime
      && journal.conversationId === identity.conversationId
    ? journal
    : null;
}

function parsedJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Redacts credentials and caps every text field that reaches the journal. */
class JournalText {
  truncated = false;

  clean(value: string): string {
    const redacted = redactMemorySecrets(value);
    if (redacted.length <= REVIEW_JOURNAL_MAX_TEXT_CHARS) return redacted;
    this.truncated = true;
    return redacted.slice(0, REVIEW_JOURNAL_MAX_TEXT_CHARS);
  }

  cleanAll(values: readonly string[]): string[] {
    return values.map((value) => this.clean(value));
  }
}

function emptyJournal(identity: ReviewJournalIdentity): ReviewJournalV1 {
  return {
    version: REVIEW_JOURNAL_VERSION,
    ...identity,
    lastSequence: 0,
    droppedThroughSequence: 0,
    entries: [],
  };
}

/** What marks a file in `sessions/` as a review journal, for readers that scan. */
export const REVIEW_JOURNAL_SUFFIX = ".review-journal.json";

export function reviewJournalPath(
  sessionDir: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
  return join(sessionDir, `${stem}.${runtime}${REVIEW_JOURNAL_SUFFIX}`);
}

export class ReviewJournalStore {
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: { now?: () => Date; logger?: Logger } = {}) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  async read(
    sessionDir: string,
    identity: ReviewJournalIdentity,
  ): Promise<ReviewJournalV1 | null> {
    const path = reviewJournalPath(sessionDir, identity.runtime, identity.conversationId);
    return serializeByKey(this.queues, path, () => this.load(path, identity));
  }

  /**
   * Append one reviewed turn, dropping the oldest entries once the journal
   * reaches its bounds. A continuation pass also attaches its rewritten turn to
   * the entry that asked for it, so the (attempt, critique, rewrite) triple is
   * reconstructable without a second review.
   */
  async record(
    sessionDir: string,
    identity: ReviewJournalIdentity,
    entry: NewReviewJournalEntry,
  ): Promise<void> {
    const path = reviewJournalPath(sessionDir, identity.runtime, identity.conversationId);
    await serializeByKey(this.queues, path, async () => {
      const state = await this.load(path, identity) ?? emptyJournal(identity);
      const text = new JournalText();
      const delta = {
        text: text.clean(entry.delta.text),
        commands: text.cleanAll(entry.delta.commands),
        paths: text.cleanAll(entry.delta.paths),
        source: entry.delta.source,
        delegations: entry.delta.delegations,
        // An opaque transcript id, not owner text: carried verbatim so a later
        // reader can find this exact turn again.
        ...(entry.delta.ownerRecordId === undefined
          ? {}
          : { ownerRecordId: entry.delta.ownerRecordId }),
      };
      const lint = entry.lint.map((finding) => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        message: text.clean(finding.message),
      }));
      const notes = entry.notes.map((note) => ({ ...note, note: text.clean(note.note) }));
      const recorded: ReviewJournalEntry = {
        sequence: state.lastSequence + 1,
        turnId: entry.turnId,
        recordedAt: this.now().toISOString(),
        mode: entry.mode,
        delta,
        lint,
        notes,
        ...(entry.severity ? { severity: entry.severity } : {}),
        delivered: entry.delivered,
        continuationPass: entry.continuationPass,
        truncated: text.truncated,
      };
      const previous = state.entries.at(-1);
      if (entry.continuationPass && previous) {
        previous.continuation = { turnId: recorded.turnId, text: recorded.delta.text };
      }
      state.lastSequence = recorded.sequence;
      state.entries.push(recorded);
      let serialized = `${JSON.stringify(state)}\n`;
      while (state.entries.length > REVIEW_JOURNAL_MAX_ENTRIES
        || (state.entries.length > 1
          && Buffer.byteLength(serialized, "utf8") > REVIEW_JOURNAL_MAX_BYTES)) {
        const dropped = state.entries.shift();
        if (!dropped) break;
        state.droppedThroughSequence = dropped.sequence;
        serialized = `${JSON.stringify(state)}\n`;
      }
      await writeDaemonControlFile(path, serialized, REVIEW_JOURNAL_MAX_BYTES);
    });
  }

  /** A missing journal reads as none; an unusable one is logged and replaced. */
  private async load(
    path: string,
    identity: ReviewJournalIdentity,
  ): Promise<ReviewJournalV1 | null> {
    let raw: string;
    try {
      raw = await readDaemonControlFile(path, REVIEW_JOURNAL_MAX_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("review journal was unreadable and starts fresh");
      }
      return null;
    }
    const journal = parseJournal(identity, parsedJson(raw));
    if (journal) return journal;
    this.logger.warn("review journal was invalid and starts fresh");
    return null;
  }
}
