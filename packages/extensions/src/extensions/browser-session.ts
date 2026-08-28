/**
 * Everything about browsing that is *not* about which browser.
 *
 * URL policy, ref bookkeeping and invalidation, the read budget, the idle
 * shutdown timer, and the serialization of parallel tool calls all live here,
 * above the `GhostBrowserBackend` seam, so the Playwright backend and the
 * coming relay backend for the owner's Chromium get exactly one
 * implementation of each and cannot drift apart on any of them. A backend that
 * forgot to check a URL would be a backend that could open `file:///`; there is
 * no way to forget from down there, because backends never see an unchecked URL.
 *
 * Two details worth keeping:
 *
 * **Actions are serialized.** pi runs tool calls in parallel by default, and two
 * of them interleaving on one page is how you get a click that lands on the page
 * a different call just navigated away from.
 *
 * **One session per ghost home, process-wide.** A launched Chromium takes an
 * exclusive lock on its user-data-dir, so two sessions over one ghost home
 * cannot each start their own. The registry below is global state, but *keyed*
 * state, which is the distinction `shared.ts` cares about: nothing here is
 * configured by a process-global, only found by one.
 */
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { GhostError } from "../errors.js";
import {
  browserAbortError,
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
import { playwrightBackend } from "./browser-playwright.js";
import {
  checkActingScope,
  checkNetworkUrl,
  DEFAULT_DNS_TIMEOUT_MS,
  defaultBrowserDnsResolver,
  isPublicInternetAddress,
  type BrowserDnsResolver,
  type BrowserPolicyClock,
  systemBrowserPolicyClock,
} from "./browser-policy.js";
import {
  DEFAULT_SCREENSHOT_RETENTION,
  ghostScreenshotMatcher,
  ghostScreenshotName,
  resolveScreenshotDirectory,
  assertScreenshotBytesWithinLimit,
  pruneScreenshotFiles,
  withScreenshotDirectory,
  writeScreenshotFile,
} from "./screenshot-retention.js";

/** Backwards-compatible singular export; storage is shared with ghost_screen. */

export const DEFAULT_BROWSER_SCREENSHOT_RETENTION = DEFAULT_SCREENSHOT_RETENTION;

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;
export const DEFAULT_READ_BUDGET_CHARS = 8_000;
export const MIN_READ_BUDGET_CHARS = 200;
export const MAX_READ_BUDGET_CHARS = 100_000;
export const DEFAULT_FIND_LIMIT = 20;
export const MAX_FIND_LIMIT = 100;
export const MAX_FIND_QUERY_CHARS = 1_000;
export const MAX_BROWSER_MATCH_TEXT_CHARS = 200;
export const MAX_BROWSER_MATCH_HREF_CHARS = 500;
export const MAX_BROWSER_REF_CHARS = 128;

const BROWSER_REF_PATTERN = /^[A-Za-z0-9._:-]+$/;

const DEFAULT_BROWSER_BACKEND = playwrightBackend();

/**
 * How many consequential actions (click/type) may fire between two explicit
 * `open()`s. An injected page that hijacks the ghost cannot issue an `open()` on
 * the owner's behalf, so bounding actions per owner-directed navigation caps
 * how much a single hijack can do before the transcript shows another deliberate
 * step. Generous by design — a normal form fill is one or two actions.
 */
export const DEFAULT_ACTING_BUDGET = 12;

export interface BrowserSessionOptions {
  readonly homeDir: string;
  /** Which browser to drive. Defaults to a dedicated Playwright Chromium profile. */
  readonly backend?: BrowserBackendFactory;
  readonly idleTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly allowLocal?: boolean;
  readonly dnsTimeoutMs?: number;
  readonly resolver?: BrowserDnsResolver;
  readonly clock?: BrowserPolicyClock;
  readonly closeTimeoutMs?: number;
  /**
   * Consequential actions allowed per owner-directed `open()`. See
   * {@link DEFAULT_ACTING_BUDGET}. Zero or negative disables the budget (the
   * domain-scope guardrail still applies).
   */
  readonly actingBudget?: number;
  /**
   * Per-conversation escape hatch: let consequential actions run off the
   * opened origin's registrable domain by default, for an owner who is running
   * a deliberate multi-site workflow. Off by default; the per-call
   * `allowCrossDomain` is the usual, more legible way to widen scope.
   */
  readonly allowActionsOffOrigin?: boolean;
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
}

export type SessionConsoleResult = BoundedEntryResult<import("./browser-backend.js").ConsoleEntry>;
export type SessionNetworkResult = BoundedEntryResult<import("./browser-backend.js").NetworkEntry>;

/**
 * One step of a {@link GhostBrowserSession.batch}. It mirrors the browser tool's
 * own parameters so a batch is just a list of the same actions, run without
 * anything interleaving between them.
 */
export interface BatchStep {
  readonly action: string;
  readonly url?: string;
  readonly query?: string;
  readonly ref?: string;
  readonly selector?: string;
  readonly text?: string;
  readonly submit?: boolean;
  readonly allowCrossDomain?: boolean;
  readonly maxChars?: number;
  readonly limit?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly x?: number;
  readonly y?: number;
  readonly fromX?: number;
  readonly fromY?: number;
  readonly toX?: number;
  readonly toY?: number;
  readonly steps?: number;
  readonly key?: string;
  readonly modifiers?: readonly string[];
  readonly code?: string;
  readonly paths?: readonly string[];
}

export interface BatchStepResult {
  readonly action: string;
  readonly ok: boolean;
  /** A short human-readable line, or the failure message when `ok` is false. */
  readonly summary: string;
  readonly failure?: string;
}

export interface BatchResult {
  readonly steps: readonly BatchStepResult[];
  /** True when a step failed and the rest were not attempted. */
  readonly stopped: boolean;
}

function boundedMatchString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function projectBrowserMatch(value: unknown): PageElementMatch | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const match = value as Record<string, unknown>;
  const ref = typeof match["ref"] === "string" ? match["ref"].trim() : "";
  if (
    ref.length === 0
    || ref.length > MAX_BROWSER_REF_CHARS
    || !BROWSER_REF_PATTERN.test(ref)
  ) return null;
  const role = boundedMatchString(match["role"], 80);
  const name = boundedMatchString(match["name"], MAX_BROWSER_MATCH_TEXT_CHARS);
  const href = boundedMatchString(match["href"], MAX_BROWSER_MATCH_HREF_CHARS);
  const valueText = boundedMatchString(match["value"], MAX_BROWSER_MATCH_TEXT_CHARS);
  return {
    ref,
    tag: boundedMatchString(match["tag"], 80),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(href ? { href } : {}),
    ...(valueText ? { value: valueText } : {}),
    text: boundedMatchString(match["text"], MAX_BROWSER_MATCH_TEXT_CHARS),
    visible: match["visible"] === true,
    disabled: match["disabled"] === true,
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
  readonly homeDir: string;
  readonly screenshotDir: string;
  readonly backend: GhostBrowserBackend;

  #queue: Promise<unknown> = Promise.resolve();
  #queuedActions = 0;
  #activeAbort: AbortController | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #refs = new Map<string, PageElementMatch>();
  #refPageUrl: string | undefined;
  #originUrl: string | undefined;
  #originHops = 0;
  #actingRemaining: number;

  readonly #idleTimeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #allowLocal: boolean;
  readonly #dnsTimeoutMs: number;
  readonly #resolver: BrowserDnsResolver;
  readonly #clock: BrowserPolicyClock;
  readonly #closeTimeoutMs: number;
  readonly #actingBudget: number;
  readonly #allowActionsOffOrigin: boolean;

  constructor(options: BrowserSessionOptions) {
    this.homeDir = resolve(options.homeDir);
    this.screenshotDir = resolveScreenshotDirectory();
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.#allowLocal = options.allowLocal ?? false;
    this.#dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
    this.#resolver = options.resolver ?? defaultBrowserDnsResolver;
    this.#clock = options.clock ?? systemBrowserPolicyClock;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS;
    this.#actingBudget = options.actingBudget ?? DEFAULT_ACTING_BUDGET;
    this.#allowActionsOffOrigin = options.allowActionsOffOrigin ?? false;
    this.#actingRemaining = this.#actingBudget;
    this.backend = (options.backend ?? DEFAULT_BROWSER_BACKEND)({
      homeDir: this.homeDir,
      checkUrl: (url, operation = { timeoutMs: this.#actionTimeoutMs }) =>
        this.#requireAllowedUrl(url, operation),
      checkAddress: (address, url) => this.#requirePublicAddress(address, url),
    });
  }

  get running(): boolean {
    return this.backend.running;
  }

  get headless(): boolean {
    return this.backend.headless;
  }

  setHeadless(headless: boolean): { applied: boolean } {
    return this.backend.setHeadless(headless);
  }

  get refs(): ReadonlyMap<string, PageElementMatch> {
    return this.#refs;
  }

  get refPageUrl(): string | undefined {
    return this.#refPageUrl;
  }

  get originUrl(): string | undefined {
    return this.#originUrl;
  }

  get originHops(): number {
    return this.#originHops;
  }

  get actingRemaining(): number {
    return this.#actingRemaining;
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

  #touchIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#queuedActions > 0 || !this.backend.running || this.#idleTimeoutMs <= 0) return;
    this.#idleTimer = this.#clock.setTimeout(() => {
      void this.close().catch(() => undefined);
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  async #requireAllowedUrl(
    url: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string> {
    let checked: Awaited<ReturnType<typeof checkNetworkUrl>>;
    try {
      checked = await checkNetworkUrl(url, {
        allowLocal: this.#allowLocal,
        resolver: this.#resolver,
        clock: this.#clock,
        timeoutMs: Math.min(options.timeoutMs, this.#dnsTimeoutMs),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw browserAbortError(`verifying ${url}`);
      throw error;
    }
    if (!checked.ok) {
      throw new GhostBrowserError("blocked_url", checked.rejection.reason, {
        url: checked.rejection.url,
      });
    }
    return checked.url;
  }

  #requirePublicAddress(address: string, url: string): void {
    if (this.#allowLocal || isPublicInternetAddress(address)) return;
    throw new GhostBrowserError(
      "blocked_url",
      `${url} connected to a private or non-public network address, so the page was closed.`,
      { url },
    );
  }

  async #validatePage<T extends PageSummary>(
    page: T,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    await this.#requireAllowedUrl(page.url, this.#timeout(options));
    return page;
  }

  #invalidateRefs(): void {
    this.#refs.clear();
    this.#refPageUrl = undefined;
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

  /**
   * The prompt-injection gate for consequential actions. Refuses to click, type,
   * or submit on a page off the owner-opened origin's registrable domain, and
   * spends one unit of the per-open acting budget. Reads never call this.
   *
   * Fails closed, before the backend ever hears about the action, with a
   * structured `GhostBrowserError` that names how the owner can widen scope.
   */
  #gateActing(currentUrl: string, allowCrossDomain: boolean): void {
    const scope = checkActingScope(this.#originUrl, currentUrl, this.#originHops, {
      allowCrossDomain: allowCrossDomain || this.#allowActionsOffOrigin,
    });
    if (!scope.ok) {
      throw new GhostBrowserError("blocked_action", scope.reason, scope.details);
    }
    if (this.#actingBudget > 0 && this.#actingRemaining <= 0) {
      throw new GhostBrowserError(
        "action_budget",
        `That is more than ${this.#actingBudget} consequential actions since the `
        + "last page you opened. This bounds how far a single hijacked page can "
        + "push the browser. If the owner asked for this, re-open the page you "
        + "mean to act on with action \"open\" (which resets the budget) and "
        + "continue from there.",
        {
          failure: "action_budget",
          budget: this.#actingBudget,
          originUrl: this.#originUrl,
        },
      );
    }
    if (this.#actingBudget > 0) this.#actingRemaining -= 1;
  }

  async #requirePage(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PageSummary> {
    const operation = this.#timeout(options);
    const page = await this.backend.current(operation);
    if (page) return this.#validatePage(page, operation);
    throw new GhostBrowserError(
      "no_page",
      "No page is loaded. Use action \"open\" with a URL first.",
    );
  }


  open(url: string, options: BrowserOperationOptions = {}) {
    return this.#serial(() => this.#openImpl(url, options));
  }

  async #openImpl(
    url: string,
    options: BrowserOperationOptions,
  ): Promise<PageSummary> {
    const operation = this.#timeout(options);
    const checked = await this.#requireAllowedUrl(url, operation);
    this.#invalidateRefs();
    const page = await this.#validatePage(
      await this.backend.open(checked, operation),
      operation,
    );
    // This navigation came from the owner: re-anchor the trusted origin to
    // where it actually landed, reset the hop count, and refill the budget.
    this.#originUrl = page.url;
    this.#originHops = 0;
    this.#actingRemaining = this.#actingBudget;
    this.#touchIdleTimer();
    return page;
  }

  read(options: BrowserOperationOptions & { maxChars?: number } = {}) {
    return this.#serial(() => this.#readImpl(options));
  }

  async #readImpl(
    options: BrowserOperationOptions & { maxChars?: number },
  ): Promise<SessionReadResult> {
    const requested = options.maxChars;
    const maxChars = typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(MIN_READ_BUDGET_CHARS, Math.min(Math.floor(requested), MAX_READ_BUDGET_CHARS))
      : DEFAULT_READ_BUDGET_CHARS;
    const operation = this.#timeout(options);
    await this.#requirePage(operation);
    const result = await this.#validatePage(await this.backend.read(operation), operation);
    this.#touchIdleTimer();
    return {
      url: result.url,
      title: result.title,
      text: result.text.slice(0, maxChars),
      totalLength: result.text.length,
    };
  }

  find(query: string, options: BrowserOperationOptions & { limit?: number } = {}) {
    return this.#serial(() => this.#findImpl(query, options));
  }

  async #findImpl(
    query: string,
    options: BrowserOperationOptions & { limit?: number },
  ): Promise<SessionFindResult> {
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
    const page = await this.#requirePage(operation);
    const backendMatches = await this.backend.find(trimmed, {
      ...operation,
      limit,
    });
    await this.#validatePage(page, operation);
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
    this.#refPageUrl = page.url;
    this.#touchIdleTimer();
    return {
      matches,
      total: backendMatches.length,
      omitted: Math.max(backendMatches.length - matches.length, 0),
    };
  }

  click(target: BackendTarget & BrowserOperationOptions & { allowCrossDomain?: boolean }) {
    return this.#serial(() => this.#clickImpl(target));
  }

  async #clickImpl(
    target: BackendTarget & BrowserOperationOptions & { allowCrossDomain?: boolean },
  ): Promise<PageSummary> {
    const operation = this.#timeout(target);
    const checked = this.#checkTarget(target);
    const before = await this.#requirePage(operation);
    // Clicking is consequential: gate it against the trusted origin first.
    this.#gateActing(before.url, target.allowCrossDomain === true);
    const page = await this.#validatePage(
      await this.backend.click(checked, operation),
      operation,
    );
    // A click that navigated invalidates every ref minted on the old page and
    // counts as one more hop the page — not the owner — drove.
    if (page.url !== before.url) {
      this.#invalidateRefs();
      this.#originHops += 1;
    }
    this.#touchIdleTimer();
    return page;
  }

  type(input: BackendTarget & {
    text: string;
    submit?: boolean;
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions) {
    return this.#serial(() => this.#typeImpl(input));
  }

  async #typeImpl(input: BackendTarget & {
    text: string;
    submit?: boolean;
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions): Promise<SessionTypeResult> {
    const operation = this.#timeout(input);
    const checked = this.#checkTarget(input);
    const before = await this.#requirePage(operation);
    // Typing into and submitting someone's form is consequential too.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    // Submitting is a separate, explicit act: filling a field is reversible,
    // pressing Enter on someone's form is not.
    const submit = input.submit === true;
    const page = await this.#validatePage(
      await this.backend.type(
        { ...checked, text: input.text, submit },
        operation,
      ),
      operation,
    );
    if (submit) {
      this.#invalidateRefs();
      if (page.url !== before.url) this.#originHops += 1;
    }
    this.#touchIdleTimer();
    return { ...page, submitted: submit };
  }

  screenshot(options: BrowserOperationOptions & { fullPage?: boolean } = {}) {
    return this.#serial(() => this.#screenshotImpl(options));
  }

  async #screenshotImpl(
    options: BrowserOperationOptions & { fullPage?: boolean },
  ): Promise<SessionScreenshotResult> {
    const operation = this.#timeout(options);
    await this.#requirePage(operation);
    const capture = await this.#validatePage(await this.backend.screenshot({
      ...operation,
      fullPage: options.fullPage === true,
    }), operation);
    if (!(capture.bytes instanceof Uint8Array)) {
      throw new GhostError(
        "invalid_format",
        "The browser screenshot backend returned invalid image bytes.",
        {},
      );
    }
    assertScreenshotBytesWithinLimit(capture.bytes.byteLength, "Browser screenshot");
    const ghostName = basename(resolve(this.homeDir));
    const result = await withScreenshotDirectory(
      this.screenshotDir,
      async (directory, logicalDir) => {
        const written = await writeScreenshotFile(
          directory,
          ghostScreenshotName(ghostName, "browser"),
          "Browser screenshot",
          async (descriptorFilePath) => writeFile(descriptorFilePath, capture.bytes),
        );
        await pruneScreenshotFiles(
          directory,
          DEFAULT_BROWSER_SCREENSHOT_RETENTION,
          ghostScreenshotMatcher(ghostName, "browser"),
        );
        return {
          url: capture.url,
          title: capture.title,
          path: join(logicalDir, written.name),
          bytes: written.bytes,
        };
      },
    );
    this.#touchIdleTimer();
    return result;
  }

  back(options: BrowserOperationOptions = {}) {
    return this.#serial(() => this.#backImpl(options));
  }

  async #backImpl(options: BrowserOperationOptions): Promise<BackendBackResult> {
    const operation = this.#timeout(options);
    await this.#requirePage(operation);
    const page = await this.#validatePage(await this.backend.back(operation), operation);
    // Going back steps toward the origin, so it undoes a hop rather than adding
    // one. Observing only — no gate — but the hop count has to stay honest.
    if (page.moved && this.#originHops > 0) this.#originHops -= 1;
    this.#invalidateRefs();
    this.#touchIdleTimer();
    return page;
  }

  forward(options: BrowserOperationOptions = {}) {
    return this.#serial(() => this.#forwardImpl(options));
  }

  async #forwardImpl(options: BrowserOperationOptions): Promise<BackendBackResult> {
    const operation = this.#timeout(options);
    await this.#requirePage(operation);
    const page = await this.#validatePage(await this.backend.forward(operation), operation);
    // Forward is the inverse of back: it re-takes a step the page — not the
    // owner — had walked, so it re-adds a hop rather than undoing one.
    if (page.moved) this.#originHops += 1;
    this.#invalidateRefs();
    this.#touchIdleTimer();
    return page;
  }

  scroll(input: {
    deltaX: number;
    deltaY: number;
    x?: number;
    y?: number;
  } & BrowserOperationOptions) {
    return this.#serial(() => this.#scrollImpl(input));
  }

  async #scrollImpl(input: {
    deltaX: number;
    deltaY: number;
    x?: number;
    y?: number;
  } & BrowserOperationOptions): Promise<PageSummary> {
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
    // Scrolling only moves the viewport; it is observing, never gated.
    const page = await this.#validatePage(
      await this.backend.scroll(
        {
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          ...(input.x === undefined ? {} : { x: input.x }),
          ...(input.y === undefined ? {} : { y: input.y }),
        },
        operation,
      ),
      operation,
    );
    this.#touchIdleTimer();
    return page;
  }

  drag(input: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    steps?: number;
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions) {
    return this.#serial(() => this.#dragImpl(input));
  }

  async #dragImpl(input: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    steps?: number;
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions): Promise<PageSummary> {
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
    // Dragging can reorder, move, or drop things: consequential, so it is gated.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    const page = await this.#validatePage(
      await this.backend.drag(
        {
          fromX: input.fromX,
          fromY: input.fromY,
          toX: input.toX,
          toY: input.toY,
          ...(input.steps === undefined ? {} : { steps: input.steps }),
        },
        operation,
      ),
      operation,
    );
    if (page.url !== before.url) {
      this.#invalidateRefs();
      this.#originHops += 1;
    }
    this.#touchIdleTimer();
    return page;
  }

  key(input: {
    key: string;
    modifiers?: readonly string[];
    text?: string;
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions) {
    return this.#serial(() => this.#keyImpl(input));
  }

  async #keyImpl(input: {
    key: string;
    modifiers?: readonly string[];
    text?: string;
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions): Promise<PageSummary> {
    const operation = this.#timeout(input);
    const key = input.key.trim();
    if (key === "") {
      throw new GhostBrowserError("invalid_input", "A key press needs a key name.");
    }
    const before = await this.#requirePage(operation);
    // Pressing keys drives the focused control: consequential, so it is gated.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    const page = await this.#validatePage(
      await this.backend.key(
        {
          key,
          ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
          ...(input.text === undefined ? {} : { text: input.text }),
        },
        operation,
      ),
      operation,
    );
    if (page.url !== before.url) {
      this.#invalidateRefs();
      this.#originHops += 1;
    }
    this.#touchIdleTimer();
    return page;
  }

  javascript(
    code: string,
    options: BrowserOperationOptions & { allowCrossDomain?: boolean } = {},
  ) {
    return this.#serial(() => this.#javascriptImpl(code, options));
  }

  async #javascriptImpl(
    code: string,
    options: BrowserOperationOptions & { allowCrossDomain?: boolean },
  ): Promise<BoundedJavascriptResult> {
    const operation = this.#timeout(options);
    if (code.trim() === "") {
      throw new GhostBrowserError("invalid_input", "There is no code to run.");
    }
    const before = await this.#requirePage(operation);
    // Running script is the sharpest consequential action: gate it exactly like a
    // click, and spend a unit of the acting budget.
    this.#gateActing(before.url, options.allowCrossDomain === true);
    const result = projectJavascriptResult(
      await this.backend.javascript(code, operation),
    );
    await this.#requirePage(operation);
    // Script can rewrite the page under our refs; the honest move is to drop them.
    this.#invalidateRefs();
    this.#touchIdleTimer();
    return result;
  }

  readConsole(options: BrowserOperationOptions = {}) {
    return this.#serial(() => this.#readConsoleImpl(options));
  }

  async #readConsoleImpl(
    options: BrowserOperationOptions,
  ): Promise<SessionConsoleResult> {
    const operation = this.#timeout(options);
    await this.#requirePage(operation);
    const entries = projectConsoleEntries(
      await this.backend.readConsole(operation),
    );
    await this.#requirePage(operation);
    this.#touchIdleTimer();
    return entries;
  }

  readNetwork(options: BrowserOperationOptions = {}) {
    return this.#serial(() => this.#readNetworkImpl(options));
  }

  async #readNetworkImpl(
    options: BrowserOperationOptions,
  ): Promise<SessionNetworkResult> {
    const operation = this.#timeout(options);
    await this.#requirePage(operation);
    const entries = projectNetworkEntries(
      await this.backend.readNetwork(operation),
    );
    await this.#requirePage(operation);
    this.#touchIdleTimer();
    return entries;
  }

  upload(input: BackendTarget & {
    paths: readonly string[];
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions) {
    return this.#serial(() => this.#uploadImpl(input));
  }

  async #uploadImpl(input: BackendTarget & {
    paths: readonly string[];
    allowCrossDomain?: boolean;
  } & BrowserOperationOptions): Promise<PageSummary> {
    const operation = this.#timeout(input);
    if (input.paths.length === 0) {
      throw new GhostBrowserError("invalid_input", "Give at least one file path to upload.");
    }
    const checked = this.#checkTarget(input);
    const before = await this.#requirePage(operation);
    // Handing a file to a form is consequential — gate it against the origin.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    const page = await this.#validatePage(
      await this.backend.upload(
        { ...checked, paths: [...input.paths] },
        operation,
      ),
      operation,
    );
    this.#touchIdleTimer();
    return page;
  }

  resize(input: { width: number; height: number } & BrowserOperationOptions) {
    return this.#serial(() => this.#resizeImpl(input));
  }

  async #resizeImpl(input: {
    width: number;
    height: number;
  } & BrowserOperationOptions): Promise<BackendResizeResult> {
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
    const result = await this.#validatePage(
      await this.backend.resize(
        { width: input.width, height: input.height },
        operation,
      ),
      operation,
    );
    this.#touchIdleTimer();
    return result;
  }

  tabs(input: {
    op: BackendTabsInput["op"];
    id?: string;
    url?: string;
  } & BrowserOperationOptions) {
    return this.#serial(() => this.#tabsImpl(input));
  }

  async #tabsImpl(input: {
    op: BackendTabsInput["op"];
    id?: string;
    url?: string;
  } & BrowserOperationOptions): Promise<BackendTabsResult> {
    const operation = this.#timeout(input);
    let url: string | undefined;
    if (input.op === "create" && input.url !== undefined && input.url.trim() !== "") {
      url = await this.#requireAllowedUrl(input.url, operation);
    }
    const result = await this.backend.tabs(
      {
        op: input.op,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(url === undefined ? {} : { url }),
      },
      operation,
    );
    for (const tab of result.tabs) await this.#validatePage(tab, operation);
    if (result.page) await this.#validatePage(result.page, operation);
    // Switching or creating a tab lands the ghost on a different page; the refs
    // minted on the old one no longer mean anything.
    this.#invalidateRefs();
    if (input.op === "create" && result.page) {
      this.#originUrl = result.page.url;
      this.#originHops = 0;
      this.#actingRemaining = this.#actingBudget;
    }
    this.#touchIdleTimer();
    return result;
  }

  batch(steps: readonly BatchStep[], options: BrowserOperationOptions = {}) {
    return this.#serial(() => this.#batchImpl(steps, options));
  }

  /**
   * Run a sequence of steps as one queue slot, so nothing else interleaves
   * between them — the whole point of batching over separate tool calls. Each
   * step reuses the same non-serialized impls the public methods do, so the
   * guardrails (URL policy, provenance gate, acting budget, ref checks) apply
   * identically. A step that fails stops the batch and is reported, rather than
   * throwing the whole thing away.
   */
  async #batchImpl(
    steps: readonly BatchStep[],
    options: BrowserOperationOptions,
  ): Promise<BatchResult> {
    const results: BatchStepResult[] = [];
    for (const step of steps) {
      try {
        const summary = await this.#runStep(step, options);
        results.push({ action: step.action, ok: true, summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = error instanceof GhostBrowserError ? error.failure : "navigation_failed";
        results.push({ action: step.action, ok: false, summary: message, failure });
        return { steps: results, stopped: true };
      }
    }
    return { steps: results, stopped: false };
  }

  async #runStep(step: BatchStep, options: BrowserOperationOptions): Promise<string> {
    const t = options;
    switch (step.action) {
      case "open": {
        const page = await this.#openImpl(step.url ?? "", t);
        return `open → ${page.url}`;
      }
      case "read": {
        const r = await this.#readImpl({ ...t, ...(step.maxChars === undefined ? {} : { maxChars: step.maxChars }) });
        return `read ${r.text.length} of ${r.totalLength} chars`;
      }
      case "find": {
        const result = await this.#findImpl(step.query ?? "", {
          ...t,
          ...(step.limit === undefined ? {} : { limit: step.limit }),
        });
        return `find "${step.query ?? ""}" → ${result.matches.length} match(es)`;
      }
      case "click": {
        const page = await this.#clickImpl({
          ...t,
          ...(step.ref === undefined ? {} : { ref: step.ref }),
          ...(step.selector === undefined ? {} : { selector: step.selector }),
          ...(step.allowCrossDomain === undefined ? {} : { allowCrossDomain: step.allowCrossDomain }),
        });
        return `click → ${page.url}`;
      }
      case "type": {
        const page = await this.#typeImpl({
          text: step.text ?? "",
          ...t,
          ...(step.ref === undefined ? {} : { ref: step.ref }),
          ...(step.selector === undefined ? {} : { selector: step.selector }),
          ...(step.submit === undefined ? {} : { submit: step.submit }),
          ...(step.allowCrossDomain === undefined ? {} : { allowCrossDomain: step.allowCrossDomain }),
        });
        return `type → ${page.submitted ? "submitted" : "filled"}`;
      }
      case "scroll": {
        await this.#scrollImpl({
          deltaX: step.deltaX ?? 0,
          deltaY: step.deltaY ?? 0,
          ...t,
          ...(step.x === undefined ? {} : { x: step.x }),
          ...(step.y === undefined ? {} : { y: step.y }),
        });
        return "scroll";
      }
      case "drag": {
        await this.#dragImpl({
          fromX: step.fromX ?? 0,
          fromY: step.fromY ?? 0,
          toX: step.toX ?? 0,
          toY: step.toY ?? 0,
          ...t,
          ...(step.steps === undefined ? {} : { steps: step.steps }),
          ...(step.allowCrossDomain === undefined ? {} : { allowCrossDomain: step.allowCrossDomain }),
        });
        return "drag";
      }
      case "key": {
        await this.#keyImpl({
          key: step.key ?? "",
          ...t,
          ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
          ...(step.text === undefined ? {} : { text: step.text }),
          ...(step.allowCrossDomain === undefined ? {} : { allowCrossDomain: step.allowCrossDomain }),
        });
        return `key ${step.key ?? ""}`;
      }
      case "javascript": {
        const r = await this.#javascriptImpl(step.code ?? "", {
          ...t,
          ...(step.allowCrossDomain === undefined ? {} : { allowCrossDomain: step.allowCrossDomain }),
        });
        return `javascript → ${r.type}`;
      }
      case "back": {
        const page = await this.#backImpl(t);
        return page.moved ? `back → ${page.url}` : "back → nowhere";
      }
      case "forward": {
        const page = await this.#forwardImpl(t);
        return page.moved ? `forward → ${page.url}` : "forward → nowhere";
      }
      case "upload": {
        const page = await this.#uploadImpl({
          paths: step.paths ?? [],
          ...t,
          ...(step.ref === undefined ? {} : { ref: step.ref }),
          ...(step.selector === undefined ? {} : { selector: step.selector }),
          ...(step.allowCrossDomain === undefined ? {} : { allowCrossDomain: step.allowCrossDomain }),
        });
        return `upload → ${page.url}`;
      }
      default:
        throw new GhostBrowserError(
          "invalid_input",
          `Batch does not support the step "${step.action}". Batchable steps are `
          + "open, read, find, click, type, scroll, drag, key, javascript, back, "
          + "forward, and upload.",
        );
    }
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

  async #closeImpl(options: BrowserOperationOptions): Promise<boolean> {
    this.#clearIdleTimer();
    this.#invalidateRefs();
    // A fresh browser has no trusted origin until the next open().
    this.#originUrl = undefined;
    this.#originHops = 0;
    this.#actingRemaining = this.#actingBudget;
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.#closeTimeoutMs,
      this.#closeTimeoutMs,
    );
    const operation = this.#timeout({ ...options, timeoutMs });
    return withTimeout(
      this.backend.close(operation),
      timeoutMs,
      "closing the browser",
      options.signal,
    );
  }
}


