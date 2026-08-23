/**
 * The seam between "what the ghost can do in a browser" and "which browser".
 *
 * There will be two backends. The first, shipping here, is a dedicated Chromium
 * profile driven by Playwright: the ghost's own browser, its own logins, nothing
 * inherited from the creator. The second, later, is a relay into the creator's
 * *real* signed-in Chromium through an MV3 extension and `chrome.debugger` —
 * which is a completely different mechanism (no profile to own, no process to
 * launch, refs that cannot be a DOM attribute we stamped) but exactly the same
 * eight verbs.
 *
 * So the verbs live behind this interface and everything *around* them —
 * URL policy, ref bookkeeping and invalidation, read truncation, the idle timer,
 * serialization of parallel tool calls, the tool schema itself — lives above it
 * in `browser-session.ts`, once, for both. A backend gets asked to do one small
 * thing at a time and is trusted with none of the policy.
 *
 * The rule for adding to this interface: if a relay into someone's real browser
 * could not honestly implement it, it does not belong here.
 */
import { GhostError } from "../errors.js";

/**
 * Why a browser action failed, precisely. `GhostErrorCode` is deliberately small
 * and shared by every ghost tool, so the exact browser reason rides along in
 * `details.failure` rather than widening that union for one extension.
 */
export type BrowserFailure =
  /** No browser to drive: nothing installed, or the relay is not connected. */
  | "browser_unavailable"
  /** The URL policy refused the destination. */
  | "blocked_url"
  /** The navigation itself failed. */
  | "navigation_failed"
  | "timeout"
  /** Nothing is loaded to act on. */
  | "no_page"
  /** A ref that no `find` minted, or one the page has since invalidated. */
  | "unknown_ref"
  | "element_not_found"
  /** The action's own parameters do not make sense. */
  | "invalid_input"
  /** A visitor session asked for the browser. */
  | "forbidden_scope"
  /**
   * A consequential action (click/type) was aimed at a page off the
   * creator-opened origin's registrable domain — the prompt-injection guardrail.
   */
  | "blocked_action"
  /** The per-open budget of consequential actions is spent. */
  | "action_budget";

const FAILURE_CODES = {
  browser_unavailable: "not_found",
  blocked_url: "forbidden",
  navigation_failed: "not_found",
  timeout: "limit_exceeded",
  no_page: "not_found",
  unknown_ref: "not_found",
  element_not_found: "not_found",
  invalid_input: "invalid_format",
  forbidden_scope: "forbidden",
  blocked_action: "forbidden",
  action_budget: "limit_exceeded",
} as const;

export class GhostBrowserError extends GhostError {
  readonly failure: BrowserFailure;

  constructor(
    failure: BrowserFailure,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(FAILURE_CODES[failure], message, { ...details, failure });
    this.name = "GhostBrowserError";
    this.failure = failure;
  }
}

// ------------------------------------------------------------------ result shapes

export interface PageSummary {
  readonly url: string;
  readonly title: string;
}

/** Untruncated. The session layer owns the budget, so both backends agree on it. */
export interface BackendReadResult extends PageSummary {
  readonly text: string;
}

export interface PageElementMatch {
  /** `e1`, `e2`, … — minted by the backend, tracked by the session layer. */
  readonly ref: string;
  readonly tag: string;
  readonly role?: string;
  readonly name?: string;
  readonly href?: string;
  readonly value?: string;
  readonly text: string;
  readonly visible: boolean;
  readonly disabled: boolean;
}

/** What to act on: a ref the backend minted, or a raw CSS selector. */
export interface BackendTarget {
  readonly ref?: string;
  readonly selector?: string;
}

export interface BackendActionOptions {
  readonly timeoutMs: number;
}

export interface BackendTypeInput extends BackendTarget {
  readonly text: string;
  readonly submit: boolean;
}

export interface BackendScreenshotOptions extends BackendActionOptions {
  /** Where to write the PNG. The session layer owns naming and the directory. */
  readonly path: string;
  readonly fullPage: boolean;
}

