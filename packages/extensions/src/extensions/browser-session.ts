/**
 * Everything about browsing that is *not* about which browser.
 *
 * URL policy, ref bookkeeping and invalidation, the read budget, the idle
 * shutdown timer, and the serialization of parallel tool calls all live here,
 * above the `GhostBrowserBackend` seam, so the Playwright backend and the
 * coming relay-into-the-creator's-Chromium backend get exactly one
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
import {
  GhostBrowserError,
  type BackendBackResult,
  type BackendTarget,
  type BrowserBackendFactory,
  type GhostBrowserBackend,
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

/**
 * How many consequential actions (click/type) may fire between two explicit
 * `open()`s. An injected page that hijacks the ghost cannot issue an `open()` on
 * the creator's behalf, so bounding actions per creator-directed navigation caps
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
   * Consequential actions allowed per creator-directed `open()`. See
   * {@link DEFAULT_ACTING_BUDGET}. Zero or negative disables the budget (the
   * domain-scope guardrail still applies).
   */
  readonly actingBudget?: number;
  /**
   * Per-conversation escape hatch: let consequential actions run off the
   * opened origin's registrable domain by default, for a creator who is running
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

  /** The URL the creator's most recent `open()` landed on — the trusted origin. */
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
    this.backend = (options.backend ?? playwrightBackend())({ homeDir: this.homeDir });
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
   * or submit on a page off the creator-opened origin's registrable domain, and
   * spends one unit of the per-open acting budget. Reads never call this.
   *
   * Fails closed, before the backend ever hears about the action, with a
   * structured `GhostBrowserError` that names how the creator can widen scope.
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
        + "push the browser. If the creator asked for this, re-open the page you "
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
    return this.#serial(async (): Promise<PageSummary> => {
      // The one place a URL is vetted. Backends never see an unchecked one.
      const checked = checkUrl(url, options);
      if (!checked.ok) {
        throw new GhostBrowserError("blocked_url", checked.rejection.reason, {
          url: checked.rejection.url,
        });
      }
      this.#invalidateRefs();
      const page = await this.backend.open(checked.url, this.#timeout(options.timeoutMs));
      // This is the creator's own navigation: re-anchor the trusted origin to
      // where it actually landed, reset the hop count, and refill the budget.
      this.#originUrl = page.url;
      this.#originHops = 0;
      this.#actingRemaining = this.#actingBudget;
      this.#touchIdleTimer();
      return page;
    });
  }

  read(options: { maxChars?: number; timeoutMs?: number } = {}) {
    return this.#serial(async (): Promise<SessionReadResult> => {
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
    });
  }

  find(query: string, options: { limit?: number; timeoutMs?: number } = {}) {
    return this.#serial(async (): Promise<readonly PageElementMatch[]> => {
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
    });
  }

  click(target: BackendTarget & { timeoutMs?: number; allowCrossDomain?: boolean }) {
    return this.#serial(async (): Promise<PageSummary> => {
      const checked = this.#checkTarget(target);
      const before = await this.#requirePage();
      // Clicking is consequential: gate it against the trusted origin first.
      this.#gateActing(before.url, target.allowCrossDomain === true);
      const page = await this.backend.click(checked, this.#timeout(target.timeoutMs));
      // A click that navigated invalidates every ref minted on the old page and
      // counts as one more hop the page — not the creator — drove.
      if (page.url !== before.url) {
        this.#invalidateRefs();
        this.#originHops += 1;
      }
      this.#touchIdleTimer();
      return page;
    });
  }

  type(input: BackendTarget & {
    text: string;
    submit?: boolean;
    timeoutMs?: number;
    allowCrossDomain?: boolean;
  }) {
    return this.#serial(async (): Promise<SessionTypeResult> => {
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
    });
  }

  screenshot(options: { fullPage?: boolean; timeoutMs?: number } = {}) {
    return this.#serial(async (): Promise<SessionScreenshotResult> => {
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
    });
  }

  back(options: { timeoutMs?: number } = {}) {
    return this.#serial(async (): Promise<BackendBackResult> => {
      await this.#requirePage();
      const page = await this.backend.back(this.#timeout(options.timeoutMs));
      // Going back steps toward the origin, so it undoes a hop rather than adding
      // one. Observing only — no gate — but the hop count has to stay honest.
      if (page.moved && this.#originHops > 0) this.#originHops -= 1;
      this.#invalidateRefs();
      this.#touchIdleTimer();
      return page;
    });
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

const sessions = new Map<string, GhostBrowserSession>();

/** Where a ghost's screenshots go. */
export function screenshotDirFor(homeDir: string): string {
  return join(resolve(homeDir), SCREENSHOT_DIRNAME);
}

/**
 * The one session for this ghost home, created on first ask. Keyed on the home
 * because that is what a launched Chromium locks, and because a ghost should
 * have one browser, not one per conversation.
 */
export function browserSessionFor(
  homeDir: string,
  options: Omit<BrowserSessionOptions, "homeDir"> = {},
): GhostBrowserSession {
  const key = resolve(homeDir);
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new GhostBrowserSession({ homeDir: key, ...options });
  sessions.set(key, session);
  return session;
}

/** Close every browser this process opened. The daemon calls this on shutdown. */
export async function closeAllBrowserSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.all(open.map((session) => session.close()));
}
