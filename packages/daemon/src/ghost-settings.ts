/**
 * The ghost's own `settings.yml`: a plain YAML mapping read from the visible
 * home only. Ghost reads a handful of dotted keys from it; nothing ambient
 * (environment overlays, machine-wide files) is consulted.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ghostPaths } from "./ghosts.js";
import { isRecord } from "./mcp-server-shape.js";

export interface GhostSettings {
  /** The value at a dotted path, or undefined. */
  get(path: string): unknown;
  getString(path: string): string | undefined;
  getBoolean(path: string): boolean | undefined;
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
    get,
    getString: (path) => {
      const value = get(path);
      return typeof value === "string" ? value : undefined;
    },
    getBoolean: (path) => {
      const value = get(path);
      return typeof value === "boolean" ? value : undefined;
    },
    getStringList: (path) => {
      const value = get(path);
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
    },
  };
}

export function loadGhostSettings(homeDir: string): GhostSettings {
  const paths = ghostPaths(homeDir);
  if (!existsSync(paths.settingsFile)) return ghostSettingsFrom({});
  return ghostSettingsFrom(parseYaml(readFileSync(paths.settingsFile, "utf8")));
}
