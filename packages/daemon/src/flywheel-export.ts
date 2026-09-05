import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { redactMemorySecrets as clean } from "@ghost/extensions";
import { claudeSdkTranscriptPath } from "./claude-sdk-files.js";
import { readDaemonControlFile } from "./control-file.js";
import type { ConversationRuntime } from "./conversation-identity.js";
import { ghostPaths, readCharacterFile } from "./ghosts.js";
import { writePrivateJsonAtomic } from "./private-file.js";
import {
  parseReviewJournal,
  REVIEW_JOURNAL_MAX_BYTES,
  REVIEW_JOURNAL_SUFFIX,
  reviewJournalPath,
  type ReviewJournalEntry,
  type ReviewJournalV1,
} from "./review-journal.js";
import { claudeSessionMetadataPath, sessionFileNameFor } from "./session-files.js";
import {
  isRecord,
  linkTranscriptRecords,
  parseTranscriptLines,
  transcriptMessage,
  transcriptOwnerText,
  transcriptRecordId,
  transcriptText,
  type TranscriptRecord,
} from "./transcript-records.js";

export const FLYWHEEL_EXPORT_VERSION = "flywheel-export/v1";
/**
 * A conversation transcript larger than this is left alone: the parent chain
 * only resolves from a whole file, so a partial read would silently export a
 * turn with the wrong context.
 */
export const FLYWHEEL_TRANSCRIPT_MAX_BYTES = 64 * 1_048_576;
const CLAUDE_SIDECAR_MAX_BYTES = 1_048_576;
export const DEFAULT_HOLDOUT_FRACTION = 0.1;
export const DEFAULT_CONTEXT_TURNS = 6;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000;
export const DEFAULT_SYSTEM_PROMPT = "character";
const TRUNCATION_MARKER = "\n…[truncated]";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Which system prompt a sample carries: what the runtime sent, or the persona
 * alone — the default, because folding the policy text into the adapter's
 * weights is the point of training.
 */
export type FlywheelSystemPrompt = "full" | "character";

export const FLYWHEEL_SKIP_REASONS = [
  "before-watermark",
  "truncated",
  "continuation-pass",
  "escalated",
  "unresolved-critique",
  "transcript-missing",
] as const;

export type FlywheelSkipReason = typeof FLYWHEEL_SKIP_REASONS[number];

export const FLYWHEEL_FILES = {
  sftTrain: "sft-train.jsonl",
  sftHoldout: "sft-holdout.jsonl",
  dpoTrain: "dpo-train.jsonl",
  dpoHoldout: "dpo-holdout.jsonl",
  manifest: "manifest.json",
} as const;

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/** One Fireworks supervised sample: OpenAI chat messages plus a sample weight. */
export interface SftSample {
  messages: ChatMessage[];
  weight: number;
}

/** One Fireworks preference pair: the attempt against the rewrite it earned. */
export interface DpoSample {
  input: { messages: ChatMessage[] };
  preferred_output: { role: "assistant"; content: string };
  non_preferred_output: { role: "assistant"; content: string };
}

export interface FlywheelManifest {
  version: typeof FLYWHEEL_EXPORT_VERSION;
  ghost: string;
  exportedAt: string;
  since: string | null;
  /** The newest `recordedAt` seen, to pass as `--since` on the next round. */
  newestRecordedAt: string | null;
  system: FlywheelSystemPrompt;
  contextTurns: number;
  holdout: number;
  maxToolResultChars: number;
  journals: number;
  entries: number;
  files: Record<string, number>;
  skipped: Record<FlywheelSkipReason, number>;
}

export interface FlywheelExportOptions {
  ghost: string;
  /** The ghost home; nothing outside it and the runtime transcripts is read. */
  home: string;
  outDir: string;
  since?: string;
  holdout?: number;
  system?: FlywheelSystemPrompt;
  contextTurns?: number;
  maxToolResultChars?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** One owner turn of a conversation: the owner's words and what followed. */
interface TranscriptTurn {
  id: string | undefined;
  ownerText: string;
  records: TranscriptRecord[];
  /** Filled on first use; a turn is cited by every later sample's context. */
  cleanedOwnerText?: string;
  finalAnswer?: string;
}

interface Conversation {
  turns: TranscriptTurn[];
  byOwnerRecordId: Map<string, number>;
  systemPrompt: string;
}

/**
 * Owner turns in transcript order. A tool result also arrives as a `user`
 * record, and an agent-attributed message is the ghost talking to itself, so a
 * boundary needs owner text the owner actually wrote.
 */
function splitOwnerTurns(
  records: readonly TranscriptRecord[],
  runtime: ConversationRuntime,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const item of records) {
    const ownerText = transcriptOwnerText(item);
    const fromAgent = transcriptMessage(item)?.attribution === "agent";
    if (ownerText && !fromAgent) {
      turns.push({ id: transcriptRecordId(item, runtime), ownerText, records: [] });
      continue;
    }
    turns.at(-1)?.records.push(item);
  }
  return turns;
}

