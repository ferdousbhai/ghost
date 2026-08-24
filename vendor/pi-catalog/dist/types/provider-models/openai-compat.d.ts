import type { ModelManagerOptions } from "../model-manager.js";
import { getBundledModels } from "../models.js";
import type { Api, FetchImpl, ModelSpec, Provider } from "../types.js";
import { ALIBABA_TOKEN_PLAN_BASE_URL } from "../wire/alibaba-token-plan.js";
import type { ModelManagerConfig } from "./descriptor-types.js";
export interface ModelsDevModel {
    id?: string;
    name?: string;
    tool_call?: boolean;
    reasoning?: boolean;
    limit?: {
        context?: number;
        output?: number;
    };
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
    modalities?: {
        input?: string[];
    };
    status?: string;
    provider?: {
        npm?: string;
    };
}
/**
 * Fetches the models.dev catalog via catalog.stencil.so, which serves a
 * field-pruned copy precompressed as a zstd blob (~93 KB vs ~3.3 MB raw).
 * The frame magic is sniffed rather than trusting content-type so plain-JSON
 * responses (test stubs, fallback mirrors) parse identically.
 *
 * Fetched fully once per process: concurrent callers share the in-flight
 * request, repeat callers send a conditional GET that the server answers
 * (and deliberately does not log) with `304`.
 */
export declare function fetchWellKnownModels(fetchImpl?: FetchImpl, signal?: AbortSignal): Promise<unknown>;
/**
 * Curated Anthropic models that are live or limited-availability on the
 * first-party `/v1/models` endpoint but that models.dev has not catalogued yet.
 * Seeded into model generation so the bundled catalog is never gated on
 * models.dev's update cadence; deduped behind upstream catalog / models.dev
 * entries once those appear. Token limits and pricing are pinned either directly or
 * in `applyAnthropicCatalogPolicy`, and `thinking` is re-baked
 * by the generator's policy pass (scripts/generated-policies.ts).
 */
export declare const ANTHROPIC_CURATED_FALLBACK_MODELS: readonly ModelSpec<"anthropic-messages">[];
type SimpleProviderDiscoveryHeaders = Record<string, string> | (() => Record<string, string> | undefined);
type SimpleProviderConfig = {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
    headers?: SimpleProviderDiscoveryHeaders;
};
export declare function createSimpleOpenAICompletionsOptions(providerId: Parameters<typeof getBundledModels>[0], defaultBaseUrl: string, config?: SimpleProviderConfig): ModelManagerOptions<"openai-completions">;
export interface UmansModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function umansModelManagerOptions(config?: UmansModelManagerConfig): ModelManagerOptions<"anthropic-messages">;
/** GPT-5.6 rates applied when a first-party request exceeds 272K input tokens. */
export declare const OPENAI_GPT_56_LONG_CONTEXT_COSTS: {
    readonly luna: {
        readonly inputThreshold: 272000;
        readonly input: 0.4;
        readonly output: 1.8;
        readonly cacheRead: 0.04;
        readonly cacheWrite: 0.5;
    };
    readonly sol: {
        readonly inputThreshold: 272000;
        readonly input: 10;
        readonly output: 45;
        readonly cacheRead: 1;
        readonly cacheWrite: 12.5;
    };
    readonly terra: {
        readonly inputThreshold: 272000;
        readonly input: 4;
        readonly output: 18;
        readonly cacheRead: 0.4;
        readonly cacheWrite: 5;
    };
};
export interface OpenAIModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function openaiModelManagerOptions(config?: OpenAIModelManagerConfig): ModelManagerOptions<"openai-responses">;
/**
 * Daybreak models are approval-gated first-party Responses models that are not
 * yet present in stencil.so. Seed the documented aliases and current Cyber
 * snapshot so fresh installs expose them without credentialed discovery.
 */
export declare const OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS: readonly ModelSpec<"openai-responses">[];
/**
 * Re-derive the generated pro-reasoning aliases (`gpt-5.6-*-pro`) for the
 * first-party `openai` gpt-5.6 rows. Each alias inherits the base row's
 * metadata, requests the base wire id via `requestModelId`, and sets
 * `reasoningMode: "pro"` so Responses-family request builders emit
 * `reasoning: { mode: "pro" }`. Called by the models.json generator after all
 * sources merge: stale copies of the owned aliases (previous snapshot,
 * including retired `openai-codex` rows) are dropped and re-projected from the
 * current base rows so alias metadata always tracks the base, while a real
 * upstream model that occupies an alias id wins and suppresses the projection.
 */
