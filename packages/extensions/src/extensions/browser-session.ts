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
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GhostError } from "../errors.js";
import {
  GhostBrowserError,
  type BackendBackResult,
  type BackendJavascriptResult,
  type BackendResizeResult,
  type BackendTabsInput,
  type BackendTabsResult,
  type BackendTarget,
  type BrowserBackendFactory,
  type ConsoleEntry,
  type GhostBrowserBackend,
  type NetworkEntry,
  type PageElementMatch,
  type PageSummary,
} from "./browser-backend.js";
import { playwrightBackend } from "./browser-playwright.js";
import { checkActingScope, checkUrl, type UrlPolicyOptions } from "./browser-policy.js";

export const SCREENSHOT_DIRNAME = ".screenshots";

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_READ_BUDGET_CHARS = 8_000;
export const MIN_READ_BUDGET_CHARS = 200;
export const DEFAULT_FIND_LIMIT = 20;
export const MAX_FIND_LIMIT = 100;

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
  /** The ghost home. Screenshots and any per-ghost backend state live under it. */
  readonly homeDir: string;
  /** Which browser to drive. Defaults to a dedicated Playwright Chromium profile. */
  readonly backend?: BrowserBackendFactory;
  /** Close the browser after this long with no action. Zero disables it. */
  readonly idleTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
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

export interface SessionReadResult extends PageSummary {
  /** Truncated to the requested budget. */
  readonly text: string;
  /** Length before truncation, so the model knows what it is missing. */
  readonly totalLength: number;
}

export interface SessionTypeResult extends PageSummary {
  readonly submitted: boolean;
}

export interface SessionScreenshotResult extends PageSummary {
  readonly path: string;
}

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
  readonly allowLocal?: boolean;
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

export class GhostBrowserSession {
  readonly homeDir: string;
  readonly screenshotDir: string;
  readonly backend: GhostBrowserBackend;

  #queue: Promise<unknown> = Promise.resolve();
  #idleTimer: NodeJS.Timeout | undefined;
  /** Refs minted by the most recent `find`, and the page they were minted on. */
  #refs = new Map<string, PageElementMatch>();
  #refPageUrl: string | undefined;
  #screenshotCount = 0;

  /** The URL the owner's most recent `open()` landed on — the trusted origin. */
  #originUrl: string | undefined;
  /** Navigations the page itself drove since that open (link-follows / redirects). */
  #originHops = 0;
  /** Consequential actions left before the next `open()` re-anchors the origin. */
  #actingRemaining: number;

  readonly #idleTimeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #actingBudget: number;
  readonly #allowActionsOffOrigin: boolean;

  constructor(options: BrowserSessionOptions) {
    this.homeDir = resolve(options.homeDir);
    this.screenshotDir = join(this.homeDir, SCREENSHOT_DIRNAME);
    this.backend = (options.backend ?? DEFAULT_BROWSER_BACKEND)({ homeDir: this.homeDir });
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.#actingBudget = options.actingBudget ?? DEFAULT_ACTING_BUDGET;
    this.#allowActionsOffOrigin = options.allowActionsOffOrigin ?? false;
    this.#actingRemaining = this.#actingBudget;
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

  /** The refs the most recent `find` minted, for tests and result rendering. */
  get refs(): ReadonlyMap<string, PageElementMatch> {
    return this.#refs;
  }

  get refPageUrl(): string | undefined {
    return this.#refPageUrl;
  }

  /** The trusted origin (last `open()`), for tests and result rendering. */
  get originUrl(): string | undefined {
    return this.#originUrl;
  }

  /** Navigations the page drove since the last `open()`. */
  get originHops(): number {
    return this.#originHops;
  }

  /** Consequential actions left before the next `open()` re-anchors the origin. */
  get actingRemaining(): number {
    return this.#actingRemaining;
  }

  // -------------------------------------------------------------------- helpers

  /** Serialize every action; see the file header. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #timeout(timeoutMs?: number): { timeoutMs: number } {
    return { timeoutMs: timeoutMs ?? this.#actionTimeoutMs };
  }

  /** Restart the idle countdown. A ghost that stopped browsing stops paying for it. */
  #touchIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#idleTimeoutMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      void this.close().catch(() => undefined);
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
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

  /** Nothing but `open` and `close` may act on a browser with no page loaded. */
  async #requirePage(): Promise<PageSummary> {
    const page = await this.backend.current();
    if (page) return page;
    throw new GhostBrowserError(
      "no_page",
      "No page is loaded. Use action \"open\" with a URL first.",
    );
  }

