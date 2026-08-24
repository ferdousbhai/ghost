/**
 * The daemon's seam onto `@ghost/extensions`.
 *
 * `packages/extensions` owns what a ghost *is* — the persona, memory, and
 * docs extensions plus the `ghost-home/v1` reader. The daemon owns how one
 * *runs*. This module is the whole of the boundary between them: the rest of
 * the daemon never imports the extensions package directly, so a change in
 * its shape is a change in one file here.
 *
 * Two things come across the seam per session:
 *
 * - the composed extension factory (persona + memory + docs over one home
 *   and one scope), and
 * - the scope-specific Ghost tool names. They are additive metadata for a
 *   creator session and the complete allowlist for a restricted visitor.
 *
 * Scope is fixed at session construction, never toggled at runtime: nothing
 * the model emits during a turn can widen a visitor into a creator.
 */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import {
  createGhostExtension,
  deriveMemoryIndex,
  deriveDocCatalog,
  ghostToolNamesFor,
  isVisitorScope,
  openGhostHome,
  relayBackend,
  CREATOR_SCOPE,
  visitorScope,
  type BrowserBackendFactory,
  type GhostScope,
  type RelayTransport,
} from "@ghost/extensions";

export type { GhostScope, RelayTransport };
export { CREATOR_SCOPE, isVisitorScope, visitorScope };

/**
 * Ensure one discovered home uses the canonical layout. This also performs the
 * one supported legacy migration: an unambiguous `notes/` directory is renamed
 * atomically to `docs/` before any session can see the home.
 */
export async function ensureGhostHomeLayout(homeDir: string): Promise<void> {
  await openGhostHome(homeDir).ensure();
}

/** How the daemon asks for a session's extension set. */
export interface GhostExtensionOptions {
  /**
   * When set, the session is a visitor's: private docs are structurally
   * unreadable and memory writes land in `memory/.visitors/<id>/`. Omitted,
   * the session is the creator's and sees the whole home.
   */
  visitorId?: string | null;
  /** Overrides the ghost home directory name as the ghost's name. */
  ghostName?: string;
  /**
   * Which browser `ghost_browser` drives. `"relay"` (with a `relayTransport`
   * present) points the tool at the creator's real Chromium; `"profile"` (or
   * no transport) leaves the extension's default per-ghost Playwright profile.
   * Ignored for visitor sessions, which never get the browser tool.
   */
  browserMode?: "relay" | "profile";
  /**
   * The daemon's relay hub, adapted as a transport. Present only when the
   * relay is enabled; the relay backend is built from it per creator session.
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
 * and the session is the creator's; otherwise `undefined` so the extension
 * keeps its Playwright default. A visitor never reaches the relay backend (it
 * would throw), and never gets the browser tool anyway.
 */
function selectBrowserBackend(
  options: GhostExtensionOptions,
  scope: GhostScope,
): BrowserBackendFactory | undefined {
  if (isVisitorScope(scope)) return undefined;
  if (options.browserMode === "profile") return undefined;
  if (!options.relayTransport) return undefined;
  return relayBackend({ transport: options.relayTransport, scope });
}

export interface ResolvedGhostExtensions {
  /** Inline factories passed to OMP's native extension loader. */
  factories: ExtensionFactory[];
  /** Additive creator tools, or the visitor session's complete allowlist. */
  toolNames: string[];
  scope: GhostScope;
}

/**
 * Turn a visitor id into a scope. An invalid id throws (the extensions
 * package refuses ids that would not survive as a path segment) rather than
 * silently degrading to creator scope — failing open here would hand a
 * visitor the creator's private docs.
 */
export function resolveGhostScope(visitorId?: string | null): GhostScope {
  return visitorId ? visitorScope(visitorId) : CREATOR_SCOPE;
}

/**
 * Build the extension set for one session. `homeDir` pins Ghost-owned files to
 * the ghost home even when OMP's native `!cd` changes the conversation cwd.
 * It is still per-session data, never a process-global value, so concurrent
 * ghosts cannot race or share a home.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions = {},
  homeDir?: string,
): ResolvedGhostExtensions {
  const scope = resolveGhostScope(options.visitorId);
  const backend = selectBrowserBackend(options, scope);
  const extensionOptions = {
    scope,
    ...(homeDir === undefined ? {} : { home: homeDir }),
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
    ...(backend === undefined ? {} : { backend }),
    ...(options.extraSections === undefined ? {} : { extraSections: options.extraSections }),
  };
  return {
    factories: [createGhostExtension(extensionOptions)],
    toolNames: ghostToolNamesFor(extensionOptions),
    scope,
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
 * Creator scope only: a greeting opens the owner's own chat window. Derived,
 * never stored, exactly as it is in a session.
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
    home.listMemory(CREATOR_SCOPE),
    home.listDocs(),
  ]);
  return {
    character: character?.body ?? null,
    memoryLines: deriveMemoryIndex(memory.files).lines,
    docLines: deriveDocCatalog(docs.docs, CREATOR_SCOPE).lines,
  };
}
