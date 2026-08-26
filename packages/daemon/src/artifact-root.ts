/**
 * A ghost home is its own extension package root.
 *
 * OMP already knows how to load `skills/`, `agents/`, `commands/`, `rules/`,
 * `prompts/`, `tools/`, and `hooks/` from a package root, so pointing it at the
 * ghost home puts every artifact a ghost owns in plain sight next to
 * `character.md`, `docs/`, and `memory/`, rather than under a dot-directory.
 * Roots merge, so the owner's global skills, agents, and commands keep arriving
 * exactly as they do in pi, codex, or Claude Code.
 *
 * The root has to be declared where OMP reads it back on every rediscovery:
 * `<home>/.omp/settings.json`. Declaring it in memory, or for the duration of
 * one call, is not enough — OMP rediscovers skills whenever the tool surface
 * changes (a ghost's first MCP refresh does it during startup), and a root that
 * lives only in the creating call's async context is gone by then. Reading the
 * file also means plain `omp` run inside a ghost home sees the same artifacts
 * the ghost does.
 *
 * This is the one file in a ghost home the owner never writes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory OMP reads project settings from. */
const OMP_CONFIG_DIRNAME = ".omp";
const OMP_SETTINGS_FILENAME = "settings.json";

/** Relative spelling of the root, resolved by OMP against the ghost home. */
const SELF_ROOT = ".";

/** `<home>/.omp/settings.json`, where OMP reads a project's extension roots. */
export function ghostOmpSettingsPath(homeDir: string): string {
  return join(homeDir, OMP_CONFIG_DIRNAME, OMP_SETTINGS_FILENAME);
}

/**
 * Declare the ghost home as its own extension package root, idempotently.
 *
 * An existing settings file is preserved key for key: only the `extensions`
 * array gains the self-reference, and only when it is missing. A file that is
 * unreadable or not an object is replaced, since OMP would ignore it anyway and
 * a ghost with no artifact root is the more confusing failure.
 */
export function ensureGhostArtifactRoot(homeDir: string): void {
  const path = ghostOmpSettingsPath(homeDir);
  const existing = readSettings(path);
  const roots = Array.isArray(existing.extensions)
    ? existing.extensions.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (roots.includes(SELF_ROOT)) return;

  const next = { ...existing, extensions: [SELF_ROOT, ...roots] };
  mkdirSync(join(homeDir, OMP_CONFIG_DIRNAME), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readSettings(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
