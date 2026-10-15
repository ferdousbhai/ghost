import { createDesktopExtension, type DesktopExtensionOptions } from "./desktop.js";

export type GhostExtensionSetOptions = DesktopExtensionOptions;
export const createGhostExtension = createDesktopExtension;
