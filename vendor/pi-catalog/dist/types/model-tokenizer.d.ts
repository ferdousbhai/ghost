import type { ModelTokenizer } from "./types.js";
/**
 * Resolve the exact locally embedded tokenizer for a canonical model id.
 *
 * This is catalog policy, not a runtime caller heuristic: [`buildModel`](./build.ts)
 * materializes the result as `Model.tokenizer`; consumers read that property.
 */
export declare function resolveModelTokenizer(modelId: string): ModelTokenizer | undefined;
