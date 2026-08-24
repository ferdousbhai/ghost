/**
 * Pinned conversations — `.sessions/pins.json`.
 *
 * Pin state is the one thing in the daemon-owned session dir that is *not*
 * derivable: nothing on disk says a conversation matters to its owner. It is
 * therefore stored, and stored the way the other sidecars in that directory
 * are — one small JSON file, replaced atomically, never appended to.
 *
 * Two properties the listing depends on:
 *
 * 1. **Reading never throws.** A missing, truncated, or hand-edited file reads
 *    as "nothing is pinned". A conversation listing must not fail because of
 *    a file the user could have opened in an editor.
 *
 * 2. **Writing is a rename.** Two daemon processes pinning at the same time
 *    can lose one edit, but neither can leave a half-written file behind for
 *    the next read to trip over.
 *
 * Ids are conversation ids (the pi-messages `options.sessionId`), so the file
 * covers OMP transcripts and Claude Code sidecars alike.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PINS_FILENAME = "pins.json";

/** The pin file inside one ghost's `.sessions/` directory. */
export function pinsPath(sessionDir: string): string {
  return join(sessionDir, PINS_FILENAME);
}

/**
 * The pinned conversation ids, in the order they were written. Deduplicated;
 * anything that is not a non-empty string is dropped. Unreadable or malformed
 * reads as empty.
 */
export async function readPins(sessionDir: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pinsPath(sessionDir), "utf8"));
  } catch {
    return [];
  }
  const pinned = (parsed as { pinned?: unknown } | null)?.pinned;
  if (!Array.isArray(pinned)) return [];
  const ids: string[] = [];
  for (const id of pinned) {
    if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids;
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
    await writeFile(temporary, `${JSON.stringify({ pinned: [...ids] }, null, 2)}\n`, {
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
