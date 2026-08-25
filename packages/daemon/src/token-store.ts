/**
 * The machinery behind ghostd's machine-local secrets.
 *
 * Two of them exist — the browser relay's pairing token and the HTTP API's
 * bearer token — and they want identical treatment: 32 random bytes as hex, in
 * a mode-0600 file inside a 0700 directory under XDG *state* (machine-local,
 * regenerable, and nothing a user should be hand-editing), minted on first
 * need, compared in constant time, and printed by a `ghostd` subcommand that
 * can also rotate them.
 *
 * Only three things differ between the two: the file name, the environment
 * variable that overrides its path, and the sentence the CLI prints to say
 * what the secret is for. Those are the parameters; everything else lives
 * here, so a hardening fix applied once applies to both.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** 32 bytes, hex. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
const TOKEN_CREATE_ATTEMPTS = 8;
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface TokenStoreOptions {
  /** Injected for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. Defaults to `os.homedir()`. */
  home?: string;
  /** Skip the XDG dance entirely and use this file. */
  path?: string;
}

export interface TokenCommandOptions extends TokenStoreOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface TokenStoreSpec {
  /** File name under `$XDG_STATE_HOME/ghost/`. */
  filename: string;
  /** Environment variable that overrides the whole path. */
  envVar: string;
  /** The `ghostd` subcommand that prints it, used in messages too. */
  command: string;
  /** One line saying what the secret is for, printed above the storage note. */
  purpose: string;
}

export interface TokenStore {
  /** File name under `$XDG_STATE_HOME/ghost/`. */
  readonly filename: string;
  /** Where the token lives, without creating anything. */
  defaultPath(env?: NodeJS.ProcessEnv, home?: string): string;
  /** The token, minting one on first call. */
  readOrCreate(options?: TokenStoreOptions): { token: string; path: string; created: boolean };
  /** The stored token, or undefined when there is no token file. */
  read(options?: TokenStoreOptions): string | undefined;
  /** Mint a fresh token, invalidating whatever the old one had paired. */
  rotate(options?: TokenStoreOptions): { token: string; path: string };
  /** `ghostd <command> [--rotate] [--quiet]`. Returns a process exit code. */
  command(argv?: readonly string[], options?: TokenCommandOptions): number;
}

/**
 * Constant-time comparison. Both callers answer a failed presentation
 * immediately, so a naive `===` would leak the token a byte at a time to
 * anything that can time a loopback socket — which, on a machine running a
 * browser, is everything.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

function ensureTokenDirectory(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function readToken(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      try {
        const entry = lstatSync(path);
        if (entry.isSymbolicLink()) {
          throw new Error(
            `Token file ${path} is a dangling symlink; rotate it explicitly to replace it.`,
          );
        }
      } catch (entryError) {
        if (isErrno(entryError, "ENOENT")) return undefined;
        throw entryError;
      }
    }
    throw error;
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`Token file ${path} is malformed; rotate it explicitly to replace it.`);
  }
  return token;
}

function createToken(path: string, token: string): void {
  writeFileSync(path, `${token}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  // Keep this explicit for filesystems whose creation-mode handling is less
  // strict than Linux's; the exclusive create means no prior mode is retained.
  chmodSync(path, 0o600);
}

function replaceToken(path: string, token: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    createToken(temporary, token);
    renameSync(temporary, path);
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the write/rename failure; a cleanup error is secondary.
    }
    throw cause;
  }
}

export function createTokenStore(spec: TokenStoreSpec): TokenStore {
  const defaultPath = (
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
  ): string => {
    const explicit = env[spec.envVar]?.trim();
    if (explicit) return explicit;
    const xdg = env.XDG_STATE_HOME?.trim();
    const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
    return join(base, "ghost", spec.filename);
  };

  const resolvePath = (options: TokenStoreOptions): string => {
    if (options.path) return options.path;
    return defaultPath(options.env ?? process.env, options.home ?? homedir());
  };

  const read = (options: TokenStoreOptions = {}): string | undefined => {
    const path = resolvePath(options);
    return readToken(path);
  };

  /**
   * Synchronous on purpose: it is read while building the server, and a race
   * between two callers each writing a different token would silently unpair
   * whatever was holding the old one.
   */
  const readOrCreate = (
    options: TokenStoreOptions = {},
  ): { token: string; path: string; created: boolean } => {
    const path = resolvePath(options);
    for (let attempt = 0; attempt < TOKEN_CREATE_ATTEMPTS; attempt += 1) {
      const existing = read({ ...options, path });
      if (existing) return { token: existing, path, created: false };

      ensureTokenDirectory(path);
      const token = mintToken();
      try {
        createToken(path, token);
        return { token, path, created: true };
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          // Another daemon or CLI won the exclusive create. Loop so its token
          // is returned; never overwrite it with the losing process's value.
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `Token file ${path} did not settle after ${TOKEN_CREATE_ATTEMPTS} concurrent create attempts.`,
    );
  };

  const rotate = (options: TokenStoreOptions = {}): { token: string; path: string } => {
    const path = resolvePath(options);
    ensureTokenDirectory(path);
    const token = mintToken();
    replaceToken(path, token);
    return { token, path };
  };

  const command = (
    argv: readonly string[] = [],
    options: TokenCommandOptions = {},
  ): number => {
    const write = options.stdout ?? ((text) => process.stdout.write(text));
    const fail = options.stderr ?? ((text) => process.stderr.write(text));
    let rotating = false;
    let quiet = false;
    for (const arg of argv) {
      if (arg === "--rotate") rotating = true;
      else if (arg === "--quiet" || arg === "-q") quiet = true;
      else {
        fail(`${spec.command}: unknown option ${arg}\n`);
        return 2;
      }
    }
    try {
      const { token, path } = rotating ? rotate(options) : readOrCreate(options);
      if (quiet) {
        write(`${token}\n`);
        return 0;
      }
      write(
        `${token}\n\n`
        + `${spec.purpose}\n`
        + `Stored at ${path} (mode 0600).${rotating ? " The previous token no longer works." : ""}\n`,
      );
      return 0;
    } catch (error) {
      fail(`${spec.command}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  };

  return { filename: spec.filename, defaultPath, read, readOrCreate, rotate, command };
}