interface EffectiveSessionOptions {
  readonly backend: BrowserBackendFactory;
  readonly backendIdentity: readonly unknown[];
  readonly backendDescription: string;
  readonly idleTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly allowLocal: boolean;
  readonly dnsTimeoutMs: number;
  readonly resolver: BrowserDnsResolver;
  readonly clock: BrowserPolicyClock;
  readonly closeTimeoutMs: number;
  readonly actingBudget: number;
  readonly allowActionsOffOrigin: boolean;
}

interface BrowserSessionEntry {
  readonly session: GhostBrowserSession;
  readonly options: EffectiveSessionOptions;
}

const sessions = new Map<string, BrowserSessionEntry>();
let closingAll: Promise<void> | undefined;

function effectiveSessionOptions(
  options: Omit<BrowserSessionOptions, "homeDir">,
): EffectiveSessionOptions {
  const backend = options.backend ?? DEFAULT_BROWSER_BACKEND;
  return {
    backend,
    backendIdentity: Object.freeze([...(backend.sessionIdentity ?? [backend])]),
    backendDescription: backend.sessionDescription ?? (backend.name || "custom backend"),
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    actionTimeoutMs: options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    allowLocal: options.allowLocal ?? false,
    dnsTimeoutMs: options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
    resolver: options.resolver ?? defaultBrowserDnsResolver,
    clock: options.clock ?? systemBrowserPolicyClock,
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
    actingBudget: options.actingBudget ?? DEFAULT_ACTING_BUDGET,
    allowActionsOffOrigin: options.allowActionsOffOrigin ?? false,
  };
}

