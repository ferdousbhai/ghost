/**
 * Per-ghost conversation sidecars in `sessions/`: `pins.json` lists pinned
 * ids in pin order, `reads.json` maps an id to when the owner last read it,
 * `questions.json` maps an id to the question the ghost is waiting on.
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
export const questionsPath = (sessionDir: string): string => join(sessionDir, "questions.json");

/** What a ghost asked the owner in one conversation, waiting for their next message. */
export interface OwnerQuestion {
  text: string;
  /** Suggested answers; the owner may answer anything. */
  options: string[];
  askedAt: string;
}

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

/** Open questions by conversation id; an entry without text or a parseable time is dropped. */
export async function readQuestions(sessionDir: string): Promise<Record<string, OwnerQuestion>> {
  const questions = readField(questionsPath(sessionDir), "questions");
  if (!isRecord(questions)) return {};
  const kept: Record<string, OwnerQuestion> = {};
  for (const [id, entry] of Object.entries(questions)) {
    if (id === "" || !isRecord(entry) || typeof entry.text !== "string" || entry.text === "") continue;
    const askedAt = typeof entry.askedAt === "string" ? Date.parse(entry.askedAt) : Number.NaN;
    if (!Number.isFinite(askedAt)) continue;
    const options = Array.isArray(entry.options)
      ? entry.options.filter((option): option is string => typeof option === "string" && option !== "")
      : [];
    kept[id] = { text: entry.text, options, askedAt: new Date(askedAt).toISOString() };
  }
  return kept;
}

export function writeQuestions(sessionDir: string, questions: Readonly<Record<string, OwnerQuestion>>): Promise<void> {
  return write(questionsPath(sessionDir), { questions });
}
