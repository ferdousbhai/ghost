export { errorMessage, isGhostError } from "./errors.js";
export { isRecord } from "./record.js";

export {
  CHARACTER_FILENAME,
  MAX_CHARACTER_BODY_LENGTH,
  openGhostHome,
} from "./home.js";

export {
  buildGhostSystemPrompt,
  FIRST_MEETING_SECTION,
  isSeededCharacter,
  SEEDED_CHARACTER,
} from "./persona.js";

export {
  collectGhostExtension,
  type CollectedGhostExtension,
  type GhostExtensionFactory,
} from "./extension-api.js";

export { serveMcpTools } from "./mcp-stdio.js";

export { resolveDocumentsDirectory, xdgBaseDir } from "./xdg-user-dirs.js";

export { createDesktopExtension } from "./extensions/desktop.js";
