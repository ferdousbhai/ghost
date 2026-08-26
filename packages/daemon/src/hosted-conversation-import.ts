/**
 * Materialize the hosted export's `conversations/*.json` fixtures as native
 * OMP sessions. The fixture remains the lossless hosted wire shape while its
 * `sessions/` projection exists; user-triggered conversation deletion moves
 * both artifacts to trash so the fixture cannot recreate a deleted chat.
 */
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AssistantMessage,
  ImageContent,
  StopReason,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@oh-my-pi/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  type CustomEntry,
  type SessionEntry,
  type SessionHeader,
  type SessionMessageEntry,
  type TitleChangeEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { sessionFileNameFor } from "./session-files.js";

const HOSTED_CONVERSATIONS_DIRNAME = "conversations";
const NATIVE_SESSIONS_DIRNAME = "sessions";
const IMPORT_FORMAT_VERSION = 1;

interface HostedCatalog {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface HostedMessage {
  id: string;
  role: "user" | "assistant";
  parts: HostedPart[];
  createdAt?: string;
  metadata?: {
    createdAt?: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
}

interface HostedPart {
  type: string;
  [key: string]: unknown;
}

interface HostedConversation {
  id: string;
  catalog: HostedCatalog;
  messages: HostedMessage[];
}

export interface HostedConversationImportFailure {
  source: string;
  error: string;
}

export interface HostedConversationImportResult {
  /** Hosted JSON fixtures found. */
  found: number;
  /** New native OMP sessions published. */
  imported: number;
  /** Native targets that already existed and were deliberately left alone. */
  existing: number;
  /** Fixtures that could not be projected; each source file remains untouched. */
  failures: HostedConversationImportFailure[];
}

/**
 * Find every valid hosted fixture capable of recreating one native session.
 * Malformed siblings are migration diagnostics, not deletion targets.
 */
export async function hostedConversationSourcePaths(
  ghostHome: string,
  conversationId: string,
): Promise<string[]> {
  const conversationsDir = join(ghostHome, HOSTED_CONVERSATIONS_DIRNAME);
  let sourceNames: string[];
  try {
    sourceNames = (await readdir(conversationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const matches: string[] = [];
  for (const sourceName of sourceNames) {
    const sourcePath = join(conversationsDir, sourceName);
    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const source = parseHostedConversation(JSON.parse(raw));
      if (source.id === conversationId) matches.push(sourcePath);
    } catch {
      // A malformed fixture could not have produced the native projection.
    }
  }
  return matches;
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  options: { empty?: boolean } = {},
): string {
  if (typeof value !== "string" || (!options.empty && value.length === 0)) {
    throw new Error(`${field} must be ${options.empty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function isoTimestamp(value: unknown, field: string): { iso: string; ms: number } {
  const source = requiredString(value, field);
  const ms = Date.parse(source);
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO timestamp.`);
  return { iso: new Date(ms).toISOString(), ms };
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseHostedConversation(value: unknown): HostedConversation {
  if (!isRecord(value)) throw new Error("conversation must be an object.");
  const id = requiredString(value.id, "id");
  if (!isRecord(value.catalog)) throw new Error("catalog must be an object.");
  const catalogId = requiredString(value.catalog.id, "catalog.id");
  if (catalogId !== id) throw new Error("catalog.id must match id.");
  const catalog: HostedCatalog = {
    id: catalogId,
    title: requiredString(value.catalog.title, "catalog.title", { empty: true }),
    createdAt: isoTimestamp(value.catalog.createdAt, "catalog.createdAt").iso,
    updatedAt: isoTimestamp(value.catalog.updatedAt, "catalog.updatedAt").iso,
  };
  if (!Array.isArray(value.messages)) throw new Error("messages must be an array.");
  const seenMessageIds = new Set<string>();
  const messages = value.messages.map((candidate, index): HostedMessage => {
    if (!isRecord(candidate)) throw new Error(`messages[${index}] must be an object.`);
    const messageId = requiredString(candidate.id, `messages[${index}].id`);
    if (seenMessageIds.has(messageId)) {
      throw new Error(`messages[${index}].id duplicates ${JSON.stringify(messageId)}.`);
    }
    seenMessageIds.add(messageId);
    if (candidate.role !== "user" && candidate.role !== "assistant") {
      throw new Error(`messages[${index}].role must be user or assistant.`);
    }
    if (!Array.isArray(candidate.parts)) {
      throw new Error(`messages[${index}].parts must be an array.`);
    }
    const parts = candidate.parts.map((part, partIndex): HostedPart => {
      if (!isRecord(part)) {
        throw new Error(`messages[${index}].parts[${partIndex}] must be an object.`);
      }
      return { ...part, type: requiredString(part.type, `messages[${index}].parts[${partIndex}].type`) };
    });
    const message: HostedMessage = { id: messageId, role: candidate.role, parts };
    if (candidate.createdAt !== undefined) {
      message.createdAt = isoTimestamp(candidate.createdAt, `messages[${index}].createdAt`).iso;
    }
    if (candidate.metadata !== undefined) {
      if (!isRecord(candidate.metadata)) {
        throw new Error(`messages[${index}].metadata must be an object.`);
      }
      const metadata: NonNullable<HostedMessage["metadata"]> = { ...candidate.metadata };
      if (candidate.metadata.createdAt !== undefined) {
        metadata.createdAt = isoTimestamp(
          candidate.metadata.createdAt,
          `messages[${index}].metadata.createdAt`,
        ).iso;
      }
      message.metadata = metadata;
    }
    return message;
  });
  return { id, catalog, messages };
}

function messageTimestamp(
  message: HostedMessage,
  index: number,
  count: number,
  createdMs: number,
  updatedMs: number,
): number {
  const explicit = message.createdAt ?? message.metadata?.createdAt;
  if (explicit !== undefined) return Date.parse(explicit);
  const span = Math.max(0, updatedMs - createdMs);
  return createdMs + Math.round((span * (index + 1)) / (count + 1));
}

function displayJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "(No output was included in the hosted export.)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function dataImage(part: HostedPart): ImageContent | null {
  if (part.type !== "file" || typeof part.url !== "string") return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.url);
  if (!match) return null;
  return { type: "image", mimeType: match[1] as string, data: match[2] as string };
}

function userContent(parts: readonly HostedPart[]): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "file") {
      const label = typeof part.filename === "string" ? part.filename : "hosted attachment";
      content.push({ type: "text", text: `[Attachment: ${label}]` });
      const image = dataImage(part);
      if (image) content.push(image);
      else if (typeof part.url === "string") content.push({ type: "text", text: part.url });
      continue;
    }
    content.push({ type: "text", text: `[Hosted ${part.type} part]\n${displayJson(part)}` });
  }
  return content;
}

function assistantGroups(parts: readonly HostedPart[]): HostedPart[][] {
  const groups: HostedPart[][] = [];
  let current: HostedPart[] = [];
  for (const part of parts) {
    if (part.type === "step-start") {
      if (current.length > 0) groups.push(current);
      current = [];
    } else {
      current.push(part);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [[]];
}

function toolName(part: HostedPart): string {
  if (typeof part.toolName === "string" && part.toolName.trim()) return part.toolName;
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

function toolArguments(part: HostedPart): Record<string, unknown> {
  return isRecord(part.input) ? part.input : { value: part.input };
}

function usageFor(message: HostedMessage): Usage {
  const input = optionalFiniteNumber(message.metadata?.inputTokens) ?? 0;
  const output = optionalFiniteNumber(message.metadata?.outputTokens) ?? 0;
  const total = optionalFiniteNumber(message.metadata?.totalTokens) ?? input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { ...ZERO_COST },
  };
}

function stopReasonFor(message: HostedMessage, hasTools: boolean): StopReason {
  if (hasTools) return "toolUse";
  switch (message.metadata?.finishReason) {
    case "length":
      return "length";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return "stop";
  }
}

function fitTitle(title: string, updatedAt: string): { title: string; slot: string } {
  let fitted = Array.from(title, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? " "
      : character;
  }).join("").trim().split(/ +/).join(" ");
  fitted = Array.from(fitted)
    .slice(0, 120)
    .join("");
  while (true) {
    try {
      return {
        title: fitted,
        slot: serializeTitleSlot({ title: fitted, source: "auto", updatedAt }),
      };
    } catch (error) {
      const characters = Array.from(fitted);
      if (characters.length === 0) throw error;
      characters.pop();
      fitted = characters.join("").trimEnd();
    }
  }
}

function buildNativeSession(
  source: HostedConversation,
  sourceName: string,
  ghostHome: string,
): string {
  const created = isoTimestamp(source.catalog.createdAt, "catalog.createdAt");
  const updated = isoTimestamp(source.catalog.updatedAt, "catalog.updatedAt");
  const { title, slot } = fitTitle(source.catalog.title, updated.iso);
  // See CONTRACTS.md's ghost-home section for the reviewed OMP session-format
  // writer exception and the invariant required before publication.
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: source.id,
    timestamp: created.iso,
    cwd: ghostHome,
    ...(title ? { title, titleSource: "auto" } : {}),
  };
  const entries: SessionEntry[] = [];
  const reserved = new Set(source.messages.map((message) => message.id));
  const used = new Set<string>();
  let parentId: string | null = null;

  const derivedId = (base: string): string => {
    let id = base;
    let suffix = 2;
    while (reserved.has(id) || used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return id;
  };
  const append = (entry: SessionEntry): void => {
    if (used.has(entry.id)) throw new Error(`Native entry id collision at ${JSON.stringify(entry.id)}.`);
    used.add(entry.id);
    entries.push(entry);
    parentId = entry.id;
  };

  for (const [messageIndex, hosted] of source.messages.entries()) {
    const baseMs = messageTimestamp(
      hosted,
      messageIndex,
      source.messages.length,
      created.ms,
      updated.ms,
    );
    if (hosted.role === "user") {
      const message: UserMessage = {
        role: "user",
        content: userContent(hosted.parts),
        attribution: "user",
        timestamp: baseMs,
      };
      append({
        type: "message",
        id: hosted.id,
        parentId,
        timestamp: new Date(baseMs).toISOString(),
        message,
      });
      continue;
    }

    const groups = assistantGroups(hosted.parts);
    for (const [groupIndex, parts] of groups.entries()) {
      const assistantContent: AssistantMessage["content"] = [];
      const results: Array<{ call: ToolCall; part: HostedPart }> = [];
      for (const [partIndex, part] of parts.entries()) {
        if (part.type === "text" && typeof part.text === "string") {
          assistantContent.push({ type: "text", text: part.text });
        } else if (part.type === "source-url" && typeof part.url === "string") {
          const label = typeof part.title === "string" && part.title.trim()
            ? part.title.trim()
            : "Source";
          assistantContent.push({ type: "text", text: `\n\n${label}: ${part.url}` });
        } else if (part.type === "data-server-tool") {
          assistantContent.push({
            type: "text",
            text: `\n\n[Hosted tool data]\n${displayJson(part.data)}`,
          });
        } else if (part.type.startsWith("tool-")) {
          const callId = typeof part.toolCallId === "string" && part.toolCallId
            ? part.toolCallId
            : `${hosted.id}-call-${groupIndex + 1}-${partIndex + 1}`;
          const call: ToolCall = {
            type: "toolCall",
            id: callId,
            name: toolName(part),
            arguments: toolArguments(part),
          };
          assistantContent.push(call);
          results.push({ call, part });
        } else {
          assistantContent.push({
            type: "text",
            text: `[Hosted ${part.type} part]\n${displayJson(part)}`,
          });
        }
      }
      if (assistantContent.length === 0) {
        assistantContent.push({ type: "text", text: "[Empty hosted assistant step]" });
      }
      const entryId = groupIndex === 0
        ? hosted.id
        : derivedId(`${hosted.id}-step-${groupIndex + 1}`);
      const timestamp = baseMs + groupIndex * 2;
      const isFinalGroup = groupIndex === groups.length - 1;
      const assistant: AssistantMessage = {
        role: "assistant",
        content: assistantContent,
        api: "openai-completions",
        provider: "summon-ghost",
        model: "hosted-export",
        usage: isFinalGroup ? usageFor(hosted) : {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { ...ZERO_COST },
        },
        stopReason: stopReasonFor(hosted, results.length > 0),
        timestamp,
      };
      append({
        type: "message",
        id: entryId,
        parentId,
        timestamp: new Date(timestamp).toISOString(),
        message: assistant,
      });
      for (const [resultIndex, { call, part }] of results.entries()) {
        const isError = part.state === "output-error" || part.errorText !== undefined;
        const output = isError ? part.errorText : part.output;
        const resultTimestamp = timestamp + resultIndex + 1;
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: displayJson(output) }],
          details: { hostedPartType: part.type, state: part.state },
          isError,
          attribution: "agent",
          timestamp: resultTimestamp,
        };
        const resultEntry: SessionMessageEntry = {
          type: "message",
          id: derivedId(`${entryId}-result-${resultIndex + 1}`),
          parentId,
          timestamp: new Date(resultTimestamp).toISOString(),
          message: result,
        };
        append(resultEntry);
      }
    }
  }

  const marker: CustomEntry = {
    type: "custom",
    id: derivedId(`hosted-import-${source.id}`),
    parentId,
    timestamp: updated.iso,
    customType: "ghost_hosted_conversation_import",
    data: {
      version: IMPORT_FORMAT_VERSION,
      source: `${HOSTED_CONVERSATIONS_DIRNAME}/${sourceName}`,
      sourceConversationId: source.id,
    },
  };
  append(marker);
  if (title) {
    const titleChange: TitleChangeEntry = {
      type: "title_change",
      id: derivedId(`hosted-title-${source.id}`),
      parentId,
      timestamp: updated.iso,
      title,
      source: "auto",
      trigger: "ghost-hosted-import",
    };
    append(titleChange);
  }

  return `${slot}${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeNativeSession(
  body: string,
  target: string,
  sessionDir: string,
  ghostHome: string,
  updatedAt: string,
): Promise<"imported" | "existing"> {
  if (await exists(target)) return "existing";
  const temporary = join(sessionDir, `.hosted-import-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Validate the exact bytes before publishing them into SessionManager.list.
    const manager = await SessionManager.open(
      temporary,
      sessionDir,
      undefined,
      { initialCwd: ghostHome, suppressBreadcrumb: true },
    );
    await manager.close();
    const modified = isoTimestamp(updatedAt, "catalog.updatedAt");
    await utimes(temporary, modified.ms / 1_000, modified.ms / 1_000);

    try {
      // Hard-link publication is atomic and, unlike rename, refuses to replace
      // a native conversation that appeared while conversion was running.
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    }
    return "imported";
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/**
 * Convert every valid hosted fixture in one ghost home. Per-file failures are
 * reported instead of making an otherwise healthy ghost unavailable.
 */
export async function migrateHostedConversations(
  ghostHome: string,
): Promise<HostedConversationImportResult> {
  const conversationsDir = join(ghostHome, HOSTED_CONVERSATIONS_DIRNAME);
  let sourceNames: string[];
  try {
    sourceNames = (await readdir(conversationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: 0, imported: 0, existing: 0, failures: [] };
    }
    throw error;
  }
  const sessionDir = join(ghostHome, NATIVE_SESSIONS_DIRNAME);
  await mkdir(sessionDir, { recursive: true });

  const result: HostedConversationImportResult = {
    found: sourceNames.length,
    imported: 0,
    existing: 0,
    failures: [],
  };
  for (const sourceName of sourceNames) {
    const sourcePath = join(conversationsDir, sourceName);
    try {
      const source = parseHostedConversation(JSON.parse(await readFile(sourcePath, "utf8")));
      const target = join(sessionDir, sessionFileNameFor(source.id));
      const status = await writeNativeSession(
        buildNativeSession(source, basename(sourceName), ghostHome),
        target,
        sessionDir,
        ghostHome,
        source.catalog.updatedAt,
      );
      result[status] += 1;
    } catch (error) {
      result.failures.push({
        source: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
