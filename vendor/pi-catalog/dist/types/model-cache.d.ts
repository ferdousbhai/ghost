import type { Api, Model, ModelSpec } from "./types.js";
interface CacheEntry<TApi extends Api = Api> {
    models: ModelSpec<TApi>[];
    fresh: boolean;
    authoritative: boolean;
    updatedAt: number;
    /** Model ids whose live headers were intentionally omitted from disk. */
    headerOmittedModelIds: readonly string[];
    /** Header-bearing model ids that cannot be rebuilt from the static source. */
    unrestorableHeaderModelIds: readonly string[];
    /** Whether unrestorable markers predate request-model header matching. */
    legacyHeaderRestoreMarkers: boolean;
    /**
     * Hash of the static catalog slice that was merged into `models` when this
     * row was written. `resolveProviderModels` compares against the current
     * static fingerprint and bypasses the static+cache re-merge when they
     * match — the cache already incorporates the same static state.
     */
    staticFingerprint: string;
}
export declare function readModelCache<TApi extends Api>(providerId: string, ttlMs: number, now: () => number, dbPath?: string): CacheEntry<TApi> | null;
export declare function writeModelCache<TApi extends Api>(providerId: string, updatedAt: number, models: Model<TApi>[], authoritative: boolean, staticFingerprint: string, dbPath?: string, staticHeaderSources?: readonly Model<TApi>[], restorableHeaderFallback?: Record<string, string>): void;
export {};
