/**
 * The provider catalog table: one entry per chat-model provider, carrying the
 * catalog half of what used to live in `@oh-my-pi/pi-ai`'s registry definitions
 * (default model, runtime model-manager factory, discovery wiring). The auth
 * half (env keys, OAuth login/refresh) stays in the pi-ai registry, which
 * type-checks itself against `KnownProvider` from this table.
 */
import type { ModelManagerConfig, ProviderCatalogEntry, ProviderDescriptor } from "./descriptor-types.js";
export declare const CATALOG_PROVIDERS: readonly [{
    readonly id: "aiand";
    readonly defaultModel: "moonshotai/kimi-k2.7-code";
    readonly envVars: readonly ["AIAND_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "ai&";
    };
}, {
    readonly id: "aimlapi";
    readonly defaultModel: "gpt-5.5-2026-04-23";
    readonly envVars: readonly ["AIMLAPI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "AIML API";
    };
}, {
    readonly id: "alibaba-coding-plan";
    readonly defaultModel: "qwen3.7-plus";
    readonly envVars: readonly ["ALIBABA_CODING_PLAN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Alibaba Coding Plan";
    };
}, {
    readonly id: "alibaba-token-plan";
    readonly defaultModel: "qwen3.7-plus";
    readonly envVars: readonly ["ALIBABA_TOKEN_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "QwenCloud Token Plan";
    };
}, {
    readonly id: "baseten";
    readonly defaultModel: "moonshotai/Kimi-K2.7-Code";
    readonly envVars: readonly ["BASETEN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Baseten";
    };
}, {
    readonly id: "amazon-bedrock";
    readonly defaultModel: "us.anthropic.claude-opus-4-8";
}, {
    readonly id: "bedrock-mantle";
    readonly defaultModel: "openai.gpt-5.6-terra";
    readonly envVars: readonly ["AWS_BEARER_TOKEN_BEDROCK"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
    readonly dynamicModelsAuthoritative: true;
}, {
    readonly id: "anthropic";
    readonly defaultModel: "claude-opus-4-8";
    readonly envVars: readonly ["ANTHROPIC_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"anthropic-messages", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Anthropic";
    };
}, {
    readonly id: "azure";
    readonly defaultModel: "gpt-5.5";
    readonly envVars: readonly ["AZURE_OPENAI_API_KEY"];
}, {
    readonly id: "cerebras";
    readonly defaultModel: "zai-glm-4.7";
    readonly envVars: readonly ["CEREBRAS_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Cerebras";
    };
}, {
    readonly id: "cloudflare-ai-gateway";
    readonly defaultModel: "anthropic/claude-opus-4-8";
    readonly envVars: readonly ["CLOUDFLARE_AI_GATEWAY_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"anthropic-messages", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Cloudflare AI Gateway";
    };
}, {
    readonly id: "cursor";
    readonly defaultModel: "claude-4.6-opus-high";
    readonly envVars: readonly ["CURSOR_ACCESS_TOKEN"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"cursor-agent", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Cursor";
        readonly envVars: readonly ["CURSOR_API_KEY"];
        readonly oauthProvider: "cursor";
    };
}, {
    readonly id: "deepseek";
    readonly defaultModel: "deepseek-v4-pro";
    readonly envVars: readonly ["DEEPSEEK_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "DeepSeek";
    };
}, {
    readonly id: "devin";
    readonly defaultModel: "swe-1-6";
    readonly envVars: readonly ["DEVIN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"devin-agent", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Devin";
        readonly envVars: readonly ["DEVIN_API_KEY"];
        readonly oauthProvider: "devin";
    };
}, {
    readonly id: "firepass";
    readonly defaultModel: "kimi-k2.6-turbo";
    readonly envVars: readonly ["FIREPASS_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
}, {
    readonly id: "fireworks";
    readonly defaultModel: "kimi-k2.7-code";
    readonly envVars: readonly ["FIREWORKS_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Fireworks";
    };
}, {
    readonly id: "github-copilot";
    readonly defaultModel: "gpt-5.5";
    readonly envVars: readonly ["COPILOT_GITHUB_TOKEN"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<import("../index.js").Api, unknown>;
}, {
    readonly id: "gitlab-duo";
    readonly defaultModel: "duo-chat-opus-4-6";
    readonly envVars: readonly ["GITLAB_TOKEN"];
}, {
    readonly id: "gitlab-duo-agent";
    readonly defaultModel: "claude_sonnet_4_6_vertex";
    readonly envVars: readonly ["GITLAB_TOKEN"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"gitlab-duo-agent", unknown>;
    readonly dynamicModelsAuthoritative: true;
}, {
    readonly id: "gmi-cloud";
    readonly defaultModel: "deepseek-ai/DeepSeek-V4-Flash";
    readonly envVars: readonly ["GMI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "GMI Cloud";
    };
}, {
    readonly id: "google";
    readonly defaultModel: "gemini-3.1-pro-preview";
    readonly envVars: readonly ["GEMINI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"google-generative-ai", unknown>;
}, {
    readonly id: "google-antigravity";
    readonly defaultModel: "gemini-3.1-pro";
    readonly specialModelManager: true;
}, {
    readonly id: "google-gemini-cli";
    readonly defaultModel: "gemini-3.1-pro-preview";
    readonly specialModelManager: true;
}, {
    readonly id: "google-vertex";
    readonly defaultModel: "gemini-3.1-pro-preview";
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<import("../index.js").Api, unknown>;
    readonly allowUnauthenticated: true;
}, {
    readonly id: "groq";
    readonly defaultModel: "openai/gpt-oss-120b";
    readonly envVars: readonly ["GROQ_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
}, {
    readonly id: "huggingface";
    readonly defaultModel: "deepseek-ai/DeepSeek-R1";
    readonly envVars: readonly ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Hugging Face";
    };
}, {
    readonly id: "kilo";
    readonly defaultModel: "anthropic/claude-opus-4.8";
    readonly envVars: readonly ["KILO_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Kilo Gateway";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "kimi-code";
    readonly defaultModel: "kimi-for-coding";
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Kimi Code";
        readonly envVars: readonly ["KIMI_API_KEY"];
    };
}, {
    readonly id: "litellm";
    readonly defaultModel: "claude-opus-4-8";
    readonly envVars: readonly ["LITELLM_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<import("../index.js").Api, unknown>;
    readonly catalogDiscovery: {
        readonly label: "LiteLLM";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "lm-studio";
    readonly defaultModel: "llama-3-8b";
    readonly envVars: readonly ["LM_STUDIO_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly allowUnauthenticated: true;
}, {
    readonly id: "minimax";
    readonly defaultModel: "MiniMax-M3";
    readonly envVars: readonly ["MINIMAX_API_KEY"];
}, {
    readonly id: "minimax-code";
    readonly defaultModel: "MiniMax-M3";
    readonly envVars: readonly ["MINIMAX_CODE_API_KEY"];
}, {
    readonly id: "minimax-code-cn";
    readonly defaultModel: "MiniMax-M3";
    readonly envVars: readonly ["MINIMAX_CODE_CN_API_KEY"];
}, {
    readonly id: "mistral";
    readonly defaultModel: "devstral-medium-latest";
    readonly envVars: readonly ["MISTRAL_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
}, {
    readonly id: "meta";
    readonly defaultModel: "muse-spark-1.1";
    readonly envVars: readonly ["MODEL_API_KEY", "META_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Meta Model API";
    };
}, {
    readonly id: "moonshot";
    readonly defaultModel: "kimi-k2.7-code";
    readonly envVars: readonly ["MOONSHOT_API_KEY", "KIMI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Moonshot";
    };
}, {
    readonly id: "nanogpt";
    readonly defaultModel: "openai/gpt-5.5";
    readonly envVars: readonly ["NANO_GPT_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "NanoGPT";
    };
}, {
    readonly id: "nvidia";
    readonly defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct";
    readonly envVars: readonly ["NVIDIA_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "NVIDIA";
    };
}, {
    readonly id: "novita";
    readonly defaultModel: "moonshotai/kimi-k2.7-code";
    readonly envVars: readonly ["NOVITA_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Novita";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "ollama";
    readonly defaultModel: "gpt-oss:20b";
    readonly envVars: readonly ["OLLAMA_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
    readonly allowUnauthenticated: true;
}, {
    readonly id: "ollama-cloud";
    readonly defaultModel: "gpt-oss:120b";
    readonly envVars: readonly ["OLLAMA_CLOUD_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"ollama-chat", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Ollama Cloud";
        readonly oauthProvider: "ollama-cloud";
    };
}, {
    readonly id: "openai";
    readonly defaultModel: "gpt-5.5";
    readonly envVars: readonly ["OPENAI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
}, {
    readonly id: "openai-codex";
    readonly defaultModel: "gpt-5.5";
    readonly envVars: readonly ["OPENAI_CODEX_OAUTH_TOKEN"];
    readonly specialModelManager: true;
}, {
    readonly id: "opencode-go";
    readonly defaultModel: "kimi-k2.7-code";
    readonly envVars: readonly ["OPENCODE_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<import("../index.js").Api, unknown>;
    readonly dynamicModelsAuthoritative: true;
}, {
    readonly id: "opencode-zen";
    readonly defaultModel: "claude-opus-4-8";
    readonly envVars: readonly ["OPENCODE_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<import("../index.js").Api, unknown>;
    readonly dynamicModelsAuthoritative: true;
}, {
    readonly id: "openrouter";
    readonly defaultModel: "openai/gpt-5.5";
    readonly envVars: readonly ["OPENROUTER_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openrouter", unknown>;
    readonly catalogDiscovery: {
        readonly label: "OpenRouter";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "qianfan";
    readonly defaultModel: "deepseek-v3.2";
    readonly envVars: readonly ["QIANFAN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Qianfan";
    };
}, {
    readonly id: "qwen-portal";
    readonly defaultModel: "coder-model";
    readonly envVars: readonly ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Qwen Portal";
        readonly oauthProvider: "qwen-portal";
    };
}, {
    readonly id: "sakana";
    readonly defaultModel: "fugu";
    readonly envVars: readonly ["SAKANA_API_KEY", "FUGU_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Sakana AI";
    };
}, {
    readonly id: "siliconflow";
    readonly defaultModel: "zai-org/GLM-5.1";
    readonly envVars: readonly ["SILICONFLOW_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
}, {
    readonly id: "siliconflow-cn";
    readonly defaultModel: "deepseek-ai/DeepSeek-V4-Pro";
    readonly envVars: readonly ["SILICONFLOW_CN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
}, {
    readonly id: "synthetic";
    readonly defaultModel: "hf:zai-org/GLM-5.1";
    readonly envVars: readonly ["SYNTHETIC_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Synthetic";
    };
}, {
    readonly id: "together";
    readonly defaultModel: "moonshotai/Kimi-K2.7-Code";
    readonly envVars: readonly ["TOGETHER_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Together";
    };
}, {
    readonly id: "umans";
    readonly defaultModel: "umans-coder";
    readonly envVars: readonly ["UMANS_AI_CODING_PLAN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"anthropic-messages", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Umans AI Coding Plan";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "venice";
    readonly defaultModel: "llama-3.3-70b";
    readonly envVars: readonly ["VENICE_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Venice";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "vercel-ai-gateway";
    readonly defaultModel: "anthropic/claude-opus-4.8";
    readonly envVars: readonly ["AI_GATEWAY_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"anthropic-messages", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Vercel AI Gateway";
        readonly envVars: readonly ["VERCEL_AI_GATEWAY_API_KEY"];
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "vllm";
    readonly defaultModel: "gpt-oss-20b";
    readonly envVars: readonly ["VLLM_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "vLLM";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "wafer-serverless";
    readonly defaultModel: "GLM-5.1";
    readonly envVars: readonly ["WAFER_SERVERLESS_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Wafer Serverless";
        readonly oauthProvider: "wafer-serverless";
    };
}, {
    readonly id: "coreweave";
    readonly defaultModel: "openai/gpt-oss-120b";
    readonly envVars: readonly ["COREWEAVE_API_KEY", "WANDB_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "CoreWeave Serverless Inference";
    };
}, {
    readonly id: "xai";
    readonly defaultModel: "grok-4.6";
    readonly envVars: readonly ["XAI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
}, {
    readonly id: "xai-oauth";
    readonly defaultModel: "grok-4.6";
    readonly envVars: readonly ["XAI_OAUTH_TOKEN", "XAI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-responses", unknown>;
    readonly catalogDiscovery: {
        readonly label: "xAI Grok OAuth (SuperGrok)";
        readonly oauthProvider: "xai-oauth";
    };
}, {
    readonly id: "xiaomi";
    readonly defaultModel: "mimo-v2.5";
    readonly envVars: readonly ["XIAOMI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly catalogDiscovery: {
        readonly label: "Xiaomi";
    };
}, {
    readonly id: "xiaomi-token-plan-ams";
    readonly defaultModel: "mimo-v2.5";
    readonly envVars: readonly ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
}, {
    readonly id: "xiaomi-token-plan-cn";
    readonly defaultModel: "mimo-v2.5";
    readonly envVars: readonly ["XIAOMI_TOKEN_PLAN_CN_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
}, {
    readonly id: "xiaomi-token-plan-sgp";
    readonly defaultModel: "mimo-v2.5";
    readonly envVars: readonly ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
}, {
    readonly id: "zai";
    readonly defaultModel: "glm-5.3";
    readonly envVars: readonly ["ZAI_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"anthropic-messages", unknown>;
    readonly catalogDiscovery: {
        readonly label: "zAI";
    };
}, {
    readonly id: "zenmux";
    readonly defaultModel: "anthropic/claude-opus-4.8";
    readonly envVars: readonly ["ZENMUX_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<import("../index.js").Api, unknown>;
    readonly allowUnauthenticated: true;
    readonly catalogDiscovery: {
        readonly label: "ZenMux";
        readonly allowUnauthenticated: true;
    };
}, {
    readonly id: "zhipu-coding-plan";
    readonly defaultModel: "glm-5.1";
    readonly envVars: readonly ["ZHIPU_API_KEY"];
    readonly createModelManagerOptions: (config: ModelManagerConfig) => import("../index.js").ModelManagerOptions<"openai-completions", unknown>;
    readonly dynamicModelsAuthoritative: true;
    readonly catalogDiscovery: {
        readonly label: "Zhipu Coding Plan";
    };
}];
/** Chat-model providers — every entry in the catalog table. */
export type KnownProvider = (typeof CATALOG_PROVIDERS)[number]["id"];
export declare const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[];
/** Default model IDs for all known providers, derived from the catalog table. */
export declare const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string>;
export declare function getCatalogProviderEntry(id: string): ProviderCatalogEntry | undefined;
