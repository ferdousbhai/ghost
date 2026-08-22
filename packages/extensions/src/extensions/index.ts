/**
 * The ghost extensions, and the composition the daemon actually wants: one
 * factory that installs persona, memory, notes, and the computer-use set
 * (vision, screen, desktop, browser) over the same ghost home and scope, plus
 * the tool allowlist that goes with it.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { browserToolNames, createBrowserExtension, type BrowserExtensionOptions } from "./browser.js";
import { createHyprlandExtension, desktopToolNames, type HyprlandExtensionOptions } from "./hyprland.js";
import { isVisitorScope, type GhostScope } from "../scope.js";
import {
  createMemoryExtension,
  GHOST_MEMORY_LIST,
  GHOST_MEMORY_READ,
  GHOST_MEMORY_WRITE,
} from "./memory.js";
import {
  createNotesExtension,
  GHOST_NOTES_GREP,
  GHOST_NOTES_LIST,
  GHOST_NOTES_READ,
  GHOST_NOTES_WRITE,
} from "./notes.js";
import { createPersonaExtension, type PersonaExtensionOptions } from "./persona.js";
import { createScreenExtension, screenToolNames, type ScreenExtensionOptions } from "./screen.js";
import { createVisionExtension, visionToolNames, type VisionExtensionOptions } from "./vision.js";
import { resolveScope } from "./shared.js";

export type GhostExtensionSetOptions = PersonaExtensionOptions
  & VisionExtensionOptions
  & ScreenExtensionOptions
  & HyprlandExtensionOptions
  & BrowserExtensionOptions;

/**
 * Every tool this package registers for a scope, in the order they should be
 * offered. Pass it as `tools` alongside `noTools: "all"` so the session has the
 * ghost tools and nothing else — no bash, no read, no write.
 */
export function ghostToolNames(
  scope: GhostScope,
  options: GhostExtensionSetOptions = {},
): string[] {
  const names = [
    GHOST_NOTES_LIST,
    GHOST_NOTES_READ,
    GHOST_NOTES_GREP,
    GHOST_MEMORY_LIST,
    GHOST_MEMORY_READ,
    GHOST_MEMORY_WRITE,
  ];
  // A visitor session has no note writer to allow.
  if (!isVisitorScope(scope)) names.push(GHOST_NOTES_WRITE);
  // Computer-use tools: every one of these returns [] in visitor scope.
  const scoped = { ...options, scope };
  names.push(
    ...visionToolNames(scoped),
    ...screenToolNames(scoped),
    ...desktopToolNames(scoped),
    ...browserToolNames(scope),
  );
  return names;
}

/**
 * Persona + memory + notes + computer use (vision fallback, screen, desktop,
 * browser), sharing one home and one scope. The computer-use factories each
 * register nothing in visitor scope, so composing them unconditionally is safe.
 */
export function createGhostExtension(
  options: GhostExtensionSetOptions = {},
): ExtensionFactory {
  const persona = createPersonaExtension(options);
  const memory = createMemoryExtension(options);
  const notes = createNotesExtension(options);
  const vision = createVisionExtension(options);
  const screen = createScreenExtension(options);
  const desktop = createHyprlandExtension(options);
  const browser = createBrowserExtension(options);
  return async (pi) => {
    await persona(pi);
    await memory(pi);
    await notes(pi);
    await vision(pi);
    await screen(pi);
    await desktop(pi);
    await browser(pi);
  };
}

/** The tool names available in a session built with these options. */
export function ghostToolNamesFor(options: GhostExtensionSetOptions = {}): string[] {
  return ghostToolNames(resolveScope(options), options);
}

export * from "./browser.js";
export * from "./browser-relay-backend.js";
/**
 * `browser.js` re-exports the seam's *shapes*; the relay needs its error class and
 * failure vocabulary too, because the daemon translates socket frames into them.
 */
export {
  GhostBrowserError,
  type BackendActionOptions,
  type BackendBackResult,
  type BackendReadResult,
  type BackendScreenshotOptions,
  type BackendTarget,
  type BackendTypeInput,
  type BrowserBackendContext,
  type BrowserFailure,
  type PageSummary,
} from "./browser-backend.js";
export * from "./hyprland.js";
export * from "./memory.js";
export * from "./notes.js";
export * from "./persona.js";
export * from "./screen.js";
export * from "./shared.js";
export * from "./vision.js";
