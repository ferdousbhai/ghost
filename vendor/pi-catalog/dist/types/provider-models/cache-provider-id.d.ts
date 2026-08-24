export interface ModelCacheProviderIdOptions {
    apiKey?: string;
    baseUrl?: string;
}
/** Whether a provider's model-cache namespace requires its resolved credential. */
export declare function isCredentialScopedModelCacheProvider(providerId: string): boolean;
export declare function getDefaultModelDiscoveryBaseUrl(providerId: string): string | undefined;
/** Resolve an Ollama model-cache namespace scoped to the normalized discovery endpoint. */
export declare function resolveOllamaModelCacheProviderId(providerId: string, baseUrl?: string): string;
/** Resolve the cache namespace used by a provider's model-manager options without constructing those options. */
export declare function resolveModelCacheProviderId(providerId: string, options?: ModelCacheProviderIdOptions): string;
