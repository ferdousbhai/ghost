/**
 * The pairing token for the browser relay.
 *
 * The daemon's HTTP API is unauthenticated on the reasoning that anything able to
 * reach `127.0.0.1:7717` is already the creator (CONTRACTS.md). The relay cannot
 * borrow that reasoning, because the thing on the other end of it is a *browser*,
 * and a browser runs code written by strangers. Any page the creator visits can
 * open `ws://127.0.0.1:7717/relay`; without a secret, the first tab with a
 * malicious script would inherit the ghost's ability to drive every signed-in tab
 * the creator has. So the relay gets one thing the rest of the API does not: a
 * token.
 *
 * It lives under XDG state rather than config — it is machine-local, regenerable,
 * and nothing a user should be editing — at `$XDG_STATE_HOME/ghost/relay-token`,
 * mode 0600 in a 0700 directory. Minted on first need, printed by
 * `ghostd relay-token`, pasted once into the extension's popup, and kept in
 * `chrome.storage.local` from then on.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 32 bytes, hex. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
export const RELAY_TOKEN_FILENAME = "relay-token";
export const RELAY_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface RelayTokenStoreOptions {
  /** Injected for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. Defaults to `os.homedir()`. */
  home?: string;
  /** Skip the XDG dance entirely and use this file. */
  path?: string;
}

export function defaultRelayTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.GHOSTD_RELAY_TOKEN_FILE?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "ghost", RELAY_TOKEN_FILENAME);
}

function resolveTokenPath(options: RelayTokenStoreOptions): string {
  if (options.path) return options.path;
  return defaultRelayTokenPath(options.env ?? process.env, options.home ?? homedir());
}

/**
 * The token, minting one on first call. Synchronous on purpose: it is read while
 * building the server, and a race between two callers each writing a different
 * token would silently unpair the extension.
 */
export function readOrCreateRelayToken(
  options: RelayTokenStoreOptions = {},
): { token: string; path: string; created: boolean } {
  const path = resolveTokenPath(options);
  const existing = readRelayToken({ ...options, path });
  if (existing) return { token: existing, path, created: false };

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  // `writeFileSync`'s mode is a *creation* mode; an existing file keeps its own.
  chmodSync(path, 0o600);
  return { token, path, created: true };
}

/** The stored token, or undefined when there is none (or it is unreadable). */
export function readRelayToken(options: RelayTokenStoreOptions = {}): string | undefined {
  const path = resolveTokenPath(options);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const token = text.trim();
  return RELAY_TOKEN_PATTERN.test(token) ? token : undefined;
}

/** Mint a fresh token, invalidating whatever the extension had stored. */
export function rotateRelayToken(
  options: RelayTokenStoreOptions = {},
): { token: string; path: string } {
  const path = resolveTokenPath(options);
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path };
}

/**
 * Constant-time comparison. The relay answers a failed pairing immediately, so a
 * naive `===` would leak the token a byte at a time to anything that can time a
 * loopback socket — which, on a machine running a browser, is everything.
 */
export function relayTokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * `ghostd relay-token [--rotate] [--quiet]` — print the pairing token so the
 * creator can paste it into the extension popup.
 */
export function relayTokenCommand(
  argv: readonly string[] = [],
  options: RelayTokenStoreOptions & {
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): number {
  const write = options.stdout ?? ((text) => process.stdout.write(text));
  const fail = options.stderr ?? ((text) => process.stderr.write(text));
  let rotate = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === "--rotate") rotate = true;
    else if (arg === "--quiet" || arg === "-q") quiet = true;
    else {
      fail(`relay-token: unknown option ${arg}\n`);
      return 2;
    }
  }
  try {
    const { token, path } = rotate
      ? rotateRelayToken(options)
      : readOrCreateRelayToken(options);
    if (quiet) {
      write(`${token}\n`);
      return 0;
    }
    write(
      `${token}\n\n`
      + `Paste this into the Ghost relay extension's popup to pair it.\n`
      + `Stored at ${path} (mode 0600).${rotate ? " The previous token no longer works." : ""}\n`,
    );
    return 0;
  } catch (error) {
    fail(`relay-token: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
