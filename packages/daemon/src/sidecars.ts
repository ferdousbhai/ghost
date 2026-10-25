/**
 * Per-ghost conversation sidecars in `sessions/`: `pins.json` lists pinned
 * ids in pin order, `reads.json` maps an id to when the owner last read it.
 * Each is replaced whole and privately; a missing, malformed, or hand-edited
 * file reads as empty rather than failing the listing.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPrivateFileText, writePrivateJsonAtomic } from "./private-file.js";
import { isRecord } from "./record.js";

const VERSION = 2;

export const pinsPath = (sessionDir: string): string => join(sessionDir, "pins.json");
export const readsPath = (sessionDir: string): string => join(sessionDir, "reads.json");

function readField(path: string, field: string): unknown {
  try {
    return (JSON.parse(readPrivateFileText(path) ?? "null") as Record<string, unknown> | null)?.[field];
  } catch {
    return undefined;
  }
}

async function write(path: string, document: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writePrivateJsonAtomic(path, { version: VERSION, ...document });
}

/** Pinned ids, deduplicated; anything but a non-empty string is dropped. */
export async function readPins(sessionDir: string): Promise<string[]> {
  const pinned = readField(pinsPath(sessionDir), "pinned");
  if (!Array.isArray(pinned)) return [];
  return [...new Set(pinned.filter((id): id is string => typeof id === "string" && id !== ""))];
}

export function writePins(sessionDir: string, ids: readonly string[]): Promise<void> {
  return write(pinsPath(sessionDir), { pinned: [...ids] });
}

/** Read times by id, as ISO timestamps; an entry without a parseable time is dropped. */
export async function readReads(sessionDir: string): Promise<Record<string, string>> {
  const reads = readField(readsPath(sessionDir), "reads");
  if (!isRecord(reads)) return {};
  const kept: Record<string, string> = {};
  for (const [id, timestamp] of Object.entries(reads)) {
    const milliseconds = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (id !== "" && Number.isFinite(milliseconds)) kept[id] = new Date(milliseconds).toISOString();
  }
  return kept;
}

export function writeReads(sessionDir: string, reads: Readonly<Record<string, string>>): Promise<void> {
  return write(readsPath(sessionDir), { reads });
}
