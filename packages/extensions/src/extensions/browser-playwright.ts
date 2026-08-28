/**
 * The Playwright backend: the ghost's own Chromium, its own profile.
 *
 * Three decisions shape this file.
 *
 * **A dedicated profile, never the owner's.** `launchPersistentContext` points
 * at `<ghost home>/.browser-profile/`. Logins the *ghost* makes persist there and
 * nowhere else, so a credential-isolated persona does not inherit the owner's
 * sessions, and two ghosts on one machine do not see each other's. This is also
 * the only shape that still works for a launched browser: Chrome ≥136 refuses
 * `--remote-debugging-port` on the default profile. Driving the owner's real,
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
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { BrowserContext, Page, Request, Response, Route } from "playwright-core";
import { GhostError } from "../errors.js";
import {
  errorMessage,
  GhostBrowserError,
  identifiedBrowserBackendFactory,
  rethrowBackendError,
  timeoutError,
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
  type BackendScreenshotResult,
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
import { BLANK_URL, checkNetworkUrl, isPublicInternetAddress } from "./browser-policy.js";
import { boundBrowserObservationString } from "./browser-observation.js";
import { assertScreenshotBytesWithinLimit } from "./screenshot-retention.js";
import { descriptorPath } from "../linux-fs.js";

export const BROWSER_PROFILE_DIRNAME = ".browser-profile";

export interface PlaywrightBackendOptions {
  readonly headless?: boolean;
  /** Skip detection and use this Chrome/Chromium binary. */
  readonly executablePath?: string;
  readonly launchTimeoutMs?: number;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

const RING_LIMIT = 200;

const LINUX_BINARY_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
  "ungoogled-chromium",
];

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
  + "owner to install one — on Arch/Omarchy that is the `chromium` package "
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

const CHROMIUM_PROFILE_DIRECTORY = /^(?:Default|Profile \d+|Guest Profile|System Profile)$/;
const PROFILE_DIRECTORY_FLAGS = constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW;
const MAX_SERVICE_WORKER_STATE_DEPTH = 64;
const MAX_SERVICE_WORKER_STATE_ENTRIES = 100_000;

interface BrowserProfilePurgeHooks {
  readonly afterRootOpened?: () => Promise<void>;
  readonly afterProfileOpened?: (profileName: string) => Promise<void>;
  readonly afterStateOpened?: (profileName: string) => Promise<void>;
}

async function openPinnedDirectory(path: string): Promise<FileHandle> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, PROFILE_DIRECTORY_FLAGS);
    const stats = await directory.stat();
    if (!stats.isDirectory()) throw new Error(`${path} is not a real directory`);
    return directory;
  } catch (error) {
    await directory?.close().catch(() => undefined);
    throw error;
  }
}

async function assertPinnedDirectory(
  path: string,
  directory: FileHandle,
): Promise<void> {
  const [pinned, current] = await Promise.all([directory.stat(), lstat(path)]);
  if (!current.isDirectory() || current.dev !== pinned.dev || current.ino !== pinned.ino) {
    throw new Error(`${path} changed while its service-worker state was being cleared`);
  }
}

async function directoryEntries(directory: FileHandle, state: { entries: number }): Promise<string[]> {
  const entries: string[] = [];
  const listing = await opendir(descriptorPath(directory));
  try {
    for (;;) {
      const entry = await listing.read();
      if (entry === null) break;
      state.entries += 1;
      if (state.entries > MAX_SERVICE_WORKER_STATE_ENTRIES) {
        throw new Error(
          `Chromium service-worker state exceeds ${MAX_SERVICE_WORKER_STATE_ENTRIES} entries`,
        );
      }
      entries.push(entry.name);
    }
  } finally {
    await listing.close().catch(() => undefined);
  }
  return entries;
}

