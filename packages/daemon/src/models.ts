/**
 * Per-ghost model configuration.
 *
 * A ghost is model-agnostic across pi providers. The one explicit runtime
 * marker is `claude-code/default`, because an installed Claude Code process
 * has different auth/accounting semantics than pi's Anthropic provider.
 * Model/runtime choice lives in the ghost's own
 * `<home>/.pi/models.json` — pi's native format, read by pi's own
 * `ModelConfig.load()` — plus pi's credential store at
 * `<home>/.pi/auth.json`. The daemon's job is to point pi at those two files
 * and to resolve which model plays the chat role.
 *
 * ## The file
 *
 * ```jsonc
 * {
 *   "providers": {
 *     "<providerId>": { "name", "baseUrl", "api", "apiKey", "headers", "models": [...] }
 *   },
 *   // Ours, not pi's. pi's schema has no additionalProperties constraint, so
 *   // an unknown top-level key rides along untouched.
 *   "roles": { "chat_model": { "provider": "<providerId>", "modelId": "<id>" } }
 * }
 * ```
 *
 * A provider that pi already knows (`openrouter`, `openai-codex`,
 * `anthropic`, `openai`, `github-copilot`, `xai`, …) needs NO `providers`
 * entry at all — declare only the `roles` binding and log in. An
 * OpenAI-compatible endpoint pi does not know (Ollama, vLLM, llama.cpp, a
 * relay speaking `pi-messages`) is declared in full under `providers`.
 *
 * ## Credentials
 *
 * Never from the environment — see env-scrub.ts. Two supported sources, both
 * per-ghost:
 *
 * 1. `apiKey` in `models.json` (device-local; fine for keyless local servers
 *    and for a key the user pastes into their own ghost).
 * 2. `auth.json`, pi's credential store, which holds OAuth credentials as
 *    well as API keys. Verified present in pi-ai 0.84.2: `openai-codex`
 *    ("OpenAI (ChatGPT Plus/Pro)", `isSubscription: true`), `anthropic`,
 *    `openrouter` ("Sign in with OpenRouter"),
 *    `github-copilot`, `xai`, `kimi-coding`, `radius`. The daemon does not
 *    implement an OAuth flow of its own — see README "Using an existing
 *    subscription" for the wrap that reuses pi's.
 *
 * `claude-code/default` uses neither source: the official Agent SDK invokes
 * the installed `claude`, and that unmodified executable reads the creator's
 * own external Claude Code login. The pinned pi docs explicitly say its
 * `anthropic` OAuth uses per-token extra usage rather than included plan
 * limits; the two selections must not be conflated.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One model entry, a subset of pi's `ModelsJsonModel`. */
export interface GhostModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  [key: string]: unknown;
}

/** One provider entry, a subset of pi's `ModelsJsonProvider`. */
export interface GhostProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  /** Device-local secret. Absent for keyless local servers and for OAuth. */
  apiKey?: string;
  headers?: Record<string, string>;
  models?: GhostModelDefinition[];
  [key: string]: unknown;
}

export interface GhostModelRoleBinding {
  provider: string;
  modelId: string;
}

/**
 * The inference roles a ghost binds. Only `chat_model` is load-bearing for a
 * chat turn; the rest exist so a role added later does not need a file
 * migration. `vision_model` is the first to take that promise up — a plain
 * addition to this union, and every existing `models.json` keeps working,
 * because `roles` is optional, each role within it is optional, and pi's own
 * schema has no `additionalProperties` constraint to trip over.
 *
 * - `chat_model` — answers the turn.
 * - `vision_model` — reads images when `chat_model` cannot; must be a model
 *   whose `input` includes `"image"`. Unbound, `@ghost/extensions` falls back
 *   to the cheapest credentialed vision-capable model in the ghost's own
 *   catalogue, ranked by `cost.input`. With none available it raises a loud,
 *   actionable error rather than letting the image be dropped in silence.
 * - `general_purpose_model`, `research_model` — reserved.
 */
export type GhostModelRole =
  | "chat_model"
  | "vision_model"
  | "general_purpose_model"
  | "research_model";

export interface GhostModelsFile {
  providers: Record<string, GhostProviderConfig>;
  roles?: Partial<Record<GhostModelRole, GhostModelRoleBinding>>;
}

