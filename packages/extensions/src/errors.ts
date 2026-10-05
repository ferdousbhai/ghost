/**
 * Errors the ghost tools raise. Every failure is a `throw` carrying a
 * machine-readable `code` plus a model-facing message, because that message is
 * what the agent reads and reacts to.
 */

export type GhostErrorCode =
  | "not_found"
  | "invalid_path"
  | "invalid_format"
  | "forbidden"
  | "limit_exceeded"
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

/** The text of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
