import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
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

/**
 * Ensure one discovered home uses the canonical layout. The home reader
 * retains hosted archive compatibility, but does not move legacy documents
 * into the owner's live Documents tree.
 */
export async function ensureGhostHomeLayout(homeDir: string): Promise<void> {
  await openGhostHome(homeDir).ensure();
}

export interface GhostExtensionOptions {
  ghostName?: string;
  documents?: MachineDocuments | string;
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
  factories: ExtensionFactory[];
  toolNames: string[];
}

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
    ...(options.documents === undefined ? {} : { documents: options.documents }),
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
