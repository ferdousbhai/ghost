import { join } from "node:path";
import { readDaemonControlFile, writeDaemonControlFile } from "./control-file.js";
import type { ConversationRuntime } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import { serializeByKey } from "./promise-chain.js";
import { sessionFileNameFor } from "./session-files.js";

export const PRESENTATION_HISTORY_MAX_BYTES = 16 * 1_048_576;
export const PRESENTATION_HISTORY_MAX_TURNS = 1_000;
export const PRESENTATION_HISTORY_MAX_TEXT_CHARS = 32_000;

/** Which native revision a journalled turn came from, per runtime. */
export type SourceRevision =
  | { kind: "pi-leaf"; value: string }
  | { kind: "claude-owner-turn"; value: number };

/** The native conversation a journalled turn belongs to. */
export type SourceIdentity =
  | { runtime: "pi"; createdAt: string }
  | { runtime: "claude-code"; createdAt: string; resumeId: string };

/** One owner turn a runtime has finished and made durable in its own storage. */
export interface SettledTurn {
  source: SourceIdentity;
  sourceRevision: SourceRevision;
  /** 1-based position of this owner turn in its native conversation. */
  sourceOrdinal: number;
  ownerPrompt: string;
  assistantText: string;
  outcome: "completed" | "failed";
}

export interface PresentationTurn {
  sequence: number;
  sourceOrdinal: number;
  sourceRevision: SourceRevision;
  settledAt: string;
  ownerText: string;
  ownerTextTruncated: boolean;
  assistantText: string;
  assistantTextTruncated: boolean;
  outcome: "completed" | "failed";
}

/**
 * A conversation's durable presentation journal: one owner prompt and final
 * assistant text per settled native turn. Display state only — it never holds
 * runtime resume state, and losing it loses nothing but rendered history.
 * `historyPrefixOmitted` records that turns before `turns[0]` existed but were
 * never journalled (a pre-existing conversation, a failed write, or a
 * bounds-driven drop), so a reader can say so instead of presenting a partial
 * journal as the whole conversation.
 */
export interface PresentationHistoryV1 {
  version: 1;
  runtime: ConversationRuntime;
  conversationId: string;
  historyPrefixOmitted: boolean;
  lastSequence: number;
  droppedThroughSequence: number;
  lastSourceOrdinal: number | null;
  lastSourceRevision: SourceRevision | null;
  turns: PresentationTurn[];
}

export interface PresentationHistoryIdentity {
  runtime: ConversationRuntime;
  conversationId: string;
}

