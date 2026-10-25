/**
 * The ghost's own `settings.yml`: a plain YAML mapping read from the visible
 * home only. Ghost reads and writes one key in it, `harness`; nothing
 * ambient (environment overlays, machine-wide files) is consulted.
 */
import { isMap, parse as parseYaml, parseDocument } from "yaml";
import { ghostPaths } from "./ghosts.js";
import { isRecord } from "./record.js";
import { readPrivateFileText, writePrivateTextAtomic } from "./private-file.js";

/** The ghost's `harness` setting, or null when it names none. */
export function readHarnessSetting(homeDir: string): string | null {
  const text = readPrivateFileText(ghostPaths(homeDir).settingsFile);
  const document: unknown = text === null ? null : parseYaml(text);
  return isRecord(document) && typeof document.harness === "string" ? document.harness : null;
}

/**
 * Set one top-level key (or remove it, for `null`), keeping the owner's other
 * keys and comments, through a temporary file and one rename.
 */
export async function writeGhostSetting(homeDir: string, key: string, value: string | null): Promise<void> {
  const { settingsFile } = ghostPaths(homeDir);
  const document = parseDocument(readPrivateFileText(settingsFile) ?? "");
  if (document.errors.length > 0) {
    throw new Error(`Ghost settings file ${JSON.stringify(settingsFile)} is not valid YAML; fix it by hand first.`);
  }
  if (value === null) {
    if (!document.has(key)) return;
    document.delete(key);
  } else {
    document.set(key, value);
  }
  // A file left with no keys stays empty rather than becoming `{}`.
  const text = isMap(document.contents) && document.contents.items.length === 0 && !document.commentBefore
    ? ""
    : document.toString();
  await writePrivateTextAtomic(settingsFile, text);
}
