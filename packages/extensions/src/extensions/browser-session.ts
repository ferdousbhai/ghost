/**
 * Browser actions are serialized because parallel tool calls cannot safely
 * navigate and act on the same page. The registry keys one shared workspace by
 * resolved ghost home: conversations of that ghost share its current tab and
 * tab list, while another ghost home gets an independent protocol owner. Tabs
 * isolate Chromium attachment and page state, not conversations from each other.
 * Screenshots are retained files under the owner's screenshot directory.
 */
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { GhostError } from "../errors.js";
import { isRecord } from "../record.js";
import {
  GhostBrowserError,
  withTimeout,
  type BackendBackResult,
  type BackendResizeResult,
  type BackendTabsInput,
  type BackendTabsResult,
  type BackendTarget,
  type BrowserBackendFactory,
  type GhostBrowserBackend,
  type PageElementMatch,
  type PageSummary,
} from "./browser-backend.js";
import {
  type BoundedEntryResult,
  type BoundedJavascriptResult,
  projectConsoleEntries,
  projectJavascriptResult,
  projectNetworkEntries,
} from "./browser-observation.js";
import { checkUrl } from "./browser-policy.js";
import { assertScreenshotBytesWithinLimit } from "./screenshot-limits.js";
import {
  DEFAULT_SCREENSHOT_RETENTION,
  ghostScreenshotMatcher,
  ghostScreenshotName,
  pruneScreenshotFiles,
  resolveScreenshotDirectory,
  withScreenshotDirectory,
  writeScreenshotFile,
} from "./screenshot-retention.js";

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;
export const DEFAULT_READ_BUDGET_CHARS = 8_000;
const MIN_READ_BUDGET_CHARS = 200;
const MAX_READ_BUDGET_CHARS = 100_000;
export const DEFAULT_FIND_LIMIT = 20;
export const MAX_FIND_LIMIT = 100;
export const MAX_FIND_QUERY_CHARS = 1_000;
export const MAX_BROWSER_MATCH_TEXT_CHARS = 200;
export const MAX_BROWSER_MATCH_HREF_CHARS = 500;
const MAX_BROWSER_REF_CHARS = 128;

const BROWSER_REF_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Timers the session schedules its idle close with; tests substitute their own. */
export interface BrowserClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export const systemBrowserClock: BrowserClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export interface BrowserSessionOptions {
  /** The ghost home this session serves; its name prefixes the screenshots. */
  readonly homeDir: string;
  /** Which browser to drive. There is one, so the caller names it. */
  readonly backend: BrowserBackendFactory;
  readonly idleTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly clock?: BrowserClock;
  readonly closeTimeoutMs?: number;
}

export interface BrowserOperationOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SessionReadResult extends PageSummary {
  readonly text: string;
  readonly totalLength: number;
}

export interface SessionTypeResult extends PageSummary {
  readonly submitted: boolean;
}

export interface SessionFindResult {
  readonly matches: readonly PageElementMatch[];
  readonly total: number;
  readonly omitted: number;
}

export interface SessionScreenshotResult extends PageSummary {
  readonly path: string;
  readonly bytes: number;
  /** The captured image, as written to `path`. */
  readonly image: Uint8Array;
}

export type SessionConsoleResult = BoundedEntryResult<import("./browser-backend.js").ConsoleEntry>;
export type SessionNetworkResult = BoundedEntryResult<import("./browser-backend.js").NetworkEntry>;

function boundedMatchString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function projectBrowserMatch(value: unknown): PageElementMatch | null {
  if (!isRecord(value)) return null;
  const match = value as Record<string, unknown>;
  const ref = typeof match.ref === "string" ? match.ref.trim() : "";
  if (
    ref.length === 0
    || ref.length > MAX_BROWSER_REF_CHARS
    || !BROWSER_REF_PATTERN.test(ref)
  ) return null;
  const role = boundedMatchString(match.role, 80);
  const name = boundedMatchString(match.name, MAX_BROWSER_MATCH_TEXT_CHARS);
  const href = boundedMatchString(match.href, MAX_BROWSER_MATCH_HREF_CHARS);
  const valueText = boundedMatchString(match.value, MAX_BROWSER_MATCH_TEXT_CHARS);
  return {
    ref,
    tag: boundedMatchString(match.tag, 80),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(href ? { href } : {}),
    ...(valueText ? { value: valueText } : {}),
    text: boundedMatchString(match.text, MAX_BROWSER_MATCH_TEXT_CHARS),
    visible: match.visible === true,
    disabled: match.disabled === true,
  };
}

