/**
 * The local host's browser sessions: one per resolved ghost home, screenshots
 * as retained files under the owner's screenshot directory, and DNS from this
 * machine. The session itself is shared with hosted Ghost in
 * `@ghost/runtime/browser-session`.
 */
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_ACTING_BUDGET,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  GhostBrowserSession as SharedGhostBrowserSession,
  type BrowserScreenshotStore,
  type BrowserSessionOptions as SharedBrowserSessionOptions,
} from "@ghost/runtime/browser-session";
import { GhostError } from "@ghost/runtime/errors";
import type { BrowserBackendFactory } from "@ghost/runtime/browser-backend";
import {
  DEFAULT_DNS_TIMEOUT_MS,
  defaultBrowserDnsResolver,
  type BrowserDnsResolver,
  type BrowserPolicyClock,
  systemBrowserPolicyClock,
} from "./browser-policy.js";
import {
  DEFAULT_SCREENSHOT_RETENTION,
  ghostScreenshotMatcher,
  ghostScreenshotName,
  pruneScreenshotFiles,
  resolveScreenshotDirectory,
  withScreenshotDirectory,
  writeScreenshotFile,
} from "./screenshot-retention.js";

export * from "@ghost/runtime/browser-session";

export interface BrowserSessionOptions extends Omit<SharedBrowserSessionOptions, "screenshots"> {
  readonly homeDir: string;
}

function fileScreenshotStore(homeDir: string, screenshotDir: string): BrowserScreenshotStore {
  const ghostName = basename(homeDir);
  return {
    save: (bytes) => withScreenshotDirectory(screenshotDir, async (directory, logicalDir) => {
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
    }),
  };
}

export class GhostBrowserSession extends SharedGhostBrowserSession {
  readonly homeDir: string;
  readonly screenshotDir: string;

  constructor(options: BrowserSessionOptions) {
    const homeDir = resolve(options.homeDir);
    const screenshotDir = resolveScreenshotDirectory();
    const { homeDir: _homeDir, ...shared } = options;
    super({
      ...shared,
      resolver: options.resolver ?? defaultBrowserDnsResolver,
      screenshots: fileScreenshotStore(homeDir, screenshotDir),
    });
    this.homeDir = homeDir;
    this.screenshotDir = screenshotDir;
  }
}

interface EffectiveSessionOptions {
  readonly backend: BrowserBackendFactory;
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
  closing?: Promise<void>;
}

const sessions = new Map<string, BrowserSessionEntry>();
let closingAll: Promise<void> | undefined;

function effectiveSessionOptions(
  options: Omit<BrowserSessionOptions, "homeDir">,
): EffectiveSessionOptions {
  return {
    backend: options.backend,
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

function changedSessionOptions(
  existing: EffectiveSessionOptions,
  requested: EffectiveSessionOptions,
): string[] {
  // The backend is deliberately not compared: there is one, and which factory
  // object produced it is not a setting the owner chose.
  const changed: string[] = [];
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

/**
 * The one session for this ghost home, created on first ask, because a ghost
 * should have one browser rather than one per conversation. Later requests must
 * describe the same effective configuration; immutable changes are a typed
 * conflict instead of being silently discarded.
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
  const requested = effectiveSessionOptions(options);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.closing) {
      throw new GhostError(
        "conflict",
        `The browser session for ${key} is still closing; wait before using it again.`,
        { conflict: "browser_session_closing", homeDir: key },
      );
    }
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