export interface BackendBackResult extends PageSummary {
  /** False when there was no history to go back to. */
  readonly moved: boolean;
}

// ------------------------------------------------------------------- the backend

export interface GhostBrowserBackend {
  /** For messages and details payloads: `playwright`, `relay`, … */
  readonly name: string;
  /** Whether a browser is live right now. Drives lazy launch and idle shutdown. */
  readonly running: boolean;
  /** Whether the browser is currently windowless. Relay backends are never headless. */
  readonly headless: boolean;

  /**
   * Ask for headed or headless. Returns whether it took effect now — for a
   * launched browser it only applies at the next start, and for a relay it never
   * applies at all, which the tool reports rather than silently swallowing.
   */
  setHeadless(headless: boolean): { applied: boolean };

  /**
   * Where the browser is right now, or undefined when nothing is loaded — which
   * includes "not started yet" and "sitting on a blank page". Must be cheap and
   * must not start a browser just to answer.
   */
  current(): Promise<PageSummary | undefined>;

  /** Navigate. The URL has already passed the policy check. */
  open(url: string, options: BackendActionOptions): Promise<PageSummary>;

  /** The page's readable text, untruncated. */
  read(options: BackendActionOptions): Promise<BackendReadResult>;

  /**
   * Locate elements by CSS selector or visible text and mint a ref for each.
   * Refs must stay resolvable until the page changes; how is the backend's
   * business (a stamped attribute, a node id, whatever the transport allows).
   */
  find(
    query: string,
    options: BackendActionOptions & { readonly limit: number },
  ): Promise<readonly PageElementMatch[]>;

  click(target: BackendTarget, options: BackendActionOptions): Promise<PageSummary>;

  type(input: BackendTypeInput, options: BackendActionOptions): Promise<PageSummary>;

  screenshot(options: BackendScreenshotOptions): Promise<PageSummary>;

  back(options: BackendActionOptions): Promise<BackendBackResult>;

  /** Shut down. Returns false when there was nothing running. */
  close(): Promise<boolean>;
}

export interface BrowserBackendContext {
  /** The ghost home. A backend that needs per-ghost state puts it under here. */
  readonly homeDir: string;
}

/**
 * How a session gets its backend. Selected once, when the session is built.
 *
 * A backend factory may describe when two independently-created factories have
 * the same effective configuration. Identity parts are compared with
 * `Object.is`: use primitives for settings and stable object references for
 * injected capabilities such as a relay transport. A factory without an
 * identity is deliberately equivalent only to itself.
 */
export interface BrowserBackendFactory {
  (ctx: BrowserBackendContext): GhostBrowserBackend;
  readonly sessionIdentity?: readonly unknown[];
  readonly sessionDescription?: string;
}

/** Attach an explicit session identity without hiding it in an ad-hoc property. */
export function identifiedBrowserBackendFactory(
  factory: (ctx: BrowserBackendContext) => GhostBrowserBackend,
  description: string,
  identity: readonly unknown[],
): BrowserBackendFactory {
  return Object.assign(factory, {
    sessionDescription: description,
    sessionIdentity: Object.freeze([...identity]),
  });
}

// --------------------------------------------------------------- shared helpers

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function timeoutError(action: string, timeoutMs: number): GhostBrowserError {
  return new GhostBrowserError(
    "timeout",
    `The browser did not finish ${action} within ${Math.round(timeoutMs / 1000)}s.`,
    { action, timeoutMs },
  );
}

/** A wall-clock cap for work whose own timeout we do not control. */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  action: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(action, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Normalize a backend's own error into ours, keeping timeouts recognizable. */
export function rethrowBackendError(
  error: unknown,
  action: string,
  timeoutMs: number,
): never {
  if (error instanceof GhostError) throw error;
  const text = errorMessage(error);
  if (/timeout .* exceeded|TimeoutError/i.test(text)) throw timeoutError(action, timeoutMs);
  throw new GhostBrowserError("navigation_failed", `${action} failed: ${text}`, { action });
}
