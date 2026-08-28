/**
 * The pairing token for the browser relay.
 *
 * Every route of the daemon's HTTP API but `GET /api/relay/status` already
 * requires its own bearer token (see api-token.ts). The relay needs a *second*
 * secret rather than sharing that one, because the thing on the other end of it
 * is a *browser*, and a browser runs code written by strangers: the extension
 * is paired by pasting a token into a popup, which puts the secret inside a
 * process the owner does not fully control, and a leak there must not also
 * hand out the API. Any page the owner visits can open
 * `ws://127.0.0.1:7717/relay`; without a secret, the first tab with a malicious
 * script would inherit the ghost's ability to drive every signed-in tab.
 *
 * It lives under XDG state rather than config — it is machine-local,
 * regenerable, and nothing a user should be editing — at
 * `$XDG_STATE_HOME/ghost/relay-token`, mode 0600 in a 0700 directory. Minted on
 * first need, printed by `ghostd relay-token`, pasted once into the extension's
 * popup, and kept in `chrome.storage.local` from then on.
 *
 * The file/compare/rotate/print machinery is shared with the API token; see
 * token-store.ts. This module is the relay's half of the parameters.
 */
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
