/**
 * Smol-model resolution, against fixtures — no real model.
 *
 * The resolution rules turn on the one thing a throwaway completion cares
 * about: a subscription (OAuth / included plan)
 * model is zero marginal cost, so it beats a cheaper metered model. These tests
 * pin that preference and the explicit-role and empty-catalogue error paths;
 * `title.test.ts` and `greeting.test.ts` cover what rides on the lane.
 */
import { describe, expect, it } from "vitest";
import {
  ADVISOR_MODEL_ROLE,
  resolveSmolModel,
  smolCatalogFromRuntime,
  SmolModelUnavailableError,
  type SmolModel,
  type SmolModelCatalog,
  type SmolRuntime,
} from "../src/smol.js";

interface FakeModel extends SmolModel {
  subscription?: boolean;
  credentialed?: boolean;
}

function catalogOf(models: FakeModel[]): SmolModelCatalog {
  const toCandidate = (model: FakeModel) => ({
    model: { provider: model.provider, id: model.id, name: model.name, cost: model.cost },
    subscription: model.subscription ?? false,
  });
  return {
    usable: () => models.filter((m) => m.credentialed !== false).map(toCandidate),
    find: (provider, id) => {
      const model = models.find((m) => m.provider === provider && m.id === id);
      return model ? toCandidate(model) : undefined;
    },
    hasCredentials: (candidate) =>
      models.find((m) => m.provider === candidate.model.provider)?.credentialed !== false,
  };
}

const cost = (input: number) => ({ input, output: input * 4, cacheRead: 0, cacheWrite: 0 });

describe("resolveSmolModel", () => {
  it("prefers a subscription model over a cheaper metered one", () => {
    const catalog = catalogOf([
      { provider: "metered", id: "cheap", cost: cost(0.25), subscription: false },
      { provider: "plan", id: "included", cost: cost(3.0), subscription: true },
    ]);
    const resolved = resolveSmolModel(catalog);
    // The metered model is cheaper on paper, but the subscription one is free.
    expect(resolved.model.provider).toBe("plan");
    expect(resolved.model.id).toBe("included");
    expect(resolved.via).toBe("cheapest");
  });

  it("picks the cheapest metered model when nothing is on a subscription", () => {
    const catalog = catalogOf([
      { provider: "a", id: "pricey", cost: cost(5) },
      { provider: "b", id: "cheap", cost: cost(0.5) },
      { provider: "c", id: "mid", cost: cost(2) },
    ]);
    expect(resolveSmolModel(catalog).model.id).toBe("cheap");
  });

  it("honours an explicit roles.smol_model binding", () => {
    const catalog = catalogOf([
      { provider: "metered", id: "cheap", cost: cost(0.25) },
      { provider: "pick", id: "me", cost: cost(9) },
    ]);
    const resolved = resolveSmolModel(catalog, { provider: "pick", modelId: "me" });
    expect(resolved).toMatchObject({ via: "role", model: { provider: "pick", id: "me" } });
  });

  it("errors when the explicit binding names an unknown model", () => {
    const catalog = catalogOf([{ provider: "a", id: "x", cost: cost(1) }]);
    expect(() => resolveSmolModel(catalog, { provider: "a", modelId: "missing" }))
      .toThrow(SmolModelUnavailableError);
  });

  it("errors when the explicit binding's provider has no credentials", () => {
    const catalog = catalogOf([
      { provider: "a", id: "x", cost: cost(1), credentialed: false },
    ]);
    try {
      resolveSmolModel(catalog, { provider: "a", modelId: "x" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmolModelUnavailableError);
      expect((error as SmolModelUnavailableError).reason).toBe("no_credentials");
      expect((error as SmolModelUnavailableError).code).toBe("smol_model_unavailable");
    }
  });

  it("errors loudly when there is genuinely no usable model", () => {
    const catalog = catalogOf([{ provider: "a", id: "x", cost: cost(1), credentialed: false }]);
    try {
      resolveSmolModel(catalog);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as SmolModelUnavailableError).reason).toBe("none_available");
    }
  });

  it("uses Ghost's advisor preference order for an unbound advisor role", () => {
    const catalog = catalogOf([
      { provider: "local", id: "cheap", cost: cost(0) },
      { provider: "anthropic", id: "claude-sonnet-4", cost: cost(5) },
      { provider: "openai", id: "gpt-5.4", cost: cost(8) },
    ]);
    const resolved = resolveSmolModel(catalog, null, ADVISOR_MODEL_ROLE);
    expect(resolved).toMatchObject({
      via: "preferred",
      model: { provider: "openai", id: "gpt-5.4" },
    });
  });

  it("does not silently use a cheap non-advisor model for an unbound advisor role", () => {
    const catalog = catalogOf([{ provider: "local", id: "cheap", cost: cost(0) }]);
    expect(() => resolveSmolModel(catalog, null, ADVISOR_MODEL_ROLE))
      .toThrow("no usable preferred advisor model");
  });
});

describe("smolCatalogFromRuntime", () => {
  it("treats OAuth and subscription providers as zero marginal cost", () => {
    const models: SmolModel[] = [
      { provider: "metered", id: "cheap", cost: cost(0.25) },
      { provider: "oauthed", id: "big", cost: cost(8) },
    ];
    const runtime = {
      getModels: () => models,
      getModel: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      hasConfiguredAuth: () => true,
      isUsingSubscription: () => false,
      isUsingOAuth: (p: string) => p === "oauthed",
    } as unknown as SmolRuntime;
    // The OAuth provider is free, so it wins over the cheaper metered model.
    expect(resolveSmolModel(smolCatalogFromRuntime(runtime)).model.provider).toBe("oauthed");
  });
});
