import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import {
  ghostContextWindowsExtension as sharedContextWindowsExtension,
  toWindowedEntry,
  type ContextWindowSettings,
  type EntryLike,
  type WindowedEntry,
} from "@ghost/runtime/context-windows";
export * from "@ghost/runtime/context-windows";

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

export function ghostContextWindowsExtension(settings: ContextWindowSettings) {
  return sharedContextWindowsExtension(settings, {
    files: sessionFiles,
    entries: sessionWindowEntries,
    source: relative,
  });
}
