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
  rankSmolModels,
  resolveSmolModel,
  SMOL_MODEL_ROLE,
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

  it("follows the chat model's provider before anything cheaper elsewhere", () => {
    const catalog = catalogOf([
      { provider: "openrouter", id: "free-tiny", cost: cost(0), credentialed: true },
      { provider: "openai-codex", id: "gpt-5.6-sol", subscription: true },
      { provider: "openai-codex", id: "gpt-5.6-mini", subscription: true },
    ]);
    const resolved = resolveSmolModel(catalog, null, "smol_model", { chatProvider: "openai-codex" });
    expect(resolved).toMatchObject({ model: { provider: "openai-codex", id: "gpt-5.6-mini" }, via: "driver" });
    // Nothing usable from that provider: the global cheapest still answers.
    expect(resolveSmolModel(catalog, null, "smol_model", { chatProvider: "anthropic" }).model)
      .toMatchObject({ provider: "openrouter", id: "free-tiny" });
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

describe("routers are not models", () => {
  // An aggregator prices some of its routers at zero — openrouter/fusion costs
  // nothing to route and bills whatever it routed to — so cheapest-first walks
  // straight into one unless a role that wants a model is given only models.
  it("does not hand a chore role a zero-priced router", () => {
    const catalog = catalogOf([
      { provider: "openrouter", id: "openrouter/fusion", cost: cost(0) },
      { provider: "openrouter", id: "deepseek/deepseek-v4", cost: cost(5) },
    ]);
    const resolved = resolveSmolModel(catalog, null, SMOL_MODEL_ROLE, { chatProvider: "openrouter" });
    expect(resolved.model.id).toBe("deepseek/deepseek-v4");
  });

  // The cheapest-overall lane has the same hole.
  it("does not fall back onto a router either", () => {
    const catalog = catalogOf([
      { provider: "openrouter", id: "openrouter/auto", cost: cost(0) },
      { provider: "anthropic", id: "claude-haiku-4-5", cost: cost(1) },
    ]);
    expect(resolveSmolModel(catalog, null, SMOL_MODEL_ROLE).model.id).toBe("claude-haiku-4-5");
  });
});

describe("published price", () => {
  // pi prices openrouter/auto at -1000000, meaning "bills whatever it picked".
  // Read as a number it is the cheapest thing in the catalogue, so a cheapest-
  // first rule reaches for the one router guaranteed to charge. Neither id
  // carries a small-tier word, so price is what decides between them here.
  it("does not read a negative sentinel as the cheapest model", () => {
    const catalog = catalogOf([
      { provider: "openrouter", id: "openrouter/auto", cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 } },
      { provider: "openrouter", id: "deepseek/deepseek-v4", cost: cost(0) },
    ]);
    const resolved = resolveSmolModel(catalog, null, SMOL_MODEL_ROLE, { chatProvider: "openrouter" });
    expect(resolved.model.id).toBe("deepseek/deepseek-v4");
  });

  // Same through the cheapest-overall lane, where a metered catalogue makes
  // effectiveInputCost the ranking key rather than a tiebreak.
  it("sorts an unpriced sentinel last when ranking by cost", () => {
    const catalog = catalogOf([
      { provider: "a", id: "auto", cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 } },
      { provider: "b", id: "metered", cost: cost(5) },
    ]);
    expect(resolveSmolModel(catalog, null, SMOL_MODEL_ROLE).model.id).toBe("metered");
  });

  // Every sentinel reads as an unknown price, so a whole catalogue of them
  // ties on both cost keys. Comparing those by subtraction yields NaN, which
  // leaves the order up to the sort implementation; the label tiebreak has to
  // decide it instead, or the chosen model changes between restarts.
  it("orders a catalogue of unpriced models by label, not by chance", () => {
    const sentinel = { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 };
    const catalog = catalogOf([
      { provider: "z", id: "zeta", cost: sentinel },
      { provider: "a", id: "alpha", cost: sentinel },
      { provider: "m", id: "mid", cost: sentinel },
    ]);
    const ranked = rankSmolModels(catalog).map((candidate) => candidate.model.id);
    expect(ranked).toEqual(["alpha", "mid", "zeta"]);
  });
});

