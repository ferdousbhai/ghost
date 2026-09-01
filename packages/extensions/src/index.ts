export {
  GhostError,
  isGhostError,
  MemoryFileFormatError,
  type GhostErrorCode,
} from "./errors.js";

export {
  assertWritableMemory,
  coerceMemorySlug,
  compareMemoryNewestFirst,
  deriveMemoryIndex,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  MAX_MEMORY_FILE_SLUG_LENGTH,
  MAX_MEMORY_FILES,
  MEMORY_INDEX_BUDGET_CHARS,
  MEMORY_INDEX_MAX_ENTRIES,
  memoryFileName,
  memorySlugForText,
  parseMemoryFile,
  parseMemoryFileName,
  REDACTED_MEMORY_SECRET,
  redactMemorySecrets,
  serializeMemoryFile,
  type MemoryFileMeta,
  type MemoryIndex,
  type ParsedMemoryFile,
} from "./memory-file.js";

export {
  CHARACTER_FILENAME,
  MAX_CHARACTER_BODY_LENGTH,
  GhostHome,
  MEMORY_DIRNAME,
  MEMORY_TRASH_DIRNAME,
  openGhostHome,
  type GhostHomeOptions,
  type MemoryReadStage,
  type MemoryListing,
  type MemoryDeleteIntent,
  type MemoryDeleteReceipt,
  type MemoryDeleteResult,
  type MemoryDeleteWithReceiptResult,
  type MemoryWriteIntent,
  type MemoryWriteInput,
  type MemoryWriteReceipt,
  type MemoryWriteResult,
  type MemoryWriteWithReceiptResult,
  type SkippedFile,
} from "./home.js";

export {
  descriptorPath,
  openConfinedDirectory,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
  withDescriptorLock,
} from "./linux-fs.js";

export {
  GHOST_HOME_FORMAT,
  type CharacterFile,
  type MemoryRecord,
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
export { stringEnum } from "./tool-schema.js";
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
