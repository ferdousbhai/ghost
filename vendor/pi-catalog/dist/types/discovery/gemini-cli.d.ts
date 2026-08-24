import type { ModelSpec } from "../types.js";
import { type VariantCollapseTable } from "../variant-collapse.js";
/**
 * Options for the Gemini CLI quota-based discovery fallback.
 */
export interface FetchGeminiCliQuotaModelsOptions {
    /** OAuth access token sent as `Authorization: Bearer <token>`. */
    token: string;
    /** Cloud Code Assist endpoint. Defaults to `https://cloudcode-pa.googleapis.com`. */
    endpoint?: string;
    /** Pre-resolved GCP project id; otherwise discovered via `loadCodeAssist`. */
    projectId?: string;
    /** Optional abort signal for request cancellation. */
    signal?: AbortSignal;
    /** Optional fetch implementation override for tests. */
    fetcher?: typeof fetch;
    /** Effort-tier collapse table applied to the discovered list. */
    collapseTable?: VariantCollapseTable;
}
/**
 * Discovers the Gemini models available to a `google-gemini-cli` credential via
 * the account's own `retrieveUserQuota` endpoint on Cloud Code Assist.
 *
 * This is the fallback for accounts whose credential is not authorized for the
 * Antigravity `fetchAvailableModels` endpoint (e.g. Gemini Code Assist Standard
 * tiers, which return HTTP 403 there). Quota buckets carry only model ids, so
 * metadata is filled from the bundled catalog where the id is known and
 * synthesized with Gemini CLI defaults otherwise.
 *
 * Returns `null` on network/payload/auth failure (the caller keeps the bundled
 * catalog). Returns `[]` when the quota response lists no usable Gemini models.
 */
export declare function fetchGeminiCliQuotaModels(options: FetchGeminiCliQuotaModelsOptions): Promise<ModelSpec<"google-gemini-cli">[] | null>;