function sameIdentity(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length
    && left.every((part, index) => Object.is(part, right[index]));
}

function changedSessionOptions(
  existing: EffectiveSessionOptions,
  requested: EffectiveSessionOptions,
): string[] {
  const changed: string[] = [];
  if (!sameIdentity(existing.backendIdentity, requested.backendIdentity)) changed.push("backend");
  if (existing.idleTimeoutMs !== requested.idleTimeoutMs) changed.push("idleTimeoutMs");
  if (existing.actionTimeoutMs !== requested.actionTimeoutMs) changed.push("actionTimeoutMs");
  if (existing.allowLocal !== requested.allowLocal) changed.push("allowLocal");
  if (existing.dnsTimeoutMs !== requested.dnsTimeoutMs) changed.push("dnsTimeoutMs");
  if (!Object.is(existing.resolver, requested.resolver)) changed.push("resolver");
  if (!Object.is(existing.clock, requested.clock)) changed.push("clock");
  if (existing.closeTimeoutMs !== requested.closeTimeoutMs) changed.push("closeTimeoutMs");
  if (existing.actingBudget !== requested.actingBudget) changed.push("actingBudget");
  if (existing.allowActionsOffOrigin !== requested.allowActionsOffOrigin) {
    changed.push("allowActionsOffOrigin");
  }
  return changed;
}

