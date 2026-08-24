import type { Api, Model, ModelSpec, Provider } from "./types.js";
/**
 * Controls when dynamic endpoint models should be fetched.
 */
export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";
/**
 * Hook for loading and mapping stencil.so fallback data into canonical model objects.
 */
export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
    /** Fetches raw fallback payload (for example from stencil.so). */
    fetch(): Promise<TPayload>;
    /** Maps payload into provider models. */
    map(payload: TPayload, providerId: Provider): readonly ModelSpec<TApi>[];
}
/**
 * Configuration for provider model resolution.
 */
export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
    /** Provider id used for static lookup and cache namespacing. */
    providerId: Provider;
    /** Optional static list override. When omitted, bundled models.json is used. */
    staticModels?: readonly ModelSpec<TApi>[];
    /** Optional override for the cache database path. Default: <agent-dir>/models.db. */
    cacheDbPath?: string;
    /** Optional provider id override for cache namespacing. Defaults to providerId. */
    cacheProviderId?: string;
    /** Maximum cache age in milliseconds before considered stale. Default: 2h (`DEFAULT_CACHE_TTL_MS`). */
    cacheTtlMs?: number;
    /** When true, a successful dynamic fetch is the complete provider catalog and prunes static-only models. */
    dynamicModelsAuthoritative?: boolean;
    /** Cached model ids whose presence forces refresh when the static or migration-policy fingerprint changes. */
    dropCachedModelIdsOnStaticMismatch?: readonly string[];
    /**
     * Trusted, provider-wide request headers that can be safely re-derived at
     * cache-read time. The cache never persists their values. Models whose live
     * headers matched this record at write time can survive offline reads without
     * a bundled static source, including configured discovery providers whose
     * bearer header comes from the current local config.
     */
    restorableHeaderFallback?: Record<string, string>;
    /** Optional dynamic endpoint fetcher. */
    fetchDynamicModels?: () => Promise<readonly ModelSpec<TApi>[] | null>;
    /** Optional stencil.so fallback hook. */
    modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;
    /** Clock override for deterministic tests. */
    now?: () => number;
}
/**
 * Resolution result.
 *
 * `stale` is false when the resolved catalog is authoritative for the selected provider:
 * - a dynamic endpoint fetch succeeded in this call (an empty catalog is still
 *   authoritative for the cycle, so downstream pruning of removed models runs),
 * - a still-fresh authoritative cache was reused in `online-if-uncached` mode, or
 * - the provider has no dynamic fetcher configured.
 */
export interface ModelResolutionResult<TApi extends Api = Api> {
    models: Model<TApi>[];
    stale: boolean;
}
/**
 * Stateful facade over provider model resolution.
 */
export interface ModelManager<TApi extends Api = Api> {
    refresh(strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
}
/**
 * Creates a reusable provider model manager.
 */
export declare function createModelManager<TApi extends Api = Api, TModelsDevPayload = unknown>(options: ModelManagerOptions<TApi, TModelsDevPayload>): ModelManager<TApi>;
/**
 * Resolves provider models with source precedence:
 * static -> stencil.so -> cache -> dynamic.
 *
 * Later sources override earlier ones by model id.
 */
export declare function resolveProviderModels<TApi extends Api = Api, TModelsDevPayload = unknown>(options: ModelManagerOptions<TApi, TModelsDevPayload>, strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
