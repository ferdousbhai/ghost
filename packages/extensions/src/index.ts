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

export {
  closeAllBrowserSessions,
  closeBrowserSession,
  createGhostExtension,
  MAX_SCREENSHOT_BYTES,
  RELAY_DISCONNECTED_MESSAGE,
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_CODE_PATTERN,
  relayBackend,
  type BrowserBackendFactory,
  isBrowserFailure,
  type BrowserFailure,
  type RelayOp,
  type RelayReply,
  type RelayRequestOptions,
  type RelayTransport,
} from "./extensions/index.js";
