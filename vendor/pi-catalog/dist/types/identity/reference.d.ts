/**
 * Proxy/reseller reference lookup: given a custom model id served through a
 * proxy (`[Kiro] claude-opus-4-8`, `gpt-5.4:cloud`, `vendor/claude-sonnet-4-6-thinking`),
 * find the bundled upstream model so missing pricing/capability metadata can be
 * inherited while keeping the custom transport.
 *
 * Kept separate from canonical-id resolution (`./equivalence`): this lookup
 * may strip `search`-style markers and prefers cache-pricing-complete
 * references, both of which would be wrong for canonical coalescing.
 */
import type { Api, Model, ThinkingConfig } from "../types.js";
export interface ModelReferenceIndex {
    exact: Map<string, Model<Api>>;
    suffixAlias: Map<string, Model<Api>>;
}
export declare function isZeroCostXaiOAuthReference(candidate: Model<Api>): boolean;
/**
 * Build a reference index from a model catalog (typically the bundled models).
 * Pure: callers are responsible for memoizing the result.
 */
export declare function buildModelReferenceIndex(models: Iterable<Model<Api>>): ModelReferenceIndex;
/**
 * Inherit bundled reference thinking only for same-provider matches. Wire routing
 * (`effortRouting`) is provider-specific; cross-provider inheritance can rewrite
 * gateway ids (e.g. Portkey `@modal/GLM-5-2-FP8` → devin `glm-5-2`).
 */
export declare function inheritReferenceThinking(modelThinking: ThinkingConfig | undefined, reference: Pick<Model<Api>, "provider" | "thinking"> | undefined, provider: string): ThinkingConfig | undefined;
/** Resolve a (possibly proxied/affixed) model id to its bundled upstream reference. */
export declare function resolveModelReference(modelId: string, index: ModelReferenceIndex): Model<Api> | undefined;
