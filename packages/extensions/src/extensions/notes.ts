/**
 * The notes tools, and the visibility gate that makes a visitor session safe.
 *
 * `public: true` publishes a note. Absent or false is private. A visitor session
 * gets two independent enforcements of that rule:
 *
 * 1. **The tools are scoped.** List, search, and read filter by
 *    `isNoteVisible`, so a private note is not reachable through them at all.
 * 2. **A `tool_call` gate blocks the call before it executes** — the shape the
 *    spike tested adversarially (report §3): with the mock provider driven to
 *    request a `public: false` note by exact path, the body never entered the
 *    model's context. The gate is structural, not an instruction in the prompt,
 *    so no amount of persuasion moves it.
 *
 * The gate also refuses pi's built-in filesystem and shell tools outright in
 * visitor mode. The daemon already runs visitor sessions with `noTools: "all"`
 * plus an allowlist; this is the second lock on the same door.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deriveNoteCatalog, isNoteVisible } from "../catalog.js";
import { GhostError } from "../errors.js";
import { normalizeNotePath } from "../home.js";
import { describeScope, isVisitorScope } from "../scope.js";
import {
  budgeted,
  budgetFooter,
  DEFAULT_NOTE_READ_BUDGET_CHARS,
  MAX_GREP_LINE_CHARS,
  resolveHome,
  resolveScope,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_NOTES_LIST = "ghost_notes_list";
export const GHOST_NOTES_READ = "ghost_notes_read";
export const GHOST_NOTES_GREP = "ghost_notes_grep";
export const GHOST_NOTES_WRITE = "ghost_notes_write";

export const GHOST_NOTES_TOOL_NAMES = [
  GHOST_NOTES_LIST,
  GHOST_NOTES_READ,
  GHOST_NOTES_GREP,
  GHOST_NOTES_WRITE,
] as const;

/**
 * pi's own file and shell tools. A visitor session must never reach the disk
 * except through the ghost tools, whatever else got registered.
 */
const BUILT_IN_FILE_TOOLS = new Set(["bash", "read", "write", "edit", "find", "grep", "ls"]);

/**
 * One reason for "private" and for "does not exist" alike. Distinguishing them
 * would turn the gate into an oracle for the existence of private notes.
 */
function unavailable(path: string): string {
  return `Note ${JSON.stringify(path)} is not available in this conversation.`;
}

export type NotesExtensionOptions = GhostExtensionOptions;

/**
 * The `tool_call` handler enforcing note visibility. Exported on its own so a
 * daemon can register it over a tool surface this package did not build.
 */
export function createNotesVisibilityGate(
  options: NotesExtensionOptions = {},
): ExtensionHandler<ToolCallEvent, ToolCallEventResult> {
  const scope = resolveScope(options);

  return async (event, ctx) => {
    if (!isVisitorScope(scope)) return;

    if (BUILT_IN_FILE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          `${event.toolName} is not available in a visitor conversation. `
          + "Use ghost_notes_list, ghost_notes_read, or ghost_notes_grep.",
      };
    }

    if (event.toolName === GHOST_NOTES_WRITE) {
      return { block: true, reason: "Notes cannot be written in a visitor conversation." };
    }

    if (event.toolName !== GHOST_NOTES_READ) return;

    const requested = (event.input as { path?: unknown }).path;
    if (typeof requested !== "string" || requested.trim() === "") return;

    let path: string;
    try {
      path = normalizeNotePath(requested);
    } catch {
      return { block: true, reason: unavailable(requested) };
    }

    const note = await resolveHome(options, ctx).findNote(path);
    if (!note || !isNoteVisible(note, scope)) {
      return { block: true, reason: unavailable(path) };
    }
    return;
  };
}

/**
 * Build the notes extension. In visitor scope the visibility gate is registered
 * with the tools; in creator scope there is nothing to gate.
 */
