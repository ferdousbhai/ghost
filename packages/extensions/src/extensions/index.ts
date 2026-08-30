import type { GhostExtensionFactory } from "../extension-api.js";
import { browserToolNames, createBrowserExtension, type BrowserExtensionOptions } from "./browser.js";
import { createHyprlandExtension, desktopToolNames, type HyprlandExtensionOptions } from "./hyprland.js";
import { createPersonaExtension, type PersonaExtensionOptions } from "./persona.js";
import { createScreenExtension, screenToolNames, type ScreenExtensionOptions } from "./screen.js";

export type GhostExtensionSetOptions = PersonaExtensionOptions
  & ScreenExtensionOptions
  & HyprlandExtensionOptions
  & BrowserExtensionOptions;

export function ghostToolNames(): string[] {
  return [
    ...screenToolNames(),
    ...desktopToolNames(),
    ...browserToolNames(),
  ];
}

export function createGhostExtension(
  options: GhostExtensionSetOptions,
): GhostExtensionFactory {
  const persona = createPersonaExtension(options);
  const screen = createScreenExtension(options);
  const desktop = createHyprlandExtension(options);
  const browser = createBrowserExtension(options);
  return async (pi) => {
    await persona(pi);
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
export * from "./hyprland.js";
export * from "./persona.js";
export * from "./screen.js";
export { untrustedTextResult } from "./shared.js";
export * from "./shared.js";
