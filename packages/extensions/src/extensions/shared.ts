/**
 * Shared plumbing for the ghost extensions.
 *
 * The ghost home is derived from `ctx.cwd` by default. The spike proved this is
 * the shape that survives two ghosts running concurrently in one process:
 * extension module scope is per-loader but caching makes it unreliable, and a
 * process-global env var is shared by definition (report §4).
 */
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