function requireFiniteNumbers(
  label: string,
  values: Readonly<Record<string, number | undefined>>,
): void {
  const invalid = Object.entries(values)
    .filter(([, value]) => value !== undefined && !Number.isFinite(value))
    .map(([name]) => name);
  if (invalid.length > 0) {
    throw new GhostBrowserError(
      "invalid_input",
      `${label} needs finite numeric values; invalid: ${invalid.join(", ")}.`,
      { invalid },
    );
  }
}

export class GhostBrowserSession {
  readonly backend: GhostBrowserBackend;
  readonly homeDir: string;
  readonly screenshotDir: string;

  #queue: Promise<unknown> = Promise.resolve();
  #queuedActions = 0;
  #activeAbort: AbortController | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #refs = new Map<string, PageElementMatch>();

  readonly #idleTimeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #clock: BrowserClock;
  readonly #closeTimeoutMs: number;

  constructor(options: BrowserSessionOptions) {
    this.homeDir = resolve(options.homeDir);
    this.screenshotDir = resolveScreenshotDirectory();
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.#clock = options.clock ?? systemBrowserClock;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS;
    this.backend = options.backend();
  }

  get running(): boolean {
    return this.backend.running;
  }


  #serial<T>(work: () => Promise<T>): Promise<T> {
    this.#queuedActions += 1;
    this.#clearIdleTimer();
    const runWork = async (): Promise<T> => {
      const controller = new AbortController();
      this.#activeAbort = controller;
      try {
        return await work();
      } finally {
        if (this.#activeAbort === controller) this.#activeAbort = undefined;
        this.#queuedActions -= 1;
        if (this.#queuedActions === 0) this.#touchIdleTimer();
      }
    };
    const run = this.#queue.then(runWork, runWork);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #timeout(options: { timeoutMs?: number; signal?: AbortSignal }): {
    timeoutMs: number;
    signal?: AbortSignal;
  } {
    const internal = this.#activeAbort?.signal;
    const signal = options.signal && internal
      ? AbortSignal.any([options.signal, internal])
      : options.signal ?? internal;
    return {
      timeoutMs: options.timeoutMs ?? this.#actionTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) this.#clock.clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  /**
   * Arm the idle close, if nothing is queued.
   *
   * Only `#serial` calls this: a verb's body always runs with
   * `#queuedActions >= 1`, so a call from inside one could never arm anything.
   */
  #touchIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#queuedActions > 0 || !this.backend.mayOwnTabs || this.#idleTimeoutMs <= 0) return;
    this.#idleTimer = this.#clock.setTimeout(() => {
      void this.close().catch(() => undefined);
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  /** A bare host reads as https; only http(s) and about:blank open. */
  #requireAllowedUrl(url: string): string {
    const checked = checkUrl(url);
    if (!checked.ok) {
      throw new GhostBrowserError("blocked_url", checked.rejection.reason, {
        url: checked.rejection.url,
      });
    }
    return checked.url;
  }

  #invalidateRefs(): void {
    this.#refs.clear();
  }

  /**
   * Refuse a ref no `find` minted — or one a navigation since invalidated —
   * before it reaches the backend, where it would only ever be "element not
   * found" with no explanation of why.
   */
  #checkTarget(target: BackendTarget): BackendTarget {
    const ref = target.ref?.trim();
    if (ref) {
      if (!this.#refs.has(ref)) {
        const known = [...this.#refs.keys()];
        throw new GhostBrowserError(
          "unknown_ref",
          known.length === 0
            ? `There is no element ${ref}. Use action "find" first; it mints the refs.`
            : `There is no element ${ref} on this page. Current refs: ${known.join(", ")}.`,
          { ref, known },
        );
      }
      return { ref };
    }
    const selector = target.selector?.trim();
    if (selector) return { selector };
    throw new GhostBrowserError(
      "invalid_input",
      "Give either a ref from find, or a CSS selector.",
    );
  }

  async #requirePage(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PageSummary> {
    const operation = this.#timeout(options);
    const page = await this.backend.current(operation);
    if (page) return page;
    throw new GhostBrowserError(
      "no_page",
      "No page is loaded. Use action \"open\" with a URL first.",
    );
  }

