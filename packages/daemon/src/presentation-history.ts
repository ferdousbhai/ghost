import { join } from "node:path";
import { readDaemonControlFile, writeDaemonControlFile } from "./control-file.js";
import type { ConversationRuntime } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import { sessionFileNameFor } from "./session-files.js";
import {
  sameSourceRevision,
  sourceRevisionMatchesRuntime,
  type ConversationSourceRevision,
  type SettledConversationTurn,
} from "./settled-conversation-turn.js";

export const PRESENTATION_HISTORY_MAX_BYTES = 16 * 1_048_576;
export const PRESENTATION_HISTORY_MAX_TURNS = 1_000;
export const PRESENTATION_HISTORY_MAX_TEXT_CHARS = 32_000;

export type PresentationHistoryMode = "journal" | "legacy-pi-native";

export interface PresentationTitle {
  value: string;
  source: "auto" | "owner";
  updatedAt: string;
}

export interface PresentationTurn {
  sequence: number;
  sourceOrdinal: number;
  sourceRevision: ConversationSourceRevision;
  settledAt: string;
  ownerText: string;
  ownerTextTruncated: boolean;
  assistantText: string;
  assistantTextTruncated: boolean;
  outcome: "completed" | "failed";
}

export interface PresentationHistoryV1 {
  version: 1;
  runtime: ConversationRuntime;
  conversationId: string;
  historyMode: PresentationHistoryMode;
  historyPrefixOmitted: boolean;
  title: PresentationTitle | null;
  lastSequence: number;
  droppedThroughSequence: number;
  lastSourceOrdinal: number | null;
  lastSourceRevision: ConversationSourceRevision | null;
  turns: PresentationTurn[];
}

export interface PresentationHistoryInitialization {
  historyMode: PresentationHistoryMode;
  historyPrefixOmitted: boolean;
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

function validTitle(value: unknown): value is PresentationTitle {
  return object(value)
    && exactKeys(value, ["value", "source", "updatedAt"])
    && typeof value.value === "string"
    && value.value.length > 0
    && value.value.length <= 120
    && (value.source === "auto" || value.source === "owner")
    && iso(value.updatedAt);
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
    && sourceRevisionMatchesRuntime(runtime, value.sourceRevision)
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

function parseHistory(
  path: string,
  identity: PresentationHistoryIdentity,
  value: unknown,
): PresentationHistoryV1 {
  if (!object(value) || !exactKeys(value, [
    "version",
    "runtime",
    "conversationId",
    "historyMode",
    "historyPrefixOmitted",
    "title",
    "lastSequence",
    "droppedThroughSequence",
    "lastSourceOrdinal",
    "lastSourceRevision",
    "turns",
  ])) throw invalidHistory(path);
  if (value.version !== 1
    || value.runtime !== identity.runtime
    || value.conversationId !== identity.conversationId
    || (value.historyMode !== "journal" && value.historyMode !== "legacy-pi-native")
    || (value.historyMode === "legacy-pi-native" && identity.runtime !== "pi")
    || typeof value.historyPrefixOmitted !== "boolean"
    || (value.title !== null && !validTitle(value.title))
    || !safeNonnegative(value.lastSequence)
    || !safeNonnegative(value.droppedThroughSequence)
    || (value.lastSourceOrdinal !== null && !positiveOrdinal(value.lastSourceOrdinal))
    || (value.lastSourceRevision !== null
      && !sourceRevisionMatchesRuntime(identity.runtime, value.lastSourceRevision))
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
  const sourceRevisions = new Set(turns.map(({ sourceRevision }) =>
    `${sourceRevision.kind}:${String(sourceRevision.value)}`));
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
      || !sameSourceRevision(value.lastSourceRevision, latest.sourceRevision)) {
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

function emptyHistory(
  identity: PresentationHistoryIdentity,
  initialization: PresentationHistoryInitialization,
): PresentationHistoryV1 {
  if (initialization.historyMode === "legacy-pi-native" && identity.runtime !== "pi") {
    throw new TypeError("Only Pi presentation history can use legacy native projection.");
  }
  return {
    version: 1,
    ...identity,
    historyMode: initialization.historyMode,
    historyPrefixOmitted: initialization.historyPrefixOmitted,
    title: null,
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
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: PresentationHistoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async read(
    sessionDir: string,
    identity: PresentationHistoryIdentity,
  ): Promise<PresentationHistoryV1 | null> {
    const path = presentationHistoryPath(sessionDir, identity.runtime, identity.conversationId);
    await this.queues.get(path)?.catch(() => undefined);
    return this.readStoredHistory(path, identity);
  }

  async recordSettledTurn(
    sessionDir: string,
    identity: PresentationHistoryIdentity,
    turn: SettledConversationTurn,
    initialization: PresentationHistoryInitialization,
  ): Promise<PresentationHistoryV1> {
    const path = presentationHistoryPath(sessionDir, identity.runtime, identity.conversationId);
    return this.withQueue(path, async () => {
      const stored = await this.readStoredHistory(path, identity);
      const state = stored ?? emptyHistory(identity, initialization);
      this.validateSettledTurn(path, identity, turn);
      if (state.lastSourceOrdinal !== null) {
        if (turn.sourceOrdinal < state.lastSourceOrdinal) throw invalidHistory(path);
        if (turn.sourceOrdinal === state.lastSourceOrdinal) {
          if (!state.lastSourceRevision
            || !sameSourceRevision(state.lastSourceRevision, turn.sourceRevision)) {
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
      while (state.turns.length > PRESENTATION_HISTORY_MAX_TURNS
        || Buffer.byteLength(serialized(state), "utf8") > PRESENTATION_HISTORY_MAX_BYTES) {
        const dropped = state.turns.shift();
        if (!dropped) throw invalidHistory(path);
        state.droppedThroughSequence = dropped.sequence;
        state.historyPrefixOmitted = true;
      }
      await writeDaemonControlFile(path, serialized(state), PRESENTATION_HISTORY_MAX_BYTES);
      return state;
    });
  }

  private validateSettledTurn(
    path: string,
    identity: PresentationHistoryIdentity,
    turn: SettledConversationTurn,
  ): void {
    if (!sourceRevisionMatchesRuntime(identity.runtime, turn.sourceRevision)
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

  private async withQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(path) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    const tracked = run.then(() => undefined, () => undefined);
    this.queues.set(path, tracked);
    try {
      return await run;
    } finally {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    }
  }
}
