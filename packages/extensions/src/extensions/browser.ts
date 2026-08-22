/**
 * `ghost_browser` — the creator-scope web browser.
 *
 * One tool with an action enum, not eight micro-tools: browsing is a sequence
 * (open → find → click → read) and a single tool keeps that sequence legible in
 * the transcript, keeps the tool list short, and gives one place to hang the
 * scope check. The actions are a closed enum with no free-form escape hatch, per
 * the schema rules — a model that invents `action: "eval"` gets a validation
 * error, not a surprise capability.
 *
 * **Creator scope only.** A visitor is someone else talking to the ghost over
 * the network; handing that conversation a browser on the creator's machine
 * would be the whole trust model inverted. Like `ghost_notes_write`, the tool is
 * simply not registered for a visitor — and, like the notes visibility gate, a
 * `tool_call` handler blocks it anyway, so a browser tool registered by some
 * *other* extension in a visitor session still cannot fire. Two locks, one door.
 *
 * The browser itself lives in `browser-session.ts`: a dedicated persistent
 * Chromium profile under the ghost home, launched lazily, shut down when idle.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isVisitorScope, type GhostScope } from "../scope.js";
import {
  GhostBrowserError,
  type BrowserBackendFactory,
  type PageElementMatch,
} from "./browser-backend.js";
import {
  browserSessionFor,
  DEFAULT_FIND_LIMIT,
  DEFAULT_READ_BUDGET_CHARS,
  MAX_FIND_LIMIT,
  type BrowserSessionOptions,
  type GhostBrowserSession,
} from "./browser-session.js";
import {
  resolveHome,
  resolveScope,
  textResult,
  type CwdContext,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_BROWSER = "ghost_browser";

export const GHOST_BROWSER_TOOL_NAMES = [GHOST_BROWSER] as const;

/** The tools this extension registers for a scope. Empty for a visitor. */
export function browserToolNames(scope: GhostScope): string[] {
  return isVisitorScope(scope) ? [] : [GHOST_BROWSER];
}

