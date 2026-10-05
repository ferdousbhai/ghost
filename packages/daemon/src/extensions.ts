import {
  createGhostExtension,
  relayBackend,
  type BrowserBackendFactory,
  type GhostExtensionFactory,
  type RelayTransport,
} from "@ghost/extensions";

export type { RelayTransport };

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

/** A factory is minted per call; the ghost's first session keeps the one it was built with. */
function browserBackend(transport: RelayTransport | undefined): BrowserBackendFactory {
  return transport === undefined ? NO_RELAY_BACKEND : relayBackend({ transport });
}

/**
 * Ghost's own tools for one ghost. `homeDir` pins Ghost-owned files to the
 * ghost home; it is per-ghost data, never a process-global value, so
 * concurrent ghosts cannot race or share a home.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions,
  homeDir: string | undefined,
): GhostExtensionFactory {
  const extensionOptions = {
    ...(homeDir === undefined ? {} : { home: homeDir }),
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
    backend: browserBackend(options.relayTransport),
  };
  return createGhostExtension(extensionOptions);
}
