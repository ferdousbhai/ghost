import type { GhostExtensionFactory } from "../extension-api.js";
import { browserToolNames, createBrowserExtension, type BrowserExtensionOptions } from "./browser.js";
import { createDesktopExtension, DESKTOP_TOOLS, type DesktopExtensionOptions } from "./desktop.js";
import { createPersonaExtension, type PersonaExtensionOptions } from "./persona.js";

export type GhostExtensionSetOptions = PersonaExtensionOptions
  & DesktopExtensionOptions
  & BrowserExtensionOptions;

export function ghostToolNames(): string[] {
  return [
    ...DESKTOP_TOOLS,
    ...browserToolNames(),
  ];
}

export function createGhostExtension(
  options: GhostExtensionSetOptions,
): GhostExtensionFactory {
  const persona = createPersonaExtension(options);
  const desktop = createDesktopExtension(options);
  const browser = createBrowserExtension(options);
  return async (pi) => {
    await persona(pi);
    await desktop(pi);
    await browser(pi);
  };
}

export {
  browserSessionFor,
  closeAllBrowserSessions,
  closeBrowserSession,
  createBrowserExtension,
  GHOST_BROWSER,
  type BrowserBackendFactory,
} from "./browser.js";
export {
  RELAY_DISCONNECTED_MESSAGE,
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_CODE_PATTERN,
  relayBackend,
  type RelayOp,
  type RelayReply,
  type RelayRequestOptions,
  type RelayTransport,
} from "./browser-relay-backend.js";
export type { BrowserFailure } from "./browser-backend.js";
export { MAX_SCREENSHOT_BYTES } from "./screenshot-retention.js";
export {
  textResult,
  untrustedTextResult,
  type GhostToolCapabilities,
  type GhostToolCapabilitiesResolver,
  type GhostToolCapabilitiesSource,
} from "./shared.js";
