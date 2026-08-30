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
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_FILE_BYTES = TOKEN_BYTES * 2 + 1;
const TOKEN_CREATE_ATTEMPTS = 50;
const TOKEN_CREATE_RETRY_MS = 2;
const tokenCreateSleep = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface TokenStoreOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  path?: string;
}

export interface TokenCommandOptions extends TokenStoreOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface TokenStoreSpec {
  filename: string;
  envVar: string;
  command: string;
  /** One line saying what the secret is for, printed above the storage note. */
  purpose: string;
}

export interface TokenStore {
  readonly filename: string;
  defaultPath(env?: NodeJS.ProcessEnv, home?: string): string;
  readOrCreate(options?: TokenStoreOptions): { token: string; path: string; created: boolean };
  read(options?: TokenStoreOptions): string | undefined;
  rotate(options?: TokenStoreOptions): { token: string; path: string };
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

function validateTokenDirectory(path: string): boolean {
  const directory = dirname(path);
  let stats: BigIntStats;
  try {
    stats = lstatSync(directory, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Token directory ${directory} is not a real directory.`);
  }
  if ((stats.mode & 0o777n) !== 0o700n) {
    throw new Error(`Token directory ${directory} must have mode 0700.`);
  }
  return true;
}

function ensureTokenDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  validateTokenDirectory(path);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function malformedToken(path: string): Error {
  return new Error(`Token file ${path} is malformed; rotate it explicitly to replace it.`);
}

class IncompleteTokenError extends Error {
  constructor(path: string) {
    super(malformedToken(path).message);
    this.name = "IncompleteTokenError";
  }
}

function invalidTokenEntry(path: string, entry: Stats): Error {
  if (entry.isSymbolicLink()) {
    return new Error(`Token file ${path} is a symbolic link; rotate it explicitly to replace it.`);
  }
  return new Error(`Token file ${path} is not a regular file.`);
}

function openToken(path: string): number | undefined {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    return openSync(path, flags);
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw new Error(`Token file ${path} is a symbolic link; rotate it explicitly to replace it.`);
    }
    if (!isErrno(error, "ENOENT")) throw error;
  }

  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw invalidTokenEntry(path, entry);

  // An exclusive creator can win after the first open reports ENOENT. Admit
  // that one winner exactly once; a second race is surfaced rather than spun.
  try {
    return openSync(path, flags);
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw new Error(`Token file ${path} is a symbolic link; rotate it explicitly to replace it.`);
    }
    throw error;
  }
}

function sameTokenFileState(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

function readToken(path: string): string | undefined {
  if (!validateTokenDirectory(path)) return undefined;
  const descriptor = openToken(path);
  if (descriptor === undefined) return undefined;
  let bytes: Buffer;
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`Token file ${path} must be a single-link regular file.`);
    }
    if ((before.mode & 0o777n) !== 0o600n) {
      throw new Error(`Token file ${path} must have mode 0600.`);
    }
    if (before.size < BigInt(TOKEN_FILE_BYTES)) throw new IncompleteTokenError(path);
    if (before.size > BigInt(TOKEN_FILE_BYTES)) throw malformedToken(path);

    bytes = Buffer.alloc(TOKEN_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`Token file ${path} changed while it was read.`);
    }
    if (length !== TOKEN_FILE_BYTES
      || !sameTokenFileState(before, after)
      || !sameTokenFileState(after, current)) {
      throw new Error(`Token file ${path} changed while it was read.`);
    }
  } finally {
    closeSync(descriptor);
  }
  if (bytes[TOKEN_FILE_BYTES - 1] !== 0x0a) throw malformedToken(path);
  const token = bytes.subarray(0, TOKEN_FILE_BYTES - 1).toString("ascii");
  if (!TOKEN_PATTERN.test(token)) throw malformedToken(path);
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
      let existing: string | undefined;
      try {
        existing = read({ ...options, path });
      } catch (error) {
        // `wx` publishes the inode before its one synchronous write completes.
        // Only that bounded wrong-length state is retryable; a linked, replaced,
        // wrong-mode, or exact-length malformed file remains an immediate error.
        if (!(error instanceof IncompleteTokenError) || attempt === TOKEN_CREATE_ATTEMPTS - 1) {
          throw error;
        }
        Atomics.wait(tokenCreateSleep, 0, 0, TOKEN_CREATE_RETRY_MS);
        continue;
      }
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
          Atomics.wait(tokenCreateSleep, 0, 0, TOKEN_CREATE_RETRY_MS);
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
