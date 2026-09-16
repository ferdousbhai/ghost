/**
 * Context windows: fresh context instead of a generated summary.
 *
 * A port of pi-posthorse (MIT, fitchmultz) onto upstream pi. When pi decides to
 * compact, Ghost answers `session_before_compact` with a compaction whose
 * summary is a bounded *recovery record* — the owner's inputs in the current
 * window, the tool batch no model has consumed yet, and the previous
 * checkpoint — rather than a model-written briefing. Earlier conversation stays
 * in the transcript and comes back through the `history` tool. One best-effort
 * checkpoint reminder lands shortly before the rollover line; `new_context`
 * rolls over on demand with the ghost's own handoff.
 *
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REMINDER_BUFFER_TOKENS = 32_000;
/** Absolute ceiling for handoffs and read pages. */
export const MAX_HANDOFF_CHARS = 20_000;
const MAX_RECOVERY_RECORD_CHARS = 4_000;
const HANDOFF_OVERHEAD_RESERVE = 1_000;
const MIN_PAGE_CHARS = 1_000;
const PAGE_MARGIN_TOKENS = 1_000;
const ESTIMATED_IMAGE_CHARS = 4_800;
export const REMINDER_TYPE = "ghost-checkpoint";
const AUTO_HANDOFF_PREFIX = "Automatic context rollover recovery record.";
const HISTORY_SEARCH_LIMIT = 50;

export const CONTEXT_WINDOW_POLICY = [
  "## Context windows",
  "When your context fills, Ghost rolls into a fresh window holding only a recovery record of the owner's inputs and the last tool batch; earlier turns come back through `history`, and a checkpoint reminder may arrive first with what to save. A recovery record preserves inputs, not progress: after a rollover, reread notes and history and verify live state before continuing stateful work.",
].join("\n");

export interface ContextWindowSettings {
  /** pi compacts once usage exceeds the window minus this reserve; absent when compaction is off. */
  reserveTokens?: number;
  enabled: boolean;
}

type ImageLike = { type: "image"; data: string; mimeType: string };
type MessageLike = {
  role?: string;
  stopReason?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  excludeFromContext?: boolean;
};
export type EntryLike = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: MessageLike;
  summary?: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
  display?: boolean;
};

type WindowedEntry = { entry: EntryLike; windowId: string; text: string; images: ImageLike[] };
type HistoryHit = { id: string; text: string; priority: 0 | 1 };
type RecoveryRecord = {
  id: string;
  timestamp: string;
  kind: "owner" | "coordination";
  label: string;
  text: string;
};

/** Narrow a value the surrounding logic already proved present. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unreachable: missing value");
  return value;
}

function isImage(part: unknown): part is ImageLike {
  const block = part as Partial<ImageLike> | null;
  return typeof block === "object" && block !== null && block.type === "image" && typeof block.data === "string";
}

function imagesOf(content: unknown): ImageLike[] {
  return Array.isArray(content) ? content.filter(isImage) : [];
}

function imageSummary(images: ImageLike[]): string {
  if (!images.length) return "";
  const types = [...new Set(images.map((image) => image.mimeType || "unknown type"))].join(", ");
  return `[${images.length} image${images.length === 1 ? "" : "s"}: ${types}]`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function textOf(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return block.thinking ?? "";
      if (block.type === "toolCall") return `${block.name ?? "tool"} ${safeJsonStringify(block.arguments ?? {})}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function textResult(text: string, images: ImageLike[] = []) {
  return { content: [{ type: "text" as const, text }, ...images], details: undefined };
}

function requireValue(value: string | undefined, name: string, op: string): string {
  if (value === undefined || value === "") throw new Error(`"${name}" is required for op "${op}".`);
  return value;
}

function excerptAround(text: string, index: number, before: number, length: number): string {
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, start + length);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n… middle omitted …\n";
  if (limit <= marker.length) return text.slice(0, limit);
  const head = Math.floor((limit - marker.length) / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - marker.length - head))}`;
}

function boundedBlock(header: string, text: string, limit: number): string {
  const textLimit = Math.max(0, limit - header.length - 1);
  return textLimit ? `${header}\n${excerpt(text, textLimit)}` : header;
}

/** A compaction entry is a window boundary; its summary is the handoff. */
function isWindowBoundary(entry: EntryLike): boolean {
  return entry.type === "compaction";
}