  // -------------------------------------------------------------------- actions

  open(url: string, options: UrlPolicyOptions & { timeoutMs?: number } = {}) {
    return this.#serial(() => this.#openImpl(url, options));
  }

  async #openImpl(
    url: string,
    options: UrlPolicyOptions & { timeoutMs?: number },
  ): Promise<PageSummary> {
    // The one place a URL is vetted. Backends never see an unchecked one.
    const checked = checkUrl(url, options);
    if (!checked.ok) {
      throw new GhostBrowserError("blocked_url", checked.rejection.reason, {
        url: checked.rejection.url,
      });
    }
    this.#invalidateRefs();
    const page = await this.backend.open(checked.url, this.#timeout(options.timeoutMs));
    // This navigation came from the owner: re-anchor the trusted origin to
    // where it actually landed, reset the hop count, and refill the budget.
    this.#originUrl = page.url;
    this.#originHops = 0;
    this.#actingRemaining = this.#actingBudget;
    this.#touchIdleTimer();
    return page;
  }

  read(options: { maxChars?: number; timeoutMs?: number } = {}) {
    return this.#serial(() => this.#readImpl(options));
  }

  async #readImpl(
    options: { maxChars?: number; timeoutMs?: number },
  ): Promise<SessionReadResult> {
    const maxChars = Math.max(
      MIN_READ_BUDGET_CHARS,
      options.maxChars ?? DEFAULT_READ_BUDGET_CHARS,
    );
    await this.#requirePage();
    const result = await this.backend.read(this.#timeout(options.timeoutMs));
    this.#touchIdleTimer();
    return {
      url: result.url,
      title: result.title,
      text: result.text.slice(0, maxChars),
      totalLength: result.text.length,
    };
  }

  find(query: string, options: { limit?: number; timeoutMs?: number } = {}) {
    return this.#serial(() => this.#findImpl(query, options));
  }

  async #findImpl(
    query: string,
    options: { limit?: number; timeoutMs?: number },
  ): Promise<readonly PageElementMatch[]> {
    const trimmed = query.trim();
    if (trimmed === "") {
      throw new GhostBrowserError("invalid_input", "A find needs a query.");
    }
    const limit = Math.min(
      MAX_FIND_LIMIT,
      Math.max(1, options.limit ?? DEFAULT_FIND_LIMIT),
    );
    const page = await this.#requirePage();
    const matches = await this.backend.find(trimmed, {
      ...this.#timeout(options.timeoutMs),
      limit,
    });
    this.#refs = new Map(matches.map((match) => [match.ref, match]));
    this.#refPageUrl = page.url;
    this.#touchIdleTimer();
    return matches;
  }

  click(target: BackendTarget & { timeoutMs?: number; allowCrossDomain?: boolean }) {
    return this.#serial(() => this.#clickImpl(target));
  }

  async #clickImpl(
    target: BackendTarget & { timeoutMs?: number; allowCrossDomain?: boolean },
  ): Promise<PageSummary> {
    const checked = this.#checkTarget(target);
    const before = await this.#requirePage();
    // Clicking is consequential: gate it against the trusted origin first.
    this.#gateActing(before.url, target.allowCrossDomain === true);
    const page = await this.backend.click(checked, this.#timeout(target.timeoutMs));
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
    timeoutMs?: number;
    allowCrossDomain?: boolean;
  }) {
    return this.#serial(() => this.#typeImpl(input));
  }

  async #typeImpl(input: BackendTarget & {
    text: string;
    submit?: boolean;
    timeoutMs?: number;
    allowCrossDomain?: boolean;
  }): Promise<SessionTypeResult> {
    const checked = this.#checkTarget(input);
    const before = await this.#requirePage();
    // Typing into and submitting someone's form is consequential too.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    // Submitting is a separate, explicit act: filling a field is reversible,
    // pressing Enter on someone's form is not.
    const submit = input.submit === true;
    const page = await this.backend.type(
      { ...checked, text: input.text, submit },
      this.#timeout(input.timeoutMs),
    );
    if (submit) {
      this.#invalidateRefs();
      if (page.url !== before.url) this.#originHops += 1;
    }
    this.#touchIdleTimer();
    return { ...page, submitted: submit };
  }

  screenshot(options: { fullPage?: boolean; timeoutMs?: number } = {}) {
    return this.#serial(() => this.#screenshotImpl(options));
  }

  async #screenshotImpl(
    options: { fullPage?: boolean; timeoutMs?: number },
  ): Promise<SessionScreenshotResult> {
    await this.#requirePage();
    await mkdir(this.screenshotDir, { recursive: true });
    this.#screenshotCount += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(this.screenshotDir, `${stamp}-${this.#screenshotCount}.png`);
    const page = await this.backend.screenshot({
      ...this.#timeout(options.timeoutMs),
      path,
      fullPage: options.fullPage === true,
    });
    this.#touchIdleTimer();
    return { ...page, path };
  }

  back(options: { timeoutMs?: number } = {}) {
    return this.#serial(() => this.#backImpl(options));
  }

  async #backImpl(options: { timeoutMs?: number }): Promise<BackendBackResult> {
    await this.#requirePage();
    const page = await this.backend.back(this.#timeout(options.timeoutMs));
    // Going back steps toward the origin, so it undoes a hop rather than adding
    // one. Observing only — no gate — but the hop count has to stay honest.
    if (page.moved && this.#originHops > 0) this.#originHops -= 1;
    this.#invalidateRefs();
    this.#touchIdleTimer();
    return page;
  }

  forward(options: { timeoutMs?: number } = {}) {
    return this.#serial(() => this.#forwardImpl(options));
  }

  async #forwardImpl(options: { timeoutMs?: number }): Promise<BackendBackResult> {
    await this.#requirePage();
    const page = await this.backend.forward(this.#timeout(options.timeoutMs));
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
    timeoutMs?: number;
  }) {
    return this.#serial(() => this.#scrollImpl(input));
  }

  async #scrollImpl(input: {
    deltaX: number;
    deltaY: number;
    x?: number;
    y?: number;
    timeoutMs?: number;
  }): Promise<PageSummary> {
    await this.#requirePage();
    // Scrolling only moves the viewport; it is observing, never gated.
    const page = await this.backend.scroll(
      {
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
      },
      this.#timeout(input.timeoutMs),
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
    timeoutMs?: number;
  }) {
    return this.#serial(() => this.#dragImpl(input));
  }

  async #dragImpl(input: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    steps?: number;
    allowCrossDomain?: boolean;
    timeoutMs?: number;
  }): Promise<PageSummary> {
    const before = await this.#requirePage();
    // Dragging can reorder, move, or drop things: consequential, so it is gated.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    const page = await this.backend.drag(
      {
        fromX: input.fromX,
        fromY: input.fromY,
        toX: input.toX,
        toY: input.toY,
        ...(input.steps === undefined ? {} : { steps: input.steps }),
      },
      this.#timeout(input.timeoutMs),
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
    timeoutMs?: number;
  }) {
    return this.#serial(() => this.#keyImpl(input));
  }

  async #keyImpl(input: {
    key: string;
    modifiers?: readonly string[];
    text?: string;
    allowCrossDomain?: boolean;
    timeoutMs?: number;
  }): Promise<PageSummary> {
    const key = input.key.trim();
    if (key === "") {
      throw new GhostBrowserError("invalid_input", "A key press needs a key name.");
    }
    const before = await this.#requirePage();
    // Pressing keys drives the focused control: consequential, so it is gated.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    const page = await this.backend.key(
      {
        key,
        ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
        ...(input.text === undefined ? {} : { text: input.text }),
      },
      this.#timeout(input.timeoutMs),
    );
    if (page.url !== before.url) {
      this.#invalidateRefs();
      this.#originHops += 1;
    }
    this.#touchIdleTimer();
    return page;
  }

  javascript(code: string, options: { allowCrossDomain?: boolean; timeoutMs?: number } = {}) {
    return this.#serial(() => this.#javascriptImpl(code, options));
  }

  async #javascriptImpl(
    code: string,
    options: { allowCrossDomain?: boolean; timeoutMs?: number },
  ): Promise<BackendJavascriptResult> {
    if (code.trim() === "") {
      throw new GhostBrowserError("invalid_input", "There is no code to run.");
    }
    const before = await this.#requirePage();
    // Running script is the sharpest consequential action: gate it exactly like a
    // click, and spend a unit of the acting budget.
    this.#gateActing(before.url, options.allowCrossDomain === true);
    const result = await this.backend.javascript(code, this.#timeout(options.timeoutMs));
    // Script can rewrite the page under our refs; the honest move is to drop them.
    this.#invalidateRefs();
    this.#touchIdleTimer();
    return result;
  }

  readConsole(options: { timeoutMs?: number } = {}) {
    return this.#serial(() => this.#readConsoleImpl(options));
  }

  async #readConsoleImpl(
    options: { timeoutMs?: number },
  ): Promise<readonly ConsoleEntry[]> {
    await this.#requirePage();
    const entries = await this.backend.readConsole(this.#timeout(options.timeoutMs));
    this.#touchIdleTimer();
    return entries;
  }

  readNetwork(options: { timeoutMs?: number } = {}) {
    return this.#serial(() => this.#readNetworkImpl(options));
  }

  async #readNetworkImpl(
    options: { timeoutMs?: number },
  ): Promise<readonly NetworkEntry[]> {
    await this.#requirePage();
    const entries = await this.backend.readNetwork(this.#timeout(options.timeoutMs));
    this.#touchIdleTimer();
    return entries;
  }

  upload(input: BackendTarget & {
    paths: readonly string[];
    allowCrossDomain?: boolean;
    timeoutMs?: number;
  }) {
    return this.#serial(() => this.#uploadImpl(input));
  }

  async #uploadImpl(input: BackendTarget & {
    paths: readonly string[];
    allowCrossDomain?: boolean;
    timeoutMs?: number;
  }): Promise<PageSummary> {
    if (input.paths.length === 0) {
      throw new GhostBrowserError("invalid_input", "Give at least one file path to upload.");
    }
    const checked = this.#checkTarget(input);
    const before = await this.#requirePage();
    // Handing a file to a form is consequential — gate it against the origin.
    this.#gateActing(before.url, input.allowCrossDomain === true);
    const page = await this.backend.upload(
      { ...checked, paths: [...input.paths] },
      this.#timeout(input.timeoutMs),
    );
    this.#touchIdleTimer();
    return page;
  }

  resize(input: { width: number; height: number; timeoutMs?: number }) {
    return this.#serial(() => this.#resizeImpl(input));
  }

  async #resizeImpl(input: {
    width: number;
    height: number;
    timeoutMs?: number;
  }): Promise<BackendResizeResult> {
    await this.#requirePage();
    const result = await this.backend.resize(
      { width: input.width, height: input.height },
      this.#timeout(input.timeoutMs),
    );
    this.#touchIdleTimer();
    return result;
  }

  tabs(input: {
    op: BackendTabsInput["op"];
    id?: string;
    url?: string;
    allowLocal?: boolean;
    timeoutMs?: number;
  }) {
    return this.#serial(() => this.#tabsImpl(input));
  }

  async #tabsImpl(input: {
    op: BackendTabsInput["op"];
    id?: string;
    url?: string;
    allowLocal?: boolean;
    timeoutMs?: number;
  }): Promise<BackendTabsResult> {
    let url: string | undefined;
    if (input.op === "create" && input.url !== undefined && input.url.trim() !== "") {
      // A new tab with a URL is an owner-directed navigation: vet it like open,
      // then re-anchor the trusted origin to it.
      const checked = checkUrl(input.url, {
        ...(input.allowLocal === undefined ? {} : { allowLocal: input.allowLocal }),
      });
      if (!checked.ok) {
        throw new GhostBrowserError("blocked_url", checked.rejection.reason, {
          url: checked.rejection.url,
        });
      }
      url = checked.url;
    }
    const result = await this.backend.tabs(
      {
        op: input.op,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(url === undefined ? {} : { url }),
      },
      this.#timeout(input.timeoutMs),
    );
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

  batch(steps: readonly BatchStep[], options: { timeoutMs?: number } = {}) {
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
    options: { timeoutMs?: number },
  ): Promise<BatchResult> {
    const results: BatchStepResult[] = [];
    for (const step of steps) {
      try {
        const summary = await this.#runStep(step, options.timeoutMs);
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

  /** Dispatch one batch step to a non-serialized impl. Returns a short summary. */
  async #runStep(step: BatchStep, timeoutMs?: number): Promise<string> {
    const t = timeoutMs === undefined ? {} : { timeoutMs };
    switch (step.action) {
      case "open": {
        const page = await this.#openImpl(step.url ?? "", {
          ...t,
          ...(step.allowLocal === undefined ? {} : { allowLocal: step.allowLocal }),
        });
        return `open → ${page.url}`;
      }
      case "read": {
        const r = await this.#readImpl({ ...t, ...(step.maxChars === undefined ? {} : { maxChars: step.maxChars }) });
        return `read ${r.text.length} of ${r.totalLength} chars`;
      }
      case "find": {
        const matches = await this.#findImpl(step.query ?? "", {
          ...t,
          ...(step.limit === undefined ? {} : { limit: step.limit }),
        });
        return `find "${step.query ?? ""}" → ${matches.length} match(es)`;
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

  /** Close the browser. Safe to call when it was never started. */
  async close(): Promise<boolean> {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#invalidateRefs();
    // A fresh browser has no trusted origin until the next open().
    this.#originUrl = undefined;
    this.#originHops = 0;
    this.#actingRemaining = this.#actingBudget;
    return this.backend.close();
  }
}

// ------------------------------------------------------------------- registry

interface EffectiveSessionOptions {
  readonly backend: BrowserBackendFactory;
  readonly backendIdentity: readonly unknown[];
  readonly backendDescription: string;
  readonly idleTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly actingBudget: number;
  readonly allowActionsOffOrigin: boolean;
}

interface BrowserSessionEntry {
  readonly session: GhostBrowserSession;
  readonly options: EffectiveSessionOptions;
}

const sessions = new Map<string, BrowserSessionEntry>();

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
    actingBudget: options.actingBudget,
    allowActionsOffOrigin: options.allowActionsOffOrigin,
  };
}

/** Where a ghost's screenshots go. */
export function screenshotDirFor(homeDir: string): string {
  return join(resolve(homeDir), SCREENSHOT_DIRNAME);
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
    actingBudget: requested.actingBudget,
    allowActionsOffOrigin: requested.allowActionsOffOrigin,
  });
  sessions.set(key, { session, options: requested });
  return session;
}

/** Close every browser this process opened. The daemon calls this on shutdown. */
export async function closeAllBrowserSessions(): Promise<void> {
  const open = [...sessions.values()].map((entry) => entry.session);
  sessions.clear();
  await Promise.all(open.map((session) => session.close()));
}
