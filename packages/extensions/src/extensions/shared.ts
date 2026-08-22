/**
 * Shared plumbing for the ghost extensions.
 *
 * The ghost home is derived from `ctx.cwd` by default. The spike proved this is
 * the shape that survives two ghosts running concurrently in one process:
 * extension module scope is per-loader but caching makes it unreliable, and a
 * process-global env var is shared by definition (report §4).
 */
import { execFile } from "node:child_process";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GhostError } from "../errors.js";
import { GhostHome, openGhostHome } from "../home.js";
import { CREATOR_SCOPE, type GhostScope } from "../scope.js";

export interface GhostExtensionOptions {
  /**
   * The ghost home this extension serves. A string is a directory path.
   * Omitted, each call resolves the home from the session's own `cwd`.
   */
  readonly home?: GhostHome | string;
  /** Whose session this is. Defaults to the creator, who sees everything. */
  readonly scope?: GhostScope;
}

export type CwdContext = Pick<ExtensionContext, "cwd">;

export function resolveHome(
  options: GhostExtensionOptions,
  ctx: CwdContext,
): GhostHome {
  const configured = options.home;
  if (configured instanceof GhostHome) return configured;
  if (typeof configured === "string") return openGhostHome(configured);
  if (!ctx.cwd) {
    throw new GhostError(
      "invalid_path",
      "No ghost home: the session has no cwd and none was configured.",
    );
  }
  return openGhostHome(ctx.cwd);
}

export function resolveScope(options: GhostExtensionOptions): GhostScope {
  return options.scope ?? CREATOR_SCOPE;
}

/** A plain text tool result. Tool *failures* throw; they never return here. */
export function textResult<TDetails>(
  text: string,
  details: TDetails,
): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// Running local programs
// ---------------------------------------------------------------------------

/**
 * The desktop extensions (screen, hyprland) reach the machine by running small
 * programs — `grim`, `hyprctl`, `notify-send`. They do it through `execFile`
 * with an **argument array and no shell**, so nothing the model emits is ever
 * parsed by `/bin/sh`. There is deliberately no `runShell` here: adding one
 * would hand a ghost the `bash` tool it is documented not to have.
 */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly signal?: AbortSignal;
  /** Kill the child after this long. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** Cap on captured stdout+stderr. Defaults to 8 MiB. */
  readonly maxBuffer?: number;
  /** Extra environment for the child. The parent env is inherited. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Run a program. Injectable so tests never touch the real desktop. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

/** A program exited non-zero, timed out, or is not installed. */
export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  /** `ENOENT` when the program is not installed. */
  readonly errno: string | undefined;
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(
    command: string,
    args: readonly string[],
    message: string,
    detail: { errno?: string; exitCode?: number; stderr?: string } = {},
  ) {
    super(message);
    this.name = "CommandError";
    this.command = command;
    this.args = [...args];
    this.errno = detail.errno;
    this.exitCode = detail.exitCode;
    this.stderr = detail.stderr ?? "";
  }
}

/** True when the failure means "that program is not installed". */
export function isCommandMissing(error: unknown): boolean {
  return error instanceof CommandError && error.errno === "ENOENT";
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/** `execFile`, promisified, with a structured failure. Never uses a shell. */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const errno = (error as NodeJS.ErrnoException).code;
        const exitCode = (error as { code?: unknown }).code;
        reject(
          new CommandError(command, args, error.message, {
            ...(typeof errno === "string" ? { errno } : {}),
            ...(typeof exitCode === "number" ? { exitCode } : {}),
            stderr: stderr.trim(),
          }),
        );
      },
    );
  });