function flattenEntry(entry: EntryLike): string | undefined {
  if (entry.type === "message") {
    const message = entry.message ?? {};
    if (message.role === "bashExecution") {
      if (message.excludeFromContext === true) return "[bashExecution] (excluded from model context by pi)";
      return `[bashExecution] $ ${message.command ?? ""}\n${message.output ?? ""}`;
    }
    return `[${message.role ?? "message"}] ${[textOf(message), imageSummary(imagesOf(message.content))].filter(Boolean).join("\n")}`;
  }
  if (entry.type === "compaction") return `[context window] Handoff: ${entry.summary ?? ""}`;
  if (entry.type === "branch_summary") return `[branch_summary] ${entry.summary ?? ""}`;
  if (entry.type === "custom_message") {
    return `[custom:${entry.customType ?? "unknown"}] ${[textOf({ content: entry.content }), imageSummary(imagesOf(entry.content))].filter(Boolean).join("\n")}`;
  }
  return undefined;
}

function isRecoveryTool(name: unknown): boolean {
  return name === "history" || name === "new_context";
}

function isRecoveryCall(part: unknown): boolean {
  const block = part as { type?: string; name?: string } | null;
  return block?.type === "toolCall" && isRecoveryTool(block.name);
}

function historyHit(item: WindowedEntry, query: string, source = ""): HistoryHit | undefined {
  const { entry } = item;
  let text = item.text;
  let matchIndex = text.toLowerCase().indexOf(query);
  if (matchIndex === -1) return undefined;
  let priority: 0 | 1 =
    isWindowBoundary(entry)
    || entry.type === "branch_summary"
    || (entry.type === "custom_message" && entry.customType === REMINDER_TYPE)
    || (entry.type === "message" && entry.message?.role === "toolResult" && isRecoveryTool(entry.message.toolName))
      ? 1
      : 0;
  if (
    entry.type === "message" && entry.message?.role === "assistant"
    && Array.isArray(entry.message.content) && entry.message.content.some(isRecoveryCall)
  ) {
    // A lookup beside a matching ordinary call or prose must not demote that original content.
    const originals = [""];
    for (const part of entry.message.content) {
      if (isRecoveryCall(part)) {
        originals.push("");
      } else {
        const partText = textOf({ content: [part] });
        if (partText) originals[originals.length - 1] += `${originals.at(-1) ? "\n" : ""}${partText}`;
      }
    }
    const images = imageSummary(item.images);
    if (images) originals[originals.length - 1] += `${originals.at(-1) ? "\n" : ""}${images}`;
    if (originals[0]) originals[0] = `[assistant] ${originals[0]}`;
    const original = originals.find((part) => part.toLowerCase().includes(query));
    priority = original ? 0 : 1;
    if (original) {
      text = original === originals[0] ? original : `[assistant] ${original}`;
      matchIndex = text.toLowerCase().indexOf(query);
    }
  }
  return {
    id: must(entry.id),
    priority,
    text: `${source ? `${source} ` : ""}${entry.timestamp ?? ""} [window ${item.windowId}] [${entry.id}] ${excerptAround(text, matchIndex, 100, 400)}`,
  };
}

function toWindowedEntry(entry: EntryLike, windows: Map<string, string>): WindowedEntry | undefined {
  const inheritedWindow = entry.parentId ? (windows.get(entry.parentId) ?? "initial") : "initial";
  const windowId = isWindowBoundary(entry) && entry.id ? entry.id : inheritedWindow;
  if (entry.id) windows.set(entry.id, windowId);
  const text = flattenEntry(entry);
  if (!text || !entry.id) return undefined;
  const images = imagesOf(entry.type === "message" ? entry.message?.content : entry.content);
  return { entry, windowId, text, images };
}

export function* windowEntries(entries: Iterable<EntryLike>): Generator<WindowedEntry> {
  const windows = new Map<string, string>();
  for (const entry of entries) {
    const item = toWindowedEntry(entry, windows);
    if (item) yield item;
  }
}