export const BROWSER_ACTIONS = [
  "open",
  "read",
  "find",
  "click",
  "type",
  "screenshot",
  "back",
  "close",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export interface BrowserExtensionOptions extends GhostExtensionOptions {
  /**
   * Which browser to drive. Defaults to `playwrightBackend()` — a dedicated
   * Chromium profile under the ghost home. The relay into the creator's real
   * signed-in Chromium slots in here, with no change to the tool.
   */
  readonly backend?: BrowserBackendFactory;
  /** Idle shutdown and per-action timeouts. */
  readonly browser?: Omit<BrowserSessionOptions, "homeDir" | "backend">;
}

const VISITOR_REFUSAL =
  "ghost_browser is not available in a visitor conversation. It drives a browser "
  + "on the creator's own machine.";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * The `tool_call` gate. Exported on its own so a daemon can register it over a
 * tool surface this package did not build — the same shape as the notes gate.
 */
export function createBrowserScopeGate(
  options: BrowserExtensionOptions = {},
): ExtensionHandler<ToolCallEvent, ToolCallEventResult> {
  const scope = resolveScope(options);
  return (event) => {
    if (!isVisitorScope(scope)) return undefined;
    if (event.toolName !== GHOST_BROWSER) return undefined;
    return { block: true, reason: VISITOR_REFUSAL };
  };
}

function describeMatch(match: PageElementMatch): string {
  const bits: string[] = [`${match.ref}  <${match.tag}>`];
  if (match.name) bits.push(JSON.stringify(match.name));
  else if (match.text) bits.push(JSON.stringify(match.text));
  if (match.role) bits.push(`role=${match.role}`);
  if (match.href) bits.push(`href=${match.href}`);
  if (match.value) bits.push(`value=${JSON.stringify(match.value)}`);
  const flags: string[] = [];
  if (!match.visible) flags.push("hidden");
  if (match.disabled) flags.push("disabled");
  if (flags.length > 0) bits.push(`(${flags.join(", ")})`);
  return bits.join(" ");
}

/** Build the browser extension. Creator scope gets the tool; a visitor gets a gate. */
export function createBrowserExtension(
  options: BrowserExtensionOptions = {},
): ExtensionFactory {
  const scope = resolveScope(options);
  const visitor = isVisitorScope(scope);

  const sessionFor = (ctx: CwdContext): GhostBrowserSession =>
    browserSessionFor(resolveHome(options, ctx).dir, {
      ...options.browser,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
    });

  return (pi: ExtensionAPI) => {
    if (visitor) {
      // No tool at all, plus the gate: a browser tool registered elsewhere in a
      // visitor session still cannot fire.
      pi.on("tool_call", createBrowserScopeGate(options));
      return;
    }

    pi.registerTool({
      name: GHOST_BROWSER,
      label: "Browse the web",
      description:
        "Browse the web in a real browser on the creator's desktop. Depending "
        + "on setup this is either the creator's own signed-in browser (you act "
        + "as them, using sessions they are already logged into) or a browser "
        + "profile of your own; either way the window is visible and the creator "
        + "can watch what you do.\n"
        + "Work in steps: open a page, read it, find the element you want, then "
        + "click or type. Refs like e1 come from find and stay valid until the "
        + "page changes. Only http and https pages are reachable; local files and "
        + "addresses on this machine are not, unless you pass allow_local.",
      parameters: Type.Object({
        action: Type.Enum([...BROWSER_ACTIONS], {
          type: "string",
          description:
            "open: go to a URL. read: the current page as text. find: locate "
            + "elements by text or CSS selector and get refs for them. click: "
            + "click a ref or selector. type: put text into a field. screenshot: "
            + "save a PNG of the page and get its path. back: go back one page. "
            + "close: shut the browser down.",
        }),
        url: Type.Optional(Type.String({
          description: "For open. A full https URL, or a bare domain.",
        })),
        query: Type.Optional(Type.String({
          description:
            "For find. Visible text such as Sign in, or a CSS selector such as "
            + "input[name=q]. A selector is tried first and text second.",
        })),
        ref: Type.Optional(Type.String({
          description: "For click and type. A ref from the last find, such as e3.",
        })),
        selector: Type.Optional(Type.String({
          description:
            "For click and type, instead of a ref. A CSS selector for the element.",
        })),
        text: Type.Optional(Type.String({
          description: "For type. The text to put in the field, replacing what is there.",
        })),
        submit: Type.Optional(Type.Boolean({
          description:
            "For type. Press Enter after typing, submitting the form. Off by "
            + "default: filling a field is reversible, submitting is not.",
        })),
        full_page: Type.Optional(Type.Boolean({
          description:
            "For screenshot. Capture the whole scrollable page instead of the window.",
        })),
        max_chars: Type.Optional(Type.Integer({
          description:
            `For read. How much page text to return. Defaults to ${DEFAULT_READ_BUDGET_CHARS}.`,
          minimum: 200,
          maximum: 100_000,
        })),
        limit: Type.Optional(Type.Integer({
          description: `For find. How many elements to return. Defaults to ${DEFAULT_FIND_LIMIT}.`,
          minimum: 1,
          maximum: MAX_FIND_LIMIT,
        })),
        allow_local: Type.Optional(Type.Boolean({
          description:
            "For open. Permit localhost and private network addresses. Off by "
            + "default; use it only when the creator asked you to look at "
            + "something running on their machine.",
        })),
        headless: Type.Optional(Type.Boolean({
          description:
            "Run the browser with no visible window. Off by default, so the "
            + "creator can see what you are doing. Takes effect the next time the "
            + "browser starts.",
        })),
        timeout_ms: Type.Optional(Type.Integer({
          description: "How long this one action may take. Defaults to 30000.",
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
        })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        // Third lock: the gate blocks the call and the tool is not registered for
        // a visitor, but the handler refuses on its own too.
        if (isVisitorScope(scope)) {
          throw new GhostBrowserError("forbidden_scope", VISITOR_REFUSAL);
        }

        const session = sessionFor(ctx);
        const timeout = params.timeout_ms === undefined ? {} : { timeoutMs: params.timeout_ms };
        let headlessNote = "";
        if (params.headless !== undefined) {
          const { applied } = session.setHeadless(params.headless);
          if (!applied) {
            headlessNote =
              "\n(headless was noted; it applies the next time the browser starts)";
          }
        }

        switch (params.action) {
          case "open": {
            const url = params.url?.trim();
            if (!url) {
              throw new GhostBrowserError(
                "invalid_input",
                "action \"open\" needs a url.",
              );
            }
            const page = await session.open(url, {
              ...(params.allow_local === undefined ? {} : { allowLocal: params.allow_local }),
              ...timeout,
            });
            return textResult(
              `Opened ${page.url}${page.title ? `\n${page.title}` : ""}${headlessNote}`,
              {
                action: "open",
                ...page,
                headless: session.headless,
                backend: session.backend.name,
              },
            );
          }

          case "read": {
            const result = await session.read({
              ...(params.max_chars === undefined ? {} : { maxChars: params.max_chars }),
              ...timeout,
            });
            const lines = [`# ${result.title || result.url}`, result.url, "", result.text];
            if (result.totalLength > result.text.length) {
              lines.push(
                "",
                `(showing the first ${result.text.length} of ${result.totalLength} `
                + "characters; raise max_chars for more)",
              );
            }
            return textResult(lines.join("\n"), {
              action: "read",
              url: result.url,
              title: result.title,
              returned: result.text.length,
              totalLength: result.totalLength,
            });
          }

          case "find": {
            const query = params.query?.trim();
            if (!query) {
              throw new GhostBrowserError(
                "invalid_input",
                "action \"find\" needs a query — visible text or a CSS selector.",
              );
            }
            const matches = await session.find(query, {
              ...(params.limit === undefined ? {} : { limit: params.limit }),
              ...timeout,
            });
            const lines = matches.map(describeMatch);
            if (lines.length === 0) {
              lines.push(`(nothing matched ${JSON.stringify(query)})`);
            }
            return textResult(lines.join("\n"), {
              action: "find",
              query,
              matches: matches.length,
              refs: matches.map((match) => match.ref),
            });
          }

          case "click": {
            const page = await session.click({
              ...(params.ref === undefined ? {} : { ref: params.ref }),
              ...(params.selector === undefined ? {} : { selector: params.selector }),
              ...timeout,
            });
            return textResult(
              `Clicked ${params.ref ?? params.selector}. Now at ${page.url}`
              + `${page.title ? ` — ${page.title}` : ""}`,
              { action: "click", ...page },
            );
          }

          case "type": {
            if (params.text === undefined) {
              throw new GhostBrowserError(
                "invalid_input",
                "action \"type\" needs the text to type.",
              );
            }
            const result = await session.type({
              text: params.text,
              ...(params.ref === undefined ? {} : { ref: params.ref }),
              ...(params.selector === undefined ? {} : { selector: params.selector }),
              ...(params.submit === undefined ? {} : { submit: params.submit }),
              ...timeout,
            });
            const target = params.ref ?? params.selector;
            return textResult(
              result.submitted
                ? `Typed into ${target} and submitted. Now at ${result.url}`
                : `Typed into ${target}. Nothing was submitted; pass submit: true to send it.`,
              { action: "type", ...result },
            );
          }

          case "screenshot": {
            const shot = await session.screenshot({
              ...(params.full_page === undefined ? {} : { fullPage: params.full_page }),
              ...timeout,
            });
            return textResult(
              `Saved a screenshot of ${shot.url} to ${shot.path}`,
              { action: "screenshot", ...shot },
            );
          }

          case "back": {
            const page = await session.back(timeout);
            return textResult(
              page.moved
                ? `Went back. Now at ${page.url}${page.title ? ` — ${page.title}` : ""}`
                : `There was nothing to go back to; still at ${page.url}`,
              { action: "back", ...page },
            );
          }

          case "close": {
            const wasOpen = await session.close();
            return textResult(
              wasOpen ? "Closed the browser." : "The browser was not open.",
              { action: "close", wasOpen },
            );
          }
        }
      },
    });
  };
}

export {
  browserSessionFor,
  closeAllBrowserSessions,
  screenshotDirFor,
  SCREENSHOT_DIRNAME,
} from "./browser-session.js";
export {
  BROWSER_PROFILE_DIRNAME,
  findChromiumExecutable,
  NO_BROWSER_MESSAGE,
  playwrightBackend,
  PlaywrightBrowserBackend,
} from "./browser-playwright.js";
export type {
  BrowserBackendFactory,
  GhostBrowserBackend,
  PageElementMatch,
} from "./browser-backend.js";

/** Creator-mode browser over the session's own ghost home. */
export default createBrowserExtension();
