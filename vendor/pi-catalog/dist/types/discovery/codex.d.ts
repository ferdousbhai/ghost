import type { FetchImpl, ModelSpec } from "../types.js";
/**
 * Fetch options for OpenAI Codex model discovery.
 */
export interface CodexModelDiscoveryOptions {
    /** OAuth access token used for `Authorization: Bearer ...`. */
    accessToken: string;
    /** ChatGPT account id value used for `chatgpt-account-id` header. */
    accountId?: string;
    /** Base URL for Codex backend. Defaults to `https://chatgpt.com/backend-api`. */
    baseUrl?: string;
    /** Optional client version attached as `client_version` query parameter. */
    clientVersion?: string;
    /** Optional endpoint path candidates. Defaults to `/codex/models`, then `/models`. */
    paths?: readonly string[];
    /** Additional headers merged on top of required Codex headers. */
    headers?: Record<string, string>;
    /** Abort signal for network request cancellation. */
    signal?: AbortSignal;
    /** Optional fetch implementation override for tests. */
    fetchFn?: FetchImpl;
}
/**
 * Normalized Codex discovery response.
 */
export interface CodexModelDiscoveryResult {
    models: ModelSpec<"openai-codex-responses">[];
    etag?: string;
}
/**
 * Fetches model metadata from Codex backend and normalizes it for pi model management.
 *
 * Returns `null` when no supported model-list route can be fetched/parsed.
 * Returns `{ models: [] }` when a route succeeds but yields no usable models.
 */
export declare function fetchCodexModels(options: CodexModelDiscoveryOptions): Promise<CodexModelDiscoveryResult | null>;
