/** freedesktop user directories, resolved the way Omarchy's own scripts do. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const XDG_BASE_DEFAULTS = {
  XDG_CACHE_HOME: ".cache",
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
} as const;

/** An XDG base directory: the variable when it names an absolute path, else its default under `home`. */
export function xdgBaseDir(env: NodeJS.ProcessEnv, variable: keyof typeof XDG_BASE_DEFAULTS, home: string): string {
  const value = env[variable]?.trim();
  return value && isAbsolute(value) ? value : join(home, XDG_BASE_DEFAULTS[variable]);
}

/** `~`, `~/…`, and `$HOME/…` under `home`; any other path unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("$HOME/")) return join(home, path.slice("$HOME/".length));
  return path;
}

/** One `NAME="value"` line out of the freedesktop user-dirs file. */
function readUserDir(name: string, env: NodeJS.ProcessEnv, home: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(join(xdgBaseDir(env, "XDG_CONFIG_HOME", home), "user-dirs.dirs"), "utf8");
  } catch {
    return null;
  }
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(contents);
  return match?.[1]?.trim() || null;
}

/**
 * The owner's documents directory: `XDG_DOCUMENTS_DIR` from the environment
 * first and then `user-dirs.dirs`, falling back to the English default. A
 * systemd user unit inherits none of the XDG desktop variables, so the file
 * matters as much as the environment. A relative value is under `home`.
 */
export function resolveDocumentsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_DOCUMENTS_DIR?.trim() || readUserDir("XDG_DOCUMENTS_DIR", env, home);
  return configured ? resolve(home, expandHome(configured, home)) : join(home, "Documents");
}
