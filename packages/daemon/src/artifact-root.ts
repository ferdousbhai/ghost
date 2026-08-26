/**
 * Ghost-owned loading for the visible OMP artifact directories.
 *
 * OMP's invocation scope is the narrow dependency boundary: it lets Ghost
 * name the home directly and exclude OMP's configured/installed package roots
 * while the ordinary Agents, Codex, and Claude providers still contribute the
 * owner's global skills, agents, and commands. Session methods can rediscover
 * capabilities long after construction, so callers must enter this scope for
 * every such operation rather than relying on creation-time async context.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { withOmpExtensionRootScope } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

export function withGhostArtifactRoot<T>(homeDir: string, operation: () => T): T {
  return withOmpExtensionRootScope([homeDir], "explicit-only", operation);
}

/**
 * JS/TS hooks execute as OMP extensions rather than passive capability rows.
 * Preloading only these paths avoids treating arbitrary files in the home as
 * extension modules when the home is also the package root.
 */
export async function ghostHookExtensionPaths(homeDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const kind of ["pre", "post"] as const) {
    const dir = join(homeDir, "hooks", kind);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!(entry.isFile() || entry.isSymbolicLink())) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
      paths.push(join(dir, entry.name));
    }
  }
  return paths;
}

/** Keep OMP's public rediscovery entry point pinned to this ghost's root. */
export function scopeGhostSessionArtifactRediscovery(
  session: AgentSession,
  homeDir: string,
): void {
  const refreshSkills = session.refreshSkills.bind(session);
  session.refreshSkills = () => withGhostArtifactRoot(homeDir, refreshSkills);

  const prompt = session.prompt.bind(session);
  session.prompt = (...args) => withGhostArtifactRoot(homeDir, () => prompt(...args));
}
