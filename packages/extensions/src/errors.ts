/**
 * Errors the ghost tools raise.
 *
 * pi 0.84.2 does not honour a returned `{ isError: true }` payload — the flag is
 * set by the runtime when `execute()` throws (spike report §6.6). So every
 * failure path here is a `throw`, and the thrown value carries a machine-readable
 * `code` plus a model-facing message, because that message is what the agent
 * reads and reacts to.
 */

export type GhostErrorCode =
  /** The named note, memory file, visitor, or ghost home does not exist. */
  | "not_found"
  /** A path escaped the ghost home, or a name is not a legal file name. */
  | "invalid_path"
  /** The bytes are not in the ghost-home/v1 shape (frontmatter, manifest, …). */
  | "invalid_format"
  /** The caller's scope is not allowed to see or change this. */
  | "forbidden"
  /** A documented size or count limit was exceeded. */
  | "limit_exceeded"
  /** The target already exists and the operation refused to clobber it. */
  | "conflict";

export class GhostError extends Error {
  readonly code: GhostErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GhostErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GhostError";
    this.code = code;
    this.details = details;
  }
}

/**
 * A memory file the model wrote does not match the format. Kept as its own class
 * (as in the hosted repo) because the message is deliberately instructional: it
 * is handed back verbatim so the model can fix its own write.
 */
export class MemoryFileFormatError extends GhostError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("invalid_format", message, details);
    this.name = "MemoryFileFormatError";
  }
}

export function isGhostError(value: unknown): value is GhostError {
  return value instanceof GhostError;
}
