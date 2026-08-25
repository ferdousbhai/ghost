/**
 * The ghost extensions, and the composition the daemon actually wants: one
 * factory that installs persona, character, memory, and the computer-use set
 * (screen, desktop, browser) over the same ghost home.
 */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { browserToolNames, createBrowserExtension, type BrowserExtensionOptions } from "./browser.js";
import {
  characterToolNames,
  createCharacterExtension,
  type CharacterExtensionOptions,
} from "./character.js";
import { createHyprlandExtension, desktopToolNames, type HyprlandExtensionOptions } from "./hyprland.js";
import {
  createMemoryExtension,
  GHOST_MEMORY_WRITE,
} from "./memory.js";
import { createPersonaExtension, type PersonaExtensionOptions } from "./persona.js";
import { createScreenExtension, screenToolNames, type ScreenExtensionOptions } from "./screen.js";

export type GhostExtensionSetOptions = PersonaExtensionOptions
  & CharacterExtensionOptions
  & ScreenExtensionOptions
  & HyprlandExtensionOptions
  & BrowserExtensionOptions;

/**
 * Every Ghost-specific tool this package registers. OMP sessions layer these
 * onto the native tool set.
 */
export function ghostToolNames(): string[] {
  const names = [GHOST_MEMORY_WRITE];
  names.push(...characterToolNames());
  names.push(
    ...screenToolNames(),
    ...desktopToolNames(),
    ...browserToolNames(),
  );
  return names;
}

/**
 * Persona + character + memory + computer use (screen, desktop, browser),
 * sharing one home.
 */
export function createGhostExtension(
  options: GhostExtensionSetOptions = {},
): ExtensionFactory {
  const persona = createPersonaExtension(options);
  const character = createCharacterExtension(options);
  const memory = createMemoryExtension(options);
  const screen = createScreenExtension(options);
  const desktop = createHyprlandExtension(options);
  const browser = createBrowserExtension(options);
  return async (pi) => {
    await persona(pi);
    await character(pi);
    await memory(pi);
    await screen(pi);
    await desktop(pi);
    await browser(pi);
  };
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
export * from "./persona.js";
export * from "./screen.js";
export * from "./shared.js";
