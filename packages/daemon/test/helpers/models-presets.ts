/**
 * `models.json` shapes used only by tests.
 *
 * These build a provider file for a fixture ghost; nothing in the daemon calls
 * them. Production writes models.json through `mutateGhostModels` and binds a
 * chat model through `bindDefaultChatModelIfUnset`, which reads pi's live
 * availability rather than any preset. They lived in `src/models.ts` and read
 * as production capability, including a hand-verified OpenRouter default that
 * no code path ever consumed.
 */
import type { GhostModelsFile, GhostProviderConfig } from "../../src/models.js";



/**
 * OpenRouter's free roster rotates, and entries leave it: the previous default
 * here, `deepseek/deepseek-r1:free`, had been delisted entirely. This is a
 * **changeable default**, not a hardcode — nothing in the daemon branches on
 * it, it only seeds a config file the owner can edit or replace with
 * `ghost model <provider>/<id>`. Re-check it whenever the seeded ghost fails
 * its first turn, and pick a current entry that still advertises tool calling:
 *
 *   curl -s https://openrouter.ai/api/v1/models | jq -r '
 *     .data[] | select(.pricing.prompt=="0" and .pricing.completion=="0")
 *     | select(.supported_parameters | index("tools"))
 *     | "\(.id)\t\(.context_length)"'
 *
 * or https://openrouter.ai/models?max_price=0 . Last verified 2026-09-15.
 */
export const OPENROUTER_DEFAULT_FREE_MODEL = "thinkingmachines/inkling:free";

const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterPresetOptions {
  apiKey?: string;
  modelId?: string;
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * OpenRouter as a fully declared provider.
 *
 * pi's built-in `openrouter` provider fetches its catalog over the network;
 * declaring the model statically here means the ghost works with
 * `offline: true` and on first run, before any catalog has been cached.
 * Cost is zeroed because the intended entry point is a `:free` model —
 * "try the ghost for nothing" needs only an OpenRouter account.
 */
export function openRouterPreset(
  options: OpenRouterPresetOptions = {},
): GhostModelsFile {
  const modelId = options.modelId ?? OPENROUTER_DEFAULT_FREE_MODEL;
  const provider: GhostProviderConfig = {
    name: "OpenRouter",
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: options.modelName ?? modelId,
        input: ["text"],
        contextWindow: options.contextWindow ?? 262_144,
        maxTokens: options.maxTokens ?? 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  if (options.apiKey) provider.apiKey = options.apiKey;
  return {
    providers: { [OPENROUTER_PROVIDER_ID]: provider },
    roles: { chat_model: { provider: OPENROUTER_PROVIDER_ID, modelId } },
  };
}

export interface OpenAiCompatiblePresetOptions {
  providerId: string;
  baseUrl: string;
  modelId: string;
  name?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Any OpenAI-compatible endpoint: Ollama, vLLM, llama.cpp, LM Studio, a
 * self-hosted gateway, or a relay speaking `pi-messages`. This is the
 * provider-agnostic path, and the one every other preset is a convenience
 * over.
 */
export function openAiCompatiblePreset(
  options: OpenAiCompatiblePresetOptions,
): GhostModelsFile {
  const provider: GhostProviderConfig = {
    name: options.name ?? options.providerId,
    baseUrl: options.baseUrl,
    api: options.api ?? "openai-completions",
    models: [
      {
        id: options.modelId,
        name: options.modelId,
        input: ["text"],
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: options.maxTokens ?? 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  if (options.apiKey) provider.apiKey = options.apiKey;
  if (options.headers) provider.headers = options.headers;
  return {
    providers: { [options.providerId]: provider },
    roles: { chat_model: { provider: options.providerId, modelId: options.modelId } },
  };
}

/**
 * Bind a model served by a provider pi already knows, authenticated from pi's
 * own credential store. No `providers` entry is emitted: pi supplies the
 * endpoint and catalogue.
 */
export function builtinProviderPreset(
  providerId: string,
  modelId: string,
): GhostModelsFile {
  return {
    providers: {},
    roles: { chat_model: { provider: providerId, modelId } },
  };
}
