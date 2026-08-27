/** Durable per-tool working-directory snapshots for transcript rehydration. */
import { isAbsolute, join } from "node:path";
import {
  readDaemonControlFile,
  writeDaemonControlFile,
} from "./control-file.js";
import { GhostError } from "./ghosts.js";
import { sessionFileNameFor } from "./session-files.js";

const VERSION = 2;
const LEGACY_VERSION = 1;
export const TOOL_CWDS_MAX_BYTES = 16 * 1_048_576;
const SERIALIZED_PREFIX = `{"version":${VERSION},"cwds":[`;
const SERIALIZED_SUFFIX = "]}\n";

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validEntry(entry: readonly unknown[]): entry is readonly [string, string] {
  return entry.length === 2
    && typeof entry[0] === "string"
    && entry[0] !== ""
    && typeof entry[1] === "string"
    && !entry[1].includes("\0")
    && isAbsolute(entry[1]);
}

function decodeToolCwds(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid tool cwd schema");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["version", "cwds"])) {
    throw new Error("invalid tool cwd schema");
  }

  let entries: Array<readonly [string, string]>;
  if (record.version === VERSION) {
    if (!Array.isArray(record.cwds) || !record.cwds.every((entry) =>
      Array.isArray(entry) && validEntry(entry))) {
      throw new Error("invalid tool cwd entry");
    }
    entries = record.cwds;
  } else if (record.version === LEGACY_VERSION) {
    if (!record.cwds || typeof record.cwds !== "object" || Array.isArray(record.cwds)) {
      throw new Error("invalid tool cwd schema");
    }
    entries = Object.entries(record.cwds);
    if (!entries.every(validEntry)) throw new Error("invalid tool cwd entry");
  } else {
    throw new Error("invalid tool cwd schema");
  }

  const result = new Map<string, string>();
  for (const [toolCallId, cwd] of entries) {
    if (result.has(toolCallId)) throw new Error("duplicate tool cwd entry");
    result.set(toolCallId, cwd);
  }
  return result;
}

function serializeBounded(cwds: ReadonlyMap<string, string>): {
  content: string;
  retained: Map<string, string>;
} {
  const serializedEntries: Array<{
    entry: readonly [string, string];
    value: string;
    bytes: number;
  }> = [];
  for (const entry of cwds) {
    if (!validEntry(entry)) throw new Error("invalid tool cwd entry");
    const copy = [entry[0], entry[1]] as const;
    const value = JSON.stringify(copy);
    serializedEntries.push({
      entry: copy,
      value,
      bytes: Buffer.byteLength(value, "utf8"),
    });
  }

  const wrapperBytes = Buffer.byteLength(SERIALIZED_PREFIX + SERIALIZED_SUFFIX, "utf8");
  let first = 0;
  let retainedBytes = serializedEntries.reduce((total, entry) => total + entry.bytes, 0);
  if (serializedEntries.length > 1) retainedBytes += serializedEntries.length - 1;

  while (wrapperBytes + retainedBytes > TOOL_CWDS_MAX_BYTES
    && first < serializedEntries.length) {
    retainedBytes -= serializedEntries[first]?.bytes ?? 0;
    first += 1;
    if (first < serializedEntries.length) retainedBytes -= 1;
  }

  const retainedEntries = serializedEntries.slice(first);
  return {
    content: SERIALIZED_PREFIX
      + retainedEntries.map((entry) => entry.value).join(",")
      + SERIALIZED_SUFFIX,
    retained: new Map(retainedEntries.map((entry) => entry.entry)),
  };
}

export function toolCwdsPath(sessionDir: string, conversationId: string): string {
  const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
  return join(sessionDir, `${stem}.pi.tool-cwds.json`);
}

export async function readToolCwds(
  sessionDir: string,
  conversationId: string,
): Promise<Map<string, string>> {
  try {
    return decodeToolCwds(JSON.parse(await readDaemonControlFile(
      toolCwdsPath(sessionDir, conversationId),
      TOOL_CWDS_MAX_BYTES,
    )) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new GhostError(
      "tool_cwds_invalid",
      "This conversation's stored tool working directories are unreadable.",
      500,
    );
  }
}

export async function writeToolCwds(
  sessionDir: string,
  conversationId: string,
  cwds: ReadonlyMap<string, string>,
  destinationPath = toolCwdsPath(sessionDir, conversationId),
): Promise<Map<string, string>> {
  const serialized = serializeBounded(cwds);
  await writeDaemonControlFile(
    destinationPath,
    serialized.content,
    TOOL_CWDS_MAX_BYTES,
  );
  return serialized.retained;
}
