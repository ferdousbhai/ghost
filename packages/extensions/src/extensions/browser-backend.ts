/**
 * The seam between "what the ghost can do in a browser" and "which browser".
 *
 * There will be two backends. The first, shipping here, is a dedicated Chromium
 * profile driven by Playwright: the ghost's own browser, its own logins, nothing
 * inherited from the owner. The second, later, is a relay into the owner's
 * *real* signed-in Chromium through an MV3 extension and `chrome.debugger` —
 * which is a completely different mechanism (no profile to own, no process to
 * launch, refs that cannot be a DOM attribute we stamped) but exactly the same
 * eight verbs.
 *
 * So the verbs live behind this interface and everything *around* them —
 * URL policy, ref bookkeeping and invalidation, read truncation, the idle timer,
 * serialization of parallel tool calls, the tool schema itself — lives above it
 * in `browser-session.ts`, once, for both. A backend gets asked to do one small
 * thing at a time; the session also supplies its URL/peer checks to backends that
 * can enforce them at the network boundary.
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
  /**
   * A consequential action (click/type) was aimed at a page off the
   * owner-opened origin's registrable domain — the prompt-injection guardrail.
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
  readonly signal?: AbortSignal;
}

export interface BackendTypeInput extends BackendTarget {
  readonly text: string;
  readonly submit: boolean;
}

export interface BackendScreenshotOptions extends BackendActionOptions {
  readonly fullPage: boolean;
}

/** The session validates and publishes these bytes into its confined directory. */
export interface BackendScreenshotResult extends PageSummary {
  readonly bytes: Uint8Array;
}

export interface BackendBackResult extends PageSummary {
  /** False when there was no history to go back to. */
  readonly moved: boolean;
}

// --------------------------------------------------- Tier-1 capability shapes

/** A wheel scroll, in CSS pixels. `x`/`y` anchor the wheel; default is centre. */
export interface BackendScrollInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly x?: number;
  readonly y?: number;
}

/** A press-move-release drag between two viewport points. */
export interface BackendDragInput {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  /** Intermediate move events; more is smoother. Defaults to a small number. */
  readonly steps?: number;
}

/** A single key or chord. `modifiers` are names: Control, Alt, Shift, Meta. */
export interface BackendKeyInput {
  readonly key: string;
  readonly code?: string;
  readonly modifiers?: readonly string[];
  /** For a printable key, the character to insert. */
  readonly text?: string;
}

/** The result of running page JavaScript. `value` is JSON-serializable. */
export interface BackendJavascriptResult {
  readonly value: unknown;
  /** `typeof value`, before JSON round-tripping flattened it. */
  readonly type: string;
}

/** One buffered console message, drained from the ring. */
export interface ConsoleEntry {
  /** `log`, `warn`, `error`, `info`, `debug`, `exception`, … */
  readonly level: string;
  readonly text: string;
  readonly url?: string;
  readonly line?: number;
}

/** One buffered network exchange, drained from the ring. */
export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  /** The resource type the browser assigned: document, script, xhr, … */
  readonly type?: string;
  /** Encoded body size in bytes, when the browser reported it. */
  readonly bodyBytes?: number;
}

/** Set files on a file input the owner's browser reads from disk itself. */
export interface BackendUploadInput extends BackendTarget {
  readonly paths: readonly string[];
}

export interface BackendResizeInput {
  readonly width: number;
  readonly height: number;
}

/** Whether the resize took effect (a relay resizes a real window; some backends can't). */
export interface BackendResizeResult extends PageSummary {
  readonly applied: boolean;
}

/** What the ghost knows about one of its tabs. */
export interface BackendTabInfo {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export type BackendTabsOp = "list" | "create" | "close" | "switch";

export interface BackendTabsInput {
  readonly op: BackendTabsOp;
  /** For close/switch: which tab. For create: ignored. */
  readonly id?: string;
  /** For create: the (already URL-policy-checked) URL to open, or blank. */
  readonly url?: string;
}

export interface BackendTabsResult {
  readonly tabs: readonly BackendTabInfo[];
  /** The active tab id, or null when none is owned. */
  readonly active: string | null;
  /** For create/switch/close: where the active tab is now. */
  readonly page?: PageSummary;
  /** For create: the new tab's id. */
  readonly id?: string;
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
  current(options?: BackendActionOptions): Promise<PageSummary | undefined>;

