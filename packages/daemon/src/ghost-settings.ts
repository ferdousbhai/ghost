/**
 * The ghost's own `settings.yml`: a plain YAML mapping read from the visible
 * home only. Ghost reads and writes one key in it, `harness`; nothing
 * ambient (environment overlays, machine-wide files) is consulted.
 */
import { isMap, parse as parseYaml, parseDocument } from "yaml";
import { ghostPaths } from "./ghosts.js";
import { isRecord } from "./record.js";
import { readPrivateFileText, writePrivateTextAtomic } from "./private-file.js";

export interface GhostSettings {
  getString(path: string): string | undefined;
}

function ghostSettingsFrom(document: unknown): GhostSettings {
  const root = isRecord(document) ? document : {};
  const get = (path: string): unknown => {
    let current: unknown = root;
    for (const segment of path.split(".")) {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
    return current;
  };
  return {
    getString: (path) => {
      const value = get(path);
      return typeof value === "string" ? value : undefined;
    },
  };
}

export function loadGhostSettings(homeDir: string): GhostSettings {
  const text = readPrivateFileText(ghostPaths(homeDir).settingsFile);
  return ghostSettingsFrom(text === null ? {} : parseYaml(text));
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
