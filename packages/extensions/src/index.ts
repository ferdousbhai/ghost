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

export { resolveDocumentsDirectory, xdgBaseDir } from "./xdg-user-dirs.js";
