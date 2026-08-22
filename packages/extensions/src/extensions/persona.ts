/**
 * The persona extension: the ghost's system prompt.
 *
 * `before_agent_start` returning `systemPrompt` replaces pi's assembled prompt
 * wholesale — the spike captured the provider-side request and confirmed zero
 * bytes of the coding-agent prompt survive (report §3). The prompt is rebuilt on
 * every agent start, so a note published or a memory written mid-session is
 * reflected on the next turn without a session restart.
 *
 * For the replacement to be complete the daemon must also pass
 * `noContextFiles`, `noSkills`, `noPromptTemplates`, and
 * `appendSystemPromptOverride: () => []` when creating the session; otherwise
 * AGENTS.md and APPEND_SYSTEM.md above the ghost home leak into the persona
 * (report §6.3). That is the daemon's half of this contract.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { deriveNoteCatalog } from "../catalog.js";
import { deriveMemoryIndex } from "../memory-file.js";
import { buildGhostSystemPrompt } from "../prompt.js";
import { resolveHome, resolveScope, type GhostExtensionOptions } from "./shared.js";

export interface PersonaExtensionOptions extends GhostExtensionOptions {
  /** Overrides the directory name as the ghost's name. */
  readonly ghostName?: string;
  /** Extra sections appended after the derived ones. */
  readonly extraSections?: readonly string[];
}

export function createPersonaExtension(
  options: PersonaExtensionOptions = {},
): ExtensionFactory {
  const scope = resolveScope(options);

  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (_event, ctx) => {
      const home = resolveHome(options, ctx);
      const [character, memory, notes] = await Promise.all([
        home.readCharacter(),
        home.listMemory(scope),
        home.listNotes(),
      ]);
      return {
        // Returned, not appended: this IS the system prompt.
        systemPrompt: buildGhostSystemPrompt({
          ghostName: options.ghostName ?? home.name,
          character,
          memory: deriveMemoryIndex(memory.files),
          notes: deriveNoteCatalog(notes.notes, scope),
          scope,
          ...(options.extraSections === undefined
            ? {}
            : { extraSections: options.extraSections }),
        }),
      };
    });
  };
}

/** Creator-view persona over the session's own ghost home. */
export default createPersonaExtension();
