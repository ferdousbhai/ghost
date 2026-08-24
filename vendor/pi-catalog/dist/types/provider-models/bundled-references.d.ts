import { getBundledModels } from "../models.js";
import type { Api, Model, ModelSpec } from "../types.js";
/**
 * Project a built `Model` back to spec stage: `compat` becomes the verbatim
 * sparse override record (`compatConfig`), never the resolved view. Discovery
 * mappers spread these references into the specs they hand to the model
 * manager, which rebuilds via `buildModel`.
 */
export declare function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi>;
export declare function createBundledReferenceMap<TApi extends Api>(provider: Parameters<typeof getBundledModels>[0]): Map<string, ModelSpec<TApi>>;
type ProviderReferenceSource<TApi extends Api> = Map<string, ModelSpec<TApi>> | (() => Map<string, ModelSpec<TApi>>);
export declare function createReferenceResolver<TApi extends Api>(providerReferenceSource: ProviderReferenceSource<TApi>): (modelId: string) => ModelSpec<TApi> | undefined;
export {};
