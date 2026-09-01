export { isGhostError } from "./errors.js";

export {
  coerceMemorySlug,
  compareMemoryNewestFirst,
  deriveMemoryIndex,
  MEMORY_INDEX_MAX_ENTRIES,
  memoryFileName,
  REDACTED_MEMORY_SECRET,
  redactMemorySecrets,
} from "./memory-file.js";

export {
  MAX_CHARACTER_BODY_LENGTH,
  GhostHome,
  MEMORY_DIRNAME,
  openGhostHome,
  type MemoryListing,
  type MemoryDeleteIntent,
  type MemoryDeleteReceipt,
  type MemoryWriteIntent,
  type MemoryWriteInput,
  type MemoryWriteReceipt,
  type MemoryWriteResult,
} from "./home.js";

export {
  descriptorPath,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
} from "./linux-fs.js";

export type {
  CharacterFile,
  MemoryRecord,
} from "./types.js";

export {
  buildGhostSystemPrompt,
  type GhostSystemPromptInput,
} from "./prompt.js";

export {
  collectGhostExtension,
  type AnyGhostToolDefinition,
  type CollectedGhostExtension,
  type GhostExtensionFactory,
  type GhostToolContext,
  type GhostToolResult,
} from "./extension-api.js";
export { fenceUntrusted } from "./untrusted.js";

export {
  browserSessionFor,
  closeAllBrowserSessions,
  closeBrowserSession,
  createBrowserExtension,
  createGhostExtension,
  createScreenExtension,
  GHOST_BROWSER,
  GHOST_SCREEN,
  ghostToolNames,
  MAX_SCREENSHOT_BYTES,
  RELAY_DISCONNECTED_MESSAGE,
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
  relayBackend,
  textResult,
  untrustedTextResult,
  type BrowserBackendFactory,
  type BrowserFailure,
  type GhostToolCapabilities,
  type GhostToolCapabilitiesResolver,
  type GhostToolCapabilitiesSource,
  type RelayOp,
  type RelayReply,
  type RelayRequestOptions,
  type RelayTransport,
} from "./extensions/index.js";
