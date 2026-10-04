import {
  closeAllBrowserSessions as closeAllExtensionBrowserSessions,
  closeBrowserSession as closeExtensionBrowserSession,
  createGhostExtension,
  ghostToolNames,
  openGhostHome,
  relayBackend,
  type BrowserBackendFactory,
  type GhostExtensionFactory,
  type RelayTransport,
} from "@ghost/extensions";

export type { RelayTransport };

/** Drain the process-wide browser registry through the one package boundary. */
export async function closeAllBrowserSessions(): Promise<void> {
  await closeAllExtensionBrowserSessions();
}

/** Retire the process-wide browser session for one resolved ghost home. */
export async function closeBrowserSession(homeDir: string): Promise<void> {
  await closeExtensionBrowserSession(homeDir);
}

/** Ensure one discovered home has the required Ghost-owned directories. */
export async function ensureGhostHomeLayout(homeDir: string): Promise<void> {
  await openGhostHome(homeDir).ensure();
}

export interface GhostExtensionOptions {
  ghostName?: string;
  /**
   * The daemon's relay hub, adapted as a transport; the browser backend is built
   * from it per session. Absent only when `GHOSTD_RELAY` is off, which leaves the
   * tool reporting that no browser is reachable.
   */
  relayTransport?: RelayTransport;
}

/**
 * No transport means the daemon has no relay hub at all; the backend says so on
 * every call rather than the tool disappearing from the conversation. Hoisted
 * because it captures nothing.
 */
const NO_RELAY_BACKEND = relayBackend({});

/**
 * A factory is minted per resolver call. That is safe because
 * `browserSessionFor`'s changed-settings check deliberately never compares the
 * backend factory: there is one relay, and which factory object wrapped it is
 * not a setting the owner chose, so a later resolver call's factory still
 * matches the cached session.
 */
function browserBackend(transport: RelayTransport | undefined): BrowserBackendFactory {
  return transport === undefined ? NO_RELAY_BACKEND : relayBackend({ transport });
}

export interface ResolvedGhostExtensions {
  /** Ghost's own extension, on the runtime-neutral seam; each runtime adapts it. */
  ghost: GhostExtensionFactory;
  toolNames: string[];
}

/**
 * Build the extension set for one session. `homeDir` pins Ghost-owned files to
 * the ghost home, apart from the conversation cwd, which is always the owner
 * home. It is still per-session data, never a process-global value, so
 * concurrent ghosts cannot race or share a home.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions,
  homeDir: string | undefined,
): ResolvedGhostExtensions {
  const extensionOptions = {
    ...(homeDir === undefined ? {} : { home: homeDir }),
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
    backend: browserBackend(options.relayTransport),
  };
  return {
    ghost: createGhostExtension(extensionOptions),
    toolNames: ghostToolNames(),
  };
}
