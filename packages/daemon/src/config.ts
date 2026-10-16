/**
 * A missing config file is not an error; a malformed one is. Falling back to
 * defaults would silently move the owner's ghosts instead of telling them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RemoteAccessOptions } from "./tailscale-identity.js";
import { errorMessage } from "./errors.js";
import { xdgBaseDir } from "./xdg-user-dirs.js";
import { isRecord } from "./record.js";

export type RemoteConfig = Pick<RemoteAccessOptions, "owner" | "guests">;

export type RemoteConfigFile = Partial<RemoteConfig>;

export interface DaemonConfig {
  port: number;
  host: string;
  ghostsRoot: string;
  /**
   * Who may reach the daemon through `tailscale serve`: `owner` is the login
   * that owns every ghost (default: the login this node belongs to), `guests`
   * says what other tailnet members may do (default read-only).
   */
  remote: RemoteConfig;
  /** The config file read, or the one that would be written; it need not exist. */
  configPath: string;
  hooksPath: string;
}

export interface DaemonConfigFile {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  remote?: RemoteConfigFile;
}

export interface DaemonConfigOverrides {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const DEFAULT_PORT = 7717;
export const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_GHOSTS_DIRNAME = "ghosts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `ghostd binds loopback only (got "${host}"). `
        + `Use the authenticated Tailscale viewer for remote access.`,
    );
  }
}

export function defaultConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(xdgBaseDir(env, "XDG_CONFIG_HOME", home), "ghost", "config.json");
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
    throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
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
  if (file.remote !== undefined) {
    if (!isRecord(file.remote)) {
      throw new Error(`${path}: "remote" must be a JSON object.`);
    }
    const raw = file.remote as Record<string, unknown>;
    const remote: RemoteConfigFile = {};
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
  return config;
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
    ?? (env.GHOSTD_CONFIG?.trim() || undefined)
    ?? defaultConfigPath(env, home);
  const file = readConfigFile(configPath);

  const envPort = env.GHOSTD_PORT?.trim();
  const envHost = env.GHOSTD_HOST?.trim();
  const envRoot = env.GHOSTS_ROOT?.trim();
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

  const hooksPath = resolve(expandHome(envHooksPath || join(dirname(configPath), "hooks.json"), home));

  assertLoopback(host);
  return {
    port,
    host,
    ghostsRoot: resolve(expandHome(rawRoot, home)),
    remote: { ...file?.remote },
    configPath,
    hooksPath,
  };
}
