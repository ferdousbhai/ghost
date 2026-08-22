/**
 * A fake `ModelCatalogRuntime`: an in-memory catalogue with a set of
 * credentialed providers, so the model switcher can be exercised over every
 * path (current-model resolution, available vs catalogue listing, provider/q
 * filters, the cap) without a real `ModelRuntime`, a provider, or a network
 * call.
 */
import type { CatalogModel, ModelCatalogRuntime } from "../../src/model-catalog.js";

export interface FakeCatalogModel extends CatalogModel {
  provider: string;
  id: string;
}

export interface FakeCatalogOptions {
  /** The full catalogue: every model pi would report from getModels(). */
  models: FakeCatalogModel[];
  /** Providers with a working credential; their models are "available". */
  credentialed?: string[];
  /** Credentialed providers signed in via OAuth (vs an api key). */
  oauth?: string[];
}

export function makeFakeCatalogRuntime(options: FakeCatalogOptions): ModelCatalogRuntime {
  const models = options.models;
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