  open(url: string, options: BrowserOperationOptions = {}): Promise<PageSummary> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      const checked = this.#requireAllowedUrl(url);
      this.#invalidateRefs();
      return this.backend.open(checked, operation);
    });
  }

  read(options: BrowserOperationOptions & { maxChars?: number } = {}): Promise<SessionReadResult> {
    return this.#serial(async () => {
      const requested = options.maxChars;
      const maxChars = typeof requested === "number" && Number.isFinite(requested)
        ? Math.max(MIN_READ_BUDGET_CHARS, Math.min(Math.floor(requested), MAX_READ_BUDGET_CHARS))
        : DEFAULT_READ_BUDGET_CHARS;
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const result = await this.backend.read(operation);
      return {
        url: result.url,
        title: result.title,
        text: result.text.slice(0, maxChars),
        totalLength: result.text.length,
      };
    });
  }

  find(query: string, options: BrowserOperationOptions & { limit?: number } = {}): Promise<SessionFindResult> {
    return this.#serial(async () => {
      const trimmed = query.trim();
      if (trimmed === "") {
        throw new GhostBrowserError("invalid_input", "A find needs a query.");
      }
      if (trimmed.length > MAX_FIND_QUERY_CHARS) {
        throw new GhostBrowserError(
          "invalid_input",
          `A find query is limited to ${MAX_FIND_QUERY_CHARS} characters.`,
        );
      }
      const requested = options.limit;
      const limit = typeof requested === "number" && Number.isFinite(requested)
        ? Math.max(1, Math.min(Math.floor(requested), MAX_FIND_LIMIT))
        : DEFAULT_FIND_LIMIT;
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const backendMatches = await this.backend.find(trimmed, {
        ...operation,
        limit,
      });
      if (!Array.isArray(backendMatches)) {
        throw new GhostBrowserError(
          "browser_unavailable",
          "The browser backend returned an invalid find result.",
        );
      }
      const matches: PageElementMatch[] = [];
      const refs = new Set<string>();
      for (const value of backendMatches.slice(0, limit) as readonly unknown[]) {
        const match = projectBrowserMatch(value);
        if (!match || refs.has(match.ref)) continue;
        refs.add(match.ref);
        matches.push(match);
      }
      this.#refs = new Map(matches.map((match) => [match.ref, match]));
      return {
        matches,
        total: backendMatches.length,
        omitted: Math.max(backendMatches.length - matches.length, 0),
      };
    });
  }

  click(target: BackendTarget & BrowserOperationOptions): Promise<PageSummary> {
    return this.#serial(async () => {
      const operation = this.#timeout(target);
      const checked = this.#checkTarget(target);
      const before = await this.#requirePage(operation);
      const page = await this.backend.click(checked, operation);
      // A click that navigated invalidates every ref minted on the old page.
      if (page.url !== before.url) this.#invalidateRefs();
      return page;
    });
  }

  type(input: BackendTarget & {
    text: string;
    submit?: boolean;
  } & BrowserOperationOptions): Promise<SessionTypeResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      const checked = this.#checkTarget(input);
      await this.#requirePage(operation);
      // Submitting is a separate, explicit act: filling a field is reversible,
      // pressing Enter on someone's form is not.
      const submit = input.submit === true;
      const page = await this.backend.type(
        { ...checked, text: input.text, submit },
        operation,
      );
      if (submit) this.#invalidateRefs();
      return { ...page, submitted: submit };
    });
  }

  screenshot(options: BrowserOperationOptions & { fullPage?: boolean } = {}): Promise<SessionScreenshotResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const capture = await this.backend.screenshot({
        ...operation,
        fullPage: options.fullPage === true,
      });
      if (!(capture.bytes instanceof Uint8Array)) {
        throw new GhostError(
          "invalid_format",
          "The browser screenshot backend returned invalid image bytes.",
          {},
        );
      }
      assertScreenshotBytesWithinLimit(capture.bytes.byteLength, "Browser screenshot");
      const saved = await this.#saveScreenshot(capture.bytes);
      return { url: capture.url, title: capture.title, path: saved.path, bytes: saved.bytes, image: capture.bytes };
    });
  }

  #saveScreenshot(bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    const ghostName = basename(this.homeDir);
    return withScreenshotDirectory(this.screenshotDir, async (directory, logicalDir) => {
      const written = await writeScreenshotFile(
        directory,
        ghostScreenshotName(ghostName, "browser"),
        "Browser screenshot",
        async (descriptorFilePath) => writeFile(descriptorFilePath, bytes),
      );
      await pruneScreenshotFiles(
        directory,
        DEFAULT_SCREENSHOT_RETENTION,
        ghostScreenshotMatcher(ghostName, "browser"),
      );
      return { path: join(logicalDir, written.name), bytes: written.bytes };
    });
  }

  back(options: BrowserOperationOptions = {}): Promise<BackendBackResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const page = await this.backend.back(operation);
      this.#invalidateRefs();
      return page;
    });
  }

  forward(options: BrowserOperationOptions = {}): Promise<BackendBackResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const page = await this.backend.forward(operation);
      this.#invalidateRefs();
      return page;
    });
  }

  scroll(input: {
    deltaX: number;
    deltaY: number;
    x?: number;
    y?: number;
  } & BrowserOperationOptions): Promise<PageSummary> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      await this.#requirePage(operation);
      requireFiniteNumbers("Scroll", {
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        x: input.x,
        y: input.y,
      });
      if ((input.x === undefined) !== (input.y === undefined)) {
        throw new GhostBrowserError(
          "invalid_input",
          "Scroll needs both x and y when a wheel anchor is provided.",
        );
      }
      const page = await this.backend.scroll(
        {
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          ...(input.x === undefined ? {} : { x: input.x }),
          ...(input.y === undefined ? {} : { y: input.y }),
        },
        operation,
      );
      return page;
    });
  }

  drag(input: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    steps?: number;
  } & BrowserOperationOptions): Promise<PageSummary> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      requireFiniteNumbers("Drag", {
        fromX: input.fromX,
        fromY: input.fromY,
        toX: input.toX,
        toY: input.toY,
        steps: input.steps,
      });
      if (
        input.steps !== undefined
        && (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100)
      ) {
        throw new GhostBrowserError(
          "invalid_input",
          "Drag steps must be an integer from 1 through 100.",
        );
      }
      const before = await this.#requirePage(operation);
      const page = await this.backend.drag(
        {
          fromX: input.fromX,
          fromY: input.fromY,
          toX: input.toX,
          toY: input.toY,
          ...(input.steps === undefined ? {} : { steps: input.steps }),
        },
        operation,
      );
      if (page.url !== before.url) {
        this.#invalidateRefs();
      }
      return page;
    });
  }

  key(input: {
    key: string;
    modifiers?: readonly string[];
    text?: string;
  } & BrowserOperationOptions): Promise<PageSummary> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      const key = input.key.trim();
      if (key === "") {
        throw new GhostBrowserError("invalid_input", "A key press needs a key name.");
      }
      const before = await this.#requirePage(operation);
      const page = await this.backend.key(
        {
          key,
          ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
          ...(input.text === undefined ? {} : { text: input.text }),
        },
        operation,
      );
      if (page.url !== before.url) {
        this.#invalidateRefs();
      }
      return page;
    });
  }

  javascript(
    code: string,
    options: BrowserOperationOptions = {},
  ): Promise<BoundedJavascriptResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      if (code.trim() === "") {
        throw new GhostBrowserError("invalid_input", "There is no code to run.");
      }
      await this.#requirePage(operation);
      const result = projectJavascriptResult(
        await this.backend.javascript(code, operation),
      );
      await this.#requirePage(operation);
      // Script can rewrite the page under our refs; the honest move is to drop them.
      this.#invalidateRefs();
      return result;
    });
  }

  readConsole(options: BrowserOperationOptions = {}): Promise<SessionConsoleResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const entries = projectConsoleEntries(
        await this.backend.readConsole(operation),
      );
      await this.#requirePage(operation);
      return entries;
    });
  }

  readNetwork(options: BrowserOperationOptions = {}): Promise<SessionNetworkResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(options);
      await this.#requirePage(operation);
      const entries = projectNetworkEntries(
        await this.backend.readNetwork(operation),
      );
      await this.#requirePage(operation);
      return entries;
    });
  }

  upload(input: BackendTarget & {
    paths: readonly string[];
  } & BrowserOperationOptions): Promise<PageSummary> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      if (input.paths.length === 0) {
        throw new GhostBrowserError("invalid_input", "Give at least one file path to upload.");
      }
      const checked = this.#checkTarget(input);
      await this.#requirePage(operation);
      return this.backend.upload({ ...checked, paths: [...input.paths] }, operation);
    });
  }

  resize(input: { width: number; height: number } & BrowserOperationOptions): Promise<BackendResizeResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      await this.#requirePage(operation);
      requireFiniteNumbers("Resize", { width: input.width, height: input.height });
      if (
        !Number.isInteger(input.width) || !Number.isInteger(input.height)
        || input.width < 100 || input.width > 10_000
        || input.height < 100 || input.height > 10_000
      ) {
        throw new GhostBrowserError(
          "invalid_input",
          "Resize width and height must be integers from 100 through 10000.",
        );
      }
      const result = await this.backend.resize(
        { width: input.width, height: input.height },
        operation,
      );
      return result;
    });
  }

  tabs(input: {
    op: BackendTabsInput["op"];
    id?: string;
    url?: string;
  } & BrowserOperationOptions): Promise<BackendTabsResult> {
    return this.#serial(async () => {
      const operation = this.#timeout(input);
      let url: string | undefined;
      if (input.op === "create" && input.url !== undefined && input.url.trim() !== "") {
        url = this.#requireAllowedUrl(input.url);
      }
      const result = await this.backend.tabs(
        {
          op: input.op,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(url === undefined ? {} : { url }),
        },
        operation,
      );
      // Switching or creating a tab lands the ghost on a different page; the refs
      // minted on the old one no longer mean anything.
      this.#invalidateRefs();
      return result;
    });
  }

  close(options: BrowserOperationOptions = {}): Promise<boolean> {
    // Wake a cooperative backend so the terminal close can take its queue slot.
    // The close itself remains serialized and therefore never races an action.
    this.#activeAbort?.abort();
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.#closeTimeoutMs,
      this.#closeTimeoutMs,
    );
    return withTimeout(
      this.#serial(() => this.#closeImpl({ ...options, timeoutMs })),
      timeoutMs,
      "waiting for browser actions to stop and close",
      options.signal,
    );
  }

  // close() has already clamped the timeout and wrapped the whole queued wait
  // in withTimeout, so this only forwards the operation to the backend.
  async #closeImpl(options: BrowserOperationOptions): Promise<boolean> {
    this.#clearIdleTimer();
    this.#invalidateRefs();
    return this.backend.close(this.#timeout(options));
  }
}

