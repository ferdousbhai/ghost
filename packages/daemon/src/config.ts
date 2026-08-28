/**
 * A missing config file is not an error; a malformed one is. Falling back to
 * defaults would silently move the owner's ghosts instead of telling them.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from "./compaction.js";
import { writePrivateJsonAtomic } from "./private-file.js";
import type { RemoteAccessOptions } from "./tailscale-identity.js";

export type RemoteConfig = Pick<RemoteAccessOptions, "owner" | "guests"> & {
  enabled: boolean;
};

export type RemoteConfigFile = Pick<RemoteAccessOptions, "owner" | "guests"> & {
  enabled?: boolean;
};

export interface DaemonConfig {
  port: number;
  host: string;
  ghostsRoot: string;
  /**
   * Forbid every network call pi makes on its own behalf (update checks,
   * provider catalog refresh, telemetry) by setting `PI_OFFLINE`.
   *
   * Default OFF, deliberately. Offline is the stronger sovereignty posture,
   * but it also disables provider catalog refresh, so a ghost can then only
   * use models declared statically in its own `models.json`. Turning it on
   * would silently break the zero-cost onboarding path (an OpenRouter
   * account on a free model) for anyone who had not written their catalog
   * out by hand. Credential isolation does NOT depend on this flag — that is
   * env-scrub.ts, which is unconditional.
   */
  offline: boolean;
  browserMode: "relay" | "profile";
  compaction: CompactionConfig;
  askTimeoutSeconds: number;
  /**
   * Who may reach the daemon through `tailscale serve`: `owner` is the login
   * that owns every ghost (default: the login this node belongs to), `guests`
   * says what other tailnet members may do (default read-only).
   */
  remote: RemoteConfig;
  configPath: string | null;
  hooksPath: string;
}

export interface DaemonConfigFile {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  offline?: boolean;
  browserMode?: "relay" | "profile";
  compaction?: {
    enabled?: boolean;
    thresholdTokens?: number;
    thresholdFraction?: number;
  };
  askTimeoutSeconds?: number;
  remote?: RemoteConfigFile;
}

export interface DaemonConfigOverrides {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  offline?: boolean;
  browserMode?: "relay" | "profile";
  compaction?: CompactionConfig;
  askTimeoutSeconds?: number;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const DEFAULT_PORT = 7717;
/**
 * Long enough that reaching it means the user genuinely walked away, short
 * enough that a forgotten question does not hold a conversation open for hours
 * — which is the state that used to leave a ghost holding a question nobody
 * could ever answer.
 */
export const DEFAULT_ASK_TIMEOUT_SECONDS = 120;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_GHOSTS_DIRNAME = "ghosts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `ghostd binds loopback only (got "${host}"). The v1 API has no auth; `
        + `exposing it off-host would publish every ghost's memory.`,
    );
  }
}

