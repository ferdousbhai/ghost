/**
 * The Playwright backend: the ghost's own Chromium, its own profile.
 *
 * Three decisions shape this file.
 *
 * **A dedicated profile, never the creator's.** `launchPersistentContext` points
 * at `<ghost home>/.browser-profile/`. Logins the *ghost* makes persist there and
 * nowhere else, so a credential-isolated persona does not inherit the creator's
 * sessions, and two ghosts on one machine do not see each other's. This is also
 * the only shape that still works for a launched browser: Chrome ≥136 refuses
 * `--remote-debugging-port` on the default profile. Driving the creator's real,
 * signed-in browser is a genuinely different mechanism and gets its own backend
 * (an MV3 relay over `chrome.debugger`) rather than being smuggled in here.
 *
 * **`playwright-core`, not `playwright`.** No bundled browser download; we launch
 * the system Chrome/Chromium and say so plainly when there isn't one. A ghost
 * install should not silently pull 150 MB of Chromium into `node_modules`.
 *
 * **Refs are a stamped attribute.** `find` sets `data-ghost-ref="e3"` on each
 * match, so acting on `e3` needs no handle held open between tool calls: the ref
 * *is* a selector. The relay backend will mint refs some other way; that is
 * exactly why refs are the backend's business and their bookkeeping is not.
 */
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { GhostError } from "../errors.js";
import {
  errorMessage,
  GhostBrowserError,
  identifiedBrowserBackendFactory,
  rethrowBackendError,
  withTimeout,
  type BackendActionOptions,
  type BackendBackResult,
  type BackendDragInput,
  type BackendJavascriptResult,
  type BackendKeyInput,
  type BackendReadResult,
  type BackendResizeInput,
  type BackendResizeResult,
  type BackendScreenshotOptions,
  type BackendScrollInput,
  type BackendTabInfo,
  type BackendTabsInput,
  type BackendTabsResult,
  type BackendTarget,
  type BackendTypeInput,
  type BackendUploadInput,
  type BrowserBackendContext,
  type BrowserBackendFactory,
  type ConsoleEntry,
  type GhostBrowserBackend,
  type NetworkEntry,
  type PageElementMatch,
  type PageSummary,
} from "./browser-backend.js";
import {
  callScript,
  FIND_ELEMENTS_SCRIPT,
  READ_PAGE_SCRIPT,
  REF_ATTRIBUTE,
} from "./browser-page-scripts.js";
import { BLANK_URL } from "./browser-policy.js";

export const BROWSER_PROFILE_DIRNAME = ".browser-profile";

export interface PlaywrightBackendOptions {
  /** Headed by default; the creator can watch the ghost browse. */
  readonly headless?: boolean;
  /** Skip detection and use this Chrome/Chromium binary. */
  readonly executablePath?: string;
  /** Launch timeout. Per-action timeouts arrive with each call. */
  readonly launchTimeoutMs?: number;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

/** How many console / network entries the rings keep before dropping the oldest. */
const RING_LIMIT = 200;

/** Names to look for on `PATH`, best first. */
const LINUX_BINARY_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
  "ungoogled-chromium",
];

/** Absolute paths worth trying when `PATH` comes up empty. */
const EXTRA_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
  "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
  "/var/lib/flatpak/exports/bin/com.google.Chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The system Chrome/Chromium, or undefined. `PATH` first — a per-user or Nix or
 * Flatpak install wins over `/usr/bin` that way, without enumerating every
 * packaging scheme.
 */
export async function findChromiumExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const configured = env["GHOST_BROWSER_EXECUTABLE"];
  if (configured && (await isExecutable(configured))) return configured;

  const pathDirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  for (const name of LINUX_BINARY_NAMES) {
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  for (const candidate of EXTRA_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export const NO_BROWSER_MESSAGE =
  "No Chrome or Chromium is installed, so the browser cannot start. Ask the "
  + "creator to install one — on Arch/Omarchy that is the `chromium` package "
  + "(`sudo pacman -S chromium`) — or point GHOST_BROWSER_EXECUTABLE at an "
  + "existing Chrome binary. This extension deliberately does not download its "
  + "own browser.";

/** Chromium flags for an unattended profile that nobody wants prompts from. */
const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-backgrounding-occluded-windows",
  // Otherwise a headed Chromium blocks on the desktop keyring for its own
  // password store, which nothing in a ghost profile ever needs.
  "--password-store=basic",
  "--use-mock-keychain",
];

/** A headed browser needs a display; without one, fall back to headless. */
function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env["WAYLAND_DISPLAY"] || env["DISPLAY"]);
}

