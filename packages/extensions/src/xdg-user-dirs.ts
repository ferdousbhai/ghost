/** freedesktop user directories, resolved the way Omarchy's own scripts do. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("$HOME/")) return join(home, path.slice("$HOME/".length));
  return isAbsolute(path) ? path : join(home, path);
}

/** One `NAME="value"` line out of the freedesktop user-dirs file. */
function readUserDir(name: string, home: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(join(home, ".config", "user-dirs.dirs"), "utf8");
  } catch {
    return null;
  }
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(contents);
  return match?.[1]?.trim() || null;
}

/**
 * One `XDG_<NAME>_DIR`, from the environment first and then `user-dirs.dirs`,
 * falling back to the English default. A systemd user unit inherits none of the
 * XDG desktop variables, so the file matters as much as the environment.
 */
export function resolveUserDirectory(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env[name]?.trim() ?? readUserDir(name, home);
  if (configured) return resolve(expandHome(configured, home));
  return join(home, fallback);
}

/** The owner's documents directory. */
export function resolveDocumentsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return resolveUserDirectory("XDG_DOCUMENTS_DIR", "Documents", env, home);
}