async function* sessionWindowEntries(file: string, signal?: AbortSignal): AsyncGenerator<WindowedEntry> {
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  const windows = new Map<string, string>();
  try {
    for await (const line of lines) {
      let entry: EntryLike;
      try {
        entry = JSON.parse(line) as EntryLike;
      } catch {
        continue;
      }
      const item = toWindowedEntry(entry, windows);
      if (item) yield item;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function sessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".intent."))
    .map((entry) => join(entry.parentPath, entry.name));
  if (files.length < 2) return files;
  return files
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ file }) => file);
}

export function currentWindowId(entries: readonly EntryLike[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = must(entries[i]);
    if (isWindowBoundary(entry) && entry.id) return entry.id;
  }
  return "initial";
}

function recoveryRecord(entry: EntryLike): RecoveryRecord | undefined {
  let kind: RecoveryRecord["kind"];
  let label: string;
  let text: string;
  let images: ImageLike[] = [];
  if (entry.type === "message" && entry.message?.role === "user") {
    kind = "owner";
    label = "owner input";
    text = textOf(entry.message).trim();
    images = imagesOf(entry.message.content);
  } else if (
    entry.type === "message"
    && entry.message?.role === "toolResult"
    && entry.message.toolName === "ask"
    && entry.message.isError !== true
  ) {
    kind = "owner";
    label = "owner answer via ask";
    text = textOf(entry.message).trim();
  } else if (entry.type === "custom_message" && entry.display === true && entry.customType !== REMINDER_TYPE) {
    kind = "coordination";
    label = `visible ${(entry.customType ?? "custom").slice(0, 80)} coordination input (not direct owner input)`;
    text = textOf({ content: entry.content }).trim();
    images = imagesOf(entry.content);
  } else {
    return undefined;
  }
  const id = entry.id?.slice(0, 120) ?? "unknown";
  const summary = imageSummary(images);
  return {
    id,
    timestamp: entry.timestamp?.slice(0, 80) ?? "unknown time",
    kind,
    label,
    text: [text, summary && `${summary} — recover with history read id ${id}`].filter(Boolean).join("\n")
      || "(non-text content; recover the entry from history)",
  };
}

function formatRecoveryRecord(record: RecoveryRecord, limit: number): string {
  return boundedBlock(`[${record.label} | ${record.timestamp} | entry ${record.id}]`, record.text, limit);
}

function formatPriorCheckpoint(entry: EntryLike | undefined, limit: number): string | undefined {
  const handoff = entry?.summary?.trim();
  if (!entry || !handoff) return undefined;
  const id = entry.id?.slice(0, 120) ?? "unknown";
  const header = `[older checkpoint; possibly stale | context-window entry ${id}]`;
  if (handoff.startsWith(AUTO_HANDOFF_PREFIX)) {
    return boundedBlock(header, `Prior automatic recovery text is not nested here. Use history read with entry ${id} if needed.`, limit);
  }
  return boundedBlock(header, handoff, limit);
}

/**
 * The trailing tool batch no model has consumed yet: an assistant tool-call
 * message followed only by its completed results. pi can roll over right after
 * tools finish, so the result that triggered the rollover would otherwise
 * vanish before any model saw it.
 */
function unconsumedToolBatch(
  entries: readonly EntryLike[],
): { callId: string; blocks: Array<{ header: string; text: string }> } | undefined {
  const results: EntryLike[] = [];
  let call: EntryLike | undefined;
  for (let i = entries.length - 1; i >= 0 && !call; i--) {
    const entry = must(entries[i]);
    const role = entry.type === "message" ? entry.message?.role : undefined;
    if (role === "toolResult") {
      results.unshift(entry);
    } else if (role === "assistant") {
      const invalid = entry.message?.stopReason === "error"
        || entry.message?.stopReason === "aborted"
        || entry.message?.stopReason === "length";
      if (invalid) {
        if (results.length) return undefined;
      } else {
        call = entry;
      }
    }
  }
  if (!call || !results.length) return undefined;
  const calls = Array.isArray(call.message?.content)
    ? (call.message.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>)
        .filter((block) => block?.type === "toolCall")
    : [];
  const blocks = results.map((result) => {
    const message = result.message ?? {};
    const matching = calls.find((block) => block.id === message.toolCallId);
    const name = (message.toolName ?? matching?.name ?? "tool").slice(0, 80);
    const resultId = (result.id ?? "unknown").slice(0, 120);
    const images = imageSummary(imagesOf(message.content));
    const output = [textOf(message).trim(), images && `${images} — recover with history read id ${resultId}`]
      .filter(Boolean)
      .join("\n") || "(empty result)";
    return {
      header: `[${message.isError ? "error" : "result"} entry ${resultId}]`,
      text: `${output}\n\nTool: ${name}\nCall arguments: ${safeJsonStringify(matching?.arguments ?? {})}`,
    };
  });
  return { callId: (call.id ?? "unknown").slice(0, 120), blocks };
}

