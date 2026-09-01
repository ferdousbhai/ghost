/**
 * The ghost's own `settings.yml`: a plain YAML mapping read from the visible
 * home only. Ghost reads a handful of dotted keys from it; nothing ambient
 * (environment overlays, machine-wide files) is consulted.
 */
import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ghostPaths } from "./ghosts.js";
import { isRecord } from "./mcp-server-shape.js";

export const GHOST_SETTINGS_MAX_BYTES = 1_048_576;

export interface GhostSettings {
  getString(path: string): string | undefined;
  getStringList(path: string): string[] | undefined;
}

export function ghostSettingsFrom(document: unknown): GhostSettings {
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
    getStringList: (path) => {
      const value = get(path);
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
    },
  };
}

export function loadGhostSettings(homeDir: string): GhostSettings {
  const paths = ghostPaths(homeDir);
  let size: number;
  try {
    size = statSync(paths.settingsFile).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ghostSettingsFrom({});
    throw error;
  }
  if (size > GHOST_SETTINGS_MAX_BYTES) {
    throw new Error(
      `Ghost settings file ${JSON.stringify(paths.settingsFile)} exceeds its ${GHOST_SETTINGS_MAX_BYTES}-byte limit.`,
    );
  }
  return ghostSettingsFrom(parseYaml(readFileSync(paths.settingsFile, "utf8")));
}
