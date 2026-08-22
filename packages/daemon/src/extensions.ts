/**
 * The daemon's seam onto `@ghost/extensions`.
 *
 * `packages/extensions` owns what a ghost *is* — the persona, memory, and
 * notes extensions plus the `ghost-home/v1` reader. The daemon owns how one
 * *runs*. This module is the whole of the boundary between them: the rest of
 * the daemon never imports the extensions package directly, so a change in
 * its shape is a change in one file here.
 *
 * Two things come across the seam per session:
 *
 * - the composed extension factory (persona + memory + notes over one home
 *   and one scope), and
 * - the tool allowlist that goes with that scope, which the daemon passes to
 *   `createAgentSession` as `tools` alongside `noTools: "all"`. The daemon
 *   does not name any tool itself; a visitor session simply gets a shorter
 *   list (no note writer) because the scope says so.
 *
 * Scope is fixed at session construction, never toggled at runtime: nothing
 * the model emits during a turn can widen a visitor into a creator.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  createGhostExtension,
  ghostToolNamesFor,
  CREATOR_SCOPE,
  visitorScope,
  type GhostScope,
} from "@ghost/extensions";

export type { GhostScope };
export { CREATOR_SCOPE, visitorScope };

/** How the daemon asks for a session's extension set. */
export interface GhostExtensionOptions {
  /**
   * When set, the session is a visitor's: private notes are structurally
   * unreadable and memory writes land in `memory/.visitors/<id>/`. Omitted,
   * the session is the creator's and sees the whole home.
   */
  visitorId?: string | null;
  /** Overrides the ghost home directory name as the ghost's name. */
  ghostName?: string;
}

export interface ResolvedGhostExtensions {
  /** Inline factories for `DefaultResourceLoader({ extensionFactories })`. */
  factories: InlineExtension[];
  /** Tool allowlist for `createAgentSession({ noTools: "all", tools })`. */
  toolNames: string[];
  scope: GhostScope;
}

/**
 * Turn a visitor id into a scope. An invalid id throws (the extensions
 * package refuses ids that would not survive as a path segment) rather than
 * silently degrading to creator scope — failing open here would hand a
 * visitor the creator's private notes.
 */
export function resolveGhostScope(visitorId?: string | null): GhostScope {
  return visitorId ? visitorScope(visitorId) : CREATOR_SCOPE;
}

/**
 * Build the extension set for one session. The ghost home is NOT passed:
 * every extension resolves it from `ctx.cwd`, which the daemon sets to the
 * ghost home, so one process can host many ghosts concurrently without a
 * shared global to race over.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions = {},
): ResolvedGhostExtensions {
  const scope = resolveGhostScope(options.visitorId);
  const extensionOptions = {
    scope,
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
  };
  return {
    factories: [{ name: "ghost", factory: createGhostExtension(extensionOptions) }],
    toolNames: ghostToolNamesFor(extensionOptions),
    scope,
  };
}