interface PresentationHistoryOptions {
  now?: () => Date;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeNonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validSourceRevision(value: unknown): value is SourceRevision {
  if (!object(value) || !exactKeys(value, ["kind", "value"])) return false;
  return value.kind === "pi-leaf"
    ? typeof value.value === "string" && value.value.length > 0 && value.value.length <= 4_096
    : value.kind === "claude-owner-turn" && Number.isSafeInteger(value.value) && (value.value as number) >= 1;
}

export function validRuntimeSourceRevision(
  runtime: ConversationRuntime,
  value: unknown,
): value is SourceRevision {
  return validSourceRevision(value)
    && (runtime === "pi" ? value.kind === "pi-leaf" : value.kind === "claude-owner-turn");
}

/** One string per revision identity, for equality and dedup across stores. */
export function sourceKey(source: SourceRevision): string {
  return `${source.kind}:${String(source.value)}`;
}

function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function invalidHistory(path: string): GhostError {
  return new GhostError(
    "presentation_history_invalid",
    `Conversation presentation history ${JSON.stringify(path)} is invalid.`,
    500,
  );
}

function validTurn(runtime: ConversationRuntime, value: unknown): value is PresentationTurn {
  return object(value)
    && exactKeys(value, [
      "sequence",
      "sourceOrdinal",
      "sourceRevision",
      "settledAt",
      "ownerText",
      "ownerTextTruncated",
      "assistantText",
      "assistantTextTruncated",
      "outcome",
    ])
    && positiveOrdinal(value.sequence)
    && positiveOrdinal(value.sourceOrdinal)
    && validRuntimeSourceRevision(runtime, value.sourceRevision)
    && (runtime !== "claude-code"
      || (value.sourceRevision.kind === "claude-owner-turn"
        && value.sourceRevision.value === value.sourceOrdinal))
    && iso(value.settledAt)
    && typeof value.ownerText === "string"
    && value.ownerText.length <= PRESENTATION_HISTORY_MAX_TEXT_CHARS
    && typeof value.ownerTextTruncated === "boolean"
    && typeof value.assistantText === "string"
    && value.assistantText.length <= PRESENTATION_HISTORY_MAX_TEXT_CHARS
    && typeof value.assistantTextTruncated === "boolean"
    && (value.outcome === "completed" || value.outcome === "failed");
}

/**
 * Re-derive every structural invariant from the stored bytes rather than
 * trusting them: identity, contiguous sequences, strictly increasing source
 * ordinals, unique source revisions, and an honest omitted-prefix marker.
 * Anything else is a hard failure, never a partially-believed journal.
 */
function parseHistory(
  path: string,
  identity: PresentationHistoryIdentity,
  value: unknown,
): PresentationHistoryV1 {
  if (!object(value) || !exactKeys(value, [
    "version",
    "runtime",
    "conversationId",
    "historyPrefixOmitted",
    "lastSequence",
    "droppedThroughSequence",
    "lastSourceOrdinal",
    "lastSourceRevision",
    "turns",
  ])) throw invalidHistory(path);
  if (value.version !== 1
    || value.runtime !== identity.runtime
    || value.conversationId !== identity.conversationId
    || typeof value.historyPrefixOmitted !== "boolean"
    || !safeNonnegative(value.lastSequence)
    || !safeNonnegative(value.droppedThroughSequence)
    || (value.lastSourceOrdinal !== null && !positiveOrdinal(value.lastSourceOrdinal))
    || (value.lastSourceRevision !== null
      && !validRuntimeSourceRevision(identity.runtime, value.lastSourceRevision))
    || !Array.isArray(value.turns)
    || value.turns.length > PRESENTATION_HISTORY_MAX_TURNS
    || !value.turns.every((turn) => validTurn(identity.runtime, turn))) {
    throw invalidHistory(path);
  }
  const turns = value.turns as PresentationTurn[];
  const lastSequence = value.lastSequence as number;
  const droppedThroughSequence = value.droppedThroughSequence as number;
  const hasOrdinalGap = turns.some((turn, index) => index === 0
    ? turn.sourceOrdinal > 1
    : turn.sourceOrdinal > (turns[index - 1]?.sourceOrdinal ?? 0) + 1);
  const sourceRevisions = new Set(turns.map((turn) => sourceKey(turn.sourceRevision)));
  if (droppedThroughSequence > lastSequence
    || lastSequence - droppedThroughSequence !== turns.length
    || turns.some((turn, index) => turn.sequence !== droppedThroughSequence + index + 1)
    || turns.some((turn, index) => index > 0
      && turn.sourceOrdinal <= (turns[index - 1]?.sourceOrdinal ?? 0))
    || sourceRevisions.size !== turns.length
    || ((droppedThroughSequence > 0 || hasOrdinalGap) && value.historyPrefixOmitted !== true)) {
    throw invalidHistory(path);
  }
  const latest = turns.at(-1);
  if (latest) {
    if (value.lastSourceOrdinal !== latest.sourceOrdinal
      || value.lastSourceRevision === null
      || sourceKey(value.lastSourceRevision) !== sourceKey(latest.sourceRevision)) {
      throw invalidHistory(path);
    }
  } else if (lastSequence !== 0
    || droppedThroughSequence !== 0
    || value.lastSourceOrdinal !== null
    || value.lastSourceRevision !== null) {
    throw invalidHistory(path);
  }
  return value as unknown as PresentationHistoryV1;
}

function truncateText(value: string): { text: string; truncated: boolean } {
  return value.length <= PRESENTATION_HISTORY_MAX_TEXT_CHARS
    ? { text: value, truncated: false }
    : { text: value.slice(0, PRESENTATION_HISTORY_MAX_TEXT_CHARS), truncated: true };
}

function serialized(state: PresentationHistoryV1): string {
  return `${JSON.stringify(state)}\n`;
}

function emptyHistory(identity: PresentationHistoryIdentity): PresentationHistoryV1 {
  return {
    version: 1,
    ...identity,
    historyPrefixOmitted: false,
    lastSequence: 0,
    droppedThroughSequence: 0,
    lastSourceOrdinal: null,
    lastSourceRevision: null,
    turns: [],
  };
}

export function presentationHistoryPath(
  sessionDir: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
  return join(sessionDir, `${stem}.${runtime}.presentation.json`);
}

export class PresentationHistoryStore {
  private readonly now: () => Date;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: PresentationHistoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async read(
    sessionDir: string,
    identity: PresentationHistoryIdentity,
  ): Promise<PresentationHistoryV1 | null> {
    const path = presentationHistoryPath(sessionDir, identity.runtime, identity.conversationId);
    return serializeByKey(this.queues, path, () => this.readStoredHistory(path, identity));
  }

