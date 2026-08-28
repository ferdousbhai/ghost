/**
 * The persona extension: the ghost's system prompt.
 *
 * Ghost replaces OMP's assembled prompt. The prompt is rebuilt before every
 * agent start, so a doc or memory written mid-session is reflected on the next
 * turn without a session restart.
 */
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { deriveDocumentsIndex } from "../catalog.js";
import {
  DOCUMENT_INDEX_MAX_ENTRIES,
  MachineDocuments,
  openMachineDocuments,
} from "../documents.js";
import { deriveMemoryIndex } from "../memory-file.js";
import { buildGhostSystemPrompt } from "../prompt.js";
import { resolveHome, type GhostExtensionOptions } from "./shared.js";

export interface PersonaExtensionOptions extends GhostExtensionOptions {
  readonly ghostName?: string;
  readonly documents?: MachineDocuments | string;
  readonly extraSections?: readonly string[];
}

function resolveDocuments(options: PersonaExtensionOptions): MachineDocuments {
  if (options.documents instanceof MachineDocuments) return options.documents;
  return openMachineDocuments(options.documents);
}

export function createPersonaExtension(
  options: PersonaExtensionOptions = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (_event, ctx) => {
      const home = resolveHome(options, ctx);
      const [character, memory, documents] = await Promise.all([
        home.readCharacter(),
        home.listMemory(),
        resolveDocuments(options).listDirectory("", {
          limit: DOCUMENT_INDEX_MAX_ENTRIES,
        }),
      ]);
      return {
        systemPrompt: [buildGhostSystemPrompt({
          ghostName: options.ghostName ?? home.name,
          character,
          memoryRoot: home.memoryDir,
          memory: deriveMemoryIndex(memory.files),
          docs: deriveDocumentsIndex(documents),
          ...(options.extraSections === undefined
            ? {}
            : { extraSections: options.extraSections }),
        })],
      };
    });
  };
}

export default createPersonaExtension();
