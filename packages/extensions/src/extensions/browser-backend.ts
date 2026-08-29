/**
 * The rule for this interface: if a relay into the owner's own signed-in
 * Chromium could not honestly implement a verb, it does not belong here. A
 * backend that has to stub one fails at runtime, not at compile time.
 */
import { GhostError } from "../errors.js";

export type BrowserFailure =
  | "browser_unavailable"
  | "blocked_url"
  | "navigation_failed"
  | "timeout"
  | "no_page"
  | "unknown_ref"
  | "element_not_found"
  | "invalid_input"
  | "blocked_action"
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


export interface PageSummary {
  readonly url: string;
  readonly title: string;
}

export interface BackendReadResult extends PageSummary {
  readonly text: string;
}

export interface PageElementMatch {
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

export interface BackendScreenshotResult extends PageSummary {
  readonly bytes: Uint8Array;
}

export interface BackendBackResult extends PageSummary {
  readonly moved: boolean;
}


export interface BackendScrollInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly x?: number;
  readonly y?: number;
}

export interface BackendDragInput {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly steps?: number;
}

export interface BackendKeyInput {
  readonly key: string;
  readonly code?: string;
  readonly modifiers?: readonly string[];
  readonly text?: string;
}

export interface BackendJavascriptResult {
  readonly value: unknown;
  readonly type: string;
}

export interface ConsoleEntry {
  readonly level: string;
  readonly text: string;
  readonly url?: string;
  readonly line?: number;
}

export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly type?: string;
  readonly bodyBytes?: number;
}

export interface BackendUploadInput extends BackendTarget {
  readonly paths: readonly string[];
}

export interface BackendResizeInput {
  readonly width: number;
  readonly height: number;
}

export interface BackendResizeResult extends PageSummary {
  readonly applied: boolean;
}

export interface BackendTabInfo {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export type BackendTabsOp = "list" | "create" | "close" | "switch";

export interface BackendTabsInput {
  readonly op: BackendTabsOp;
  readonly id?: string;
  readonly url?: string;
}

export interface BackendTabsResult {
  readonly tabs: readonly BackendTabInfo[];
  readonly active: string | null;
  readonly page?: PageSummary;
  readonly id?: string;
}


export interface GhostBrowserBackend {
  readonly name: string;
  readonly running: boolean;

  /**
   * Where the browser is right now, or undefined when nothing is loaded — which
   * includes "not started yet" and "sitting on a blank page". Must be cheap and
   * must not start a browser just to answer.
   */
  current(options?: BackendActionOptions): Promise<PageSummary | undefined>;

  open(url: string, options: BackendActionOptions): Promise<PageSummary>;

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

  forward(options: BackendActionOptions): Promise<BackendBackResult>;

  scroll(input: BackendScrollInput, options: BackendActionOptions): Promise<PageSummary>;

  drag(input: BackendDragInput, options: BackendActionOptions): Promise<PageSummary>;

  key(input: BackendKeyInput, options: BackendActionOptions): Promise<PageSummary>;

  /**
   * Run JavaScript in the page and return its JSON-serializable value. This is a
   * genuine injection vector: the page and the returned value are untrusted data.
   * Consequential.
   */
  javascript(code: string, options: BackendActionOptions): Promise<BackendJavascriptResult>;

  readConsole(options: BackendActionOptions): Promise<readonly ConsoleEntry[]>;

  readNetwork(options: BackendActionOptions): Promise<readonly NetworkEntry[]>;

  upload(input: BackendUploadInput, options: BackendActionOptions): Promise<PageSummary>;

  /**
   * Resize the browser window. Returns whether it took effect — the owner's
   * window manager may refuse, which the tool reports rather than swallowing.
   */
  resize(input: BackendResizeInput, options: BackendActionOptions): Promise<BackendResizeResult>;

  tabs(input: BackendTabsInput, options: BackendActionOptions): Promise<BackendTabsResult>;

  close(options?: BackendActionOptions): Promise<boolean>;
}

/**
 * How a session gets its backend. Selected once, when the session is built.
 *
 * Nothing is passed in: the backend is the relay into the owner's Chromium and
 * it needs no per-session context. The parameterless shape is what lets a
 * caller hand over a fixture as a bare arrow.
 */
export type BrowserBackendFactory = () => GhostBrowserBackend;


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
