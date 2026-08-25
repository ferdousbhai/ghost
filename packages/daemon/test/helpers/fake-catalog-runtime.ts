/**
 * A fake `ModelCatalogRuntime`: an in-memory catalogue with a set of
 * credentialed providers, so the model switcher can be exercised over every
 * path (current-model resolution, available vs catalogue listing, provider/q
 * filters, the cap) without a real OMP registry, a provider, or a network
 * call.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { CatalogModel, ModelCatalogRuntime } from "../../src/model-catalog.js";

export interface FakeCatalogModel extends CatalogModel {
  provider: string;
  id: string;
}

export interface FakeCatalogOptions {
  /** The full catalogue: every model OMP would report from getModels(). */
  models: FakeCatalogModel[];
  /** Providers with a working credential; their models are "available". */
  credentialed?: string[];
  /** Credentialed providers signed in via OAuth (vs an api key). */
  oauth?: string[];
}

/** Materialize a complete OMP model while keeping catalogue fixtures concise. */
export function fakeOmpModel(model: FakeCatalogModel): Model<Api> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "google-generative-ai",
    provider: model.provider,
    baseUrl: "https://models.invalid",
    reasoning: false,
    input: [...(model.input ?? ["text"])],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? null,
    maxTokens: null,
    ...(model.priority === undefined ? {} : { priority: model.priority }),
    compat: undefined,
  };
}

export function makeFakeCatalogRuntime(options: FakeCatalogOptions): ModelCatalogRuntime {
  const models = options.models.map(fakeOmpModel);
  const credentialed = new Set(options.credentialed ?? []);
  const oauth = new Set(options.oauth ?? []);
  const scoped = (providerId?: string) =>
    providerId ? models.filter((m) => m.provider === providerId) : models;
  return {
    getModels(providerId) {
      return scoped(providerId);
    },
    getModel(providerId, modelId) {
      return models.find((m) => m.provider === providerId && m.id === modelId);
    },
    async getAvailable(providerId) {
      return scoped(providerId).filter((m) => credentialed.has(m.provider));
    },
    getProviderAuthStatus(providerId) {
      return { configured: credentialed.has(providerId) };
    },
    isUsingOAuth(providerId) {
      return oauth.has(providerId);
    },
    close() {},
  };
}

/** A small, realistic catalogue: two providers, one credentialed. */
export function sampleCatalog(): FakeCatalogModel[] {
  return [
    {
      provider: "openai-codex",
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      input: ["text", "image"],
      contextWindow: 400_000,
      cost: { input: 1.25, output: 10, cacheRead: 0.13, cacheWrite: 0 },
    },
    {
      provider: "openai-codex",
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      input: ["text"],
      contextWindow: 200_000,
      cost: { input: 0.25, output: 2, cacheRead: 0.03, cacheWrite: 0 },
    },
    {
      provider: "anthropic",
      id: "claude-opus-4",
      name: "Claude Opus 4",
      input: ["text", "image"],
      contextWindow: 200_000,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
  ];
}
