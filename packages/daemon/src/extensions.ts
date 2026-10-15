import { createGhostExtension, type GhostExtensionFactory } from "@ghost/extensions";

export function resolveGhostExtensions(): GhostExtensionFactory {
  return createGhostExtension({});
}