async function clearPinnedDirectory(
  directory: FileHandle,
  state: { entries: number },
  depth = 0,
): Promise<void> {
  if (depth > MAX_SERVICE_WORKER_STATE_DEPTH) {
    throw new Error(
      `Chromium service-worker state exceeds ${MAX_SERVICE_WORKER_STATE_DEPTH} directory levels`,
    );
  }
  for (const name of await directoryEntries(directory, state)) {
    const path = descriptorPath(directory, name);
    let child: FileHandle;
    try {
      child = await openPinnedDirectory(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "ENOTDIR" && code !== "ELOOP") throw error;
      try {
        // unlink() never follows the final component, whether it is a regular
        // file, special file, or a symlink swapped in by another process.
        await unlink(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    try {
      await clearPinnedDirectory(child, state, depth + 1);
      await assertPinnedDirectory(path, child);
    } finally {
      await child.close();
    }
    try {
      // rmdir() also refuses a final-component symlink. A post-assert swap can
      // therefore fail the launch, but cannot redirect deletion outside state.
      await rmdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const remaining = await directoryEntries(directory, state);
  if (remaining.length > 0) {
    throw new Error("Chromium service-worker state changed while it was being cleared");
  }
}

async function removeServiceWorkerState(
  profile: FileHandle,
  profileName: string,
  hooks: BrowserProfilePurgeHooks,
): Promise<void> {
  const statePath = descriptorPath(profile, "Service Worker");
  let state: FileHandle;
  try {
    state = await openPinnedDirectory(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await hooks.afterStateOpened?.(profileName);
    // Chromium keeps its registration database, scripts, and CacheStorage in
    // this tree. Pinning it before traversal ensures a rename/symlink swap can
    // only make cleanup fail; it cannot redirect cleanup through a new parent.
    await clearPinnedDirectory(state, { entries: 0 });
    await assertPinnedDirectory(statePath, state);
  } finally {
    await state.close();
  }
  await rmdir(statePath);
}

async function removePersistedServiceWorkers(
  userDataDir: string,
  hooks: BrowserProfilePurgeHooks = {},
): Promise<void> {
  const root = await openPinnedDirectory(userDataDir);
  try {
    await hooks.afterRootOpened?.();
    // Check the root for older/alternate layouts before current Chromium's
    // named profile directories. Every later path is anchored to an open fd.
    await removeServiceWorkerState(root, ".", hooks);
    for (const name of await directoryEntries(root, { entries: 0 })) {
      if (!CHROMIUM_PROFILE_DIRECTORY.test(name)) continue;
      const profilePath = descriptorPath(root, name);
      const profile = await openPinnedDirectory(profilePath);
      try {
        await hooks.afterProfileOpened?.(name);
        await removeServiceWorkerState(profile, name, hooks);
        await assertPinnedDirectory(profilePath, profile);
      } finally {
        await profile.close();
      }
    }
    await assertPinnedDirectory(userDataDir, root);
  } finally {
    await root.close();
  }
}

function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env["WAYLAND_DISPLAY"] || env["DISPLAY"]);
}

export class PlaywrightBrowserBackend implements GhostBrowserBackend {
  readonly name = "playwright";
  readonly profileDir: string;

  #context: BrowserContext | undefined;
  #launching: Promise<BrowserContext> | undefined;
  #closing: Promise<boolean> | undefined;
  #generation = 0;
  #headless: boolean;
  #refs = new Set<string>();

  #console: ConsoleEntry[] = [];
  #network: NetworkEntry[] = [];
  #observed = new WeakSet<Page>();
  #pageIds = new WeakMap<Page, string>();
  #nextPageId = 1;
  /** Network-policy failures are sticky until a deliberate new navigation. */
  #policyFailures = new WeakMap<Page, GhostBrowserError>();
  #policyFailure: GhostBrowserError | undefined;
  #pendingPeerChecks = new WeakMap<Page, Set<Promise<void>>>();

  readonly #executablePath: string | undefined;
  readonly #launchTimeoutMs: number;
  readonly #checkUrl: BrowserBackendContext["checkUrl"];
  readonly #checkAddress: BrowserBackendContext["checkAddress"];
  readonly #profilePurgeHooks: BrowserProfilePurgeHooks;

  constructor(
    profileDir: string,
    options: PlaywrightBackendOptions = {},
    policy?: Pick<BrowserBackendContext, "checkUrl" | "checkAddress"> & {
      readonly profilePurgeHooks?: BrowserProfilePurgeHooks;
    },
  ) {
    this.profileDir = resolve(profileDir);
    this.#headless = options.headless ?? !hasDisplay();
    this.#executablePath = options.executablePath;
    this.#launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    this.#checkUrl = policy?.checkUrl ?? (async (rawUrl, action = {
      timeoutMs: this.#launchTimeoutMs,
    }) => {
      const checked = await checkNetworkUrl(rawUrl, {
        timeoutMs: action.timeoutMs,
        ...(action.signal === undefined ? {} : { signal: action.signal }),
      });
      if (!checked.ok) {
        throw new GhostBrowserError("blocked_url", checked.rejection.reason, { url: rawUrl });
      }
      return checked.url;
    });
    this.#checkAddress = policy?.checkAddress ?? ((address, url) => {
      if (!isPublicInternetAddress(address)) {
        throw new GhostBrowserError(
          "blocked_url",
          `Blocked ${url}: its connected peer ${address} is not a public Internet address.`,
          { url, address },
        );
      }
    });
    this.#profilePurgeHooks = policy?.profilePurgeHooks ?? {};
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


  async #contextOrLaunch(): Promise<BrowserContext> {
    if (this.#closing) await this.#closing;
    if (this.#context) return this.#context;
    if (!this.#launching) {
      const generation = this.#generation;
      const launching = this.#launch(generation).finally(() => {
        if (this.#launching === launching) this.#launching = undefined;
      });
      this.#launching = launching;
    }
    return this.#launching;
  }

  async #launch(generation: number): Promise<BrowserContext> {
    const executablePath = this.#executablePath ?? (await findChromiumExecutable());
    if (!executablePath) {
      throw new GhostBrowserError("browser_unavailable", NO_BROWSER_MESSAGE);
    }
    try {
      await mkdir(this.profileDir, { recursive: true });
      await removePersistedServiceWorkers(this.profileDir, this.#profilePurgeHooks);
    } catch (error) {
      throw new GhostBrowserError(
        "browser_unavailable",
        `The browser profile's persisted service workers could not be safely cleared: `
          + errorMessage(error),
        { profileDir: this.profileDir },
      );
    }

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
      // Playwright must own the launch timeout: its timeout cancellation also
      // reaps the Chromium process it spawned. A Promise.race here would only
      // abandon the context promise and leave the profile lock behind.
      context = await chromium.launchPersistentContext(this.profileDir, {
        executablePath,
        headless: this.#headless,
        // Playwright routing cannot see requests a service worker handles. A
        // dedicated ghost profile does not need them, so block registration
        // rather than leaving a route-policy bypass inside the page.
        serviceWorkers: "block",
        // Playwright otherwise adds --no-sandbox for system Chromium.
        chromiumSandbox: true,
        args: LAUNCH_ARGS,
        viewport: { width: 1280, height: 900 },
        timeout: this.#launchTimeoutMs,
      });
    } catch (error) {
      if (error instanceof GhostError) throw error;
      if (/timeout .* exceeded|TimeoutError/i.test(errorMessage(error))) {
        throw timeoutError("starting the browser", this.#launchTimeoutMs);
      }
      throw new GhostBrowserError(
        "browser_unavailable",
        `The browser failed to start: ${errorMessage(error)}`,
        { executablePath },
      );
    }

    // Shutdown can race a launch. Never publish a context from an obsolete
    // generation; close it while we still own the only handle.
    if (generation !== this.#generation) {
      try {
        await context.close();
      } catch {
        // A context that died during startup is closed enough.
      }
      throw new GhostBrowserError(
        "browser_unavailable",
        "The browser was closed while it was starting.",
      );
    }

    context.setDefaultTimeout?.(this.#launchTimeoutMs);
    context.setDefaultNavigationTimeout?.(this.#launchTimeoutMs);
    // Validate every HTTP(S) request before Chromium resolves/connects. This
    // covers redirects and subresources, not only the model's top-level URL.
    try {
      await context.route("**/*", async (route: Route, request: Request) => {
        const url = request.url();
        if (!/^https?:/i.test(url)) {
          await route.continue();
          return;
        }
        try {
          await this.#checkUrl(url, { timeoutMs: this.#launchTimeoutMs });
          await route.continue();
        } catch (error) {
          const page = this.#pageForRequest(request);
          if (page) this.#recordPolicyFailure(page, error, url);
          await route.abort("blockedbyclient").catch(() => undefined);
        }
      });
    } catch (error) {
      await context.close().catch(() => undefined);
      throw new GhostBrowserError(
        "browser_unavailable",
        `The browser could not install its network safety policy: ${errorMessage(error)}`,
      );
    }
    // Routing setup is asynchronous. Shutdown may have claimed this generation
    // after the earlier launch check, so guard publication a second time.
    if (generation !== this.#generation) {
      await context.close().catch(() => undefined);
      throw new GhostBrowserError(
        "browser_unavailable",
        "The browser was closed while it was starting.",
      );
    }
    // The window closing (owner clicked the X) must not leave a stale handle.
    context.on?.("close", () => {
      if (this.#context === context) {
        this.#context = undefined;
        this.#refs.clear();
        this.#policyFailure = undefined;
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
        level: boundBrowserObservationString(msg.type()).value,
        text: boundBrowserObservationString(msg.text()).value,
        ...(loc.url ? { url: boundBrowserObservationString(loc.url).value } : {}),
        ...(typeof loc.lineNumber === "number" && Number.isFinite(loc.lineNumber)
          ? { line: loc.lineNumber }
          : {}),
      });
    });
    page.on?.("pageerror", (error: Error) => {
      pushConsole({ level: "error", text: boundBrowserObservationString(error.message).value });
    });
    page.on?.("response", (response: Response) => {
      const request = response.request();
      this.#network.push({
        method: boundBrowserObservationString(request.method()).value,
        url: boundBrowserObservationString(response.url()).value,
        ...(Number.isFinite(response.status()) ? { status: response.status() } : {}),
        type: boundBrowserObservationString(request.resourceType()).value,
      });
      if (this.#network.length > RING_LIMIT) this.#network.shift();
      const check = this.#verifyResponsePeer(page, response).catch(() => undefined);
      let pending = this.#pendingPeerChecks.get(page);
      if (!pending) {
        pending = new Set();
        this.#pendingPeerChecks.set(page, pending);
      }
      pending.add(check);
      void check.then(() => pending?.delete(check));
    });
  }

  #pageForRequest(request: Request): Page | undefined {
    try {
      return request.frame().page();
    } catch {
      // Service-worker requests have no owning frame. The pre-connect URL/DNS
      // check still applies; there is simply no page on which to surface it.
      return undefined;
    }
  }

  #recordPolicyFailure(page: Page, error: unknown, url: string): GhostBrowserError {
    const failure = error instanceof GhostBrowserError
      ? error
      : new GhostBrowserError(
        "blocked_url",
        `Blocked ${url}: the browser could not verify its network destination.`,
        { url },
      );
    if (!this.#policyFailures.has(page)) this.#policyFailures.set(page, failure);
    this.#policyFailure ??= failure;
    return failure;
  }

  async #verifyResponsePeer(page: Page, response: Response): Promise<void> {
    const url = response.url();
    if (!/^https?:/i.test(url)) return;
    try {
      const peer = await response.serverAddr();
      if (!peer?.ipAddress) {
        throw new GhostBrowserError(
          "blocked_url",
          `Blocked ${url}: Chromium did not expose the connected peer address.`,
          { url },
        );
      }
      this.#checkAddress(peer.ipAddress, url);
    } catch (error) {
      const failure = this.#recordPolicyFailure(page, error, url);
      // A response exists already, so closing is the only honest way to stop a
      // non-public or unverifiable connection from continuing in this page.
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
      throw failure;
    }
  }

  async #assertPagePolicy(page: Page): Promise<void> {
    const pending = [...(this.#pendingPeerChecks.get(page) ?? [])];
    if (pending.length > 0) await Promise.allSettled(pending);
    const failure = this.#policyFailures.get(page);
    if (failure) throw failure;
  }

  #throwPagePolicyFailure(page: Page): void {
    const failure = this.#policyFailures.get(page);
    if (failure) throw failure;
  }

  #tabId(page: Page): string {
    const existing = this.#pageIds.get(page);
    if (existing) return existing;
    const id = `t${this.#nextPageId}`;
    this.#nextPageId += 1;
    this.#pageIds.set(page, id);
    return id;
  }

  async close(_options?: BackendActionOptions): Promise<boolean> {
    if (this.#closing) return this.#closing;
    const context = this.#context;
    const launching = this.#launching;
    const wasOpen = context !== undefined || launching !== undefined;
    this.#generation += 1;
    this.#context = undefined;
    this.#refs.clear();
    this.#policyFailure = undefined;
    this.#console = [];
    this.#network = [];
    if (!wasOpen) return false;

    const closing = (async () => {
      let owned = context;
      if (!owned && launching) {
        try {
          owned = await launching;
        } catch {
          // Failed and cancelled launches have no live context to close here.
        }
      }
      if (owned) {
        if (this.#context === owned) this.#context = undefined;
        try {
          await owned.close();
        } catch {
          // A browser that already died is closed enough.
        }
      }
      return true;
    })().finally(() => {
      if (this.#closing === closing) this.#closing = undefined;
    });
    this.#closing = closing;
    return closing;
  }


  async #contextWithin(options: BackendActionOptions, action: string): Promise<BrowserContext> {
    try {
      return await withTimeout(
        this.#contextOrLaunch(),
        options.timeoutMs,
        action,
        options.signal,
      );
    } catch (error) {
      // Cancelling a launch must also invalidate/reap the generation rather than
      // leaving it to publish a live context after the caller has gone away.
      if (
        error instanceof GhostError
        && (error.details["reason"] === "aborted"
          || (error instanceof GhostBrowserError && error.failure === "timeout"))
      ) {
        void this.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async #page(options: BackendActionOptions, action: string): Promise<Page> {
    const context = await this.#contextWithin(options, action);
    const pages = context.pages();
    const page = pages[pages.length - 1];
    if (page) return page;
    return withTimeout(context.newPage(), options.timeoutMs, action, options.signal);
  }

  async #openPage(options: BackendActionOptions, action: string): Promise<Page> {
    if (!this.#context) {
      throw new GhostBrowserError("no_page", "The browser is not open yet.");
    }
    if (this.#policyFailure) throw this.#policyFailure;
    const page = await this.#page(options, action);
    const url = page.url();
    if (url === BLANK_URL || url === "") {
      throw new GhostBrowserError("no_page", "No page is loaded.");
    }
    return page;
  }

  async current(options: BackendActionOptions = { timeoutMs: this.#launchTimeoutMs }): Promise<PageSummary | undefined> {
    if (!this.#context) return undefined;
    if (this.#policyFailure) throw this.#policyFailure;
    const pages = this.#context.pages();
    const page = pages[pages.length - 1];
    if (!page) return undefined;
    const url = page.url();
    if (url === BLANK_URL || url === "") return undefined;
    await this.#assertPagePolicy(page);
    return this.#summarize(page, options);
  }

  #selectorFor(target: BackendTarget): string {
    const ref = target.ref?.trim();
    if (ref) return `[${REF_ATTRIBUTE}="${ref}"]`;
    const selector = target.selector?.trim();
    if (selector) return selector;
    throw new GhostBrowserError("invalid_input", "No ref or selector was given.");
  }

  async #summarize(page: Page, options: BackendActionOptions): Promise<PageSummary> {
    let title = "";
    try {
      title = await this.#boundedPageWork(page, page.title(), options, "reading the page title");
    } catch (error) {
      if (error instanceof GhostError) throw error;
      // A page mid-navigation has no title yet; the URL is enough.
    }
    return { url: page.url(), title };
  }

  async #boundedPageWork<T>(
    page: Page,
    work: Promise<T>,
    options: BackendActionOptions,
    action: string,
  ): Promise<T> {
    try {
      return await withTimeout(work, options.timeoutMs, action, options.signal);
    } catch (error) {
      const cancelled = error instanceof GhostError
        ? error.details["reason"] === "aborted"
          || (error instanceof GhostBrowserError && error.failure === "timeout")
        : /timeout|aborted/i.test(errorMessage(error));
      if (cancelled) {
        // evaluate/mouse/keyboard APIs have no transport cancellation. Closing
        // the dedicated tab terminates their execution instead of merely
        // abandoning the promise.
        void page.close({ runBeforeUnload: false }).catch(() => undefined);
      }
      throw error;
    }
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


  async open(url: string, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#page(options, `opening ${url}`);
    this.#refs.clear();
    this.#policyFailures.delete(page);
    this.#policyFailure = undefined;
    try {
      await this.#boundedPageWork(
        page,
        page.goto(url, {
          timeout: options.timeoutMs,
          waitUntil: "domcontentloaded",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        `opening ${url}`,
      );
      await this.#assertPagePolicy(page);
    } catch (error) {
      this.#throwPagePolicyFailure(page);
      rethrowBackendError(error, `opening ${url}`, options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async read(options: BackendActionOptions): Promise<BackendReadResult> {
    const page = await this.#openPage(options, "reading the page");
    try {
      const result = await this.#boundedPageWork(
        page,
        page.evaluate<BackendReadResult>(callScript(READ_PAGE_SCRIPT)),
        options,
        "reading the page",
      );
      await this.#assertPagePolicy(page);
      return result;
    } catch (error) {
      rethrowBackendError(error, "reading the page", options.timeoutMs);
    }
  }

  async find(
    query: string,
    options: BackendActionOptions & { limit: number },
  ): Promise<readonly PageElementMatch[]> {
    const page = await this.#openPage(options, "searching the page");
    let matches: readonly PageElementMatch[];
    try {
      matches = await this.#boundedPageWork(
        page,
        page.evaluate<readonly PageElementMatch[]>(
          callScript(FIND_ELEMENTS_SCRIPT, {
            query,
            limit: options.limit,
            attribute: REF_ATTRIBUTE,
          }),
        ),
        options,
        "searching the page",
      );
      await this.#assertPagePolicy(page);
    } catch (error) {
      rethrowBackendError(error, "searching the page", options.timeoutMs);
    }
    this.#refs = new Set(matches.map((match) => match.ref));
    return matches;
  }

  async click(target: BackendTarget, options: BackendActionOptions): Promise<PageSummary> {
    const selector = this.#selectorFor(target);
    const page = await this.#openPage(options, `clicking ${selector}`);
    try {
      await this.#boundedPageWork(
        page,
        page.click(selector, {
          timeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        `clicking ${selector}`,
      );
      await this.#assertPagePolicy(page);
    } catch (error) {
      this.#throwPagePolicyFailure(page);
      this.#actionError(error, selector, `clicking ${selector}`, options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async type(input: BackendTypeInput, options: BackendActionOptions): Promise<PageSummary> {
    const selector = this.#selectorFor(input);
    const page = await this.#openPage(options, `typing into ${selector}`);
    try {
      await this.#boundedPageWork(
        page,
        page.fill(selector, input.text, {
          timeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        `typing into ${selector}`,
      );
      if (input.submit) {
        await this.#boundedPageWork(
          page,
          page.press(selector, "Enter", {
            timeout: options.timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          options,
          `submitting ${selector}`,
        );
        await this.#boundedPageWork(
          page,
          page.waitForLoadState("domcontentloaded", {
            timeout: options.timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          options,
          `waiting for ${selector} to submit`,
        );
      }
      await this.#assertPagePolicy(page);
    } catch (error) {
      this.#throwPagePolicyFailure(page);
      this.#actionError(error, selector, `typing into ${selector}`, options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async screenshot(options: BackendScreenshotOptions): Promise<BackendScreenshotResult> {
    const page = await this.#openPage(options, "taking a screenshot");
    try {
      // Playwright allocates the encoded image before returning it; this is the
      // earliest boundary at which the caller can enforce a byte ceiling.
      const bytes = await this.#boundedPageWork(
        page,
        page.screenshot({
          type: "png",
          timeout: options.timeoutMs,
          fullPage: options.fullPage,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        "taking a screenshot",
      );
      await this.#assertPagePolicy(page);
      assertScreenshotBytesWithinLimit(bytes.byteLength, "Browser screenshot");
      return { ...(await this.#summarize(page, options)), bytes };
    } catch (error) {
      rethrowBackendError(error, "taking a screenshot", options.timeoutMs);
    }
  }

  async back(options: BackendActionOptions): Promise<BackendBackResult> {
    const page = await this.#openPage(options, "going back");
    let moved = false;
    try {
      const response = await this.#boundedPageWork(
        page,
        page.goBack({
          timeout: options.timeoutMs,
          waitUntil: "domcontentloaded",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        "going back",
      );
      moved = response !== null;
      await this.#assertPagePolicy(page);
    } catch (error) {
      this.#throwPagePolicyFailure(page);
      rethrowBackendError(error, "going back", options.timeoutMs);
    }
    this.#refs.clear();
    return { ...(await this.#summarize(page, options)), moved };
  }

  async forward(options: BackendActionOptions): Promise<BackendBackResult> {
    const page = await this.#openPage(options, "going forward");
    let moved = false;
    try {
      const response = await this.#boundedPageWork(
        page,
        page.goForward({
          timeout: options.timeoutMs,
          waitUntil: "domcontentloaded",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        "going forward",
      );
      moved = response !== null;
      await this.#assertPagePolicy(page);
    } catch (error) {
      this.#throwPagePolicyFailure(page);
      rethrowBackendError(error, "going forward", options.timeoutMs);
    }
    this.#refs.clear();
    return { ...(await this.#summarize(page, options)), moved };
  }

  async scroll(input: BackendScrollInput, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#openPage(options, "scrolling");
    try {
      await this.#boundedPageWork(
        page,
        (async () => {
          if (input.x !== undefined && input.y !== undefined) {
            await page.mouse.move(input.x, input.y);
          }
          await page.mouse.wheel(input.deltaX, input.deltaY);
        })(),
        options,
        "scrolling",
      );
      await this.#assertPagePolicy(page);
    } catch (error) {
      rethrowBackendError(error, "scrolling", options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async drag(input: BackendDragInput, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#openPage(options, "dragging");
    try {
      await this.#boundedPageWork(
        page,
        (async () => {
          await page.mouse.move(input.fromX, input.fromY);
          await page.mouse.down();
          await page.mouse.move(input.toX, input.toY, { steps: Math.max(1, input.steps ?? 8) });
          await page.mouse.up();
        })(),
        options,
        "dragging",
      );
      await this.#assertPagePolicy(page);
    } catch (error) {
      rethrowBackendError(error, "dragging", options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async key(input: BackendKeyInput, options: BackendActionOptions): Promise<PageSummary> {
    const page = await this.#openPage(options, "pressing a key");
    // Playwright presses a chord from a "+"-joined string: Control+Shift+KeyA.
    const combo = [...(input.modifiers ?? []), input.key].join("+");
    try {
      await this.#boundedPageWork(page, page.keyboard.press(combo), options, "pressing a key");
      await this.#assertPagePolicy(page);
    } catch (error) {
      rethrowBackendError(error, "pressing a key", options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async javascript(
    code: string,
    options: BackendActionOptions,
  ): Promise<BackendJavascriptResult> {
    const page = await this.#openPage(options, "running javascript");
    try {
      // The string form evaluates an expression in the page's main world, exactly
      // like the relay's `Runtime.evaluate`. The value is untrusted data.
      const value = await this.#boundedPageWork(
        page,
        page.evaluate<unknown>(code),
        options,
        "running javascript",
      );
      await this.#assertPagePolicy(page);
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
    const page = await this.#openPage(options, `uploading to ${selector}`);
    try {
      await this.#boundedPageWork(
        page,
        page.setInputFiles(selector, [...input.paths], {
          timeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        options,
        `uploading to ${selector}`,
      );
      await this.#assertPagePolicy(page);
    } catch (error) {
      this.#actionError(error, selector, `uploading to ${selector}`, options.timeoutMs);
    }
    return this.#summarize(page, options);
  }

  async resize(
    input: BackendResizeInput,
    options: BackendActionOptions,
  ): Promise<BackendResizeResult> {
    const page = await this.#openPage(options, "resizing the browser");
    try {
      await this.#boundedPageWork(
        page,
        page.setViewportSize({ width: input.width, height: input.height }),
        options,
        "resizing the browser",
      );
      await this.#assertPagePolicy(page);
      return { ...(await this.#summarize(page, options)), applied: true };
    } catch (error) {
      if (error instanceof GhostError) throw error;
      // A real headed window may refuse a viewport change; report it rather than
      // pretend, mirroring setHeadless's honest {applied:false}.
      return { ...(await this.#summarize(page, options)), applied: false };
    }
  }

  async tabs(input: BackendTabsInput, options: BackendActionOptions): Promise<BackendTabsResult> {
    const context = await this.#contextWithin(options, "working with browser tabs");
    const active = context.pages()[context.pages().length - 1];
    const summarizeList = async (activePage: Page | undefined): Promise<BackendTabInfo[]> => {
      const infos: BackendTabInfo[] = [];
      for (const page of context.pages()) {
        await this.#assertPagePolicy(page);
        const summary = await this.#summarize(page, options);
        infos.push({ id: this.#tabId(page), url: summary.url, title: summary.title, active: page === activePage });
      }
      return infos;
    };

    if (input.op === "list") {
      const tabs = await summarizeList(active);
      return { tabs, active: active ? this.#tabId(active) : null };
    }
    if (input.op === "create") {
      const page = await withTimeout(
        context.newPage(),
        options.timeoutMs,
        "opening a browser tab",
        options.signal,
      );
      this.#refs.clear();
      this.#policyFailure = undefined;
      if (input.url && input.url !== BLANK_URL) {
        this.#policyFailures.delete(page);
        await this.#boundedPageWork(
          page,
          page.goto(input.url, {
            timeout: options.timeoutMs,
            waitUntil: "domcontentloaded",
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          options,
          `opening ${input.url}`,
        );
        await this.#assertPagePolicy(page);
      }
      const tabs = await summarizeList(page);
      return {
        tabs,
        active: this.#tabId(page),
        id: this.#tabId(page),
        page: await this.#summarize(page, options),
      };
    }
    // close / switch both name a tab by id.
    const target = context.pages().find((page) => this.#tabId(page) === input.id);
    if (!target) {
      throw new GhostBrowserError("invalid_input", `There is no tab ${input.id ?? "(none given)"}.`);
    }
    if (input.op === "switch") {
      await this.#boundedPageWork(
        target,
        target.bringToFront(),
        options,
        `switching to tab ${input.id}`,
      );
      this.#refs.clear();
      const tabs = await summarizeList(target);
      return { tabs, active: this.#tabId(target), page: await this.#summarize(target, options) };
    }
    // close
    await this.#boundedPageWork(
      target,
      target.close({ runBeforeUnload: false }),
      options,
      `closing tab ${input.id}`,
    );
    this.#refs.clear();
    const remaining = context.pages();
    const nowActive = remaining[remaining.length - 1];
    const tabs = await summarizeList(nowActive);
    return {
      tabs,
      active: nowActive ? this.#tabId(nowActive) : null,
      ...(nowActive ? { page: await this.#summarize(nowActive, options) } : {}),
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
      new PlaywrightBrowserBackend(
        join(resolve(ctx.homeDir), BROWSER_PROFILE_DIRNAME),
        options,
        ctx,
      ),
    "playwright",
    [
      "playwright",
      options.headless ?? "auto",
      options.executablePath ?? "auto",
      launchTimeoutMs,
    ],
  );
}
