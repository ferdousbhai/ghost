import type { ConversationRuntime } from "./conversation-identity.js";

/**
 * Reading a runtime's own conversation transcript: pi's JSONL under the ghost
 * home's `sessions/`, and Claude Code's SDK session file. The two differ only
 * in their envelope — record type names and the parent-link key — so every
 * consumer that walks a transcript shares this module rather than learning
 * both shapes again.
 */

/** One parsed JSONL line of a runtime transcript. */
export interface TranscriptRecord {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): TranscriptRecord | null {
  return isRecord(value) ? value as TranscriptRecord : null;
}

/** The plain text of a message body, ignoring every non-text block. */
export function transcriptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const block = asRecord(part);
    if (block?.type !== "text" || typeof block.text !== "string") return [];
    return [block.text];
  }).join("");
}

/** The message a transcript record carries, under either runtime's envelope. */
export function transcriptMessage(recordValue: TranscriptRecord): TranscriptRecord | null {
  const message = asRecord(recordValue.message);
  if (recordValue.type === "message") return message;
  if (recordValue.type === "user" || recordValue.type === "assistant" || recordValue.type === "system") {
    return message;
  }
  return null;
}

/**
 * The owner's own words in this record, or null when it is not owner input.
 * A tool result also arrives as a `user` record under Claude Code, so a caller
 * looking for a turn boundary must additionally require non-empty text.
 */
export function transcriptOwnerText(recordValue: TranscriptRecord): string | null {
  const message = transcriptMessage(recordValue);
  if (message?.role === "user") return transcriptText(message.content);
  if (recordValue.type === "custom_message") return transcriptText(recordValue.content);
  return null;
}

/** The record's own identity in its transcript, which is stable across reads. */
export function transcriptRecordId(
  recordValue: TranscriptRecord,
  runtime: ConversationRuntime,
): string | undefined {
  const id = recordValue[runtime === "pi" ? "id" : "uuid"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * What this record contributes to the conversation — a labelled body — or null
 * when it carries none. This is what makes a record part of the replayed
 * branch, so it decides both the leaf of the parent chain and what a consumer
 * has to render.
 */
export function transcriptBody(
  recordValue: TranscriptRecord,
): { label: string; content: string | unknown[] } | null {
  const message = transcriptMessage(recordValue);
  if (message && typeof message.role === "string") {
    const content = message.content;
    if (typeof content !== "string" && !Array.isArray(content)) return null;
    return { label: message.role, content };
  }
  if (recordValue.type === "custom_message"
    && (typeof recordValue.content === "string" || Array.isArray(recordValue.content))) {
    return { label: "context", content: recordValue.content };
  }
  return null;
}

export function parseTranscriptLines(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = asRecord(JSON.parse(line));
    if (!parsed) throw new Error("transcript line is not an object");
    records.push(parsed);
  }
  return records;
}

/**
 * The single parent chain from the conversation root to its last record with a
 * body: the branch the runtime actually replayed, with forks left behind.
 */
export function linkTranscriptRecords(
  records: readonly TranscriptRecord[],
  runtime: ConversationRuntime,
): TranscriptRecord[] {
  const parentKey = runtime === "pi" ? "parentId" : "parentUuid";
  const byId = new Map<string, TranscriptRecord>();
  let leaf: TranscriptRecord | undefined;
  for (const item of records) {
    const id = transcriptRecordId(item, runtime);
    if (id === undefined) continue;
    byId.set(id, item);
    if (transcriptBody(item)) leaf = item;
  }
  if (!leaf) return [];
  const path: TranscriptRecord[] = [];
  const seen = new Set<string>();
  let current: TranscriptRecord | undefined = leaf;
  while (current) {
    const id = transcriptRecordId(current, runtime);
    if (id === undefined || seen.has(id)) throw new Error("invalid transcript parent chain");
    seen.add(id);
    path.push(current);
    const parent: unknown = current[parentKey];
    current = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  return path.reverse();
}
