import {
  closeAllBrowserSessions as closeAllExtensionBrowserSessions,
  createGhostExtension,
  deriveMemoryIndex,
  deriveDocumentsIndex,
  DOCUMENT_INDEX_MAX_ENTRIES,
  ghostToolNames,
  MachineDocuments,
  openMachineDocuments,
  openGhostHome,
  relayBackend,
  type BrowserBackendFactory,
  type CharacterFile,
  type DocumentDirectoryPage,
  type DocumentsIndex,
  type GhostExtensionFactory,
  type GhostToolCapabilitiesSource,
  type GhostToolCapabilitiesResolver,
  type MemoryListing,
  type RelayTransport,
} from "@ghost/extensions";

export type { RelayTransport };

/** Drain the process-wide browser registry through the one package boundary. */
export async function closeAllBrowserSessions(): Promise<void> {
  await closeAllExtensionBrowserSessions();
}

/** Ensure one discovered home has the required Ghost-owned directories. */
export async function ensureGhostHomeLayout(homeDir: string): Promise<void> {
  await openGhostHome(homeDir).ensure();
}

export interface GhostExtensionOptions {
  ghostName?: string;
  documents?: MachineDocuments | string;
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
 * A factory is minted per resolver call.
 * That stays cheap only because `browserSessionFor` compares a factory's
 * `sessionIdentity` (`["relay", transport]`) by contents rather than by identity,
 * so a later resolver call's factory matches the cached session's. Widening
 * that comparison to the factory object would make it a configuration conflict.
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
 * the ghost home even when a direct `!cd` changes the conversation cwd.
 * It is still per-session data, never a process-global value, so concurrent
 * ghosts cannot race or share a home.
 */
export function resolveGhostExtensions(
  options: GhostExtensionOptions,
  homeDir: string | undefined,
  capabilities: GhostToolCapabilitiesSource,
): ResolvedGhostExtensions {
  const extensionOptions = {
    ...(homeDir === undefined ? {} : { home: homeDir }),
    ...(options.ghostName === undefined ? {} : { ghostName: options.ghostName }),
    ...(options.documents === undefined ? {} : { documents: options.documents }),
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
 * at session start, but it has no `AgentSession` to derive it inside of — so the
 * read crosses the seam here rather than in `greeting.ts`, which never imports
 * `@ghost/extensions` directly.
 *
 * Derived, never stored, exactly as it is in a session.
 */
export interface GhostHomeDigest {
  character: string | null;
  memoryLines: readonly string[];
  documents: DocumentsIndex;
}

export type GhostHomeDigestInput = "character" | "memory" | "documents";

/** Injectable input readers for deterministic failure and isolation tests. */
export interface GhostHomeDigestReaders {
  readonly character?: () => Promise<CharacterFile | null>;
  readonly memory?: () => Promise<MemoryListing>;
  readonly documents?: () => Promise<DocumentDirectoryPage>;
}

export interface GhostHomeDigestReadOptions {
  readonly readers?: GhostHomeDigestReaders;
  readonly onUnavailable?: (input: GhostHomeDigestInput) => void;
}

export async function readGhostHomeDigest(
  homeDir: string,
  configuredDocuments?: MachineDocuments | string,
  options: GhostHomeDigestReadOptions = {},
): Promise<GhostHomeDigest> {
  const home = openGhostHome(homeDir);
  const settled = await Promise.allSettled([
    Promise.resolve().then(() =>
      options.readers?.character ? options.readers.character() : home.readCharacter()),
    Promise.resolve().then(() =>
      options.readers?.memory ? options.readers.memory() : home.listMemory()),
    Promise.resolve().then(() => {
      if (options.readers?.documents) return options.readers.documents();
      const documents = configuredDocuments instanceof MachineDocuments
        ? configuredDocuments
        : openMachineDocuments(configuredDocuments);
      return documents.listDirectory("", { limit: DOCUMENT_INDEX_MAX_ENTRIES });
    }),
  ]);
  const [characterResult, memoryResult, documentsResult] = settled;
  if (characterResult.status === "rejected") options.onUnavailable?.("character");
  if (memoryResult.status === "rejected") options.onUnavailable?.("memory");
  if (documentsResult.status === "rejected") options.onUnavailable?.("documents");

  const character = characterResult.status === "fulfilled" ? characterResult.value : null;
  const memory = memoryResult.status === "fulfilled"
    ? memoryResult.value
    : { files: [], skipped: [] };
  const documentPage = documentsResult.status === "fulfilled"
    ? documentsResult.value
    : { root: "", path: "", entries: [], total: 0 };
  return {
    character: character?.body ?? null,
    memoryLines: deriveMemoryIndex(memory.files).lines,
    documents: deriveDocumentsIndex(documentPage),
  };
}
