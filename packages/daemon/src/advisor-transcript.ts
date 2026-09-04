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
  commands: string[];
  paths: string[];
  /** How often the turn escalated to a specialist through the `task` tool. */
  delegations: number;
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
    commands: [],
    paths: [],
    delegations: 0,
    fallbackReason: reason,
  };
}

const MAX_TOOL_ARGUMENT_VALUES = 128;
const MAX_TOOL_ARGUMENT_DEPTH = 8;

function argumentKind(key: string): "command" | "path" | undefined {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  if (normalized === "command" || normalized === "commands" || normalized === "cmd") {
    return "command";
  }
  if (normalized === "path" || normalized === "paths" || normalized === "cwd"
    || normalized === "workdir" || normalized === "directory"
    || normalized.endsWith("_path") || normalized.endsWith("_paths")) {
    return "path";
  }
  return undefined;
}

function collectArgumentValues(
  value: unknown,
  key: string,
  output: { commands: string[]; paths: string[] },
  depth = 0,
): void {
  if (depth > MAX_TOOL_ARGUMENT_DEPTH
    || output.commands.length + output.paths.length >= MAX_TOOL_ARGUMENT_VALUES) return;
  const kind = argumentKind(key);
  if (typeof value === "string") {
    if (kind) output[kind === "command" ? "commands" : "paths"].push(redactMemorySecrets(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentValues(item, key, output, depth + 1);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [childKey, child] of Object.entries(object)) {
    collectArgumentValues(child, childKey, output, depth + 1);
  }
}

/**
 * The escalation tool: bare `task` under Pi, and `mcp__<server>__task` under
 * Claude Code, where Ghost's internal MCP server is `ghost` unless a project
 * server took that name. Its siblings (`task_get` and the rest) only follow up.
 */
function isEscalation(name: unknown): boolean {
  return typeof name === "string" && (name === "task" || /^mcp__.+__task$/u.test(name));
}

function toolArguments(
  records: readonly TranscriptRecord[],
): { commands: string[]; paths: string[]; delegations: number } {
  const output = { commands: [] as string[], paths: [] as string[], delegations: 0 };
  for (const item of records) {
    const message = messageFrom(item);
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const block = record(part);
      const pi = block?.type === "toolCall";
      if (!pi && block?.type !== "tool_use" && block?.type !== "mcp_tool_use") continue;
      collectArgumentValues(pi ? block.arguments : block.input, "", output);
      if (isEscalation(block.name)) output.delegations += 1;
    }
  }
  return output;
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
  const activeTurn = records.slice(ownerIndex);
  const rendered = activeTurn.flatMap((item) => {
    const line = renderRecord(item);
    return line ? [line] : [];
  });
  if (rendered.length === 0) return fallback(event, "parse");
  return { text: rendered.join("\n"), source: "transcript", ...toolArguments(activeTurn) };
}
