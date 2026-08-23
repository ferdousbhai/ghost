/**
 * Ghost's structured memory writer, plus scoped visitor access tools.
 *
 * Memory is atomic files — one fact per file, a `description` line that becomes
 * that file's line in the derived index, and a body. A write creates or replaces
 * exactly one file; there is no index to keep in sync, because the index is
 * derived per session and never stored.
 *
 * Creator sessions use OMP's native read/grep/glob tools for discovery and
 * retrieval, avoiding duplicate filesystem-shaped tools. They retain the
 * structured writer because it validates and serializes the atomic memory-file
 * format used by the derived index. Visitor sessions cannot receive native
 * filesystem tools, so they also receive the scoped list/read operations.
 */
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { deriveMemoryIndex, MAX_MEMORY_FILE_DESCRIPTION_LENGTH } from "../memory-file.js";
import { describeScope, isVisitorScope } from "../scope.js";
import {
  resolveHome,
  resolveScope,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_MEMORY_LIST = "ghost_memory_list";
export const GHOST_MEMORY_READ = "ghost_memory_read";
export const GHOST_MEMORY_WRITE = "ghost_memory_write";

export const GHOST_MEMORY_TOOL_NAMES = [
  GHOST_MEMORY_LIST,
  GHOST_MEMORY_READ,
  GHOST_MEMORY_WRITE,
] as const;

export type MemoryExtensionOptions = GhostExtensionOptions;

/**
 * Build the memory extension. The returned factory is a pi extension: pass it as
 * an inline `extensionFactories` entry, or default-export it from a file on
 * `additionalExtensionPaths`.
 */
export function createMemoryExtension(
  options: MemoryExtensionOptions = {},
): ExtensionFactory {
  const scope = resolveScope(options);
  const visitor = isVisitorScope(scope);

  return (pi: ExtensionAPI) => {
    if (visitor) {
      pi.registerTool({
        name: GHOST_MEMORY_LIST,
        label: "List memory",
        description:
          "List your memory files. Each line is one file: its name, then the one-line "
          + "description you gave it. Read a file to see the fact itself.",
        parameters: Type.Object({}),
        execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
          const home = resolveHome(options, ctx);
          const { files, skipped } = await home.listMemory(scope);
          const index = deriveMemoryIndex(files);
          const lines = index.lines.length > 0 ? [...index.lines] : ["(nothing yet)"];
          if (index.omitted > 0) lines.push(`(+${index.omitted} more, not listed here)`);
          for (const file of skipped) {
            lines.push(`(unreadable: ${file.path} — ${file.reason})`);
          }
          return textResult(lines.join("\n"), {
            count: files.length,
            omitted: index.omitted,
            skipped: skipped.length,
            scope: describeScope(scope),
          });
        },
      });

      pi.registerTool({
        name: GHOST_MEMORY_READ,
        label: "Read memory",
        description: "Read one memory file by name, as listed by ghost_memory_list.",
        parameters: Type.Object({
          name: Type.String({
            description: "The memory file name, such as preferred-tone.md.",
          }),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
          const home = resolveHome(options, ctx);
          // Not-found and format errors throw: pi ignores a returned isError flag.
          const file = await home.readMemory(params.name, scope);
          const header = file.updated ? `${file.description} (updated ${file.updated})`
            : file.description;
          return textResult(`${header}\n\n${file.content}`, {
            slug: file.slug,
            updated: file.updated ?? null,
            scope: describeScope(scope),
          });
        },
      });
    }

    pi.registerTool({
      name: GHOST_MEMORY_WRITE,
      label: "Write memory",
      description:
        "Write one memory file: a single fact worth keeping, with a one-line "
        + "description for the index. Writing a name that already exists replaces "
        + "that file, which is how you correct or update a memory. Keep unrelated "
        + "facts in separate files.",
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
        const written = await home.writeMemory(
          {
            description: params.description,
            content: params.content,
            ...(params.name === undefined ? {} : { name: params.name }),
          },
          scope,
        );
        return textResult(
          `${written.created ? "Wrote" : "Replaced"} ${written.path}.`,
          { ...written, scope: describeScope(scope) },
        );
      },
    });
  };
}

/** Structured writer for creators; scoped list/read/write surface for visitors. */
export default createMemoryExtension();
