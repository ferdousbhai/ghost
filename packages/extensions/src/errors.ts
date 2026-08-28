/**
 * Errors the ghost tools raise.
 *
 * OMP marks tool failures when `execute()` throws rather than from a returned
 * `{ isError: true }` payload. So every
 * failure path here is a `throw`, and the thrown value carries a machine-readable
 * `code` plus a model-facing message, because that message is what the agent
 * reads and reacts to.
 */

export type GhostErrorCode =
  | "not_found"
  | "invalid_path"
  | "invalid_format"
  | "forbidden"
  | "limit_exceeded"
  | "document_too_large"
  | "invalid_document_content"
  | "invalid_cursor"
  | "cursor_stale"
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
