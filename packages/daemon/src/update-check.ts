/**
 * Whether a newer Ghost release exists. One small request to GitHub's
 * latest-release endpoint, first shortly after boot and then daily, cached in
 * memory: `GET /api/status` reports the last answer and never waits on the
 * network. Applying the update stays the owner's: `omarchy-update` for the
 * package, a pull, build, and restart for a checkout. Ghost only says so, in
 * `ghost status`, the HUD, and the ghost's own policy text.
 */
import type { Logger } from "./log.js";

export const GHOST_LATEST_RELEASE_URL = "https://api.github.com/repos/ferdousbhai/ghost/releases/latest";
export const UPDATE_CHECK_INITIAL_DELAY_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/u;

export interface UpdateAvailable {
  /** The newer release's version, without the `v`. */
  readonly latest: string;
  /** The shell command that installs it on this machine. */
  readonly command: string;
  readonly url: string;
}

export type UpdateFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** `"v1.2.3"` or `"1.2.3"` as `"1.2.3"`; anything else is null. */
export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const match = RELEASE_TAG.exec(tag.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

/** Numeric triple comparison; a version that does not parse sorts lowest. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] =>
    parseReleaseTag(version)?.split(".").map(Number) ?? [-1, -1, -1];
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
  }
  return 0;
}

/**
 * How this install updates. A checkout pulls, builds, and restarts; the
 * packaged install is Omarchy's to update.
 */
export function updateCommand(sourceRoot: string | null): string {
  if (sourceRoot === null) return "omarchy-update";
  const root = JSON.stringify(sourceRoot);
  return `git -C ${root} pull --ff-only && pnpm --dir ${root} install --frozen-lockfile && pnpm --dir ${root} build && systemctl --user restart ghostd.service ghost-shell.service`;
}

/** The latest release's version, or null for any failure: offline, rate-limited, or an unexpected body. */
export async function fetchLatestReleaseVersion(
  fetch: UpdateFetch,
  url: string = GHOST_LATEST_RELEASE_URL,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ghostd" },
      signal: timeout,
    });
    if (!response.ok) return null;
    const body = await response.json();
    return parseReleaseTag((body as { tag_name?: unknown } | null)?.tag_name);
  } catch {
    return null;
  }
}

export interface UpdateCheckerOptions {
  readonly version: string;
  readonly sourceRoot: string | null;
  readonly fetch?: UpdateFetch;
  readonly url?: string;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly logger?: Logger;
}

/** Checks on a timer and remembers the answer; `current` is what `/api/status` reports. */
export class UpdateChecker {
  #current: UpdateAvailable | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #options: UpdateCheckerOptions;

  constructor(options: UpdateCheckerOptions) {
    this.#options = options;
  }

  get current(): UpdateAvailable | null {
    return this.#current;
  }

  async checkNow(): Promise<UpdateAvailable | null> {
    const fetch = this.#options.fetch ?? (globalThis.fetch as unknown as UpdateFetch);
    const latest = await fetchLatestReleaseVersion(fetch, this.#options.url);
    if (latest !== null && compareVersions(latest, this.#options.version) > 0) {
      const url = `https://github.com/ferdousbhai/ghost/releases/tag/v${latest}`;
      if (this.#current?.latest !== latest) {
        this.#options.logger?.info("a newer ghost release is available", { running: this.#options.version, latest });
      }
      this.#current = { latest, command: updateCommand(this.#options.sourceRoot), url };
    } else {
      this.#current = null;
    }
    return this.#current;
  }

  /** First check after a short delay, then daily; the timers never hold the process open. */
  start(): void {
    this.stop();
    const schedule = (delayMs: number): void => {
      this.#timer = setTimeout(() => {
        void this.checkNow().finally(() => {
          if (this.#timer !== undefined) schedule(this.#options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
        });
      }, delayMs);
      this.#timer.unref?.();
    };
    schedule(this.#options.initialDelayMs ?? UPDATE_CHECK_INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
