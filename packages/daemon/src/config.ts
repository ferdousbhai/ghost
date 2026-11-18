/**
 * A missing config file is not an error; a malformed one is. Falling back to
 * defaults would silently move the owner's ghosts instead of telling them.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RemoteAccessOptions } from "./tailscale-identity.js";
import { errorMessage } from "./errors.js";
import { expandHome, xdgBaseDir } from "./xdg-user-dirs.js";
import { readPrivateFileText } from "./private-file.js";
import { isRecord } from "./record.js";
import { LOOPBACK_ADDRESSES } from "./loopback.js";
import { DEFAULT_LOCAL_CONTEXT, DEFAULT_LOCAL_IDLE_MS, type LocalModelConfig } from "./local-model.js";

type RemoteConfig = Pick<RemoteAccessOptions, "owner" | "guests"> & { apps?: string[] };

/** The web apps admitted to call this daemon with a tailnet identity (CONTRACTS.md "Daemon HTTP API"). */
const DEFAULT_REMOTE_APPS: readonly string[] = ["https://summonghost.com"];

/** An `https://host[:port]` origin exactly as a browser sends it, or null. */
function appOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

type RemoteConfigFile = Partial<RemoteConfig>;

export interface DaemonConfig {
  port: number;
  host: string;
  ghostsRoot: string;
  /**
   * Who may reach the daemon through `tailscale serve`: `owner` is the login
   * that owns every ghost (default: the login this node belongs to), `guests`
   * says what other tailnet members may do (default "none"), `apps` the web
   * app origins admitted with a tailnet identity (default
   * `DEFAULT_REMOTE_APPS`; `[]` admits none).
   */
  remote: RemoteConfig;
  /** The config file read; it need not exist. */
  configPath: string;
  hooksPath: string;
  /** The model ghostd runs itself, or null when none is configured (CONTRACTS.md "Local model"). */
  local: LocalModelConfig | null;
}

interface DaemonConfigFile {
  port?: number;
  host?: string;
  ghostsRoot?: string;
  remote?: RemoteConfigFile;
  local?: LocalModelConfig;
}

/** `local`: `{ model, server?, contextSize?, idleMinutes? }`, paths `~`-expanded. */
function parseLocal(raw: unknown, path: string, home: string): LocalModelConfig {
  if (!isRecord(raw)) throw new Error(`${path}: "local" must be a JSON object.`);
  if (typeof raw.model !== "string" || !raw.model.trim()) throw new Error(`${path}: "local.model" must be the path of a GGUF file.`);
  if (raw.server !== undefined && (typeof raw.server !== "string" || !raw.server.trim())) {
    throw new Error(`${path}: "local.server" must be the llama-server executable.`);
  }
  const positive = (key: string, fallback: number): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${path}: "local.${key}" must be a positive whole number.`);
    return value;
  };
  return {
    model: resolve(expandHome(raw.model, home)),
    server: typeof raw.server === "string" ? expandHome(raw.server, home) : "llama-server",
    contextSize: positive("contextSize", DEFAULT_LOCAL_CONTEXT),
    idleMs: positive("idleMinutes", DEFAULT_LOCAL_IDLE_MS / 60_000) * 60_000,
  };
}

export interface DaemonConfigOverrides {
  port?: number;
  ghostsRoot?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const DEFAULT_PORT = 7717;
export const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_GHOSTS_DIRNAME = "ghosts";

export function assertLoopback(host: string): void {
  if (host !== "localhost" && !LOOPBACK_ADDRESSES.has(host)) {
    throw new Error(
      `ghostd binds loopback only (got "${host}"). `
        + "Use Tailscale Serve (`ghost remote on`) for remote access.",
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

function readConfigFile(path: string, home: string): DaemonConfigFile | null {
  let text: string | null;
  try {
    text = readPrivateFileText(path);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
  }
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const file = parsed;
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
    const raw = file.remote;
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
    if (raw.apps !== undefined) {
      const apps = Array.isArray(raw.apps) ? raw.apps.map(appOrigin) : [null];
      if (apps.some((app) => app === null)) {
        throw new Error(`${path}: "remote.apps" must be a list of origins like "https://summonghost.com".`);
      }
      remote.apps = apps as string[];
    }
    config.remote = remote;
  }
  if (file.local !== undefined) config.local = parseLocal(file.local, path, home);
  return config;
}

export function loadConfig(overrides: DaemonConfigOverrides = {}): DaemonConfig {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? homedir();
  const configPath = overrides.configPath
    ?? (env.GHOSTD_CONFIG?.trim() || undefined)
    ?? defaultConfigPath(env, home);
  const file = readConfigFile(configPath, home);

  const envPort = env.GHOSTD_PORT?.trim();
  const envHost = env.GHOSTD_HOST?.trim();
  const envRoot = env.GHOSTS_ROOT?.trim();
  const envHooksPath = env.GHOSTD_HOOKS?.trim();

  const port = overrides.port
    ?? (envPort ? parsePort(envPort, "GHOSTD_PORT") : undefined)
    ?? file?.port
    ?? DEFAULT_PORT;
  const host = (envHost || undefined) ?? file?.host ?? DEFAULT_HOST;
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
    remote: { apps: [...DEFAULT_REMOTE_APPS], ...file?.remote },
    configPath,
    hooksPath,
    local: file?.local ?? null,
  };
}
