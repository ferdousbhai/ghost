/**
 * Known model-endpoint host classification — the single vocabulary for the
 * `provider === id || baseUrl.includes(marker)` idiom that gates wire-level
 * behavior (compat detection, routing, header shaping, watchdog floors).
 *
 * Markers are case-insensitive substrings matched against the base URL, NOT
 * parsed hostnames: proxies regularly embed the upstream host in a path
 * segment, and the historical call sites all used substring semantics.
 * Callers that need strict hostname matching — where a substring false
 * positive is dangerous, e.g. the Anthropic official-endpoint OAuth gate —
 * parse the URL and compare the hostname themselves.
 */
export declare const KNOWN_HOSTS: {
    readonly openai: {
        readonly providers: readonly ["openai"];
        readonly urlMarkers: readonly ["api.openai.com"];
    };
    readonly azureOpenAI: {
        readonly providers: readonly ["azure"];
        readonly urlMarkers: readonly [".openai.azure.com", "azure.com/openai", "models.inference.ai.azure.com"];
    };
    readonly openrouter: {
        readonly providers: readonly ["openrouter"];
        readonly urlMarkers: readonly ["openrouter.ai"];
    };
    readonly vercelAIGateway: {
        readonly providers: readonly ["vercel-ai-gateway"];
        readonly urlMarkers: readonly ["ai-gateway.vercel.sh"];
    };
    readonly githubCopilot: {
        readonly providers: readonly ["github-copilot"];
        readonly urlMarkers: readonly ["githubcopilot.com", "copilot-api."];
    };
    readonly anthropic: {
        readonly providers: readonly ["anthropic"];
        readonly urlMarkers: readonly ["api.anthropic.com"];
    };
    /** DeepSeek's first-party API only — gates direct-API quirks (max_tokens field, thinking extraBody). */
    readonly deepseekDirect: {
        readonly providers: readonly ["deepseek"];
        readonly urlMarkers: readonly ["api.deepseek.com"];
    };
    /** Any DeepSeek-operated host (first-party API, web-chat fronts). Wider than `deepseekDirect` on purpose. */
    readonly deepseekFamily: {
        readonly providers: readonly ["deepseek"];
        readonly urlMarkers: readonly ["deepseek.com"];
    };
    readonly cerebras: {
        readonly providers: readonly ["cerebras"];
        readonly urlMarkers: readonly ["cerebras.ai"];
    };
    readonly zai: {
        readonly providers: readonly ["zai"];
        readonly urlMarkers: readonly ["api.z.ai"];
    };
    readonly zhipu: {
        readonly providers: readonly ["zhipu-coding-plan"];
        readonly urlMarkers: readonly ["open.bigmodel.cn"];
    };
    readonly kilo: {
        readonly providers: readonly ["kilo"];
        readonly urlMarkers: readonly ["api.kilo.ai"];
    };
    readonly alibabaDashscope: {
        readonly providers: readonly ["alibaba-coding-plan", "alibaba-token-plan"];
        readonly urlMarkers: readonly ["dashscope", "token-plan."];
    };
    readonly umans: {
        readonly providers: readonly ["umans"];
        readonly urlMarkers: readonly ["api.code.umans.ai"];
    };
    readonly xiaomi: {
        readonly providers: readonly ["xiaomi"];
        readonly providerPrefixes: readonly ["xiaomi-token-plan-"];
        readonly urlMarkers: readonly ["xiaomimimo.com"];
    };
    readonly xai: {
        readonly providers: readonly ["xai", "xai-oauth"];
        readonly urlMarkers: readonly ["api.x.ai"];
    };
    readonly mistral: {
        readonly providers: readonly ["mistral"];
        readonly urlMarkers: readonly ["mistral.ai"];
    };
    readonly together: {
        readonly providers: readonly ["together"];
        readonly urlMarkers: readonly ["api.together.xyz"];
    };
    readonly baseten: {
        readonly providers: readonly ["baseten"];
        readonly urlMarkers: readonly ["baseten.co"];
    };
    /** URL-only on purpose: the `fireworks`/`firepass` providers route per-model and not every model is Fireworks-shaped. */
    readonly fireworks: {
        readonly urlMarkers: readonly ["fireworks.ai"];
    };
    readonly groq: {
        readonly providers: readonly ["groq"];
        readonly urlMarkers: readonly ["api.groq.com"];
    };
    readonly minimax: {
        readonly providers: readonly ["minimax", "minimax-code", "minimax-code-cn"];
        readonly urlMarkers: readonly ["api.minimax.io", "api.minimaxi.com"];
    };
    readonly qwenPortal: {
        readonly providers: readonly ["qwen-portal"];
        readonly urlMarkers: readonly ["portal.qwen.ai"];
    };
    /** NVIDIA NIM (`integrate.api.nvidia.com`). Qwen NIM endpoints take `chat_template_kwargs.enable_thinking`, never top-level `enable_thinking`. */
    readonly nvidia: {
        readonly providers: readonly ["nvidia"];
        readonly urlMarkers: readonly ["integrate.api.nvidia.com"];
    };
    /** Venice AI (`api.venice.ai`). OpenAI-compatible; drives reasoning via top-level `reasoning_effort` (and `venice_parameters.disable_thinking`), and rejects DashScope's top-level `enable_thinking` with a 400 (`additionalProperties: false` request schema). */
    readonly venice: {
        readonly providers: readonly ["venice"];
        readonly urlMarkers: readonly ["api.venice.ai"];
    };
    readonly moonshotNative: {
        readonly providers: readonly ["moonshot", "kimi-code"];
        readonly urlMarkers: readonly ["api.moonshot.ai", "api.kimi.com"];
    };
    /** Google AI Studio's OpenAI-compatible shim (`/v1beta/openai`) — a subset of chat-completions; rejects `store` with a 400. Native Gemini uses `google-generative-ai` api instead. */
    readonly googleAistudio: {
        readonly providers: readonly [];
        readonly urlMarkers: readonly ["generativelanguage.googleapis.com"];
    };
    readonly opencode: {
        readonly providers: readonly ["opencode-go", "opencode-zen"];
        readonly urlMarkers: readonly ["opencode.ai"];
    };
    /** ZenMux's Anthropic-compatible proxy (`zenmux.ai/api/anthropic`) forwards to signature-enforcing Anthropic. */
    readonly zenmux: {
        readonly providers: readonly ["zenmux"];
        readonly urlMarkers: readonly ["zenmux.ai"];
    };
    readonly chutes: {
        readonly urlMarkers: readonly ["chutes.ai"];
    };
};
export type KnownHost = keyof typeof KNOWN_HOSTS;
/** URL-only host check (for call sites that have no provider id, e.g. raw env config). */
export declare function hostMatchesUrl(baseUrl: string | undefined, host: KnownHost): boolean;
/** Provider-or-URL host check — the canonical `provider === id || baseUrl.includes(marker)` idiom. */
export declare function modelMatchesHost(model: {
    provider: string;
    baseUrl: string;
}, host: KnownHost): boolean;
/**
 * Hostname for a Vertex AI GenerateContent / rawPredict / OpenAI-compat
 * request for the given location.
 *
 * - `global` → global endpoint (`aiplatform.googleapis.com`)
 * - `eu` / `us` multi-regions → REP endpoints (`aiplatform.{eu|us}.rep.googleapis.com`)
 * - every other location → regional (`{location}-aiplatform.googleapis.com`)
 *
 * Multi-region codes do NOT follow the regional `{location}-aiplatform` pattern;
 * interpolating them that way yields hosts like `eu-aiplatform.googleapis.com`
 * that 404.
 */
export declare function resolveVertexEndpointHost(location: string): string;
/** Vertex AI express-mode OpenAI-compatible endpoint (`…/endpoints/openapi`). */
export declare function isVertexExpressOpenAIUrl(baseUrl: string): boolean;
/** Vertex AI Anthropic raw-predict endpoints (`:streamRawPredict` / `:rawPredict`). */
export declare function isVertexRawPredictUrl(baseUrl: string): boolean;
/** Azure OpenAI deployment-scoped path (`…/deployments/<name>/…`). */
export declare function isAzureDeploymentsUrl(baseUrl: string): boolean;
/** Alibaba DashScope consumer `compatible-mode` endpoint (rejects multimodal arrays for some text-only SKUs). */
export declare function isDashscopeCompatibleModeUrl(baseUrl: string): boolean;
