/**
 * Ghost's reading of a pi session transcript on disk: bounded streaming of
 * the leading entries, the conversation title, and the one-time conversion
 * of transcripts written by the Oh My Pi runtime.
 *
 * OMP prefixed every transcript with a fixed-width `title` slot line and
 * wrote titles as `title_change` entries; pi keeps titles as `session_info`
 * entries. Conversion strips the slot, carries the latest title into a
 * `session_info` entry, and leaves every other entry untouched — pi ignores
 * entry types it does not know while keeping them in the tree.
 */
import { createReadStream } from "node:fs";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";

const OMP_TITLE_SLOT_TYPE = "title";
const OMP_TITLE_CHANGE_TYPE = "title_change";

/** Read entries from the start of a transcript until `visit` returns false. */
export async function visitLeadingEntries(
  sessionFile: string,
  visit: (entry: unknown) => boolean,
): Promise<void> {
  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!visit(entry)) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Every entry of a transcript, tolerant of malformed lines like pi's loader. */
export async function readSessionEntries(sessionFile: string): Promise<FileEntry[]> {
  return parseSessionEntries(await readFile(sessionFile, "utf8"));
}

/** One printable line: control characters become spaces, runs collapse, ends trim. */
export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("").replace(/ +/g, " ").trim();
  return normalized || null;
}

/**
 * The title the entries carry: pi's latest `session_info`, else OMP's latest
 * `title_change`, else the OMP header title. An empty `session_info` clears.
 */
export function sessionTitle(entries: readonly unknown[]): string | null {
  let title: string | null = null;
  let fromPi = false;
  for (const entry of entries) {
    const record = entry as { type?: unknown; name?: unknown; title?: unknown } | null;
    if (record?.type === "session_info") {
      title = normalizeTitle(record.name);
      fromPi = true;
    } else if (!fromPi && (record?.type === OMP_TITLE_CHANGE_TYPE || record?.type === "session")) {
      const candidate = normalizeTitle(record.title);
      if (candidate !== null) title = candidate;
    }
  }
  return title;
}

/** Whether a transcript still starts with OMP's title slot. */
export async function hasOmpTitleSlot(sessionFile: string): Promise<boolean> {
  let slot = false;
  await visitLeadingEntries(sessionFile, (entry) => {
    slot = isOmpSlot(entry);
    return false;
  });
  return slot;
}

function isOmpSlot(entry: unknown): boolean {
  return (entry as { type?: unknown } | null)?.type === OMP_TITLE_SLOT_TYPE;
}

/** OMP-era custom messages carried `attribution` at the top level; pi keeps it in `details`. */
function withAttributionInDetails(entry: unknown): unknown {
  const record = entry as { type?: unknown; attribution?: unknown; details?: unknown };
  if (record.type !== "custom_message" || typeof record.attribution !== "string") return entry;
  const { attribution, ...rest } = record;
  const details = rest.details && typeof rest.details === "object" ? rest.details as Record<string, unknown> : {};
  return { ...rest, details: { attribution, ...details } };
}

/**
 * Rewrite an OMP transcript as a pi one in place. Returns whether the file
 * changed. Idempotent: a pi transcript is left untouched.
 */
export async function convertOmpTranscript(sessionFile: string): Promise<boolean> {
  const raw = await readFile(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  });
  if (!parsed.some(isOmpSlot) && !parsed.some((entry) => (entry as { type?: unknown } | null)?.type === OMP_TITLE_CHANGE_TYPE)) {
    return false;
  }
  const kept: unknown[] = [];
  let lastId: string | null = null;
  for (const entry of parsed) {
    if (entry === null || isOmpSlot(entry)) continue;
    kept.push(withAttributionInDetails(entry));
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string") lastId = id;
  }
  const title = sessionTitle(kept);
  const hasSessionInfo = kept.some((entry) => (entry as { type?: unknown } | null)?.type === "session_info");
  if (title && !hasSessionInfo) {
    kept.push({
      type: "session_info",
      id: `ghost-title-${Math.random().toString(36).slice(2, 10)}`,
      parentId: lastId,
      timestamp: new Date().toISOString(),
      name: title,
    });
  }
  const rendered = `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const temporary = `${sessionFile}.${process.pid}.convert.tmp`;
  await writeFile(temporary, rendered, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, sessionFile);
  return true;
}

