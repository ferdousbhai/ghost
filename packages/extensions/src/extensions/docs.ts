/**
 * Visitor-scoped doc tools and their visibility gate.
 *
 * `public: true` publishes a doc. Absent or false is private. A visitor session
 * gets two independent enforcements of that rule:
 *
 * 1. **The tools are scoped.** List, search, and read filter by
 *    `isDocVisible`, so a private doc is not reachable through them at all.
 * 2. **A `tool_call` gate blocks the call before it executes** — the shape the
 *    spike tested adversarially (report §3): with the mock provider driven to
 *    request a `public: false` doc by exact path, the body never entered the
 *    model's context. The gate is structural, not an instruction in the prompt,
 *    so no amount of persuasion moves it.
 *
 * Creator sessions use OMP's native read/grep/glob/write/edit tools directly
 * against the plain `docs/` directory. Visitor sessions cannot receive those
 * tools because they would bypass doc publication, so this extension keeps the
 * scoped list/search/read surface for visitors only.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { deriveDocCatalog, isDocVisible } from "../catalog.js";
import { GhostError } from "../errors.js";
import { normalizeDocPath } from "../home.js";
import { describeScope, isVisitorScope } from "../scope.js";
import {
  budgeted,
  budgetFooter,
  DEFAULT_DOC_READ_BUDGET_CHARS,
  MAX_GREP_LINE_CHARS,
  resolveHome,
  resolveScope,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_DOCS_LIST = "ghost_docs_list";
export const GHOST_DOCS_READ = "ghost_docs_read";
export const GHOST_DOCS_GREP = "ghost_docs_grep";

/**
 * pi's own file and shell tools. A visitor session must never reach the disk
 * except through the ghost tools, whatever else got registered.
 */
const BUILT_IN_FILE_TOOLS = new Set(["bash", "read", "write", "edit", "find", "grep", "ls"]);

/**
 * One reason for "private" and for "does not exist" alike. Distinguishing them
 * would turn the gate into an oracle for the existence of private docs.
 */
function unavailable(path: string): string {
  return `Document ${JSON.stringify(path)} is not available in this conversation.`;
}

export type DocsExtensionOptions = GhostExtensionOptions;

/**
 * The `tool_call` handler enforcing doc visibility. Exported on its own so a
 * daemon can register it over a tool surface this package did not build.
 */
export function createDocsVisibilityGate(
  options: DocsExtensionOptions = {},
): ExtensionHandler<ToolCallEvent, ToolCallEventResult> {
  const scope = resolveScope(options);

  return async (event, ctx) => {
    if (!isVisitorScope(scope)) return;

    if (BUILT_IN_FILE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          `${event.toolName} is not available in a visitor conversation. `
          + "Use ghost_docs_list, ghost_docs_read, or ghost_docs_grep.",
      };
    }

    if (event.toolName !== GHOST_DOCS_READ) return;

    const requested = (event.input as { path?: unknown }).path;
    if (typeof requested !== "string" || requested.trim() === "") return;

    let path: string;
    try {
      path = normalizeDocPath(requested);
    } catch {
      return { block: true, reason: unavailable(requested) };
    }

    const doc = await resolveHome(options, ctx).findDoc(path);
    if (!doc || !isDocVisible(doc, scope)) {
      return { block: true, reason: unavailable(path) };
    }
    return;
  };
}

/**
 * Build the docs extension. In visitor scope the visibility gate is registered
 * with the tools; in creator scope there is nothing to gate.
 */
export function createDocsExtension(
  options: DocsExtensionOptions = {},
): ExtensionFactory {
  const scope = resolveScope(options);
  const visitor = isVisitorScope(scope);

  return (pi: ExtensionAPI) => {
    if (!visitor) return;

    pi.registerTool({
      name: GHOST_DOCS_LIST,
      label: "List docs",
      description: "List the docs you can draw on, by path, with their titles and tags.",
      parameters: Type.Object({
        include_archived: Type.Optional(Type.Boolean({
          description: "Include docs you have archived. Off by default.",
        })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const { docs, skipped } = await home.listDocs();
        const selected = params.include_archived === true
          ? docs
          : docs.filter((doc) => !doc.archived);
        const catalog = deriveDocCatalog(selected, scope);
        const lines = catalog.lines.length > 0 ? [...catalog.lines] : ["(no docs yet)"];
        if (catalog.omitted > 0) {
          lines.push(`(+${catalog.omitted} more, not listed here; use ghost_docs_grep)`);
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
      name: GHOST_DOCS_READ,
      label: "Read document",
      description: "Read one document by its path, as listed by ghost_docs_list.",
      parameters: Type.Object({
        path: Type.String({
          description: "The document path, such as craft/paper-guide.md.",
        }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const doc = await home.readDoc(params.path);
        // Second lock: the gate blocks this call before it runs, but the tool
        // refuses on its own so it is safe even if the gate was not registered.
        if (!isDocVisible(doc.meta, scope)) {
          throw new GhostError("forbidden", unavailable(doc.meta.path), {
            path: doc.meta.path,
          });
        }
        const heading = doc.meta.title ?? doc.meta.path;
        // A doc body is unbounded — an imported doc can be enormous — so it is
        // capped before it reaches the model, with a footer saying what was cut.
        const body = budgeted(doc.body, DEFAULT_DOC_READ_BUDGET_CHARS);
        const footer = budgetFooter(body);
        return textResult(
          `# ${heading}\n\n${body.text}${footer ? `\n\n${footer}` : ""}`,
          {
            path: doc.meta.path,
            public: doc.meta.public,
            archived: doc.meta.archived,
            tags: [...doc.meta.tags],
            truncated: body.truncated,
            totalLength: body.totalLength,
          },
        );
      },
    });

    pi.registerTool({
      name: GHOST_DOCS_GREP,
      label: "Search docs",
      description:
        "Search your docs for a phrase and get the matching lines with their document "
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
        const result = await home.searchDocs(params.query, {
          scope,
          ...(params.regex === undefined ? {} : { regex: params.regex }),
          ...(params.max_results === undefined ? {} : { maxResults: params.max_results }),
        });
        const lines = result.matches.map((match) => {
          // A single match line can be arbitrarily long; cap each one so a doc
          // full of long lines cannot flood the model's context.
          const shown = budgeted(match.text, MAX_GREP_LINE_CHARS);
          const text = shown.truncated ? `${shown.text}…` : shown.text;
          return `${match.path}:${match.line}: ${text}`;
        });
        if (lines.length === 0) lines.push("(no matches)");
        if (result.truncated) lines.push("(more matches were not listed)");
        return textResult(lines.join("\n"), {
          matches: result.matches.length,
          docsSearched: result.docsSearched,
          truncated: result.truncated,
        });
      },
    });

    pi.on("tool_call", createDocsVisibilityGate(options));
  };
}

/** Visitor tools when scoped; creator sessions use OMP's filesystem tools. */
export default createDocsExtension();