export function createNotesExtension(
  options: NotesExtensionOptions = {},
): ExtensionFactory {
  const scope = resolveScope(options);
  const visitor = isVisitorScope(scope);

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: GHOST_NOTES_LIST,
      label: "List notes",
      description: visitor
        ? "List the notes you can draw on, by path, with their titles and tags."
        : "List your notes, by path, with title, tags, and whether each one is "
          + "published to visitors.",
      parameters: Type.Object({
        include_archived: Type.Optional(Type.Boolean({
          description: "Include notes you have archived. Off by default.",
        })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const { notes, skipped } = await home.listNotes();
        const selected = params.include_archived === true
          ? notes
          : notes.filter((note) => !note.archived);
        const catalog = deriveNoteCatalog(selected, scope);
        const lines = catalog.lines.length > 0 ? [...catalog.lines] : ["(no notes yet)"];
        if (catalog.omitted > 0) {
          lines.push(`(+${catalog.omitted} more, not listed here; use ghost_notes_grep)`);
        }
        for (const file of skipped) {
          lines.push(`(unreadable: ${file.path} — ${file.reason})`);
        }
        return textResult(lines.join("\n"), {
          count: catalog.total,
          publicCount: catalog.publicCount,
          omitted: catalog.omitted,
          skipped: skipped.length,
          scope: describeScope(scope),
        });
      },
    });

    pi.registerTool({
      name: GHOST_NOTES_READ,
      label: "Read note",
      description: "Read one note by its path, as listed by ghost_notes_list.",
      parameters: Type.Object({
        path: Type.String({
          description: "The note path, such as craft/paper-notes.md.",
        }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const note = await home.readNote(params.path);
        // Second lock: the gate blocks this call before it runs, but the tool
        // refuses on its own so it is safe even if the gate was not registered.
        if (!isNoteVisible(note.meta, scope)) {
          throw new GhostError("forbidden", unavailable(note.meta.path), {
            path: note.meta.path,
          });
        }
        const heading = note.meta.title ?? note.meta.path;
        // A note body is unbounded — an imported note can be enormous — so it is
        // capped before it reaches the model, with a footer saying what was cut.
        const body = budgeted(note.body, DEFAULT_NOTE_READ_BUDGET_CHARS);
        const footer = budgetFooter(body);
        return textResult(
          `# ${heading}\n\n${body.text}${footer ? `\n\n${footer}` : ""}`,
          {
            path: note.meta.path,
            public: note.meta.public,
            archived: note.meta.archived,
            tags: [...note.meta.tags],
            truncated: body.truncated,
            totalLength: body.totalLength,
          },
        );
      },
    });

    pi.registerTool({
      name: GHOST_NOTES_GREP,
      label: "Search notes",
      description:
        "Search your notes for a phrase and get the matching lines with their note "
        + "paths. Use it before answering from memory alone.",
      parameters: Type.Object({
        query: Type.String({ description: "The text to look for." }),
        regex: Type.Optional(Type.Boolean({
          description: "Read the query as a regular expression instead of plain text.",
        })),
        max_results: Type.Optional(Type.Integer({
          description: "Stop after this many matching lines. Defaults to 50.",
          minimum: 1,
          maximum: 200,
        })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const result = await home.searchNotes(params.query, {
          scope,
          ...(params.regex === undefined ? {} : { regex: params.regex }),
          ...(params.max_results === undefined ? {} : { maxResults: params.max_results }),
        });
        const lines = result.matches.map((match) => {
          // A single match line can be arbitrarily long; cap each one so a note
          // full of long lines cannot flood the model's context.
          const shown = budgeted(match.text, MAX_GREP_LINE_CHARS);
          const text = shown.truncated ? `${shown.text}…` : shown.text;
          return `${match.path}:${match.line}: ${text}`;
        });
        if (lines.length === 0) lines.push("(no matches)");
        if (result.truncated) lines.push("(more matches were not listed)");
        return textResult(lines.join("\n"), {
          matches: result.matches.length,
          notesSearched: result.notesSearched,
          truncated: result.truncated,
        });
      },
    });

    // A visitor session gets no writer at all; registering one and blocking every
    // call would just be a tool that always fails.
    if (!visitor) {
      pi.registerTool({
        name: GHOST_NOTES_WRITE,
        label: "Write note",
        description:
          "Write a note to a path, replacing whatever is there. Notes are private "
          + "unless you publish them: set public to true only for something you are "
          + "willing to say to any visitor.",
        parameters: Type.Object({
          path: Type.String({
            description: "The note path, such as craft/paper-notes.md.",
          }),
          body: Type.String({ description: "The note text, in markdown." }),
          title: Type.Optional(Type.String({ description: "A title for the note." })),
          public: Type.Optional(Type.Boolean({
            description: "Publish this note to visitors. Private by default.",
          })),
          tags: Type.Optional(Type.Array(Type.String(), {
            description: "Tags for this note.",
          })),
          archived: Type.Optional(Type.Boolean({
            description: "Mark the note archived, keeping it out of the working set.",
          })),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
          const home = resolveHome(options, ctx);
          const meta = await home.writeNote(params.path, {
            body: params.body,
            ...(params.title === undefined ? {} : { title: params.title }),
            ...(params.public === undefined ? {} : { public: params.public }),
            ...(params.tags === undefined ? {} : { tags: params.tags }),
            ...(params.archived === undefined ? {} : { archived: params.archived }),
          });
          return textResult(
            `Wrote notes/${meta.path} (${meta.public ? "public" : "private"}).`,
            { path: meta.path, public: meta.public },
          );
        },
      });
    }

    if (visitor) {
      pi.on("tool_call", createNotesVisibilityGate(options));
    }
  };
}

/** Creator-mode notes tools over the session's own ghost home; no gate. */
export default createNotesExtension();
