import MODELS from "./models.json";
import type { Api, KnownProvider, Model, Usage } from "./types.js";
export type GeneratedProvider = keyof typeof MODELS;
export declare function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi>;
export declare function getBundledProviders(): KnownProvider[];
export declare function getBundledModels(provider: GeneratedProvider): Model<Api>[];
/** Price a prompt as fully uncached input under its active context-length tier. */
export declare function calculateUncachedInputCost(cost: Model["cost"], promptInputTokens: number): number;
export declare function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"];
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export declare function modelsAreEqual<TApi extends Api>(a: Model<TApi> | null | undefined, b: Model<TApi> | null | undefined): boolean;
