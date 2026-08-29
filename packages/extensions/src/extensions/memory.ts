import { Type } from "typebox";
import type { GhostExtensionAPI, GhostExtensionFactory } from "../extension-api.js";
import {
  resolveHome,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_MEMORY_WRITE = "ghost_memory_write";

export const GHOST_MEMORY_TOOL_NAMES = [GHOST_MEMORY_WRITE] as const;

export type MemoryExtensionOptions = GhostExtensionOptions;

export function createMemoryExtension(
  options: MemoryExtensionOptions = {},
): GhostExtensionFactory {
  return (pi: GhostExtensionAPI) => {
    pi.registerTool({
      name: GHOST_MEMORY_WRITE,
      label: "Write memory",
      description:
        "Write one memory file: a single concise fact worth keeping. Writing a "
        + "name that already exists replaces "
        + "that file, which is how you correct or update a memory. Keep unrelated "
        + "facts in separate files, and mention a related memory in the content "
        + "by its slug in double brackets, like [[preferred-tone]].",
      parameters: Type.Object({
        content: Type.String({
          description:
            "One concise fact, in your own words. This is the entire Markdown file.",
        }),
        name: Type.Optional(Type.String({
          description:
            "File name, lowercase words joined by dashes, such as preferred-tone.md. "
            + "The memory index shows only names, so make it say what the fact is "
            + "about. Omit it and a name is derived from the fact. Reuse an existing "
            + "name to replace that memory.",
        })),
      }),
      // Serialized against other writes to the same file by the home writer's
      // mutation queue; pi runs a batch of tool calls in parallel by default.
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const written = await home.writeMemory({
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
