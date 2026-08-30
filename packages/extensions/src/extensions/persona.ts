import type { GhostExtensionAPI, GhostExtensionFactory } from "../extension-api.js";
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
): GhostExtensionFactory {
  return (pi: GhostExtensionAPI) => {
    // pi fires `before_agent_start` once per turn, but the character file and
    // the memory/Documents indexes are session-start state: deriving them again
    // mid-conversation only rewrites a prompt prefix the model has already read.
    // One registration is one session, so this closure is the session's scope.
    // Live truth stays on disk, where the native file tools read it.
    let sessionPrompt: string | undefined;
    pi.on("before_agent_start", async (_event, ctx) => {
      const home = resolveHome(options, ctx);
      if (sessionPrompt === undefined) {
        const [character, memory, documents] = await Promise.all([
          home.readCharacter(),
          home.listMemory(),
          resolveDocuments(options).listDirectory("", {
            limit: DOCUMENT_INDEX_MAX_ENTRIES,
          }),
        ]);
        sessionPrompt = buildGhostSystemPrompt({
          ghostName: options.ghostName ?? home.name,
          character,
          memoryRoot: home.memoryDir,
          memory: deriveMemoryIndex(memory.files),
          docs: deriveDocumentsIndex(documents),
          ...(options.extraSections === undefined
            ? {}
            : { extraSections: options.extraSections }),
        });
      }
      return { systemPrompt: [sessionPrompt] };
    });
  };
}

export default createPersonaExtension();
