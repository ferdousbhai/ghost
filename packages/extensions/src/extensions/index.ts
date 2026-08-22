/**
 * The three ghost extensions, and the composition the daemon actually wants:
 * one factory that installs persona, memory, and notes over the same ghost home
 * and scope, plus the tool allowlist that goes with it.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
import { resolveScope } from "./shared.js";

export type GhostExtensionSetOptions = PersonaExtensionOptions;

/**
 * Every tool this package registers for a scope, in the order they should be
 * offered. Pass it as `tools` alongside `noTools: "all"` so the session has the
 * ghost tools and nothing else — no bash, no read, no write.
 */
export function ghostToolNames(scope: GhostScope): string[] {
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
  return names;
}

/** Persona + memory + notes, sharing one home and one scope. */
export function createGhostExtension(
  options: GhostExtensionSetOptions = {},
): ExtensionFactory {
  const persona = createPersonaExtension(options);
  const memory = createMemoryExtension(options);
  const notes = createNotesExtension(options);
  return async (pi) => {
    await persona(pi);
    await memory(pi);
    await notes(pi);
  };
}

/** The tool names available in a session built with these options. */
export function ghostToolNamesFor(options: GhostExtensionSetOptions = {}): string[] {
  return ghostToolNames(resolveScope(options));
}

export * from "./memory.js";
export * from "./notes.js";
export * from "./persona.js";
export * from "./shared.js";
