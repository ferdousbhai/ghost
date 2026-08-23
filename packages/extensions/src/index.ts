/**
 * `@ghost/extensions` — the OMP extensions that make a plain-file ghost home
 * behave like a persona, plus the typed reader/writer for that layout.
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
  assertWritableMemory,
  coerceMemorySlug,
  deriveMemoryIndex,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  MAX_MEMORY_FILE_DESCRIPTION_LENGTH,
  MAX_MEMORY_FILE_SLUG_LENGTH,
  MAX_MEMORY_FILES_PER_SCOPE,
  MEMORY_INDEX_BUDGET_CHARS,
  memoryFileName,
  memorySlugForText,
  normalizeMemoryText,
  parseMemoryFile,
  parseMemoryFileName,
  serializeMemoryFile,
  type MemoryFileMeta,
  type MemoryIndex,
  type ParsedMemoryFile,
} from "./memory-file.js";

export {
  CREATOR_SCOPE,
  describeScope,
  isVisitorScope,
  visitorScope,
  type GhostScope,
} from "./scope.js";

export {
  deriveNoteCatalog,
  isNoteVisible,
  NOTE_CATALOG_BUDGET_CHARS,
  visibleNotes,
} from "./catalog.js";

export {
  CHARACTER_FILENAME,
  CONVERSATIONS_DIRNAME,
  EXPORT_MANIFEST_FILENAME,
  GhostHome,
  MEMORY_DIRNAME,
  normalizeNotePath,
  NOTES_DIRNAME,
  openGhostHome,
  VISITORS_DIRNAME,
  type MemoryListing,
  type MemoryWriteInput,
  type MemoryWriteResult,
  type NoteListing,
  type NoteSearchMatch,
  type NoteSearchOptions,
  type NoteSearchResult,
  type NoteWriteInput,
  type SkippedFile,
} from "./home.js";

export {
  GHOST_HOME_FORMAT,
  type CharacterFile,
  type MemoryRecord,
  type NoteCatalog,
  type NoteFile,
  type NoteFrontmatter,
  type NoteMeta,
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

export * from "./extensions/index.js";