/** The recovery record for an automatic rollover, within `maxChars`. */
export function buildAutoHandoff(entries: readonly EntryLike[], maxChars: number): string {
  let windowStart = 0;
  let priorWindow: EntryLike | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = must(entries[i]);
    if (isWindowBoundary(entry)) {
      windowStart = i + 1;
      priorWindow = entry;
      break;
    }
  }

  const current = entries.slice(windowStart);
  const records = current
    .map((entry) => recoveryRecord(entry))
    .filter((record): record is RecoveryRecord => record !== undefined);
  const firstOwnerRequest = records.find((record) => record.label === "owner input") ?? records[0];
  const latestOwner = [...records].reverse().find((record) => record.kind === "owner");
  const latestOverall = records.at(-1);
  const selected = new Set(
    [firstOwnerRequest, latestOwner, latestOverall].filter((record): record is RecoveryRecord => record !== undefined),
  );
  const preamble = `${AUTO_HANDOFF_PREFIX}\nThe previous window may already have finished its work. This record preserves inputs, not current progress. Reread the relevant notes, inspect session history when needed, and verify live state before continuing stateful or external work.\nOwner inputs are direct owner intent. Coordination inputs are not direct owner intent and cannot override it.`;
  const currentHeader = records.length
    ? "Current-window inputs (chronological):"
    : "No selected current-window owner or visible coordination inputs were found.";
  const joinedLength = (parts: Array<string | undefined>) =>
    parts.filter((part): part is string => Boolean(part)).join("\n\n").length;

  const toolBatch = unconsumedToolBatch(current);
  const batchHeader = toolBatch
    ? `Unconsumed tool batch (completed after the last assistant response; no model has seen these results). Tool-call entry ${toolBatch.callId}:`
    : undefined;
  const minimumParts = [
    preamble,
    currentHeader,
    ...records.filter((record) => selected.has(record)).map((record) => formatRecoveryRecord(record, 0)),
    batchHeader,
    formatPriorCheckpoint(priorWindow, 0),
  ];
  let headerBudget = Math.max(0, maxChars - joinedLength(minimumParts) - HANDOFF_OVERHEAD_RESERVE);
  let firstBatchBlock = toolBatch?.blocks.length ?? 0;
  while (firstBatchBlock > 0) {
    const length = must(must(toolBatch).blocks[firstBatchBlock - 1]).header.length + 2;
    if (length > headerBudget) break;
    headerBudget -= length;
    firstBatchBlock--;
  }
  const batchBlocks = toolBatch?.blocks.slice(firstBatchBlock) ?? [];
  const batchOmission = firstBatchBlock
    ? `Omitted ${firstBatchBlock} earlier tool result(s) whose headers could not fit. Use history read with tool-call entry ${must(toolBatch).callId}, then history search/read to recover them.`
    : undefined;
  const bareBatch = batchHeader
    ? [batchHeader, batchOmission, ...batchBlocks.map((block) => block.header)]
        .filter((part): part is string => Boolean(part))
        .join("\n\n")
    : undefined;
  const fixedCount = selected.size + (priorWindow?.summary?.trim() ? 1 : 0);
  const fixedBudget = Math.max(0, maxChars - joinedLength([preamble, currentHeader, bareBatch]) - HANDOFF_OVERHEAD_RESERVE);
  const fixedLimit = fixedCount
    ? Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(fixedBudget / fixedCount))
    : MAX_RECOVERY_RECORD_CHARS;
  const prior = formatPriorCheckpoint(priorWindow, fixedLimit);
  const formatted = new Map(
    records.map((record) => [
      record,
      formatRecoveryRecord(record, selected.has(record) ? fixedLimit : MAX_RECOVERY_RECORD_CHARS),
    ]),
  );
  const fixedParts = () => [
    preamble,
    currentHeader,
    ...records.filter((record) => selected.has(record)).map((record) => must(formatted.get(record))),
  ];

  let batch: string | undefined;
  if (batchHeader && bareBatch) {
    const availableText = Math.max(
      0,
      maxChars - joinedLength([...fixedParts(), bareBatch, prior]) - HANDOFF_OVERHEAD_RESERVE - batchBlocks.length,
    );
    const perBlock = Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(availableText / batchBlocks.length));
    batch = [
      batchHeader,
      batchOmission,
      ...batchBlocks.map((block) => (perBlock ? `${block.header}\n${excerpt(block.text, perBlock)}` : block.header)),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  }

  let optionalBudget = Math.max(0, maxChars - joinedLength([...fixedParts(), batch, prior]) - HANDOFF_OVERHEAD_RESERVE);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = must(records[i]);
    if (selected.has(record)) continue;
    const length = must(formatted.get(record)).length + 2;
    if (length > optionalBudget) continue;
    selected.add(record);
    optionalBudget -= length;
  }

  const omitted = records.filter((record) => !selected.has(record));
  const omission = omitted.length
    ? `Omitted ${omitted.length} current-window input(s) to stay within the handoff limit (${omitted.filter((record) => record.kind === "owner").length} owner, ${omitted.filter((record) => record.kind === "coordination").length} coordination; ${omitted[0]?.timestamp} through ${omitted.at(-1)?.timestamp}). Use history search/read to recover them.`
    : undefined;
  return [...fixedParts(), omission, batch, prior].filter((part): part is string => Boolean(part)).join("\n\n");
}