export const MODELS_FILENAME = "models.json";
export const AUTH_FILENAME = "auth.json";

export function ghostModelsPath(agentDir: string): string {
  return join(agentDir, MODELS_FILENAME);
}

export function ghostAuthPath(agentDir: string): string {
  return join(agentDir, AUTH_FILENAME);
}

/** Read `<agentDir>/models.json`, or null when absent. Throws on malformed. */
export function readGhostModels(agentDir: string): GhostModelsFile | null {
  const path = ghostModelsPath(agentDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const file = parsed as { providers?: unknown; roles?: unknown };
  if (file.providers !== undefined
    && (file.providers === null || typeof file.providers !== "object" || Array.isArray(file.providers))) {
    throw new Error(`${path}: "providers" must be an object.`);
  }
  return {
    providers: (file.providers as Record<string, GhostProviderConfig>) ?? {},
    roles: file.roles as GhostModelsFile["roles"],
  };
}

export function writeGhostModels(agentDir: string, file: GhostModelsFile): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(ghostModelsPath(agentDir), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/**
 * Which model answers a chat turn.
 *
 * `roles.chat_model` wins. Otherwise the first declared model of the first
 * declared provider, so a hand-written `models.json` with one provider needs
 * no roles block. Null means "let pi decide" — its settings, then its first
 * available model.
 */
export function resolveChatModelRef(
  file: GhostModelsFile | null,
): GhostModelRoleBinding | null {
  if (!file) return null;
  const bound = file.roles?.chat_model;
  if (bound?.provider && bound.modelId) return bound;
  for (const [provider, config] of Object.entries(file.providers)) {
    const first = config.models?.[0];
    if (first?.id) return { provider, modelId: first.id };
  }
  return null;
}

/**
 * Set `roles.chat_model` to a specific (provider, modelId), the writer behind
 * the model switcher. Reuses `readGhostModels`/`writeGhostModels`, preserves
 * every other key (providers, other roles) untouched, and creates the file
 * when the ghost has none yet. Unlike `bindDefaultChatModelIfUnset` in auth.ts,
 * this always overwrites the binding — it is the explicit "switch to this
 * model" action, not a first-run default.
 */
export function setChatModelRole(
  agentDir: string,
  provider: string,
  modelId: string,
): GhostModelsFile {
  const file: GhostModelsFile = readGhostModels(agentDir) ?? { providers: {} };
  file.roles = { ...(file.roles ?? {}), chat_model: { provider, modelId } };
  writeGhostModels(agentDir, file);
  return file;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * OpenRouter's free roster rotates; this is a **changeable default**, not a
 * hardcode — nothing in the daemon branches on it, it only seeds a config
 * file the user can edit. Check the current free roster with:
 *
 *   curl -s https://openrouter.ai/api/v1/models | jq -r '
 *     .data[] | select(.pricing.prompt=="0") | .id'
 *
 * or https://openrouter.ai/models?max_price=0 .
 */
export const OPENROUTER_DEFAULT_FREE_MODEL = "deepseek/deepseek-r1:free";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterPresetOptions {
  /** Device-local OpenRouter key. Omit when signing in via OAuth instead. */
  apiKey?: string;
  /** Model id to bind to the chat role. Defaults to the free model above. */
  modelId?: string;
  /** Display name for the model in pi's picker. */
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * OpenRouter as a fully declared provider.
 *
 * pi has a built-in `openrouter` provider whose catalog is fetched over the
 * network; declaring the model statically here means the ghost works with
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
        contextWindow: options.contextWindow ?? 128_000,
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
  /** Provider id, also the key in `providers`. */
  providerId: string;
  baseUrl: string;
  modelId: string;
  name?: string;
  /** pi stream api. Defaults to `openai-completions`. `pi-messages` works too. */
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
 * Bind a model served by a provider pi already knows, authenticated from
 * `auth.json` — an API key or, for the providers that support it, a
 * subscription OAuth credential (`openai-codex`, `anthropic`, `openrouter`,
 * `github-copilot`, `xai`, `kimi-coding`, `radius`). No `providers` entry is
 * emitted: pi supplies the endpoint and the catalog.
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
