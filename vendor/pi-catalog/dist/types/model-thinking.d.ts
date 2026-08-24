/**
 * Thinking metadata: build-time derivation and runtime field-read helpers.
 *
 * Derivation (`resolveModelThinking`) runs exactly once per model — from
 * `buildModel` for dynamic specs and from the catalog generator for bundled
 * entries. Everything below the "runtime helpers" divider reads baked fields
 * only: no id parsing, no host matching, no compat detection per request.
 */
import { Effort } from "./effort.js";
import type { Api, CompatOf, Model, ModelSpec, ThinkingConfig } from "./types.js";
/**
 * Runtime helpers read baked metadata only, so they accept both pre-build
 * specs and built models.
 */
type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;
/**
 * Resolve the canonical thinking metadata for a spec. Called exactly once per
 * model by `buildModel`, after compat resolution.
 *
 * - Non-reasoning models never carry thinking.
 * - Models that reason natively but reject the wire effort param
 *   (`compat.supportsReasoningEffort: false` on openai-responses*) carry no
 *   thinking either: `reasoning: true, thinking: undefined` IS the encoding
 *   for "thinks, but exposes no control surface".
 * - Explicit spec thinking (generator-baked or user-authored) owns the
 *   capability surface (`mode`, `efforts`, `defaultLevel`); the wire facts
 *   (`effortMap`, `supportsDisplay`) are backfilled from identity when not
 *   explicitly set, so configs never need to know provider wire tier tables.
 * - Sparse specs go through full inference.
 */
export declare function resolveModelThinking<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): ThinkingConfig | undefined;
/** Derive thinking from identity + resolved compat, ignoring any baked value. Generator-side entry. */
export declare function deriveThinking<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): ThinkingConfig;
/**
 * Returns the supported thinking efforts declared on the model metadata.
 * Empty for non-reasoning models and for reasoning models without a
 * controllable effort surface (`thinking: undefined`).
 */
export declare function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[];
/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export declare function clampThinkingLevelForModel<TApi extends Api>(model: ApiModel<TApi> | undefined, requested: Effort | undefined): Effort | undefined;
export declare function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort;
/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values.
 * When a collapsed family routes `minimal` onto the same wire id as `low`
 * (Antigravity Gemini 3.6/3.7 Flash), emit `LOW` — Cloud Code Assist rejects
 * `MINIMAL` on those `-low` SKUs.
 */
export declare function mapEffortToGoogleThinkingLevel<TApi extends Api>(effort: Effort, model?: ApiModel<TApi>): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
/**
 * Maps a normalized thinking effort to Anthropic adaptive effort values via
 * the model's baked `thinking.effortMap` (identity for unmapped efforts).
 */
export declare function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive";
/**
 * Resolves the upstream wire model id for a request at the given effort
 * (`undefined` = thinking off). Collapsed effort-tier variants route through
 * `thinking.effortRouting`; everything else falls back to
 * `requestModelId ?? id`.
 */
export declare function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string;
/**
 * Lowest supported effort in canonical order — the clamp target for
 * thinking-off requests on `thinking.requiresEffort` models.
 */
export declare function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined;
export {};
