/**
 * A refusal the API answers with its own status: `code` is machine-readable
 * and `message` says what to do next.
 */
export class GhostError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "GhostError";
    this.code = code;
    this.status = status;
  }
}

/** The text of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