export function defaultConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "ghost", "config.json");
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port from ${source}: ${JSON.stringify(raw)}`);
  }
  return port;
}

function readConfigFile(path: string): DaemonConfigFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const file = parsed as Record<string, unknown>;
  const config: DaemonConfigFile = {};
  if (file.port !== undefined) {
    if (typeof file.port !== "number") throw new Error(`${path}: "port" must be a number.`);
    config.port = parsePort(String(file.port), path);
  }
  if (file.host !== undefined) {
    if (typeof file.host !== "string") throw new Error(`${path}: "host" must be a string.`);
    config.host = file.host;
  }
  if (file.ghostsRoot !== undefined) {
    if (typeof file.ghostsRoot !== "string") {
      throw new Error(`${path}: "ghostsRoot" must be a string.`);
    }
    config.ghostsRoot = file.ghostsRoot;
  }
  if (file.offline !== undefined) {
    if (typeof file.offline !== "boolean") {
      throw new Error(`${path}: "offline" must be a boolean.`);
    }
    config.offline = file.offline;
  }
  if (file.browserMode !== undefined) {
    if (file.browserMode !== "relay" && file.browserMode !== "profile") {
      throw new Error(`${path}: "browserMode" must be "relay" or "profile".`);
    }
    config.browserMode = file.browserMode;
  }
  if (file.remote !== undefined) {
    if (file.remote === null || typeof file.remote !== "object" || Array.isArray(file.remote)) {
      throw new Error(`${path}: "remote" must be a JSON object.`);
    }
    const raw = file.remote as Record<string, unknown>;
    const remote: RemoteConfigFile = {};
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean") {
        throw new Error(`${path}: "remote.enabled" must be a boolean.`);
      }
      remote.enabled = raw.enabled;
    }
    if (raw.owner !== undefined) {
      if (typeof raw.owner !== "string" || !raw.owner.trim()) throw new Error(`${path}: "remote.owner" must be a login.`);
      remote.owner = raw.owner;
    }
    if (raw.guests !== undefined) {
      if (raw.guests !== "read-only" && raw.guests !== "none") {
        throw new Error(`${path}: "remote.guests" must be "read-only" or "none".`);
      }
      remote.guests = raw.guests;
    }
    config.remote = remote;
  }
  if (file.compaction !== undefined) {
    if (file.compaction === null || typeof file.compaction !== "object" || Array.isArray(file.compaction)) {
      throw new Error(`${path}: "compaction" must be a JSON object.`);
    }
    const raw = file.compaction as Record<string, unknown>;
    const compaction: DaemonConfigFile["compaction"] = {};
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean") {
        throw new Error(`${path}: "compaction.enabled" must be a boolean.`);
      }
      compaction.enabled = raw.enabled;
    }
    if (raw.thresholdTokens !== undefined) {
      if (typeof raw.thresholdTokens !== "number" || !Number.isFinite(raw.thresholdTokens) || raw.thresholdTokens <= 0) {
        throw new Error(`${path}: "compaction.thresholdTokens" must be a positive number.`);
      }
      compaction.thresholdTokens = raw.thresholdTokens;
    }
    if (raw.thresholdFraction !== undefined) {
      if (typeof raw.thresholdFraction !== "number" || !(raw.thresholdFraction > 0 && raw.thresholdFraction <= 1)) {
        throw new Error(`${path}: "compaction.thresholdFraction" must be a number in (0, 1].`);
      }
      compaction.thresholdFraction = raw.thresholdFraction;
    }
    config.compaction = compaction;
  }
  if (file.askTimeoutSeconds !== undefined) {
    if (typeof file.askTimeoutSeconds !== "number" || !Number.isFinite(file.askTimeoutSeconds)
      || file.askTimeoutSeconds < 0) {
      throw new Error(`${path}: "askTimeoutSeconds" must be a non-negative number.`);
    }
    config.askTimeoutSeconds = file.askTimeoutSeconds;
  }
  return config;
}

function parseBrowserMode(raw: string, source: string): "relay" | "profile" {
  if (raw === "relay" || raw === "profile") return raw;
  throw new Error(`Invalid browserMode from ${source}: ${JSON.stringify(raw)} (want "relay" or "profile")`);
}

function parseBoolean(raw: string, source: string): boolean {
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid boolean from ${source}: ${JSON.stringify(raw)}`);
}

