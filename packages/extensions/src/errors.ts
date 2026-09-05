/**
 * Errors the ghost tools raise.
 *
 * Pi marks tool failures when `execute()` throws rather than from a returned
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

export function isGhostError(value: unknown): value is GhostError {
  return value instanceof GhostError;
}
