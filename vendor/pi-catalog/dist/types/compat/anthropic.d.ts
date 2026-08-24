import type { ModelSpec, ResolvedAnthropicCompat } from "../types.js";
/**
 * Official first-party Anthropic API. A missing baseUrl is official on purpose:
 * request dispatch falls back to `https://api.anthropic.com`. This is the one
 * auth-sensitive host check — OAuth credentials are attached based on it — so
 * it requires the exact origin or a path boundary (`/`) after it; a bare
 * prefix check would accept lookalikes like `https://api.anthropic.com.evil.com`.
 */
export declare function isOfficialAnthropicApiUrl(baseUrl?: string): boolean;
/**
 * Known non-official URLs that enforce Anthropic thinking signatures on replay.
 *
 * Runtime routing calls this with the effective URL because a model's resolved
 * compat can be stale after Foundry or a provider base-URL override reroutes it.
 */
export declare function isAnthropicSigningProxyUrl(baseUrl?: string): boolean;
/** Build the resolved anthropic-messages compat record for a model spec. */
export declare function buildAnthropicCompat(spec: ModelSpec<"anthropic-messages">): ResolvedAnthropicCompat;
