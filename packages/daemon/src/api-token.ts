import {
  createTokenStore,
  tokenMatches,
  TOKEN_PATTERN,
  type TokenCommandOptions,
  type TokenStoreOptions,
} from "./token-store.js";

const API_TOKEN_FILENAME = "api-token";
export const API_TOKEN_PATTERN = TOKEN_PATTERN;

export type ApiTokenStoreOptions = TokenStoreOptions;

const store = createTokenStore({
  filename: API_TOKEN_FILENAME,
  envVar: "GHOSTD_API_TOKEN_FILE",
  command: "api-token",
  purpose: "Local API clients read this file directly; this printout is for"
    + " debugging and scripts.",
});

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

export function readApiToken(options: ApiTokenStoreOptions = {}): string | undefined {
  return store.read(options);
}

export function rotateApiToken(
  options: ApiTokenStoreOptions = {},
): { token: string; path: string } {
  return store.rotate(options);
}

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