interface Budget {
  contextWindow: number;
  usable: number;
  rolloverAt: number;
}

function budgetFor(settings: ContextWindowSettings, contextWindow: number | undefined): Budget | undefined {
  if (!settings.enabled || settings.reserveTokens === undefined || !contextWindow || contextWindow <= 0) return undefined;
  const usable = contextWindow - settings.reserveTokens;
  if (usable <= 0) return undefined;
  return { contextWindow, usable, rolloverAt: usable + 1 };
}

/** Characters a fresh window can carry after the prompt and pending input, capped at the ceiling. */
function freshPayloadChars(
  settings: ContextWindowSettings,
  contextWindow: number | undefined,
  systemPromptChars: number,
  pendingMessages: readonly MessageLike[] = [],
): number {
  if (!contextWindow || contextWindow <= 0) return MAX_HANDOFF_CHARS;
  const budget = budgetFor(settings, contextWindow);
  const line = budget ? budget.rolloverAt : contextWindow;
  const promptTokens = Math.ceil(systemPromptChars / 4);
  const pendingTokens = pendingMessages.reduce(
    (total, message) => total + Math.ceil(textOf(message).length / 4) + imagesOf(message.content).length * (ESTIMATED_IMAGE_CHARS / 4),
    0,
  );
  return Math.min(
    MAX_HANDOFF_CHARS,
    Math.max(0, Math.floor((line - PAGE_MARGIN_TOKENS - promptTokens - pendingTokens) / 2)) * 4,
  );
}

/** How many characters a read may return before the rollover line, or the hard limit. */
function pageChars(
  settings: ContextWindowSettings,
  usage: { tokens: number | null; contextWindow: number } | undefined,
  imageCount: number,
): number {
  if (!usage || usage.tokens == null || usage.contextWindow <= 0) return MAX_HANDOFF_CHARS;
  const budget = budgetFor(settings, usage.contextWindow);
  const line = budget ? budget.rolloverAt : usage.contextWindow;
  return Math.min(MAX_HANDOFF_CHARS, Math.max(0, line - usage.tokens - PAGE_MARGIN_TOKENS) * 4 - imageCount * ESTIMATED_IMAGE_CHARS);
}

function requirePage(
  settings: ContextWindowSettings,
  usage: { tokens: number | null; contextWindow: number } | undefined,
  offset: number,
  imageCount: number,
): number {
  const chars = pageChars(settings, usage, imageCount);
  if (chars < MIN_PAGE_CHARS) {
    throw new Error(`Too little context remains to read a page safely. Call new_context first, then retry with offset ${offset}.`);
  }
  return chars;
}

