/**
 * Daemon configuration: an XDG config file with environment overrides.
 *
 * Precedence (lowest → highest):
 *   built-in defaults  <  ~/.config/ghost/config.json  <  environment  <  CLI flags
 *
 * The config file is optional; a missing file is not an error. A malformed
 * file IS an error — silently falling back to defaults would move a user's
 * ghosts without telling them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Resolved, absolute daemon configuration. */
export interface DaemonConfig {
  /** TCP port for the local HTTP API. 0 = ephemeral (tests). */
  port: number;
  /** Loopback address to bind. Never widened beyond loopback (see assertLoopback). */
  host: string;
  /** Absolute path to the directory holding one sub-directory per ghost. */
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
  /** Where the config was read from, or null when defaults/env only. */
  configPath: string | null;
}

/** The subset a user may write into config.json. */
export interface DaemonConfigFile {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  offline?: boolean;
}

/** Explicit overrides from CLI flags — highest precedence. */
export interface DaemonConfigOverrides {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  offline?: boolean;
  /** Config file path; defaults to <XDG_CONFIG_HOME>/ghost/config.json. */
  configPath?: string;
  /** Injected for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. Defaults to os.homedir(). */
  home?: string;
}

export const DEFAULT_PORT = 7717;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_GHOSTS_DIRNAME = "Ghosts";

/** Loopback-only, per CONTRACTS.md. v1 has no auth, so exposure is the risk. */
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
  return config;
}

function parseBoolean(raw: string, source: string): boolean {
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid boolean from ${source}: ${JSON.stringify(raw)}`);
}

/** Expand a leading `~` so config.json can say `~/Ghosts`. */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Resolve the effective configuration.
 *
 * Environment overrides:
 * - `GHOSTD_PORT`       → port
 * - `GHOSTD_HOST`       → host (must stay loopback)
 * - `GHOSTS_ROOT`       → ghostsRoot
 * - `GHOSTD_OFFLINE`    → offline
 * - `GHOSTD_CONFIG`     → config file path
 * - `XDG_CONFIG_HOME`   → config file directory
 */
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

  assertLoopback(host);
  return {
    port,
    host,
    ghostsRoot: resolve(expandHome(rawRoot, home)),
    offline,
    configPath: file ? configPath : null,
  };
}
