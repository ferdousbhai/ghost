/**
 * Local OpenAI-compatible model endpoints, detected instead of configured.
 *
 * A runner the owner already started on a well-known loopback port is a fact
 * about the machine, not a setting: `models.json` never records one. Each
 * responding endpoint becomes a zero-cost provider built exactly the way
 * {@link openAiCompatiblePreset} builds one, merged into the provider set the
 * hosting runtime reads (`model-config-view.ts`), so pi reaches a detected
 * endpoint through the same path as a configured one.
 *
 * Nothing here is fatal or noisy: a refused connection, a timeout, a non-JSON
 * body, or an endpoint listing no models all mean "not there".
 */
import {
  openAiCompatiblePreset,
  resolveChatModelRef,
  type GhostModelDefinition,
  type GhostModelRoleBinding,
  type GhostModelsFile,
  type GhostProviderConfig,
} from "./models.js";

export interface LocalRunner {
  /** The provider id a detected endpoint is published under. */
  provider: string;
  /** How the runner names itself, for the provider's display name. */
  label: string;
  port: number;
}

/**
 * The runners worth probing, in the order a detected one is preferred as the
 * default driver.
 */
export const LOCAL_RUNNERS: readonly LocalRunner[] = [
  { provider: "local-ollama", label: "Ollama", port: 11434 },
  { provider: "local-lm-studio", label: "LM Studio", port: 1234 },
  { provider: "local-llama-cpp", label: "llama.cpp", port: 8080 },
  { provider: "local-vllm", label: "vLLM", port: 8000 },
];

/**
 * pi calls a provider usable only once a key is configured — its provider
 * config has no keyless mode — and local runners ignore the Authorization
 * header entirely. This placeholder buys that availability; it is not a
 * credential and never reaches `models.json`.
 */
const LOCAL_PLACEHOLDER_API_KEY = "local";

/** Long enough for a loopback answer, short enough that four misses are free. */
const PROBE_TIMEOUT_MS = 300;

export interface DetectedLocalProvider {
  provider: string;
  config: GhostProviderConfig;
}

export interface DetectLocalModelsOptions {
  /** Offline skips probing entirely. */
  offline?: boolean;
  /** Test seam: the ports to probe. */
  runners?: readonly LocalRunner[];
  timeoutMs?: number;
}

/** Every local endpoint answering now, in {@link LOCAL_RUNNERS} order. */
export async function detectLocalModelProviders(
  options: DetectLocalModelsOptions = {},
): Promise<DetectedLocalProvider[]> {
  if (options.offline) return [];
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probed = await Promise.all(
    (options.runners ?? LOCAL_RUNNERS).map((runner) => probeRunner(runner, timeoutMs)),
  );
  return probed.filter((provider): provider is DetectedLocalProvider => provider !== null);
}

async function probeRunner(
  runner: LocalRunner,
  timeoutMs: number,
): Promise<DetectedLocalProvider | null> {
  const baseUrl = `http://127.0.0.1:${runner.port}/v1`;
  let body: unknown;
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    return null;
  }
  const models = listedModels(runner.provider, baseUrl, body);
  if (models.length === 0) return null;
  return {
    provider: runner.provider,
    config: {
      name: `${runner.label} (local)`,
      baseUrl,
      api: "openai-completions",
      apiKey: LOCAL_PLACEHOLDER_API_KEY,
      models,
    },
  };
}

/** Every model id an OpenAI-compatible `/v1/models` body lists, deduplicated. */
function listedModels(
  providerId: string,
  baseUrl: string,
  body: unknown,
): GhostModelDefinition[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: GhostModelDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = reportedContextWindow(entry);
    const preset = openAiCompatiblePreset({
      providerId,
      baseUrl,
      modelId: id,
      ...(contextWindow === null ? {} : { contextWindow }),
    });
    const model = preset.providers[providerId]?.models?.[0];
    if (model) models.push(model);
  }
  return models;
}

/**
 * The context length the endpoint reports, under the key its runner uses;
 * null leaves the preset default in place.
 */
function reportedContextWindow(entry: unknown): number | null {
  const record = entry as Record<string, unknown> | null;
  const meta = record?.meta as Record<string, unknown> | undefined;
  for (const value of [
    record?.context_length,
    record?.max_context_length,
    record?.max_model_len,
    meta?.n_ctx_train,
  ]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return null;
}

/**
 * The ghost's own providers plus the detected ones. A provider the ghost
 * configured under a detected id wins: configuration outranks detection.
 */
export function withLocalProviders(
  file: GhostModelsFile,
  detected: readonly DetectedLocalProvider[],
): GhostModelsFile {
  if (detected.length === 0) return file;
  const providers = { ...file.providers };
  for (const { provider, config } of detected) {
    if (!providers[provider]) providers[provider] = config;
  }
  return { ...file, providers };
}

/** The first model of the first detected endpoint, or null when none answered. */
function localChatModelRef(
  detected: readonly DetectedLocalProvider[],
): GhostModelRoleBinding | null {
  for (const { provider, config } of detected) {
    const first = config.models?.[0];
    if (first?.id) return { provider, modelId: first.id };
  }
  return null;
}

export interface ChatModelChoice {
  /** Null hands the choice to pi's catalogue default. */
  ref: GhostModelRoleBinding | null;
  /** Set only when the ref came from detection rather than the ghost's own file. */
  origin?: "local";
}

/**
 * Which model drives a turn: the ghost's own binding when it has one, else a
 * detected local endpoint, else pi's catalogue default. The one place this
 * precedence is written down.
 */
export function chatModelChoice(
  file: GhostModelsFile | null,
  detected: readonly DetectedLocalProvider[],
): ChatModelChoice {
  const configured = resolveChatModelRef(file);
  if (configured) return { ref: configured };
  const local = localChatModelRef(detected);
  return local ? { ref: local, origin: "local" } : { ref: null };
}
