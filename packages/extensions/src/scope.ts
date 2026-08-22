/**
 * Who the session is for.
 *
 * A ghost home is one directory, but two very different sessions read it: the
 * creator's, which sees everything, and a **visitor's**, which sees only the
 * published working set and writes memory into its own sub-scope. Terminology is
 * fixed: visitors, never "callers".
 *
 * Scope is a session-construction parameter, not a runtime toggle. The daemon
 * builds the extensions for a visitor session with a visitor scope; nothing the
 * model says can widen it.
 */
import { GhostError } from "./errors.js";
import { sanitizePathSegment } from "./frontmatter.js";

export type GhostScope =
  | { readonly kind: "creator" }
  | { readonly kind: "visitor"; readonly visitorId: string };

export const CREATOR_SCOPE: GhostScope = Object.freeze({ kind: "creator" as const });

/** A visitor id must survive as a single path segment, unchanged. */
export function visitorScope(visitorId: string): GhostScope {
  const trimmed = visitorId.trim();
  if (!trimmed || trimmed !== sanitizePathSegment(trimmed) || trimmed.includes("/")) {
    throw new GhostError(
      "invalid_path",
      `Invalid visitor id ${JSON.stringify(visitorId)}: it must be usable as a single directory name.`,
      { visitorId },
    );
  }
  return { kind: "visitor", visitorId: trimmed };
}

export function isVisitorScope(
  scope: GhostScope,
): scope is { kind: "visitor"; visitorId: string } {
  return scope.kind === "visitor";
}

export function describeScope(scope: GhostScope): string {
  return isVisitorScope(scope) ? `visitor ${scope.visitorId}` : "creator";
}