function parsePositiveNumber(raw: string, source: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid positive number from ${source}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseNonNegativeNumber(raw: string, source: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid non-negative number from ${source}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseFraction(raw: string, source: string): number {
  const value = Number(raw);
  if (!(value > 0 && value <= 1)) {
    throw new Error(`Invalid fraction from ${source}: ${JSON.stringify(raw)} (want (0, 1])`);
  }
  return value;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function loadConfig(overrides: DaemonConfigOverrides = {}): DaemonConfig {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? homedir();
  const configPath = overrides.configPath
    ?? env.GHOSTD_CONFIG?.trim()
    ?? defaultConfigPath(env, home);
  const file = readConfigFile(configPath);

  const envPort = env.GHOSTD_PORT?.trim();
  const envHost = env.GHOSTD_HOST?.trim();
  const envRoot = env.GHOSTS_ROOT?.trim();
  const envOffline = env.GHOSTD_OFFLINE?.trim();
  const envBrowserMode = env.GHOST_BROWSER_MODE?.trim();
  const envCompaction = env.GHOSTD_COMPACTION?.trim();
  const envCompactionTokens = env.GHOSTD_COMPACTION_THRESHOLD_TOKENS?.trim();
  const envCompactionFraction = env.GHOSTD_COMPACTION_THRESHOLD_FRACTION?.trim();
  const envAskTimeout = env.GHOSTD_ASK_TIMEOUT?.trim();
  const envHooksPath = env.GHOSTD_HOOKS?.trim();

  const port = overrides.port
    ?? (envPort ? parsePort(envPort, "GHOSTD_PORT") : undefined)
    ?? file?.port
    ?? DEFAULT_PORT;
  const host = overrides.host ?? (envHost || undefined) ?? file?.host ?? DEFAULT_HOST;
  const rawRoot = overrides.ghostsRoot
    ?? (envRoot || undefined)
    ?? file?.ghostsRoot
    ?? join(home, DEFAULT_GHOSTS_DIRNAME);

  const offline = overrides.offline
    ?? (envOffline ? parseBoolean(envOffline, "GHOSTD_OFFLINE") : undefined)
    ?? file?.offline
    ?? false;

  const browserMode = overrides.browserMode
    ?? (envBrowserMode ? parseBrowserMode(envBrowserMode, "GHOST_BROWSER_MODE") : undefined)
    ?? file?.browserMode
    ?? "relay";

  const enabled = overrides.compaction?.enabled
    ?? (envCompaction ? parseBoolean(envCompaction, "GHOSTD_COMPACTION") : undefined)
    ?? file?.compaction?.enabled
    ?? DEFAULT_COMPACTION_CONFIG.enabled;
  const thresholdTokens = overrides.compaction?.thresholdTokens
    ?? (envCompactionTokens ? parsePositiveNumber(envCompactionTokens, "GHOSTD_COMPACTION_THRESHOLD_TOKENS") : undefined)
    ?? file?.compaction?.thresholdTokens;
  const thresholdFraction = overrides.compaction?.thresholdFraction
    ?? (envCompactionFraction ? parseFraction(envCompactionFraction, "GHOSTD_COMPACTION_THRESHOLD_FRACTION") : undefined)
    ?? file?.compaction?.thresholdFraction;
  const compaction: CompactionConfig = {
    enabled,
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {}),
    ...(thresholdFraction !== undefined ? { thresholdFraction } : {}),
  };

  const askTimeoutSeconds = overrides.askTimeoutSeconds
    ?? (envAskTimeout ? parseNonNegativeNumber(envAskTimeout, "GHOSTD_ASK_TIMEOUT") : undefined)
    ?? file?.askTimeoutSeconds
    ?? DEFAULT_ASK_TIMEOUT_SECONDS;

  const hooksPath = resolve(expandHome(envHooksPath || join(dirname(configPath), "hooks.json"), home));

  assertLoopback(host);
  return {
    port,
    host,
    ghostsRoot: resolve(expandHome(rawRoot, home)),
    offline,
    browserMode,
    compaction,
    askTimeoutSeconds,
    remote: { ...file?.remote, enabled: file?.remote?.enabled ?? false },
    configPath: file ? configPath : null,
    hooksPath,
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge a config patch without discarding fields this daemon version does not understand. */
export async function writeConfigFile(path: string, patch: Partial<DaemonConfigFile>): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!plainObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
    existing = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = plainObject(value) && plainObject(existing[key])
      ? { ...existing[key], ...value }
      : value;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(path, merged);
}
