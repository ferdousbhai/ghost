/**
 * Owner read state for conversations — `sessions/reads.json`.
 *
 * Like pins, this is deliberately stored in the daemon-owned session
 * directory because no transcript can say when the owner last opened it.
 * Reads tolerate missing or hand-edited state, and writes publish by atomic
 * replacement so a listing never observes a partial JSON document.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const READS_FILENAME = "reads.json";
export const READS_VERSION = 2;

export type ConversationReads = Record<string, string>;

export interface ConversationReadState {
  version: 1 | typeof READS_VERSION;
  reads: ConversationReads;
}

/** The read-state file inside one ghost's `sessions/` directory. */
export function readsPath(sessionDir: string): string {
  return join(sessionDir, READS_FILENAME);
}

/**
 * Read validated conversation-id to ISO timestamp entries. Malformed files,
 * ids, and dates are ignored rather than making the session listing fail.
 */
export async function readReadState(sessionDir: string): Promise<ConversationReadState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(readsPath(sessionDir), "utf8"));
  } catch {
    return { version: READS_VERSION, reads: {} };
  }
  const reads = (parsed as { reads?: unknown } | null)?.reads;
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) {
    return { version: READS_VERSION, reads: {} };
  }
  const kept: ConversationReads = {};
  for (const [id, timestamp] of Object.entries(reads)) {
    if (id === "" || typeof timestamp !== "string") continue;
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds)) continue;
    kept[id] = new Date(milliseconds).toISOString();
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== undefined && version !== 1 && version !== READS_VERSION) {
    return { version: READS_VERSION, reads: {} };
  }
  return { version: version === READS_VERSION ? READS_VERSION : 1, reads: kept };
}

/** Compatibility projection for callers that only need the stored map. */
export async function readReads(sessionDir: string): Promise<ConversationReads> {
  return (await readReadState(sessionDir)).reads;
}

/** Atomically replace the read-state file with exactly `reads`. */
export async function writeReads(
  sessionDir: string,
  reads: Readonly<ConversationReads>,
): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const path = readsPath(sessionDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: READS_VERSION, reads }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