function systemPromptOf(records: readonly TranscriptRecord[]): string {
  for (const item of records) {
    const message = transcriptMessage(item);
    if (message?.role === "system") return transcriptText(message.content);
  }
  return "";
}

/**
 * The runtime transcript backing one conversation: pi's JSONL beside the
 * journal, or Claude Code's own SDK file behind its resume metadata.
 */
async function transcriptPathFor(
  sessionDir: string,
  journal: ReviewJournalV1,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (journal.runtime === "pi") {
    return join(sessionDir, sessionFileNameFor(journal.conversationId));
  }
  try {
    const raw = await readDaemonControlFile(
      claudeSessionMetadataPath(sessionDir, journal.conversationId),
      CLAUDE_SIDECAR_MAX_BYTES,
    );
    const metadata: unknown = JSON.parse(raw);
    if (!isRecord(metadata)
      || metadata.conversationId !== journal.conversationId
      || typeof metadata.sessionId !== "string") return undefined;
    return claudeSdkTranscriptPath(metadata.sessionId, env);
  } catch {
    return undefined;
  }
}

async function loadConversation(
  path: string | undefined,
  runtime: ConversationRuntime,
): Promise<Conversation | null> {
  if (!path) return null;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > FLYWHEEL_TRANSCRIPT_MAX_BYTES) return null;
    const records = linkTranscriptRecords(
      parseTranscriptLines(await readFile(path, "utf8")),
      runtime,
    );
    if (records.length === 0) return null;
    const turns = splitOwnerTurns(records, runtime);
    const byOwnerRecordId = new Map<string, number>();
    turns.forEach((turn, index) => {
      if (turn.id !== undefined) byOwnerRecordId.set(turn.id, index);
    });
    return { turns, byOwnerRecordId, systemPrompt: clean(systemPromptOf(records)) };
  } catch {
    return null;
  }
}

