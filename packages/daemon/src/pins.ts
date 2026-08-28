import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PINS_FILENAME = "pins.json";
export const PINS_VERSION = 2;

export interface ConversationPins {
  version: 1 | typeof PINS_VERSION;
  pinned: string[];
}

export function pinsPath(sessionDir: string): string {
  return join(sessionDir, PINS_FILENAME);
}

/**
 * The pinned conversation ids, in the order they were written. Deduplicated;
 * anything that is not a non-empty string is dropped. Unreadable or malformed
 * reads as empty.
 */
export async function readPinState(sessionDir: string): Promise<ConversationPins> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pinsPath(sessionDir), "utf8"));
  } catch {
    return { version: PINS_VERSION, pinned: [] };
  }
  const pinned = (parsed as { pinned?: unknown } | null)?.pinned;
  if (!Array.isArray(pinned)) return { version: PINS_VERSION, pinned: [] };
  const ids: string[] = [];
  for (const id of pinned) {
    if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== undefined && version !== 1 && version !== PINS_VERSION) {
    return { version: PINS_VERSION, pinned: [] };
  }
  return { version: version === PINS_VERSION ? PINS_VERSION : 1, pinned: ids };
}

/** Compatibility projection for callers that only need the stored keys. */
export async function readPins(sessionDir: string): Promise<string[]> {
  return (await readPinState(sessionDir)).pinned;
}

/**
 * Replace the pin file with exactly `ids`.
 *
 * The temporary lives beside the destination so `rename` cannot cross a
 * filesystem boundary, and its random, exclusive name keeps two concurrent
 * writers off one staging file. Mode 0600 matches the sibling sidecars.
 */
export async function writePins(sessionDir: string, ids: readonly string[]): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const path = pinsPath(sessionDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: PINS_VERSION, pinned: [...ids] }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    // `writeFile` may create the temporary before throwing, so cleanup cannot
    // depend on the call having returned.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
