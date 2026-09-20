import {
  closeAllBrowserSessions as closeAllExtensionBrowserSessions,
  closeBrowserSession as closeExtensionBrowserSession,
  createGhostExtension,
  ghostToolNames,
  openGhostHome,
  relayBackend,
  type BrowserBackendFactory,
  type CharacterFile,
  type GhostExtensionFactory,
  type GhostToolCapabilitiesSource,
  type GhostToolCapabilitiesResolver,
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
  /**
   * Extra system-prompt sections, appended after the persona's derived ones.
   * Fixed for the session's lifetime — the persona extension reads them into
   * the session-start prompt and reuses that prompt for later turns.
   */
  extraSections?: readonly string[];
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

export const piToolCapabilities: GhostToolCapabilitiesResolver = (context) => ({
  vision: context.model?.input?.includes("image") ?? false,
});

/**
 * Build the extension set for one session. `homeDir` pins Ghost-owned files to
 * the ghost home, apart from the conversation cwd, which is always the owner
 * home. It is still per-session data, never a process-global value, so
 * concurrent ghosts cannot race or share a home.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions,
  homeDir: string | undefined,
  capabilities: GhostToolCapabilitiesSource,
): ResolvedGhostExtensions {
  const extensionOptions = {
    ...(homeDir === undefined ? {} : { home: homeDir }),
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
    backend: browserBackend(options.relayTransport),
    ...(options.extraSections === undefined ? {} : { extraSections: options.extraSections }),
    capabilities,
  };
  return {
    ghost: createGhostExtension(extensionOptions),
    toolNames: ghostToolNames(),
  };
}

/**
 * What the persona prompt is assembled from, read once outside any session.
 *
 * The greeting generator needs the same material the persona extension derives
 * at session start, but it has no `AgentSession` to derive it inside of.
 *
 * Derived, never stored, exactly as it is in a session.
 */
export interface GhostHomeDigest {
  character: string | null;
}

export type GhostHomeDigestInput = "character";

/** Injectable input readers for deterministic failure and isolation tests. */
export interface GhostHomeDigestReaders {
  readonly character?: () => Promise<CharacterFile | null>;
}

export interface GhostHomeDigestReadOptions {
  readonly readers?: GhostHomeDigestReaders;
  readonly onUnavailable?: (input: GhostHomeDigestInput) => void;
}

export async function readGhostHomeDigest(
  homeDir: string,
  options: GhostHomeDigestReadOptions = {},
): Promise<GhostHomeDigest> {
  const home = openGhostHome(homeDir);
  const [characterResult] = await Promise.allSettled([
    Promise.resolve().then(() =>
      options.readers?.character ? options.readers.character() : home.readCharacter()),
  ]);
  if (characterResult.status === "rejected") options.onUnavailable?.("character");
  const character = characterResult.status === "fulfilled" ? characterResult.value : null;
  return { character: character?.body ?? null };
}
