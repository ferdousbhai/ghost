/**
 * The ghost's own `settings.yml`: a plain YAML mapping read from the visible
 * home only. Ghost reads a handful of dotted keys from it; nothing ambient
 * (environment overlays, machine-wide files) is consulted.
 */
import { parse as parseYaml } from "yaml";
import { ghostPaths } from "./ghosts.js";
import { isRecord } from "./mcp-server-shape.js";
import { MAX_PRIVATE_FILE_BYTES, PrivateReadError, readPrivateFileText } from "./private-file.js";

export interface GhostSettings {
  getString(path: string): string | undefined;
  getStringList(path: string): string[] | undefined;
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
    getStringList: (path) => {
      const value = get(path);
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
    },
  };
}

export function loadGhostSettings(homeDir: string): GhostSettings {
  const paths = ghostPaths(homeDir);
  let text: string;
  try {
    text = readPrivateFileText(paths.settingsFile);
  } catch (error) {
    if (error instanceof PrivateReadError) {
      if (error.refusal === "open"
        && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return ghostSettingsFrom({});
      }
      if (error.refusal === "too_large") {
        throw new Error(
          `Ghost settings file ${JSON.stringify(paths.settingsFile)} exceeds its ${MAX_PRIVATE_FILE_BYTES}-byte limit.`,
          { cause: error },
        );
      }
      // Name the file and the refusal: the bare "read refused" message is
      // unactionable at ghost startup (a symlinked or concurrently rewritten
      // settings.yml lands here).
      throw new Error(
        `Ghost settings file ${JSON.stringify(paths.settingsFile)} could not be read safely (${error.refusal}).`,
        { cause: error },
      );
    }
    throw error;
  }
  return ghostSettingsFrom(parseYaml(text));
}
