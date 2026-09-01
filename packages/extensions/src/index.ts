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
  normalizeMemoryText,
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

export * from "./extension-api.js";
export { stringEnum } from "./tool-schema.js";
export * from "./untrusted.js";

export * from "./extensions/index.js";
