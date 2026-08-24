import type { FetchImpl, ModelSpec } from "../types.js";
/**
 * Options for fetching dynamic Devin (Codeium Cascade) models from `GetCliModelConfigs`.
 */
export interface DevinModelDiscoveryOptions {
    /** Codeium session token carried inside protobuf `Metadata.apiKey`. */
    apiKey?: string;
    /** Optional Codeium API base URL override. */
    baseUrl?: string;
    /** Optional request timeout in milliseconds (default 5000). */
    timeoutMs?: number;
    /** Optional caller abort signal, combined with the internal timeout. */
    signal?: AbortSignal;
    /** Optional fetch implementation for request-debug/proxy/test transports. */
    fetch?: FetchImpl;
}
/**
 * Fetches Devin models through the `GetCliModelConfigs` unary Connect RPC and
 * normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export declare function fetchDevinModels(options: DevinModelDiscoveryOptions): Promise<ModelSpec<"devin-agent">[] | null>;
