import type { ModelSpec, OpenAICompat, ResolvedOpenAICompat, ResolvedOpenAIResponsesCompat, ResolvedOpenRouterCompat } from "../types.js";
/** Wire effort remap for first-party xAI Responses. */
export declare function xaiResponsesReasoningEffortMap(modelId: string): NonNullable<OpenAICompat["reasoningEffortMap"]>;
/**
 * Build the resolved chat-completions compat record for a model spec.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 */
export declare function buildOpenAICompat(spec: ModelSpec<"openai-completions">): ResolvedOpenAICompat;
interface OpenAIResponsesSpecLike {
    id?: string;
    provider: string;
    name: string;
    baseUrl: string;
    reasoning?: boolean;
    compat?: OpenAICompat;
}
/**
 * Build the resolved Responses-API compat record. Most shared OpenAI-compatible
 * capability defaults intentionally mirror chat-completions, while Responses-
 * only behavior (developer role, prompt cache, pairing strictness, image detail)
 * keeps endpoint-specific detection. Azure is detected by provider id as well
 * as URL — bundled `azure` models carry no baseUrl (the deployment host is per-
 * resource, resolved at runtime) — while OpenAI/Copilot developer-role and
 * prompt-cache detection stay URL-keyed, as the historical call sites were.
 */
export declare function buildOpenAIResponsesCompat(spec: OpenAIResponsesSpecLike): ResolvedOpenAIResponsesCompat;
export declare function buildOpenRouterCompat(spec: ModelSpec<"openrouter">): ResolvedOpenRouterCompat;
export {};