  /** Navigate. The URL has passed session policy; capable backends recheck at request time. */
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

  screenshot(options: BackendScreenshotOptions): Promise<BackendScreenshotResult>;

  back(options: BackendActionOptions): Promise<BackendBackResult>;

  /** Forward navigation — the mirror of `back`. */
  forward(options: BackendActionOptions): Promise<BackendBackResult>;

  /** Wheel-scroll the page. Observing; never gated. */
  scroll(input: BackendScrollInput, options: BackendActionOptions): Promise<PageSummary>;

  /** A trusted press-move-release drag. Consequential. */
  drag(input: BackendDragInput, options: BackendActionOptions): Promise<PageSummary>;

  /** A trusted key or chord. Consequential. */
  key(input: BackendKeyInput, options: BackendActionOptions): Promise<PageSummary>;

  /**
   * Run JavaScript in the page and return its JSON-serializable value. This is a
   * genuine injection vector: the page and the returned value are untrusted data.
   * Consequential.
   */
  javascript(code: string, options: BackendActionOptions): Promise<BackendJavascriptResult>;

  /** Drain the buffered console messages. Observing. */
  readConsole(options: BackendActionOptions): Promise<readonly ConsoleEntry[]>;

  /** Drain the buffered network exchanges. Observing. */
  readNetwork(options: BackendActionOptions): Promise<readonly NetworkEntry[]>;

  /** Set files on a file input. Consequential. */
  upload(input: BackendUploadInput, options: BackendActionOptions): Promise<PageSummary>;

  /**
   * Resize the browser window. Returns whether it took effect — a launched
   * profile can honour it; some backends cannot, mirroring `setHeadless`.
   */
  resize(input: BackendResizeInput, options: BackendActionOptions): Promise<BackendResizeResult>;

  /** List / create / close / switch the ghost's tabs. */
  tabs(input: BackendTabsInput, options: BackendActionOptions): Promise<BackendTabsResult>;

  /** Shut down. Returns false when there was nothing running. */
  close(options?: BackendActionOptions): Promise<boolean>;
}

export interface BrowserBackendContext {
  /** The ghost home. A backend that needs per-ghost state puts it under here. */
  readonly homeDir: string;
  /**
   * Session-owned network policy. Playwright uses this on every request; other
   * backends still have their requested and returned URLs checked by the
   * session layer.
   */
  readonly checkUrl: (url: string, options?: BackendActionOptions) => Promise<string>;
  /** Verify an actual connected peer when a backend can observe it. */
  readonly checkAddress: (address: string, url: string) => void;
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

export function browserAbortError(action: string): GhostError {
  return new GhostError(
    "not_found",
    `The browser stopped ${action} because the turn was cancelled.`,
    { action, reason: "aborted" },
  );
}

/** Reject promptly when an operation is cancelled, even across an injected seam. */
export async function withAbort<T>(
  work: Promise<T>,
  action: string,
  signal?: AbortSignal,
): Promise<T> {
  // The caller necessarily created `work` before entering this helper. Attach a
  // rejection observer before checking an already-aborted signal, or a later
  // failure from non-cancellable work becomes an unhandled rejection.
  void work.catch(() => undefined);
  if (!signal) return work;
  if (signal.aborted) throw browserAbortError(action);
  let detach: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(browserAbortError(action));
      signal.addEventListener("abort", onAbort, { once: true });
      detach = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([work, aborted]);
    } catch (error) {
      if (signal.aborted) throw browserAbortError(action);
      throw error;
    }
  } finally {
    detach?.();
  }
}

/** A wall-clock cap for work whose own timeout we do not control. */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  action: string,
  signal?: AbortSignal,
): Promise<T> {
  // See withAbort: cancellation can win before this already-created operation
  // settles, but its eventual rejection must still be observed.
  void work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await withAbort(Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(action, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]), action, signal);
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