export declare function projectOpenAIProReasoningAliases(models: readonly ModelSpec<Api>[]): ModelSpec<Api>[];
/**
 * Bundled seed for GMI Cloud. Generation has no `GMI_API_KEY`, so a regen
 * without credentials would leave the provider slice empty and the declared
 * `defaultModel` unresolvable on a fresh install before the async runtime
 * discovery fires. Live `/v1/models` discovery is authoritative for the model
 * ID set and overrides context/max-token limits, but `mapWithBundledReference`
 * keeps the reference's cost/reasoning/thinking — so these fields carry GMI's
 * direct-tariff values: V4-Flash at $0.14/$0.28 per 1M with Think High/Max
 * modes per GMI's launch post
 * (https://www.gmicloud.ai/en/blog/deepseek-v4-is-here-we-tested-it), not
 * discounted gateway-route pricing. GMI publishes no cache-read tariff, so
 * cacheRead stays 0 until a direct source confirms cached-token billing.
 */
export declare const GMI_CLOUD_STATIC_MODELS: readonly ModelSpec<"openai-completions">[];
export interface GmiCloudModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function gmiCloudModelManagerOptions(config?: GmiCloudModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface GroqModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface CerebrasModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function cerebrasModelManagerOptions(config?: CerebrasModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface HuggingfaceModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function huggingfaceModelManagerOptions(config?: HuggingfaceModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface NvidiaModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function nvidiaModelManagerOptions(config?: NvidiaModelManagerConfig): ModelManagerOptions<"openai-completions">;
/** Novita OpenAI-compatible discovery configuration. */
export interface NovitaModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
/** Builds Novita's public model-discovery manager. */
export declare function novitaModelManagerOptions(config?: NovitaModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface XaiModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function xaiModelManagerOptions(config?: XaiModelManagerConfig): ModelManagerOptions<"openai-responses">;
export interface XaiOAuthModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
interface XAICuratedModel {
    id: string;
    contextWindow: number;
    name?: string;
    /** Whether the model reasons natively. Defaults to true for Grok-4.x family. */
    reasoning?: boolean;
    /**
     * Whether xAI accepts the `reasoning.effort` wire param for this model.
     * Default true. When false: the picker hides the effort dial (via
     * getSupportedEfforts in model-thinking.ts) AND the wire omits the param —
     * both derive from `isGrokReasoningEffortCapable` (identity/family.ts), the
     * single allowlist shared by this curated layer and the compat builder.
     */
    supportsReasoningEffort?: boolean;
    /**
     * Input modalities this model accepts. Defaults to `["text"]` when absent.
     * Vision-capable Grok models MUST list `"image"` here so the curated layer
     * overrides `fetchOpenAICompatibleModels`' default of `["text"]` (which
     * otherwise strips image capability on every online refresh).
     */
    input?: ("text" | "image")[];
}
export declare const XAI_OAUTH_CURATED_MODELS: readonly XAICuratedModel[];
/**
 * Bake first-party xAI Responses effort-dial metadata onto a catalog spec.
 *
 * models.dev marks many Grok SKUs as reasoners and the thinking rebake would
 * otherwise emit a default `minimal/low/medium/high` dial. api.x.ai only
 * accepts `reasoning.effort` for {@link isGrokReasoningEffortCapable} ids —
 * off-allowlist reasoners (`grok-code-fast-1`, `grok-build-0.1`,
 * `grok-4.20-0309-reasoning`, …) 400 if the param is sent. SuperGrok
 * (`xai-oauth`) already curates this via {@link mergeCuratedIntoModel}; paid
 * `xai` rows come from stencil.so and need the same wire facts in the exported
 * `models.json` so direct catalog readers do not present an unsupported dial.
 *
 * Explicit `compat.supportsReasoningEffort` / `omitReasoningEffort` win.
 */
export declare function applyXaiResponsesThinkingPolicy(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses">;
/**
 * Render `XAI_OAUTH_CURATED_MODELS` as full `ModelSpec<"openai-responses">` entries.
 *
 * Single source of truth for the curated to Model fan-in, consumed by both
 * - {@link xaiOAuthModelManagerOptions} (runtime static seed handed to the model
 *   manager so the picker is populated on a fresh login), and
 * - \`packages/catalog/scripts/generate-models.ts\` (bundles the same entries into
 *   `models.json`, so the synchronous `ModelRegistry.#loadModels()` boot path
 *   sees `xai-oauth` without waiting for a refresh — fixes the boot-time
 *   default-model reset when `modelRoles.default = "xai-oauth/<id>"`).
 *
 * `reasoning` defaults to `true` for the Grok-4.x family; the explicit
 * `grok-4.20-0309-non-reasoning` entry opts out via `XAICuratedModel.reasoning`.
 * `maxTokens` mirrors each model's `contextWindow` (the OAuth surface reports
 * no per-request output limit); the openai-responses wire still clamps the
 * actual request to OPENAI_MAX_OUTPUT_TOKENS. Mirrors
 * `hermes-agent/hermes_cli/models.py:_XAI_STATIC_FALLBACK`.
 */
export declare function buildXaiOAuthStaticSeed(baseUrl?: string): ModelSpec<"openai-responses">[];
export declare function xaiOAuthModelManagerOptions(config?: XaiOAuthModelManagerConfig): ModelManagerOptions<"openai-responses">;
export declare function isLikelyAimlApiChatModelId(id: string): boolean;
export interface AimlApiModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function aimlApiModelManagerOptions(config?: AimlApiModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface DeepSeekModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function deepseekModelManagerOptions(config?: DeepSeekModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface SiliconFlowModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function isLikelySiliconFlowChatModelId(id: string): boolean;
export declare function siliconflowModelManagerOptions(config?: SiliconFlowModelManagerConfig): ModelManagerOptions<"openai-completions">;
export declare function siliconflowCnModelManagerOptions(config?: SiliconFlowModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface ZhipuCodingPlanModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function zhipuCodingPlanModelManagerOptions(config?: ZhipuCodingPlanModelManagerConfig): ModelManagerOptions<"openai-completions">;
/**
 * Fireworks-published cap for the Kimi K2 family. Fireworks' `/v1/models`
 * envelope generically reports `max_completion_tokens: 65536` for every Kimi
 * deployment, but Kimi K2 (instruct / thinking / turbo) on Fireworks is
 * documented to ship long reasoning traces that should be bounded — capping
 * at 32,768 prevents handing callers a budget the router cannot honor.
 * See https://github.com/can1357/oh-my-pi/issues/1849.
 */
export declare const FIREWORKS_KIMI_MAX_TOKENS = 32768;
/**
 * Fireworks' output ceiling for Kimi K2.7-Code specifically. Its `/v1/models`
 * generic `max_completion_tokens` is 65,536 and Fireworks serves it in full —
 * verified with a single completion emitting 58,971 output tokens and
 * `max_tokens: 200000` accepted without error. Unlike the older K2.5/K2.6
 * family (see {@link FIREWORKS_KIMI_MAX_TOKENS}), K2.7-Code is not clamped to
 * 32,768; that ceiling only truncated it.
 */
export declare const FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65536;
/**
 * Returns true for the Kimi K2.5 / K2.6 family served by Fireworks-backed
 * providers (`fireworks` direct, `firepass` router) that share the 32,768
 * `maxTokens` ceiling. Matches both the public catalog id (`kimi-k2.5`,
 * `kimi-k2.6`, `kimi-k2.6-turbo`) and the canonical Fireworks wire id
 * (`accounts/fireworks/{models,routers}/kimi-k2…`).
 *
 * K2.7-Code (incl. `-fast` / `-highspeed`) is deliberately excluded: unlike the
 * earlier K2 family it serves its full context on Fireworks — verified with a
 * single completion emitting 58,971 output tokens and `max_tokens: 200000`
 * accepted without error — so the 32,768 cap would only truncate it. It inherits
 * Fireworks' reported `max_completion_tokens` (65,536) instead.
 */
export declare function isFireworksKimiK2ModelId(modelId: string): boolean;
/**
 * Clamp the Kimi K2 family's `maxTokens` to {@link FIREWORKS_KIMI_MAX_TOKENS}
 * on Fireworks-backed providers, leaving every other model untouched.
 */
export declare function clampFireworksKimiMaxTokens(modelId: string, candidate: number): number;
export declare function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null;
/**
 * Kimi K2.7 Code's documented recommended output budget. Some provider
 * discovery rows report the context-sized `max_completion_tokens` instead.
 */
export declare const KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS = 32768;
export declare function isKimiK27CodeModelId(modelId: string): boolean;
export declare function clampKimiK27CodeMaxTokens(modelId: string, candidate: number): number;
export declare function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null;
/**
 * Build the Fireworks Fast seed by projecting each base bundled spec into a
 * `<id>-fast` variant. Pushed into the generated catalog (Fast routers never
 * appear in the serverless control-plane list, so discovery cannot surface
 * them) and deduped behind any identical previous-snapshot entry.
 */
export declare function buildFireworksFastSeed(): ModelSpec<"openai-completions">[];
/**
 * Fireworks DeepSeek V4 accepts effort via `reasoning_effort` but rejects the
 * DeepSeek-native binary `thinking` toggle when both are present.
 */
export declare function stripFireworksDeepSeekThinkingToggle(model: ModelSpec<"openai-completions">, publicModelId: string): ModelSpec<"openai-completions">;
export interface FireworksModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function fireworksModelManagerOptions(config?: FireworksModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface FirepassModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
/**
 * Fire Pass is a Fireworks subscription product that exposes a single router
 * model (Kimi K2.6 Turbo) under `accounts/fireworks/routers/kimi-k2p6-turbo`.
 * The dedicated `fpk_…` keys do not authorize `/v1/models`, so this manager
 * never performs dynamic discovery — the bundled catalog entry is canonical.
 * See https://docs.fireworks.ai/firepass.
 */
export declare function firepassModelManagerOptions(_config?: FirepassModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface WaferModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
type WaferThinkingFormat = "zai" | "qwen";
export declare function resolveWaferServerlessThinkingFormat(modelId: string, upstreamProvider: unknown): WaferThinkingFormat | undefined;
export declare function waferServerlessModelManagerOptions(config?: WaferModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface MistralModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function mistralModelManagerOptions(config?: MistralModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface OpenCodeModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function opencodeZenModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api>;
export declare function opencodeGoModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api>;
export interface OllamaModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses">;
export interface OpenRouterModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function openrouterModelManagerOptions(config?: OpenRouterModelManagerConfig): ModelManagerOptions<"openrouter">;
export interface ZenMuxModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function zenmuxModelManagerOptions(config?: ZenMuxModelManagerConfig): ModelManagerOptions<Api>;
export interface KiloModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function kiloModelManagerOptions(config?: KiloModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface AlibabaCodingPlanModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function alibabaCodingPlanModelManagerOptions(config?: AlibabaCodingPlanModelManagerConfig): ModelManagerOptions<"openai-completions">;
export { ALIBABA_TOKEN_PLAN_BASE_URL };
export declare const ALIBABA_TOKEN_PLAN_STATIC_MODELS: readonly ModelSpec<"openai-completions">[];
/**
 * Metadata for Alibaba Token Plan models that are dynamically discovered but not
 * in the static catalog. Context window and max tokens are sourced from
 * official model documentation and provider catalogs. Unknown future models
 * remain available with null limits instead of assigning unsafe guessed limits.
 */
export interface AlibabaTokenPlanModelLimits {
    contextWindow: number;
    maxTokens: number;
}
export declare const ALIBABA_TOKEN_PLAN_DISCOVERED_MODEL_LIMITS: Readonly<Record<string, AlibabaTokenPlanModelLimits>>;
export interface AlibabaTokenPlanModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function alibabaTokenPlanModelManagerOptions(config?: AlibabaTokenPlanModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface VercelAiGatewayModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function vercelAiGatewayModelManagerOptions(config?: VercelAiGatewayModelManagerConfig): ModelManagerOptions<"anthropic-messages">;
export interface KimiCodeModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
/**
 * Kimi Code output ceilings by model family. The `/coding/v1/models` discovery
 * envelope carries no output-limit field, so the mapper supplies the documented
 * per-family caps instead of a blanket constant. Values match models.dev's
 * `kimi-for-coding` and `moonshotai` kimi-k3 entries. See #6711.
 */
export declare const KIMI_CODE_K3_MAX_TOKENS = 131072;
export declare const KIMI_CODE_FOR_CODING_MAX_TOKENS = 32768;
/** Fallback output cap for Kimi Code families without a documented ceiling (legacy K2 discovery rows). */
export declare const KIMI_CODE_DEFAULT_MAX_TOKENS = 32000;
/**
 * Resolve a Kimi Code model's output ceiling from its id: `k3` / `k3-256k` ->
 * 131072, `kimi-for-coding[-highspeed]` -> 32768, everything else -> `fallback`.
 */
export declare function kimiCodeMaxTokens(modelId: string, fallback?: number): number;
export declare function kimiCodeMaxTokens(modelId: string, fallback: number | null): number | null;
export declare function kimiCodeModelManagerOptions(config?: KimiCodeModelManagerConfig): ModelManagerOptions<"openai-completions">;
/** Native LM Studio metadata keyed by model id from `/api/v0/models`. */
export interface LmStudioNativeModelMetadata {
    input: ("text" | "image")[];
    contextWindow?: number;
}
/** Options for LM Studio's optional native metadata probe. */
export interface LmStudioNativeModelMetadataOptions {
    headers?: Record<string, string>;
    signal?: AbortSignal;
}
/** Fetches LM Studio native model metadata used to mark VLM models as image-capable. */
export declare function fetchLmStudioNativeModelMetadata(baseUrl: string, fetchImpl?: FetchImpl, options?: LmStudioNativeModelMetadataOptions): Promise<Map<string, LmStudioNativeModelMetadata> | null>;
export interface LmStudioModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function lmStudioModelManagerOptions(config?: LmStudioModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface SyntheticModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function syntheticModelManagerOptions(config?: SyntheticModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface VeniceModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function veniceModelManagerOptions(config?: VeniceModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface BasetenModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function basetenModelManagerOptions(config?: BasetenModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface TogetherModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function togetherModelManagerOptions(config?: TogetherModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface CoreWeaveModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function coreWeaveModelManagerOptions(config?: CoreWeaveModelManagerConfig): ModelManagerOptions<"openai-completions">;
export declare const META_MUSE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[];
/**
 * OpenAI frontier models served exclusively through Bedrock Mantle's Responses
 * endpoint. Pricing is per million tokens from the Amazon Bedrock pricing page.
 */
export declare const BEDROCK_MANTLE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[];
export declare function bedrockMantleModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-responses">;
export interface MetaModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function metaModelManagerOptions(config?: MetaModelManagerConfig): ModelManagerOptions<"openai-responses">;
export interface MoonshotModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function moonshotModelManagerOptions(config?: MoonshotModelManagerConfig): ModelManagerOptions<"openai-completions">;
export declare const SAKANA_FUGU_STATIC_MODELS: readonly ModelSpec<"openai-responses">[];
export interface SakanaModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function sakanaModelManagerOptions(config?: SakanaModelManagerConfig): ModelManagerOptions<"openai-responses">;
/**
 * Documented ai& catalog (docs.aiand.com/models/catalog, 2026-08) bundled so
 * the provider is usable when generation and first boot have no live key.
 * The org-scoped `/v1/models` response is authoritative once discovery runs.
 */
export declare const AIAND_STATIC_MODELS: readonly ModelSpec<"openai-completions">[];
export interface AiandModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
/**
 * ai& (aiand.com) model manager: OpenAI-compatible chat completions with an
 * org-scoped `/v1/models` catalog carrying context, capability, effort, and
 * pricing metadata, so discovery is authoritative over the bundled seed.
 */
export declare function aiandModelManagerOptions(config?: AiandModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface QwenPortalModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function qwenPortalModelManagerOptions(config?: QwenPortalModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface QianfanModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function qianfanModelManagerOptions(config?: QianfanModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface CloudflareAiGatewayModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function cloudflareAiGatewayModelManagerOptions(config?: CloudflareAiGatewayModelManagerConfig): ModelManagerOptions<"anthropic-messages">;
/** Region codes for Xiaomi Token Plan clusters exposed as separate login providers. */
export type XiaomiTokenPlanRegion = "sgp" | "ams" | "cn";
/** Configures Xiaomi standard or regional Token Plan OpenAI-compatible model discovery. */
export interface XiaomiModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
    providerId?: Provider;
    tokenPlanRegion?: XiaomiTokenPlanRegion;
}
/** Builds a Xiaomi model manager, preserving Token Plan region provider ids during discovery. */
export declare function xiaomiModelManagerOptions(config?: XiaomiModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface LiteLLMModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export interface FetchLiteLLMRichModelsOptions<TApi extends Api> {
    api: TApi;
    provider: Provider;
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    fetch?: FetchImpl;
    signal?: AbortSignal;
    timeoutMs?: number;
    referenceResolver?: (modelId: string) => ModelSpec<TApi> | undefined;
    resolveApi?: (entry: Record<string, unknown>, modelId: string) => TApi;
}
export declare const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128000;
export declare const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32768;
export declare function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string;
export declare function resolveLiteLLMApi(entry: Record<string, unknown> | undefined, id: string, fallbackApi?: Api): Api;
export declare function fetchLiteLLMRichModels<TApi extends Api>(options: FetchLiteLLMRichModelsOptions<TApi>): Promise<ModelSpec<TApi>[] | null>;
export declare function litellmModelManagerOptions(config?: LiteLLMModelManagerConfig): ModelManagerOptions<Api>;
export interface VllmModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface NanoGptModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function nanoGptModelManagerOptions(config?: NanoGptModelManagerConfig): ModelManagerOptions<"openai-completions">;
export interface GithubCopilotModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
/** Local id/name suffixes for synthesized Copilot long-context variants. */
export declare const COPILOT_LONG_CONTEXT_ID_SUFFIX = "-1m";
export declare function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api>;
export interface AnthropicModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
export declare function anthropicModelManagerOptions(config?: AnthropicModelManagerConfig): ModelManagerOptions<"anthropic-messages">;
/** Describes how to map models.dev API data for a single provider. */
export interface ModelsDevProviderDescriptor {
    /** Key in the models.dev API response JSON (e.g., "anthropic", "amazon-bedrock") */
    modelsDevKey: string;
    /** Provider ID in our system */
    providerId: string;
    /** Default API type for this provider's models */
    api: Api;
    /** Default base URL */
    baseUrl: string;
    /** Default context window fallback (default: UNKNNOWN_CONTEXT_WINDOW) */
    defaultContextWindow?: number;
    /** Default max tokens fallback (default: UNKNNOWN_MAX_TOKENS) */
    defaultMaxTokens?: number;
    /** Optional compat overrides applied to every model from this provider */
    compat?: ModelSpec<Api>["compat"];
    /** Optional static headers applied to every model */
    headers?: Record<string, string>;
    /**
     * Optional filter: return false to skip a model.
     * Called with (modelId, rawModel). Default: skip if tool_call !== true.
     */
    filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
    /**
     * Optional transform: modify the mapped model before it's added.
     * Can return null to skip the model, or an array to emit multiple models.
     */
    transformModel?: (model: ModelSpec<Api>, modelId: string, raw: ModelsDevModel) => ModelSpec<Api> | ModelSpec<Api>[] | null;
    /**
     * Optional: override the API type per-model.
     * Called with (modelId, raw). Return the API type to use.
     * If not provided, uses the `api` field.
     */
    resolveApi?: (modelId: string, raw: ModelsDevModel) => {
        api: Api;
        baseUrl: string;
    } | null;
}
/** Generic mapper that converts models.dev data using provider descriptors. */
export declare function mapModelsDevToModels(data: Record<string, unknown>, descriptors: readonly ModelsDevProviderDescriptor[]): ModelSpec<Api>[];
/** All provider descriptors for models.dev data mapping in generate-models.ts. */
export declare const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[];
