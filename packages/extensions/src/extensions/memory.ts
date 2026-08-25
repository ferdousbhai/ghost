/**
 * Ghost's structured memory writer.
 *
 * Memory is atomic files — one fact per file, a `description` line that becomes
 * that file's line in the derived index, and a body. A write creates or replaces
 * exactly one file; there is no index to keep in sync, because the index is
 * derived per session and never stored.
 *
 * Sessions use OMP's native read/grep/glob tools for discovery and
 * retrieval, avoiding duplicate filesystem-shaped tools. They retain the
 * structured writer because it validates and serializes the atomic memory-file
 * format used by the derived index.
 */
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { MAX_MEMORY_FILE_DESCRIPTION_LENGTH } from "../memory-file.js";
import {
  resolveHome,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_MEMORY_WRITE = "ghost_memory_write";

export const GHOST_MEMORY_TOOL_NAMES = [GHOST_MEMORY_WRITE] as const;

export type MemoryExtensionOptions = GhostExtensionOptions;

/**
 * Build the memory extension. The returned factory is a pi extension: pass it as
 * an inline `extensionFactories` entry, or default-export it from a file on
 * `additionalExtensionPaths`.
 */
export function createMemoryExtension(
  options: MemoryExtensionOptions = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: GHOST_MEMORY_WRITE,
      label: "Write memory",
      description:
        "Write one memory file: a single fact worth keeping, with a one-line "
        + "description for the index. Writing a name that already exists replaces "
        + "that file, which is how you correct or update a memory. Keep unrelated "
        + "facts in separate files, and mention a related memory in the content "
        + "by its slug in double brackets, like [[preferred-tone]].",
      parameters: Type.Object({
        description: Type.String({
          description:
            `One line for the index, ${MAX_MEMORY_FILE_DESCRIPTION_LENGTH} characters `
            + "or fewer, describing what this memory holds.",
        }),
        content: Type.String({
          description: "The fact itself, in your own words.",
        }),
        name: Type.Optional(Type.String({
          description:
            "File name, lowercase words joined by dashes, such as preferred-tone.md. "
            + "Omit it and a name is derived from the description. Reuse an existing "
            + "name to replace that memory.",
        })),
      }),
      // Serialized against other writes to the same file by the home writer's
      // mutation queue; pi runs a batch of tool calls in parallel by default.
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const written = await home.writeMemory({
          description: params.description,
          content: params.content,
          ...(params.name === undefined ? {} : { name: params.name }),
        });
        return textResult(
          `${written.created ? "Wrote" : "Replaced"} ${written.path}.`,
          written,
        );
      },
    });
  };
}

export default createMemoryExtension();
