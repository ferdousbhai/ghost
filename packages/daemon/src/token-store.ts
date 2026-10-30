/**
 * The HTTP API's bearer token: 32 random bytes as hex in a mode-0600 file
 * under XDG state, minted by the daemon when missing and read by the CLI and
 * HUD. The daemon holds the token it started with, so replacing it is
 * delete-and-restart.
 */
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const TOKEN_FILE = /^([0-9a-f]{64})\n$/;

/**
 * Constant-time comparison. A failed presentation is answered immediately, so
 * a naive `===` would leak the token a byte at a time to anything that can
 * time a loopback socket.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** `$GHOSTD_API_TOKEN_FILE`, else `$XDG_STATE_HOME/ghost/api-token`, else under `~/.local/state`. */
export function apiTokenPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = env.GHOSTD_API_TOKEN_FILE?.trim();
  if (explicit) return explicit;
  // xdgBaseDir's rule, inline: this module imports no sibling, so a test can
  // load it in plain Node processes racing to mint the token.
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "ghost", "api-token");
}

/** The token, or undefined when the file does not exist; anything else wrong with it throws. */
export function readApiToken(path: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`Token file ${path} is not a regular file.`);
    if ((stats.mode & 0o077) !== 0) throw new Error(`Token file ${path} must be readable only by its owner (mode 0600).`);
    const token = TOKEN_FILE.exec(readFileSync(descriptor, "ascii"))?.[1];
    if (!token) throw new Error(`Token file ${path} is malformed; delete it and restart ghostd.`);
    return token;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The token, minted when missing. A complete file is published with `link`,
 * which fails when another process published first; that one's token wins.
 */
export function ensureApiToken(path: string): { token: string; created: boolean } {
  const existing = readApiToken(path);
  if (existing) return { token: existing, created: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const token = randomBytes(32).toString("hex");
  writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, path);
    return { token, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { token: readApiToken(path) as string, created: false };
  } finally {
    unlinkSync(temporary);
  }
}

/** `ghostd api-token [--quiet]`: print the token, minting it on first run. */
export function apiTokenCommand(
  argv: readonly string[],
  options: { path?: string; stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): number {
  const write = options.stdout ?? ((text) => process.stdout.write(text));
  const fail = options.stderr ?? ((text) => process.stderr.write(text));
  const unknown = argv.find((arg) => arg !== "--quiet" && arg !== "-q");
  if (unknown !== undefined) {
    fail(`api-token: unknown option ${unknown}\n`);
    return 2;
  }
  const path = options.path ?? apiTokenPath();
  try {
    const { token } = ensureApiToken(path);
    write(argv.length > 0
      ? `${token}\n`
      : `${token}\n\nLocal API clients read this file directly; this printout is for debugging and scripts.\n`
        + `Stored at ${path} (mode 0600). To replace it, delete the file and restart ghostd.\n`);
    return 0;
  } catch (error) {
    fail(`api-token: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
