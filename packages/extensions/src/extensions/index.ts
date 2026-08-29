import type { GhostExtensionFactory } from "../extension-api.js";
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

export function createGhostExtension(
  options: GhostExtensionSetOptions,
): GhostExtensionFactory {
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
export {
  GhostBrowserError,
  type BackendActionOptions,
  type BackendBackResult,
  type BackendReadResult,
  type BackendScreenshotOptions,
  type BackendScreenshotResult,
  type BackendTarget,
  type BackendTypeInput,
  type BrowserFailure,
  type PageSummary,
} from "./browser-backend.js";
export * from "./character.js";
export * from "./hyprland.js";
export * from "./memory.js";
export * from "./persona.js";
export * from "./screen.js";
export { untrustedTextResult } from "./shared.js";
export * from "./shared.js";
