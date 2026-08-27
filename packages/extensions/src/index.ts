/**
 * `@ghost/extensions` — the OMP extensions that make a plain-file ghost home
 * behave like a persona, plus typed readers for that layout and the owner's
 * shared machine Documents tree.
 *
 * Boundary (CONTRACTS.md): no HTTP, no daemon lifecycle, no session management.
 * Anything about *how an agent runs* is OMP's; anything about *what a ghost is*
 * lives here.
 */
export {
  GhostError,
  isGhostError,
  MemoryFileFormatError,
  type GhostErrorCode,
} from "./errors.js";

export {
  parseDocument,
  parseFrontmatterLines,
  renderDocument,
  sanitizePathSegment,
  splitFrontmatter,
  yamlFlowList,
  yamlScalar,
  type FrontmatterRecord,
  type FrontmatterValue,
  type ParsedDocument,
  type SplitDocument,
} from "./frontmatter.js";

export {
  migrateDoc,
  parseDoc,
  renderDoc,
  slugifyDocTag,
  type DocRenderInput,
  type ParsedDoc,
} from "./doc-format.js";

export {
  assertWritableMemory,
  coerceMemorySlug,
  deriveMemoryIndex,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  MAX_MEMORY_FILE_SLUG_LENGTH,
  MAX_MEMORY_FILES,
  MEMORY_INDEX_BUDGET_CHARS,
  MEMORY_INDEX_PREVIEW_CHARS,
  memoryFileName,
  memoryIndexPreview,
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
  deriveDocumentsIndex,
  DOC_CATALOG_BUDGET_CHARS,
} from "./catalog.js";

export {
  DOCUMENT_INDEX_BUDGET_CHARS,
  DOCUMENT_INDEX_MAX_ENTRIES,
  DOCUMENT_INLINE_MAX_BYTES,
  DOCUMENT_LIST_DEFAULT_LIMIT,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_QUERY_MAX_CHARS,
  MachineDocuments,
  normalizeDocumentsDirectoryPath,
  normalizeDocumentsFilePath,
  openMachineDocuments,
  resolveDocumentsDirectory,
  type DocumentDirectoryEntry,
  type DocumentDirectoryPage,
  type DocumentEntryKind,
  type DocumentTextContent,
  type ListDocumentDirectoryOptions,
  type ResolveDocumentsDirectoryOptions,
  type SkippedDocumentEntry,
} from "./documents.js";

export {
  CHARACTER_FILENAME,
  CONVERSATIONS_DIRNAME,
  EXPORT_MANIFEST_FILENAME,
  GhostHome,
  MEMORY_DIRNAME,
  MEMORY_TRASH_DIRNAME,
  DOCS_DIRNAME,
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
  type DocumentsIndex,
} from "./types.js";

export {
  importGhostArchive,
  type GhostArchiveManifest,
  type ImportGhostArchiveOptions,
  type ImportGhostArchiveResult,
} from "./import.js";

export {
  buildGhostSystemPrompt,
  type GhostSystemPromptInput,
} from "./prompt.js";

export * from "./untrusted.js";

export * from "./extensions/index.js";
