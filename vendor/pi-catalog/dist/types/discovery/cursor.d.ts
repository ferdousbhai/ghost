import type { ModelSpec } from "../types.js";
/**
 * Options for fetching dynamic Cursor models from `GetUsableModels`.
 */
export interface CursorModelDiscoveryOptions {
    /** Cursor access token used for bearer authentication. */
    apiKey: string;
    /** Optional Cursor API base URL override. */
    baseUrl?: string;
    /** Optional client version override sent as `x-cursor-client-version`. */
    clientVersion?: string;
    /** Optional request timeout in milliseconds. */
    timeoutMs?: number;
    /** Optional list of custom Cursor model ids to include in request context. */
    customModelIds?: string[];
}
/**
 * Fetches Cursor models through `GetUsableModels` and normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export declare function fetchCursorUsableModels(options: CursorModelDiscoveryOptions): Promise<ModelSpec<"cursor-agent">[] | null>;