interface BrowserSessionEntry {
  readonly session: GhostBrowserSession;
  closing?: Promise<void>;
}

const sessions = new Map<string, BrowserSessionEntry>();
let closingAll: Promise<void> | undefined;

/**
 * The one session for this ghost home, created on first ask, because a ghost
 * should have one browser rather than one per conversation. The first caller's
 * options stand for the session's lifetime.
 */
export function browserSessionFor(
  homeDir: string,
  options: Omit<BrowserSessionOptions, "homeDir">,
): GhostBrowserSession {
  const key = resolve(homeDir);
  if (closingAll) {
    throw new GhostError(
      "conflict",
      "Browser shutdown is still in progress; wait before opening another session.",
      { conflict: "browser_shutdown" },
    );
  }
  const existing = sessions.get(key);
  if (existing) {
    if (existing.closing) {
      throw new GhostError(
        "conflict",
        `The browser session for ${key} is still closing; wait before using it again.`,
        { conflict: "browser_session_closing", homeDir: key },
      );
    }
    return existing.session;
  }
  const session = new GhostBrowserSession({ ...options, homeDir: key });
  sessions.set(key, { session });
  return session;
}

function closeBrowserSessionEntry(
  key: string,
  entry: BrowserSessionEntry,
): Promise<void> {
  if (entry.closing) return entry.closing;
  const closing = entry.session.close().then(() => {
    if (sessions.get(key) === entry) sessions.delete(key);
  }).finally(() => {
    if (entry.closing === closing) delete entry.closing;
  });
  entry.closing = closing;
  return closing;
}

/** Close and forget only the browser session keyed by this resolved ghost home. */
export function closeBrowserSession(homeDir: string): Promise<void> {
  const key = resolve(homeDir);
  const entry = sessions.get(key);
  return entry ? closeBrowserSessionEntry(key, entry) : Promise.resolve();
}

export async function closeAllBrowserSessions(): Promise<void> {
  if (closingAll) return closingAll;
  const open = [...sessions.entries()];
  if (open.length === 0) return;
  const closing = (async () => {
    const results = await Promise.allSettled(
      open.map(([key, entry]) => closeBrowserSessionEntry(key, entry)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more browser sessions did not close cleanly.");
    }
  })().finally(() => {
    if (closingAll === closing) closingAll = undefined;
  });
  closingAll = closing;
  return closing;
}
