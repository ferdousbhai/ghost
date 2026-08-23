/**
 * The bearer token for the daemon's HTTP API.
 *
 * Binding to `127.0.0.1` is not authentication. Every browser on the machine
 * can reach loopback, and a page the creator visits can send a form-style
 * `text/plain` POST to `http://127.0.0.1:7717/api/ghosts/<name>/messages`
 * without a preflight — CORS never sees it, because CORS governs *reading* a
 * response, not *sending* a request. That is a cross-site request forgery
 * against the ghost, and it would let any web page drive the browser and
 * desktop tools the ghost owns (issue #485).
 *
 * So the API gets a secret of its own: 64 hex characters at
 * `$XDG_STATE_HOME/ghost/api-token` (override with `GHOSTD_API_TOKEN_FILE`),
 * mode 0600 in a 0700 directory, minted when the server starts. Local clients
 * read the file — that is what the Quickshell surfaces do — and present it as
 * `Authorization: Bearer <token>`. A page in a browser cannot read a file, so
 * it cannot forge the header.
 *
 * `ghostd api-token` prints it for debugging and shell scripts; `--rotate`
 * invalidates the old one. The file/compare/rotate/print machinery is shared
 * with the relay's pairing token; see token-store.ts.
 */
import {
  createTokenStore,
  tokenMatches,
  TOKEN_PATTERN,
  type TokenCommandOptions,
  type TokenStoreOptions,
} from "./token-store.js";

export const API_TOKEN_FILENAME = "api-token";
export const API_TOKEN_PATTERN = TOKEN_PATTERN;

export type ApiTokenStoreOptions = TokenStoreOptions;

const store = createTokenStore({
  filename: API_TOKEN_FILENAME,
  envVar: "GHOSTD_API_TOKEN_FILE",
  command: "api-token",
  purpose: "Local API clients read this file directly; this printout is for"
    + " debugging and scripts.",
});

/** Where the API token lives, without creating it. */
export function defaultApiTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  return home === undefined ? store.defaultPath(env) : store.defaultPath(env, home);
}

/**
 * The token, minting one on first call. Synchronous on purpose: the server
 * reads it while being built, and the shell reads the file as soon as it
 * starts — a token that appeared only on the first authenticated request would
 * be a token no client could ever present.
 */
export function readOrCreateApiToken(
  options: ApiTokenStoreOptions = {},
): { token: string; path: string; created: boolean } {
  return store.readOrCreate(options);
}

/** The stored token, or undefined when there is none (or it is unreadable). */
export function readApiToken(options: ApiTokenStoreOptions = {}): string | undefined {
  return store.read(options);
}

/** Mint a fresh token, invalidating whatever any running client holds. */
export function rotateApiToken(
  options: ApiTokenStoreOptions = {},
): { token: string; path: string } {
  return store.rotate(options);
}

/** Constant-time comparison; see token-store.ts for why it has to be. */
export function apiTokenMatches(expected: string, presented: string): boolean {
  return tokenMatches(expected, presented);
}

/**
 * `ghostd api-token [--rotate] [--quiet]` — print the API bearer token. The
 * shell reads the file itself; this is for curl, scripts, and diagnosing a
 * client that is getting 401s.
 */
export function apiTokenCommand(
  argv: readonly string[] = [],
  options: TokenCommandOptions = {},
): number {
  return store.command(argv, options);
}
