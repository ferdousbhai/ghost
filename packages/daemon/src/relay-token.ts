import {
  createTokenStore,
  tokenMatches,
  TOKEN_PATTERN,
  type TokenCommandOptions,
  type TokenStoreOptions,
} from "./token-store.js";

export const RELAY_TOKEN_FILENAME = "relay-token";
export const RELAY_TOKEN_PATTERN = TOKEN_PATTERN;

export type RelayTokenStoreOptions = TokenStoreOptions;

const store = createTokenStore({
  filename: RELAY_TOKEN_FILENAME,
  envVar: "GHOSTD_RELAY_TOKEN_FILE",
  command: "relay-token",
  purpose: "Paste this into the Ghost relay extension's popup to pair it.",
});

export function defaultRelayTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  return home === undefined ? store.defaultPath(env) : store.defaultPath(env, home);
}

/**
 * The token, minting one on first call. Synchronous on purpose: it is read
 * while building the server, and a race between two callers each writing a
 * different token would silently unpair the extension.
 */
export function readOrCreateRelayToken(
  options: RelayTokenStoreOptions = {},
): { token: string; path: string; created: boolean } {
  return store.readOrCreate(options);
}

export function readRelayToken(options: RelayTokenStoreOptions = {}): string | undefined {
  return store.read(options);
}

export function rotateRelayToken(
  options: RelayTokenStoreOptions = {},
): { token: string; path: string } {
  return store.rotate(options);
}

/**
 * Constant-time comparison. The relay answers a failed pairing immediately, so
 * a naive `===` would leak the token a byte at a time to anything that can time
 * a loopback socket — which, on a machine running a browser, is everything.
 */
export function relayTokenMatches(expected: string, presented: string): boolean {
  return tokenMatches(expected, presented);
}

/**
 * `ghostd relay-token [--rotate] [--quiet]` — print the pairing token so the
 * owner can paste it into the extension popup.
 */
export function relayTokenCommand(
  argv: readonly string[] = [],
  options: TokenCommandOptions = {},
): number {
  return store.command(argv, options);
}
