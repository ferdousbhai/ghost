import type { Api, FetchImpl, ModelSpec, Provider } from "../types.js";
/**
 * Default hard deadline applied to an OpenAI-compatible `/models` probe when
 * the caller supplies neither an `AbortSignal` nor an explicit `timeoutMs`.
 *
 * Built-in provider model managers (openrouter, xAI, DeepSeek, …) call
 * {@link fetchOpenAICompatibleModels} with no timeout, so without this bound a
 * stalled endpoint left the request pending forever and blocked startup's
 * awaited `resolveModelDiscoveryFallback` discovery pass indefinitely
 * (issue #8315). 10s matches the coding-agent's remote-discovery budget.
 */
export declare const DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS = 10000;
/**
 * Minimal OpenAI-style model entry shape consumed by discovery.
 *
 * Providers may return additional fields; this type only captures
 * fields that are useful for generic normalization.
 */
export interface OpenAICompatibleModelRecord {
    id?: unknown;
    name?: unknown;
    object?: unknown;
    owned_by?: unknown;
    [key: string]: unknown;
}
/**
 * Tolerant envelope for OpenAI-compatible `/models` responses.
 *
 * Common providers return `{ data: [...] }`, but variants such as
 * `{ models: [...] }`, `{ result: [...] }`, or direct arrays are also
 * accepted during extraction.
 */
export interface OpenAICompatibleModelsEnvelope {
    data?: unknown;
    models?: unknown;
    result?: unknown;
    items?: unknown;
    [key: string]: unknown;
}
/**
 * Context passed to custom OpenAI-compatible model mappers.
 */
export interface OpenAICompatibleModelMapperContext<TApi extends Api> {
    api: TApi;
    provider: Provider;
    baseUrl: string;
}
/**
 * Options for fetching and normalizing OpenAI-compatible `/models` catalogs.
 */
export interface FetchOpenAICompatibleModelsOptions<TApi extends Api> {
    /** API type assigned to normalized models. */
    api: TApi;
    /** Provider id assigned to normalized models. */
    provider: Provider;
    /** Provider base URL used for both fetch and normalized model records. */
    baseUrl: string;
    /** Optional bearer token for Authorization header. */
    apiKey?: string;
    /** Additional request headers. */
    headers?: Record<string, string>;
    /** Optional AbortSignal for request cancellation; caller owns its lifecycle. */
    signal?: AbortSignal;
    /**
     * Optional cancellable request timeout used when `signal` is omitted.
     * Defaults to {@link DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS} so a
     * stalled endpoint can never hang discovery indefinitely.
     */
    timeoutMs?: number;
    /** Optional fetch implementation override for testing/custom runtimes. */
    fetch?: FetchImpl;
    /**
     * Optional post-normalization filter.
     * Return false to skip a model.
     */
    filterModel?: (entry: OpenAICompatibleModelRecord, model: ModelSpec<TApi>) => boolean;
    /**
     * Optional mapper override for provider-specific quirks.
     * Return null to skip a model.
     */
    mapModel?: (entry: OpenAICompatibleModelRecord, defaults: ModelSpec<TApi>, context: OpenAICompatibleModelMapperContext<TApi>) => ModelSpec<TApi> | null;
}
/**
 * Fetches and normalizes an OpenAI-compatible `/models` catalog.
 *
 * Returns `null` on transport/protocol failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export declare function fetchOpenAICompatibleModels<TApi extends Api>(options: FetchOpenAICompatibleModelsOptions<TApi>): Promise<ModelSpec<TApi>[] | null>;
