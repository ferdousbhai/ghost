import { redactMemorySecrets } from "@ghost/extensions";
import { open } from "node:fs/promises";
import type { GhostSessionStopEvent } from "./hooks.js";

export const ADVISOR_TRANSCRIPT_MAX_BYTES = 1024 * 1024;

interface TranscriptRecord {
  [key: string]: unknown;
}

export interface AdvisorTurnDelta {
  text: string;
  source: "transcript" | "assistant-fallback";
  fallbackReason?: "missing" | "read" | "parse" | "owner-boundary";
}

function record(value: unknown): TranscriptRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as TranscriptRecord
    : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const block = record(part);
    if (block?.type !== "text" || typeof block.text !== "string") return [];
    return [block.text];
  }).join("");
}

export function advisorAssistantText(message: unknown): string {
  const candidate = record(message);
  return candidate?.role === "assistant" ? contentText(candidate.content) : "";
}

function messageFrom(recordValue: TranscriptRecord): TranscriptRecord | null {
  const message = record(recordValue.message);
  if (recordValue.type === "message") return message;
  if (recordValue.type === "user" || recordValue.type === "assistant" || recordValue.type === "system") {
    return message;
  }
  return null;
}

function ownerText(recordValue: TranscriptRecord): string | null {
  const message = messageFrom(recordValue);
  if (message?.role === "user") return contentText(message.content);
  if (recordValue.type === "custom_message") return contentText(recordValue.content);
  return null;
}

function renderRecord(recordValue: TranscriptRecord): string | null {
  const message = messageFrom(recordValue);
  if (message && typeof message.role === "string") {
    const content = message.content;
    if (typeof content !== "string" && !Array.isArray(content)) return null;
    return `${message.role}: ${redactMemorySecrets(JSON.stringify(content))}`;
  }
  if (recordValue.type === "custom_message"
    && (typeof recordValue.content === "string" || Array.isArray(recordValue.content))) {
    return `context: ${redactMemorySecrets(JSON.stringify(recordValue.content))}`;
  }
  return null;
}

function linkedRecords(
  records: readonly TranscriptRecord[],
  runtime: GhostSessionStopEvent["runtime"],
): TranscriptRecord[] {
  const idKey = runtime === "pi" ? "id" : "uuid";
  const parentKey = runtime === "pi" ? "parentId" : "parentUuid";
  const byId = new Map<string, TranscriptRecord>();
  let leaf: TranscriptRecord | undefined;
  for (const item of records) {
    const id = item[idKey];
    if (typeof id !== "string" || id === "") continue;
    byId.set(id, item);
    if (renderRecord(item)) leaf = item;
  }
  if (!leaf) return [];
  const path: TranscriptRecord[] = [];
  const seen = new Set<string>();
  let current: TranscriptRecord | undefined = leaf;
  while (current) {
    const id = current[idKey];
    if (typeof id !== "string" || seen.has(id)) throw new Error("invalid transcript parent chain");
    seen.add(id);
    path.push(current);
    const parent: unknown = current[parentKey];
    current = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  return path.reverse();
}

async function readTranscriptTail(path: string, maximum: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("transcript is not a regular file");
    const length = Math.min(metadata.size, maximum);
    const offset = metadata.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    let text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) throw new Error("bounded transcript tail has no complete line");
      text = text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    await file.close();
  }
}

function parseJsonLines(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = record(JSON.parse(line));
    if (!parsed) throw new Error("transcript line is not an object");
    records.push(parsed);
  }
  return records;
}

function fallback(event: GhostSessionStopEvent, reason: AdvisorTurnDelta["fallbackReason"]): AdvisorTurnDelta {
  return {
    text: `assistant: ${redactMemorySecrets(JSON.stringify(advisorAssistantText(event.last_assistant_message)))}`,
    source: "assistant-fallback",
    fallbackReason: reason,
  };
}

export async function reconstructAdvisorTurnDelta(
  event: GhostSessionStopEvent,
  options: { maxBytes?: number } = {},
): Promise<AdvisorTurnDelta> {
  if (!event.transcript_path) return fallback(event, "missing");
  let text: string;
  try {
    text = await readTranscriptTail(
      event.transcript_path,
      options.maxBytes ?? ADVISOR_TRANSCRIPT_MAX_BYTES,
    );
  } catch {
    return fallback(event, "read");
  }
  let records: TranscriptRecord[];
  try {
    records = linkedRecords(parseJsonLines(text), event.runtime);
  } catch {
    return fallback(event, "parse");
  }
  let ownerIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const item = records[index];
    if (item && ownerText(item) === event.owner_prompt) {
      ownerIndex = index;
      break;
    }
  }
  if (ownerIndex < 0) return fallback(event, "owner-boundary");
  const rendered = records.slice(ownerIndex).flatMap((item) => {
    const line = renderRecord(item);
    return line ? [line] : [];
  });
  if (rendered.length === 0) return fallback(event, "parse");
  return { text: rendered.join("\n"), source: "transcript" };
}