function sessionOptionSummary(options: EffectiveSessionOptions): Record<string, unknown> {
  return {
    backend: options.backendDescription,
    idleTimeoutMs: options.idleTimeoutMs,
    actionTimeoutMs: options.actionTimeoutMs,
    allowLocal: options.allowLocal,
    dnsTimeoutMs: options.dnsTimeoutMs,
    resolver: options.resolver === defaultBrowserDnsResolver ? "system" : "custom",
    clock: options.clock === systemBrowserPolicyClock ? "system" : "custom",
    closeTimeoutMs: options.closeTimeoutMs,
    actingBudget: options.actingBudget,
    allowActionsOffOrigin: options.allowActionsOffOrigin,
  };
}

export function screenshotDirFor(_homeDir: string): string {
  return resolveScreenshotDirectory();
}

/**
 * The one session for this ghost home, created on first ask. Keyed on the home
 * because that is what a launched Chromium locks, and because a ghost should
 * have one browser, not one per conversation. Later requests must describe the
 * same effective configuration; immutable changes are a typed conflict instead
 * of being silently discarded.
 */
export function browserSessionFor(
  homeDir: string,
  options: Omit<BrowserSessionOptions, "homeDir"> = {},
): GhostBrowserSession {
  const key = resolve(homeDir);
  if (closingAll) {
    throw new GhostError(
      "conflict",
      "Browser shutdown is still in progress; wait before opening another session.",
      { conflict: "browser_shutdown" },
    );
  }
  const requested = effectiveSessionOptions(options);
  const existing = sessions.get(key);
  if (existing) {
    const changed = changedSessionOptions(existing.options, requested);
    if (changed.length === 0) return existing.session;
    throw new GhostError(
      "conflict",
      `A browser session for ${key} already exists with different immutable settings: `
        + `${changed.join(", ")}. Reuse the existing settings, or call `
        + "closeAllBrowserSessions() before changing them (restart ghostd after a config change).",
      {
        conflict: "browser_session_configuration",
        homeDir: key,
        changedOptions: changed,
        existing: sessionOptionSummary(existing.options),
        requested: sessionOptionSummary(requested),
      },
    );
  }
  const session = new GhostBrowserSession({
    homeDir: key,
    backend: requested.backend,
    idleTimeoutMs: requested.idleTimeoutMs,
    actionTimeoutMs: requested.actionTimeoutMs,
    allowLocal: requested.allowLocal,
    dnsTimeoutMs: requested.dnsTimeoutMs,
    resolver: requested.resolver,
    clock: requested.clock,
    closeTimeoutMs: requested.closeTimeoutMs,
    actingBudget: requested.actingBudget,
    allowActionsOffOrigin: requested.allowActionsOffOrigin,
  });
  sessions.set(key, { session, options: requested });
  return session;
}

export async function closeAllBrowserSessions(): Promise<void> {
  if (closingAll) return closingAll;
  const open = [...sessions.entries()];
  if (open.length === 0) return;
  const closing = (async () => {
    const results = await Promise.allSettled(
      open.map(([, entry]) => entry.session.close()),
    );
    for (const [index, [key, entry]] of open.entries()) {
      if (results[index]?.status === "fulfilled" && sessions.get(key) === entry) {
        sessions.delete(key);
      }
    }
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
