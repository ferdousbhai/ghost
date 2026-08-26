/**
 * The persona extension: the ghost's system prompt.
 *
 * The Ghost persona is appended to OMP's assembled prompt, preserving the
 * harness's native tool, skill, rule, and project-context guidance. The Ghost
 * section is rebuilt before every agent start, so a doc or memory written
 * mid-session is reflected on the next turn without a session restart.
 *
 * The same pass drops the harness sections a ghost does not carry: the role it
 * would otherwise be told it has, and the rules of a coding task.
 */
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { deriveDocCatalog } from "../catalog.js";
import { deriveMemoryIndex } from "../memory-file.js";
import { buildGhostSystemPrompt, stripHarnessSections } from "../prompt.js";
import { resolveHome, type GhostExtensionOptions } from "./shared.js";

export interface PersonaExtensionOptions extends GhostExtensionOptions {
  /** Overrides the directory name as the ghost's name. */
  readonly ghostName?: string;
  /** Extra sections appended after the derived ones. */
  readonly extraSections?: readonly string[];
}

export function createPersonaExtension(
  options: PersonaExtensionOptions = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event, ctx) => {
      const home = resolveHome(options, ctx);
      const [character, memory, docs] = await Promise.all([
        home.readCharacter(),
        home.listMemory(),
        home.listDocs(),
      ]);
      return {
        systemPrompt: [...event.systemPrompt.map(stripHarnessSections), buildGhostSystemPrompt({
          ghostName: options.ghostName ?? home.name,
          character,
          memory: deriveMemoryIndex(memory.files),
          docs: deriveDocCatalog(docs.docs),
          ...(options.extraSections === undefined
            ? {}
            : { extraSections: options.extraSections }),
        })],
      };
    });
  };
}

/** Persona over the session's own ghost home. */
export default createPersonaExtension();
