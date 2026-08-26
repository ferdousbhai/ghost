/**
 * The daemon's seam onto `@ghost/extensions`.
 *
 * `packages/extensions` owns what a ghost *is* — the persona, memory, and
 * memory extensions plus the `ghost-home/v1` reader. The daemon owns how one
 * *runs*. This module is the whole of the boundary between them: the rest of
 * the daemon never imports the extensions package directly, so a change in
 * its shape is a change in one file here.
 *
 * Two things come across the seam per session:
 *
 * - the composed extension factory (persona + memory over one home), and
 * - Ghost's additive tool names.
 */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import {
  closeAllBrowserSessions as closeAllExtensionBrowserSessions,
  createGhostExtension,
  deriveMemoryIndex,
  deriveDocCatalog,
  ghostToolNames,
  openGhostHome,
  relayBackend,
  type BrowserBackendFactory,
  type GhostToolCapabilitiesSource,
  type GhostToolCapabilitiesResolver,
  type RelayTransport,
} from "@ghost/extensions";

import { ensureGhostArtifactRoot } from "./artifact-root.js";

export type { RelayTransport };

/** Drain the process-wide browser registry through the one package boundary. */
export async function closeAllBrowserSessions(): Promise<void> {
  await closeAllExtensionBrowserSessions();
}

/**
 * Ensure one discovered home uses the canonical layout: the artifact root
 * declaration, and the one supported legacy migration, an unambiguous `notes/`
 * directory renamed atomically to `docs/` before any session sees the home.
 */
export async function ensureGhostHomeLayout(homeDir: string): Promise<void> {
  await openGhostHome(homeDir).ensure();
  ensureGhostArtifactRoot(homeDir);
}

/** How the daemon asks for a session's extension set. */
export interface GhostExtensionOptions {
  /** Overrides the ghost home directory name as the ghost's name. */
  ghostName?: string;
  /**
   * Which browser `ghost_browser` drives. `"relay"` (with a `relayTransport`
   * present) points the tool at the owner's real Chromium; `"profile"` (or
   * no transport) leaves the extension's default per-ghost Playwright profile.
   */
  browserMode?: "relay" | "profile";
  /**
   * The daemon's relay hub, adapted as a transport. Present only when the
   * relay is enabled; the relay backend is built from it per session.
   */
  relayTransport?: RelayTransport;
  /**
   * Extra system-prompt sections, appended after the persona's derived ones.
   * Fixed for the session's lifetime — the persona extension rebuilds the
   * prompt every turn, but from the sections it was constructed with.
   */
  extraSections?: readonly string[];
}

/**
 * Choose the browser backend for a session. Relay when asked for and available
 * otherwise `undefined` so the extension keeps its Playwright default.
 */
function selectBrowserBackend(
  options: GhostExtensionOptions,
): BrowserBackendFactory | undefined {
  if (options.browserMode === "profile") return undefined;
  if (!options.relayTransport) return undefined;
  return relayBackend({ transport: options.relayTransport });
}

export interface ResolvedGhostExtensions {
  /** Inline factories passed to OMP's native extension loader. */
  factories: ExtensionFactory[];
  /** Ghost-specific tools added to OMP's native tool set. */
  toolNames: string[];
}

/** Preserve OMP's existing per-call model capability behavior exactly. */
export const ompToolCapabilities: GhostToolCapabilitiesResolver = (context) => ({
  vision: context.model?.input?.includes("image") ?? false,
});

/**
 * Build the extension set for one session. `homeDir` pins Ghost-owned files to
 * the ghost home even when OMP's native `!cd` changes the conversation cwd.
 * It is still per-session data, never a process-global value, so concurrent
 * ghosts cannot race or share a home.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions,
  homeDir: string | undefined,
  capabilities: GhostToolCapabilitiesSource,
): ResolvedGhostExtensions {
  const backend = selectBrowserBackend(options);
  const extensionOptions = {
    ...(homeDir === undefined ? {} : { home: homeDir }),
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
    ...(backend === undefined ? {} : { backend }),
    ...(options.extraSections === undefined ? {} : { extraSections: options.extraSections }),
    capabilities,
  };
  return {
    factories: [createGhostExtension(extensionOptions)],
    toolNames: ghostToolNames(),
  };
}

/**
 * What the persona prompt is assembled from, read once outside any session.
 *
 * The greeting generator needs the same material the persona extension derives
 * per turn, but it has no `AgentSession` to derive it inside of — so the read
 * crosses the seam here rather than in `greeting.ts`, which never imports
 * `@ghost/extensions` directly.
 *
 * Derived, never stored, exactly as it is in a session.
 */
export interface GhostHomeDigest {
  /** The character body, or null when there is no character file. */
  character: string | null;
  memoryLines: readonly string[];
  docLines: readonly string[];
}

export async function readGhostHomeDigest(homeDir: string): Promise<GhostHomeDigest> {
  const home = openGhostHome(homeDir);
  const [character, memory, docs] = await Promise.all([
    home.readCharacter(),
    home.listMemory(),
    home.listDocs(),
  ]);
  return {
    character: character?.body ?? null,
    memoryLines: deriveMemoryIndex(memory.files).lines,
    docLines: deriveDocCatalog(docs.docs).lines,
  };
}
