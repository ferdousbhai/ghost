import type { ModelSpec, ResolvedDevinCompat } from "../types.js";
/**
 * Resolve devin-agent (Codeium Cascade) compat. Cascade has no wire
 * reasoning/effort field — effort is selected by routing to a sibling model id
 * (the `thinking.effortRouting` baked by variant-collapse). So the thinking
 * deriver must never fabricate an effort ladder from identity for these models;
 * only explicit routed metadata counts.
 */
export declare function buildDevinCompat(_spec: ModelSpec<"devin-agent">): ResolvedDevinCompat;