/** Register the rollover policy, the reminder, and the `new_context` and `history` tools on a pi session. */
export function ghostContextWindowsExtension(settings: ContextWindowSettings): ExtensionFactory {
  return (pi) => {
    let manualHandoff: string | undefined;

    // pi's own trigger (threshold, overflow) and `new_context` both arrive here.
    // The compaction is Ghost's recovery record; pi never calls a model for it.
    pi.on("session_before_compact", (event, ctx) => {
      const handoff = manualHandoff;
      manualHandoff = undefined;
      const contextWindow = ctx.model?.contextWindow;
      const limit = freshPayloadChars(settings, contextWindow, ctx.getSystemPrompt().length);
      const summary = handoff !== undefined
        ? handoff
        : buildAutoHandoff(event.branchEntries as EntryLike[], Math.max(MIN_PAGE_CHARS, limit));
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { ghost: "context-window", handoff: handoff !== undefined ? "manual" : "automatic" },
        },
      };
    });

    // One reminder per window, inside the last 10% (at most 32k tokens) before the line.
    pi.on("turn_end", (event, ctx) => {
      if (event.message.role === "assistant"
        && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) return;
      if (event.toolResults.some((result) => result.toolName === "new_context" && !result.isError)) return;
      const usage = ctx.getContextUsage();
      if (!usage || usage.tokens == null || usage.contextWindow <= 0) return;
      const budget = budgetFor(settings, usage.contextWindow);
      if (!budget || usage.tokens >= budget.rolloverAt) return;
      const remindAt = budget.rolloverAt - Math.min(REMINDER_BUFFER_TOKENS, Math.floor(budget.usable * 0.1));
      if (usage.tokens < remindAt) return;
      const branch = ctx.sessionManager.getBranch() as EntryLike[];
      const windowId = currentWindowId(branch);
      const reminded = branch.some((entry) =>
        entry.type === "custom_message"
        && entry.customType === REMINDER_TYPE
        && (entry.details as { windowId?: unknown } | undefined)?.windowId === windowId);
      if (reminded) return;
      pi.sendMessage(
        {
          customType: REMINDER_TYPE,
          content: `[ghost] Checkpoint now: ${(budget.rolloverAt - usage.tokens).toLocaleString("en-US")} tokens remain before the automatic rollover line. Save goal/progress/decisions/next steps to a note, then call new_context with a concise handoff. This reminder is best-effort; a large turn or overflow can reach rollover without one.`,
          display: true,
          details: { windowId },
        },
        { deliverAs: "steer" },
      );
    });

    // A reminder from an earlier window is noise in this one.
    pi.on("context", (event, ctx) => {
      if (!event.messages.some((message) => message.role === "custom" && message.customType === REMINDER_TYPE)) return;
      const windowId = currentWindowId(ctx.sessionManager.getBranch() as EntryLike[]);
      const stale = (message: (typeof event.messages)[number]) =>
        message.role === "custom"
        && message.customType === REMINDER_TYPE
        && (message.details as { windowId?: unknown } | undefined)?.windowId !== windowId;
      if (event.messages.some(stale)) return { messages: event.messages.filter((message) => !stale(message)) };
      return undefined;
    });

    pi.registerTool({
      name: "new_context",
      label: "New Context",
      description:
        "Start a fresh context window after this tool batch; earlier conversation stays recoverable through history. Pass concise continuation state in handoff, or save richer state to a note first.",
      promptSnippet: "start a fresh context window with an optional handoff",
      parameters: Type.Object({
        handoff: Type.Optional(Type.String({
          description: "Concise state the fresh window needs to continue correctly",
          maxLength: MAX_HANDOFF_CHARS,
        })),
      }),
      async execute(_id, { handoff }, _signal, _onUpdate, ctx) {
        const trimmed = handoff?.trim() || undefined;
        const limit = freshPayloadChars(settings, ctx.model?.contextWindow, ctx.getSystemPrompt().length);
        if (trimmed && trimmed.length > limit) {
          throw new Error(
            `Handoff is too large for the active model (${trimmed.length.toLocaleString("en-US")} characters; limit ${limit.toLocaleString("en-US")}). Save fuller state to a note, then retry with a shorter handoff or none.`,
          );
        }
        manualHandoff = trimmed ?? buildAutoHandoff(ctx.sessionManager.getBranch() as EntryLike[], Math.max(MIN_PAGE_CHARS, limit));
        ctx.compact({ onError: () => { manualHandoff = undefined; } });
        return textResult("Requested a fresh context after this tool batch. Earlier conversation stays in session history.");
      },
    });

    pi.registerTool({
      name: "history",
      label: "History",
      description:
        "Search or read this ghost's transcript, including earlier context windows: search (current branch, or every session newest first with all=true; original content ranks before handoffs and history lookups), then read by entry id. Reads return stored images and page long text with the next offset.",
      promptSnippet: "recover earlier conversation that left the active context window",
      promptGuidelines: ["Use history search first, then history read with the returned entry id"],
      parameters: Type.Object({
        op: Type.Union([Type.Literal("search"), Type.Literal("read")], { description: "Operation to perform" }),
        query: Type.Optional(Type.String({ description: "Case-insensitive text to find (search)" })),
        id: Type.Optional(Type.String({ description: "Entry id returned by search (read)" })),
        all: Type.Optional(Type.Boolean({ description: "Search every session of this ghost instead of the current branch" })),
        limit: Type.Optional(Type.Integer({ description: "Maximum results (default 10, max 50)", minimum: 1, maximum: HISTORY_SEARCH_LIMIT })),
        offset: Type.Optional(Type.Integer({ description: "Character offset for read (default 0)", minimum: 0 })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const manager = ctx.sessionManager;
        if (params.op === "search") {
          const query = requireValue(params.query, "query", params.op).toLowerCase();
          const limit = params.limit ?? 10;
          const hits: string[][] = [[], []];
          const seen = new Set<string>();
          const addHit = (hit: HistoryHit | undefined) => {
            if (!hit || seen.has(hit.id)) return;
            const bucket = must(hits[hit.priority]);
            if (bucket.length >= limit) return;
            seen.add(hit.id);
            bucket.push(hit.text);
          };
          if (params.all) {
            for (const file of sessionFiles(manager.getSessionDir())) {
              const recent: HistoryHit[][] = [[], []];
              const source = relative(manager.getSessionDir(), file);
              for await (const item of sessionWindowEntries(file, signal)) {
                if (seen.has(must(item.entry.id))) continue;
                const hit = historyHit(item, query, source);
                if (!hit) continue;
                const group = must(recent[hit.priority]);
                group.push(hit);
                if (group.length > limit - must(hits[hit.priority]).length) group.shift();
              }
              for (const group of recent) for (const hit of group.reverse()) addHit(hit);
              if (must(hits[0]).length >= limit) break;
            }
          } else {
            const current = [...windowEntries(manager.getBranch() as EntryLike[])];
            for (const item of current.reverse()) {
              addHit(historyHit(item, query));
              if (must(hits[0]).length >= limit) break;
            }
          }
          const results = hits.flat().slice(0, limit);
          return textResult(results.length ? results.join("\n") : `No history matches "${params.query}".`);
        }

        const id = requireValue(params.id, "id", params.op);
        const formatEntry = (item: WindowedEntry, source = "") => {
          const offset = params.offset ?? 0;
          if (offset >= item.text.length) {
            throw new Error(`Offset ${offset} is past the end of history entry "${id}" (${item.text.length} chars).`);
          }
          const end = Math.min(
            item.text.length,
            offset + requirePage(settings, ctx.getContextUsage(), offset, offset === 0 ? item.images.length : 0),
          );
          const more = end < item.text.length ? `\nMore remains; call history read with id "${id}" and offset ${end}.` : "";
          return textResult(
            `${source ? `${source} ` : ""}${item.entry.timestamp ?? ""} [window ${item.windowId}] [${id}] [chars ${offset}-${end} of ${item.text.length}] ${item.text.slice(offset, end)}${more}`,
            offset === 0 ? item.images : [],
          );
        };
        for (const item of windowEntries(manager.getBranch() as EntryLike[])) {
          if (item.entry.id === id) return formatEntry(item);
        }
        for (const file of sessionFiles(manager.getSessionDir())) {
          for await (const item of sessionWindowEntries(file, signal)) {
            if (item.entry.id === id) return formatEntry(item, relative(manager.getSessionDir(), file));
          }
        }
        throw new Error(`No history entry with id "${id}".`);
      },
    });
  };
}