export class PlaywrightBrowserBackend implements GhostBrowserBackend {
  readonly name = "playwright";
  readonly profileDir: string;

  #context: BrowserContext | undefined;
  #launching: Promise<BrowserContext> | undefined;
  #headless: boolean;
  #refs = new Set<string>();

  /** Console and network rings, drained by `readConsole`/`readNetwork`. */
  #console: ConsoleEntry[] = [];
  #network: NetworkEntry[] = [];
  #observed = new WeakSet<Page>();
  /** Stable ids for tabs, since Playwright pages have none of their own. */
  #pageIds = new WeakMap<Page, string>();
  #nextPageId = 1;

  readonly #executablePath: string | undefined;
  readonly #launchTimeoutMs: number;

  constructor(profileDir: string, options: PlaywrightBackendOptions = {}) {
    this.profileDir = resolve(profileDir);
    this.#headless = options.headless ?? !hasDisplay();
    this.#executablePath = options.executablePath;
    this.#launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.#context !== undefined;
  }

  get headless(): boolean {
    return this.#headless;
  }

  setHeadless(headless: boolean): { applied: boolean } {
    this.#headless = headless;
    return { applied: !this.running };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Launch on first use, and only once even under parallel tool calls. */
  async #contextOrLaunch(): Promise<BrowserContext> {
    if (this.#context) return this.#context;
    if (!this.#launching) {
      this.#launching = this.#launch().finally(() => {
        this.#launching = undefined;
      });
    }
    return this.#launching;
  }

  async #launch(): Promise<BrowserContext> {
    const executablePath = this.#executablePath ?? (await findChromiumExecutable());
    if (!executablePath) {
      throw new GhostBrowserError("browser_unavailable", NO_BROWSER_MESSAGE);
    }
    await mkdir(this.profileDir, { recursive: true });

    let chromium: (typeof import("playwright-core"))["chromium"];
    try {
      ({ chromium } = await import("playwright-core"));
    } catch (error) {
      throw new GhostBrowserError(
        "browser_unavailable",
        `playwright-core could not be loaded: ${errorMessage(error)}`,
      );
    }

    let context: BrowserContext;
    try {
      context = await withTimeout(
        chromium.launchPersistentContext(this.profileDir, {
          executablePath,
          headless: this.#headless,
          args: LAUNCH_ARGS,
          viewport: { width: 1280, height: 900 },
        }),
        this.#launchTimeoutMs,
        "starting the browser",
      );
    } catch (error) {
      if (error instanceof GhostError) throw error;
      throw new GhostBrowserError(
        "browser_unavailable",
        `The browser failed to start: ${errorMessage(error)}`,
        { executablePath },
      );
    }

    context.setDefaultTimeout?.(this.#launchTimeoutMs);
    context.setDefaultNavigationTimeout?.(this.#launchTimeoutMs);
    // The window closing (creator clicked the X) must not leave a stale handle.
    context.on?.("close", () => {
      if (this.#context === context) {
        this.#context = undefined;
        this.#refs.clear();
      }
    });
    // Buffer console and network from every page, present and future, so a later
    // `readConsole`/`readNetwork` has something to drain without arming anything
    // per call.
    context.on?.("page", (page: Page) => this.#observe(page));
    for (const page of context.pages()) this.#observe(page);
    this.#context = context;
    return context;
  }

  /** Attach console / network listeners once per page; feeds the rings. */
  #observe(page: Page): void {
    if (this.#observed.has(page)) return;
    this.#observed.add(page);
    const pushConsole = (entry: ConsoleEntry): void => {
      this.#console.push(entry);
      if (this.#console.length > RING_LIMIT) this.#console.shift();
    };
    page.on?.("console", (msg: {
      type: () => string;
      text: () => string;
      location: () => { url?: string; lineNumber?: number };
    }) => {
      const loc = msg.location();
      pushConsole({
        level: msg.type(),
        text: msg.text(),
        ...(loc.url ? { url: loc.url } : {}),
        ...(typeof loc.lineNumber === "number" ? { line: loc.lineNumber } : {}),
      });
    });
    page.on?.("pageerror", (error: Error) => {
      pushConsole({ level: "error", text: error.message });
    });
    page.on?.("response", (response: {
      status: () => number;
      url: () => string;
      request: () => { method: () => string; resourceType: () => string };
    }) => {
      const request = response.request();
      this.#network.push({
        method: request.method(),
        url: response.url(),
        status: response.status(),
        type: request.resourceType(),
      });
      if (this.#network.length > RING_LIMIT) this.#network.shift();
    });
  }

  #tabId(page: Page): string {
    const existing = this.#pageIds.get(page);
    if (existing) return existing;
    const id = `t${this.#nextPageId}`;
    this.#nextPageId += 1;
    this.#pageIds.set(page, id);
    return id;
  }

  async close(): Promise<boolean> {
    const context = this.#context;
    this.#context = undefined;
    this.#refs.clear();
    this.#console = [];
    this.#network = [];
    if (!context) return false;
    try {
      await context.close();
    } catch {
      // A browser that already died is closed enough.
    }
    return true;
  }

  // -------------------------------------------------------------------- helpers

  async #page(): Promise<Page> {
    const context = await this.#contextOrLaunch();
    const pages = context.pages();
    const page = pages[pages.length - 1];
    if (page) return page;
    return context.newPage();
  }

  /** The current page, refusing to launch just to report there is nothing on it. */
  async #openPage(): Promise<Page> {
    if (!this.#context) {
      throw new GhostBrowserError("no_page", "The browser is not open yet.");
    }
    const page = await this.#page();
    const url = page.url();
    if (url === BLANK_URL || url === "") {
      throw new GhostBrowserError("no_page", "No page is loaded.");
    }
    return page;
  }

  async current(): Promise<PageSummary | undefined> {
    if (!this.#context) return undefined;
    const pages = this.#context.pages();
    const page = pages[pages.length - 1];
    if (!page) return undefined;
    const url = page.url();
    if (url === BLANK_URL || url === "") return undefined;
    return this.#summarize(page);
  }

  #selectorFor(target: BackendTarget): string {
    const ref = target.ref?.trim();
    if (ref) return `[${REF_ATTRIBUTE}="${ref}"]`;
    const selector = target.selector?.trim();
    if (selector) return selector;
    throw new GhostBrowserError("invalid_input", "No ref or selector was given.");
  }

  async #summarize(page: Page): Promise<PageSummary> {
    let title = "";
    try {
      title = await page.title();
    } catch {
      // A page mid-navigation has no title yet; the URL is enough.
    }
    return { url: page.url(), title };
  }

  /** Playwright's "waiting for locator" is a missing element, not a page failure. */
  #actionError(error: unknown, selector: string, action: string, timeoutMs: number): never {
    if (error instanceof GhostError) throw error;
    const text = errorMessage(error);
    if (/waiting for (locator|selector)|element is not|not visible|not an? (input|editable)/i
      .test(text)) {
      throw new GhostBrowserError(
        "element_not_found",
        `Nothing matched ${selector}. Run find again — the page may have changed.`,
        { selector },
      );
    }
    rethrowBackendError(error, action, timeoutMs);
  }

  // -------------------------------------------------------------------- actions

  async open(url: string, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#page();
    this.#refs.clear();
    try {
      await page.goto(url, { timeout: options.timeoutMs, waitUntil: "domcontentloaded" });
    } catch (error) {
      rethrowBackendError(error, `opening ${url}`, options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async read(options: BackendActionOptions): Promise<BackendReadResult> {
    const page = await this.#openPage();
    try {
      return await withTimeout(
        page.evaluate<BackendReadResult>(callScript(READ_PAGE_SCRIPT)),
        options.timeoutMs,
        "reading the page",
      );
    } catch (error) {
      rethrowBackendError(error, "reading the page", options.timeoutMs);
    }
  }

  async find(
    query: string,
    options: BackendActionOptions & { limit: number },
  ): Promise<readonly PageElementMatch[]> {
    const page = await this.#openPage();
    let matches: readonly PageElementMatch[];
    try {
      matches = await withTimeout(
        page.evaluate<readonly PageElementMatch[]>(
          callScript(FIND_ELEMENTS_SCRIPT, {
            query,
            limit: options.limit,
            attribute: REF_ATTRIBUTE,
          }),
        ),
        options.timeoutMs,
        "searching the page",
      );
    } catch (error) {
      rethrowBackendError(error, "searching the page", options.timeoutMs);
    }
    this.#refs = new Set(matches.map((match) => match.ref));
    return matches;
  }

  async click(target: BackendTarget, options: BackendActionOptions): Promise<PageSummary> {
    const selector = this.#selectorFor(target);
    const page = await this.#openPage();
    try {
      await page.click(selector, { timeout: options.timeoutMs });
    } catch (error) {
      this.#actionError(error, selector, `clicking ${selector}`, options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async type(input: BackendTypeInput, options: BackendActionOptions): Promise<PageSummary> {
    const selector = this.#selectorFor(input);
    const page = await this.#openPage();
    try {
      await page.fill(selector, input.text, { timeout: options.timeoutMs });
      if (input.submit) {
        await page.press(selector, "Enter", { timeout: options.timeoutMs });
        await page
          .waitForLoadState("domcontentloaded", { timeout: options.timeoutMs })
          .catch(() => undefined);
      }
    } catch (error) {
      this.#actionError(error, selector, `typing into ${selector}`, options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async screenshot(options: BackendScreenshotOptions): Promise<PageSummary> {
    const page = await this.#openPage();
    try {
      await page.screenshot({
        path: options.path,
        timeout: options.timeoutMs,
        fullPage: options.fullPage,
      });
    } catch (error) {
      rethrowBackendError(error, "taking a screenshot", options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async back(options: BackendActionOptions): Promise<BackendBackResult> {
    const page = await this.#openPage();
    let moved = false;
    try {
      const response = await page.goBack({
        timeout: options.timeoutMs,
        waitUntil: "domcontentloaded",
      });
      moved = response !== null;
    } catch (error) {
      rethrowBackendError(error, "going back", options.timeoutMs);
    }
    this.#refs.clear();
    return { ...(await this.#summarize(page)), moved };
  }

  async forward(options: BackendActionOptions): Promise<BackendBackResult> {
    const page = await this.#openPage();
    let moved = false;
    try {
      const response = await page.goForward({
        timeout: options.timeoutMs,
        waitUntil: "domcontentloaded",
      });
      moved = response !== null;
    } catch (error) {
      rethrowBackendError(error, "going forward", options.timeoutMs);
    }
    this.#refs.clear();
    return { ...(await this.#summarize(page)), moved };
  }

  async scroll(input: BackendScrollInput, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#openPage();
    try {
      if (input.x !== undefined && input.y !== undefined) {
        await page.mouse.move(input.x, input.y);
      }
      await page.mouse.wheel(input.deltaX, input.deltaY);
    } catch (error) {
      rethrowBackendError(error, "scrolling", options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async drag(input: BackendDragInput, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#openPage();
    try {
      await page.mouse.move(input.fromX, input.fromY);
      await page.mouse.down();
      await page.mouse.move(input.toX, input.toY, { steps: Math.max(1, input.steps ?? 8) });
      await page.mouse.up();
    } catch (error) {
      rethrowBackendError(error, "dragging", options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async key(input: BackendKeyInput, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#openPage();
    // Playwright presses a chord from a "+"-joined string: Control+Shift+KeyA.
    const combo = [...(input.modifiers ?? []), input.key].join("+");
    try {
      await withTimeout(page.keyboard.press(combo), options.timeoutMs, "pressing a key");
    } catch (error) {
      rethrowBackendError(error, "pressing a key", options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async javascript(
    code: string,
    options: BackendActionOptions,
  ): Promise<BackendJavascriptResult> {
    const page = await this.#openPage();
    try {
      // The string form evaluates an expression in the page's main world, exactly
      // like the relay's `Runtime.evaluate`. The value is untrusted data.
      const value = await withTimeout(
        page.evaluate<unknown>(code),
        options.timeoutMs,
        "running javascript",
      );
      return { value, type: typeof value };
    } catch (error) {
      rethrowBackendError(error, "running javascript", options.timeoutMs);
    }
  }

  async readConsole(_options: BackendActionOptions): Promise<readonly ConsoleEntry[]> {
    const drained = this.#console;
    this.#console = [];
    return drained;
  }

  async readNetwork(_options: BackendActionOptions): Promise<readonly NetworkEntry[]> {
    const drained = this.#network;
    this.#network = [];
    return drained;
  }

  async upload(input: BackendUploadInput, options: BackendActionOptions): Promise<PageSummary> {
    const selector = this.#selectorFor(input);
    const page = await this.#openPage();
    try {
      await page.setInputFiles(selector, [...input.paths], { timeout: options.timeoutMs });
    } catch (error) {
      this.#actionError(error, selector, `uploading to ${selector}`, options.timeoutMs);
    }
    return this.#summarize(page);
  }

  async resize(
    input: BackendResizeInput,
    _options: BackendActionOptions,
  ): Promise<BackendResizeResult> {
    const page = await this.#openPage();
    try {
      await page.setViewportSize({ width: input.width, height: input.height });
      return { ...(await this.#summarize(page)), applied: true };
    } catch {
      // A real headed window may refuse a viewport change; report it rather than
      // pretend, mirroring setHeadless's honest {applied:false}.
      return { ...(await this.#summarize(page)), applied: false };
    }
  }

  async tabs(input: BackendTabsInput, options: BackendActionOptions): Promise<BackendTabsResult> {
    const context = await this.#contextOrLaunch();
    const active = context.pages()[context.pages().length - 1];
    const summarizeList = async (activePage: Page | undefined): Promise<BackendTabInfo[]> => {
      const infos: BackendTabInfo[] = [];
      for (const page of context.pages()) {
        const summary = await this.#summarize(page);
        infos.push({ id: this.#tabId(page), url: summary.url, title: summary.title, active: page === activePage });
      }
      return infos;
    };

    if (input.op === "list") {
      const tabs = await summarizeList(active);
      return { tabs, active: active ? this.#tabId(active) : null };
    }
    if (input.op === "create") {
      const page = await context.newPage();
      this.#refs.clear();
      if (input.url && input.url !== BLANK_URL) {
        await page.goto(input.url, { timeout: options.timeoutMs, waitUntil: "domcontentloaded" });
      }
      const tabs = await summarizeList(page);
      return { tabs, active: this.#tabId(page), id: this.#tabId(page), page: await this.#summarize(page) };
    }
    // close / switch both name a tab by id.
    const target = context.pages().find((page) => this.#tabId(page) === input.id);
    if (!target) {
      throw new GhostBrowserError("invalid_input", `There is no tab ${input.id ?? "(none given)"}.`);
    }
    if (input.op === "switch") {
      await target.bringToFront();
      this.#refs.clear();
      const tabs = await summarizeList(target);
      return { tabs, active: this.#tabId(target), page: await this.#summarize(target) };
    }
    // close
    await target.close();
    this.#refs.clear();
    const remaining = context.pages();
    const nowActive = remaining[remaining.length - 1];
    const tabs = await summarizeList(nowActive);
    return {
      tabs,
      active: nowActive ? this.#tabId(nowActive) : null,
      ...(nowActive ? { page: await this.#summarize(nowActive) } : {}),
    };
  }
}

/**
 * The default backend factory: one Chromium per ghost home, profile under it.
 */
export function playwrightBackend(
  options: PlaywrightBackendOptions = {},
): BrowserBackendFactory {
  const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  return identifiedBrowserBackendFactory(
    (ctx: BrowserBackendContext) =>
      new PlaywrightBrowserBackend(join(resolve(ctx.homeDir), BROWSER_PROFILE_DIRNAME), options),
    "playwright",
    [
      "playwright",
      options.headless ?? "auto",
      options.executablePath ?? "auto",
      launchTimeoutMs,
    ],
  );
}
