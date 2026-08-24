/**
 * The ghost extensions, and the composition the daemon actually wants: one
 * factory that installs persona, character, memory, notes, and the computer-use
 * set (screen, desktop, browser) over the same ghost home and scope,
 * plus the visitor-only tool allowlist that goes with it.
 */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { browserToolNames, createBrowserExtension, type BrowserExtensionOptions } from "./browser.js";
import {
  characterToolNames,
  createCharacterExtension,
  type CharacterExtensionOptions,
} from "./character.js";
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
} from "./notes.js";
import { createPersonaExtension, type PersonaExtensionOptions } from "./persona.js";
import { createScreenExtension, screenToolNames, type ScreenExtensionOptions } from "./screen.js";
import { resolveScope } from "./shared.js";

export type GhostExtensionSetOptions = PersonaExtensionOptions
  & CharacterExtensionOptions
  & ScreenExtensionOptions
  & HyprlandExtensionOptions
  & BrowserExtensionOptions;

/**
 * Every Ghost-specific tool this package registers for a scope. Creator OMP
 * sessions layer these onto the native tool set; visitor sessions use this as
 * their complete allowlist because native filesystem access would bypass note
 * publication and visitor memory scoping.
 */
export function ghostToolNames(
  scope: GhostScope,
  options: GhostExtensionSetOptions = {},
): string[] {
  const names = isVisitorScope(scope)
    ? [
        GHOST_NOTES_LIST,
        GHOST_NOTES_READ,
        GHOST_NOTES_GREP,
        GHOST_MEMORY_LIST,
        GHOST_MEMORY_READ,
        GHOST_MEMORY_WRITE,
      ]
    : [GHOST_MEMORY_WRITE];
  // Creator-only: a visitor never rewrites the persona.
  const scoped = { ...options, scope };
  names.push(...characterToolNames(scoped));
  // Computer-use tools: every one of these returns [] in visitor scope.
  names.push(
    ...screenToolNames(scoped),
    ...desktopToolNames(scoped),
    ...browserToolNames(scope),
  );
  return names;
}

/**
 * Persona + character + memory + notes + computer use (screen, desktop,
 * browser), sharing one home and one scope. The character and
 * computer-use factories each register nothing in visitor scope, so composing
 * them unconditionally is safe.
 */
export function createGhostExtension(
  options: GhostExtensionSetOptions = {},
): ExtensionFactory {
  const persona = createPersonaExtension(options);
  const character = createCharacterExtension(options);
  const memory = createMemoryExtension(options);
  const notes = createNotesExtension(options);
  const screen = createScreenExtension(options);
  const desktop = createHyprlandExtension(options);
  const browser = createBrowserExtension(options);
  return async (pi) => {
    await persona(pi);
    await character(pi);
    await memory(pi);
    await notes(pi);
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
export * from "./character.js";
export * from "./hyprland.js";
export * from "./memory.js";
export * from "./notes.js";
export * from "./persona.js";
export * from "./screen.js";
export * from "./shared.js";