function boundedToolResult(value: string, maximum: number): string {
  const redacted = clean(value);
  return redacted.length <= maximum
    ? redacted
    : `${redacted.slice(0, maximum)}${TRUNCATION_MARKER}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  const text = transcriptText(content);
  return text || (content === undefined ? "" : JSON.stringify(content));
}

/**
 * The assistant side of one owner turn as OpenAI chat messages: text, tool
 * calls, and tool results in transcript order. Private reasoning is never
 * carried — `thinking` blocks are dropped rather than redacted.
 *
 * Returns null for a turn that is not a well-formed sample: a tool call with
 * no result, or a turn that never reached a spoken answer. The caller counts
 * those rather than inventing the missing half.
 */
function buildTurnMessages(turn: TranscriptTurn, maxToolResultChars: number): ChatMessage[] | null {
  const messages: ChatMessage[] = [];
  const pendingCalls: string[] = [];
  let calls = 0;

  const resolveCall = (id: string | undefined, content: string): void => {
    const queued = id === undefined ? 0 : pendingCalls.indexOf(id);
    if (queued < 0) return;
    const [callId] = pendingCalls.splice(queued, 1);
    if (callId !== undefined) messages.push({ role: "tool", tool_call_id: callId, content });
  };

  for (const item of turn.records) {
    const message = transcriptMessage(item);
    if (!message) continue;
    if (message.role === "assistant") {
      const toolCalls: ChatToolCall[] = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(part)) continue;
        const pi = part.type === "toolCall";
        if (!pi && part.type !== "tool_use" && part.type !== "mcp_tool_use") continue;
        calls += 1;
        const id = typeof part.id === "string" && part.id ? part.id : `call_${calls}`;
        pendingCalls.push(id);
        toolCalls.push({
          id,
          type: "function",
          function: {
            name: typeof part.name === "string" ? part.name : "unknown",
            arguments: clean(JSON.stringify((pi ? part.arguments : part.input) ?? {})),
          },
        });
      }
      const text = clean(transcriptText(message.content));
      if (!text && toolCalls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "toolResult") {
      resolveCall(
        typeof message.toolCallId === "string" ? message.toolCallId : undefined,
        boundedToolResult(toolResultText(message.content), maxToolResultChars),
      );
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "tool_result") continue;
        resolveCall(
          typeof part.tool_use_id === "string" ? part.tool_use_id : undefined,
          boundedToolResult(toolResultText(part.content), maxToolResultChars),
        );
      }
    }
  }

  if (pendingCalls.length > 0) return null;
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.content) return null;
  return messages;
}

/** The final spoken answer of a prior turn, for context without its tool trace. */
function finalAnswerOf(turn: TranscriptTurn): string {
  if (turn.finalAnswer !== undefined) return turn.finalAnswer;
  let answer = "";
  for (let index = turn.records.length - 1; index >= 0 && !answer; index -= 1) {
    const message = transcriptMessage(turn.records[index] as TranscriptRecord);
    if (message?.role === "assistant") answer = clean(transcriptText(message.content));
  }
  turn.finalAnswer = answer;
  return answer;
}

function cleanedOwnerTextOf(turn: TranscriptTurn): string {
  turn.cleanedOwnerText ??= clean(turn.ownerText);
  return turn.cleanedOwnerText;
}

function contextMessages(
  conversation: Conversation,
  index: number,
  options: { system: FlywheelSystemPrompt; character: string; contextTurns: number },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = options.system === "full"
    ? conversation.systemPrompt || options.character
    : options.character;
  if (system) messages.push({ role: "system", content: system });
  for (let prior = Math.max(0, index - options.contextTurns); prior < index; prior += 1) {
    const turn = conversation.turns[prior] as TranscriptTurn;
    messages.push({ role: "user", content: cleanedOwnerTextOf(turn) });
    const answer = finalAnswerOf(turn);
    if (answer) messages.push({ role: "assistant", content: answer });
  }
  const target = conversation.turns[index] as TranscriptTurn;
  messages.push({ role: "user", content: cleanedOwnerTextOf(target) });
  return messages;
}

function aboveNit(entry: ReviewJournalEntry): boolean {
  return entry.severity === "concern" || entry.severity === "blocker"
    || entry.notes.some((note) => note.severity === "concern" || note.severity === "blocker");
}

type Verdict = { kind: "sft" | "dpo" } | { kind: "skip"; reason: FlywheelSkipReason };

/**
 * The fruitful gate. A clean turn nobody had to correct is a positive sample;
 * a turn a strict continuation rewrote is a preference pair; everything else
 * is counted and left out.
 */
export function classifyReviewEntry(entry: ReviewJournalEntry, since?: string): Verdict {
  if (since && entry.recordedAt <= since) return { kind: "skip", reason: "before-watermark" };
  if (entry.truncated) return { kind: "skip", reason: "truncated" };
  if (entry.continuation) return { kind: "dpo" };
  if (entry.continuationPass) return { kind: "skip", reason: "continuation-pass" };
  if (entry.delta.delegations > 0) return { kind: "skip", reason: "escalated" };
  if (entry.delivered === "continuation") return { kind: "skip", reason: "unresolved-critique" };
  if (aboveNit(entry)) return { kind: "skip", reason: "unresolved-critique" };
  return { kind: "sft" };
}

/**
 * Which slice a conversation belongs to. Hashing the conversation id keeps
 * every turn of one conversation on the same side, so held-out context never
 * leaks into training.
 */
export function isHoldoutConversation(conversationId: string, holdout: number): boolean {
  if (holdout <= 0) return false;
  if (holdout >= 1) return true;
  const digest = createHash("sha256").update(conversationId).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < holdout;
}

/**
 * One journal off disk, or null. The file names the conversation it belongs
 * to and that name steers which transcript is read, so the self-declared id
 * has to agree with the name the daemon would have written.
 */
async function readJournal(sessionDir: string, name: string): Promise<ReviewJournalV1 | null> {
  try {
    const journal = parseReviewJournal(JSON.parse(
      await readDaemonControlFile(join(sessionDir, name), REVIEW_JOURNAL_MAX_BYTES),
    ));
    if (!journal) return null;
    const expected = reviewJournalPath(sessionDir, journal.runtime, journal.conversationId);
    return basename(expected) === name ? journal : null;
  } catch {
    return null;
  }
}

async function journalNames(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir))
      .filter((name) => name.endsWith(REVIEW_JOURNAL_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

async function writeDatasetFile(path: string, lines: readonly string[]): Promise<void> {
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  await writeFile(path, body, { encoding: "utf8", mode: FILE_MODE });
  await chmod(path, FILE_MODE);
}

/**
 * Turn a ghost's review journals into Fireworks training files. Reads only the
 * ghost home and the runtime transcripts it points at, so it works with ghostd
 * stopped and never sends a transcript over the wire.
 */
export async function exportFlywheelDataset(
  options: FlywheelExportOptions,
): Promise<FlywheelManifest> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const holdout = options.holdout ?? DEFAULT_HOLDOUT_FRACTION;
  const system = options.system ?? DEFAULT_SYSTEM_PROMPT;
  const contextTurns = options.contextTurns ?? DEFAULT_CONTEXT_TURNS;
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const { sessionDir } = ghostPaths(options.home);
  const character = clean((readCharacterFile(options.home) ?? "").trim());

  const lines: Record<string, string[]> = {
    [FLYWHEEL_FILES.sftTrain]: [],
    [FLYWHEEL_FILES.sftHoldout]: [],
    [FLYWHEEL_FILES.dpoTrain]: [],
    [FLYWHEEL_FILES.dpoHoldout]: [],
  };
  const skipped = Object.fromEntries(
    FLYWHEEL_SKIP_REASONS.map((reason) => [reason, 0]),
  ) as Record<FlywheelSkipReason, number>;
  let journals = 0;
  let entries = 0;
  let newestRecordedAt: string | null = null;

  for (const name of await journalNames(sessionDir)) {
    const journal = await readJournal(sessionDir, name);
    if (!journal) continue;
    journals += 1;
    const held = isHoldoutConversation(journal.conversationId, holdout);
    const sft = lines[held ? FLYWHEEL_FILES.sftHoldout : FLYWHEEL_FILES.sftTrain] as string[];
    const dpo = lines[held ? FLYWHEEL_FILES.dpoHoldout : FLYWHEEL_FILES.dpoTrain] as string[];
    // A journal whose entries are all skipped never opens its transcript.
    let conversation: Conversation | null | undefined;

    for (const entry of journal.entries) {
      entries += 1;
      if (!newestRecordedAt || entry.recordedAt > newestRecordedAt) {
        newestRecordedAt = entry.recordedAt;
      }
      const verdict = classifyReviewEntry(entry, options.since);
      if (verdict.kind === "skip") {
        skipped[verdict.reason] += 1;
        continue;
      }
      if (conversation === undefined) {
        conversation = await loadConversation(
          await transcriptPathFor(sessionDir, journal, env),
          journal.runtime,
        );
      }
      const ownerRecordId = entry.delta.ownerRecordId;
      const index = ownerRecordId === undefined
        ? undefined
        : conversation?.byOwnerRecordId.get(ownerRecordId);
      const turn = conversation && index !== undefined
        ? conversation.turns[index]
        : undefined;
      if (!conversation || index === undefined || !turn) {
        skipped["transcript-missing"] += 1;
        continue;
      }
      if (verdict.kind === "dpo") {
        // The journal is the only record of the attempt: by now the transcript
        // shows the whole owner turn as it read after the rewrite landed.
        // Both texts were redacted on write; redacted again because this is
        // the egress path and a hand-edited journal is not a trusted input.
        const pair: DpoSample = {
          input: { messages: contextMessages(conversation, index, { system, character, contextTurns }) },
          preferred_output: { role: "assistant", content: clean(entry.continuation?.text ?? "") },
          non_preferred_output: { role: "assistant", content: clean(entry.delta.text) },
        };
        dpo.push(JSON.stringify(pair));
        continue;
      }
      const turnMessages = buildTurnMessages(turn, maxToolResultChars);
      if (!turnMessages) {
        skipped["transcript-missing"] += 1;
        continue;
      }
      const sample: SftSample = {
        messages: [
          ...contextMessages(conversation, index, { system, character, contextTurns }),
          ...turnMessages,
        ],
        weight: 1,
      };
      sft.push(JSON.stringify(sample));
    }
  }

  const manifest: FlywheelManifest = {
    version: FLYWHEEL_EXPORT_VERSION,
    ghost: options.ghost,
    exportedAt: now().toISOString(),
    since: options.since ?? null,
    newestRecordedAt,
    system,
    contextTurns,
    holdout,
    maxToolResultChars,
    journals,
    entries,
    files: Object.fromEntries(
      Object.entries(lines).map(([name, body]) => [name, body.length]),
    ),
    skipped,
  };

  await mkdir(options.outDir, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(options.outDir, DIRECTORY_MODE);
  await Promise.all(Object.entries(lines).map(([name, body]) =>
    writeDatasetFile(join(options.outDir, name), body)));
  await writePrivateJsonAtomic(join(options.outDir, FLYWHEEL_FILES.manifest), manifest);
  return manifest;
}