  /**
   * Append one settled turn, idempotently by source ordinal. Recording an
   * already-journalled ordinal with the same revision is a no-op; a skipped
   * ordinal marks the prefix omitted so a missed write self-heals into an
   * honest gap instead of an undetectable hole.
   */
  async recordSettledTurn(
    sessionDir: string,
    identity: PresentationHistoryIdentity,
    turn: SettledTurn,
  ): Promise<PresentationHistoryV1> {
    const path = presentationHistoryPath(sessionDir, identity.runtime, identity.conversationId);
    return serializeByKey(this.queues, path, async () => {
      const stored = await this.readStoredHistory(path, identity);
      const state = stored ?? emptyHistory(identity);
      this.validateSettledTurn(path, identity, turn);
      if (state.lastSourceOrdinal !== null) {
        if (turn.sourceOrdinal < state.lastSourceOrdinal) throw invalidHistory(path);
        if (turn.sourceOrdinal === state.lastSourceOrdinal) {
          if (!state.lastSourceRevision
            || sourceKey(state.lastSourceRevision) !== sourceKey(turn.sourceRevision)) {
            throw invalidHistory(path);
          }
          return state;
        }
        if (turn.sourceOrdinal > state.lastSourceOrdinal + 1) {
          state.historyPrefixOmitted = true;
        }
      } else if (turn.sourceOrdinal > 1) {
        state.historyPrefixOmitted = true;
      }

      const owner = truncateText(turn.ownerPrompt);
      const assistant = truncateText(turn.assistantText);
      if (state.lastSequence >= Number.MAX_SAFE_INTEGER) throw invalidHistory(path);
      state.lastSequence += 1;
      state.lastSourceOrdinal = turn.sourceOrdinal;
      state.lastSourceRevision = turn.sourceRevision;
      state.turns.push({
        sequence: state.lastSequence,
        sourceOrdinal: turn.sourceOrdinal,
        sourceRevision: turn.sourceRevision,
        settledAt: this.now().toISOString(),
        ownerText: owner.text,
        ownerTextTruncated: owner.truncated,
        assistantText: assistant.text,
        assistantTextTruncated: assistant.truncated,
        outcome: turn.outcome,
      });
      let text = serialized(state);
      while (state.turns.length > PRESENTATION_HISTORY_MAX_TURNS
        || Buffer.byteLength(text, "utf8") > PRESENTATION_HISTORY_MAX_BYTES) {
        const dropped = state.turns.shift();
        if (!dropped) throw invalidHistory(path);
        state.droppedThroughSequence = dropped.sequence;
        state.historyPrefixOmitted = true;
        text = serialized(state);
      }
      await writeDaemonControlFile(path, text, PRESENTATION_HISTORY_MAX_BYTES);
      return state;
    });
  }

  private validateSettledTurn(
    path: string,
    identity: PresentationHistoryIdentity,
    turn: SettledTurn,
  ): void {
    if (!validRuntimeSourceRevision(identity.runtime, turn.sourceRevision)
      || !positiveOrdinal(turn.sourceOrdinal)
      || turn.source.runtime !== identity.runtime
      || (identity.runtime === "claude-code"
        && (turn.source.runtime !== "claude-code"
          || turn.source.resumeId.length === 0
          || turn.sourceRevision.kind !== "claude-owner-turn"
          || turn.sourceRevision.value !== turn.sourceOrdinal))
      || !iso(turn.source.createdAt)
      || typeof turn.ownerPrompt !== "string"
      || typeof turn.assistantText !== "string"
      || (turn.outcome !== "completed" && turn.outcome !== "failed")) {
      throw invalidHistory(path);
    }
  }

  private async readStoredHistory(
    path: string,
    identity: PresentationHistoryIdentity,
  ): Promise<PresentationHistoryV1 | null> {
    try {
      return parseHistory(
        path,
        identity,
        JSON.parse(await readDaemonControlFile(path, PRESENTATION_HISTORY_MAX_BYTES)) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof GhostError) throw error;
      throw invalidHistory(path);
    }
  }
}
