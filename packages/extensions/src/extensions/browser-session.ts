/**
 * The local host's browser sessions: one per resolved ghost home, screenshots
 * as retained files under the owner's screenshot directory.
 */
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  GhostBrowserSession as SharedGhostBrowserSession,
  type BrowserScreenshotStore,
  type BrowserSessionOptions as SharedBrowserSessionOptions,
} from "@ghost/runtime/browser-session";
import { GhostError } from "@ghost/runtime/errors";
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
    super({ ...shared, screenshots: fileScreenshotStore(homeDir, screenshotDir) });
    this.homeDir = homeDir;
    this.screenshotDir = screenshotDir;
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
