/**
 * Title-model resolution and title generation, against fixtures — no real model.
 *
 * The resolution rules mirror the vision resolver's shape but add the one thing
 * a throwaway title cares about: a subscription (OAuth / included plan) model is
 * zero marginal cost, so it beats a cheaper metered model. These tests pin that
 * preference, the explicit-role and empty-catalogue error paths, and the title
 * text cleanup.
 */
import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  generateTitle,
  resolveTitleModel,
  TitleModelUnavailableError,
  titleCatalogFromRuntime,
  type TitleModel,
  type TitleModelCatalog,
  type TitleRuntime,
} from "../src/title.js";

interface FakeModel extends TitleModel {
  subscription?: boolean;
  credentialed?: boolean;
}

/** Build a catalog directly (no runtime) for the pure resolver tests. */
function catalogOf(models: FakeModel[]): TitleModelCatalog {
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

describe("resolveTitleModel", () => {
  it("prefers a subscription model over a cheaper metered one", () => {
    const catalog = catalogOf([
      { provider: "metered", id: "cheap", cost: cost(0.25), subscription: false },
      { provider: "plan", id: "included", cost: cost(3.0), subscription: true },
    ]);
    const resolved = resolveTitleModel(catalog);
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
    expect(resolveTitleModel(catalog).model.id).toBe("cheap");
  });

  it("honours an explicit roles.title_model binding", () => {
    const catalog = catalogOf([
      { provider: "metered", id: "cheap", cost: cost(0.25) },
      { provider: "pick", id: "me", cost: cost(9) },
    ]);
    const resolved = resolveTitleModel(catalog, { provider: "pick", modelId: "me" });
    expect(resolved).toMatchObject({ via: "role", model: { provider: "pick", id: "me" } });
  });

  it("errors when the explicit binding names an unknown model", () => {
    const catalog = catalogOf([{ provider: "a", id: "x", cost: cost(1) }]);
    expect(() => resolveTitleModel(catalog, { provider: "a", modelId: "missing" }))
      .toThrow(TitleModelUnavailableError);
  });

  it("errors when the explicit binding's provider has no credentials", () => {
    const catalog = catalogOf([
      { provider: "a", id: "x", cost: cost(1), credentialed: false },
    ]);
    try {
      resolveTitleModel(catalog, { provider: "a", modelId: "x" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TitleModelUnavailableError);
      expect((error as TitleModelUnavailableError).reason).toBe("no_credentials");
    }
  });

  it("errors loudly when there is genuinely no usable model", () => {
    const catalog = catalogOf([{ provider: "a", id: "x", cost: cost(1), credentialed: false }]);
    try {
      resolveTitleModel(catalog);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as TitleModelUnavailableError).reason).toBe("none_available");
    }
  });
});

describe("titleCatalogFromRuntime", () => {
  it("treats OAuth and subscription providers as zero marginal cost", () => {
    const models: TitleModel[] = [
      { provider: "metered", id: "cheap", cost: cost(0.25) },
      { provider: "oauthed", id: "big", cost: cost(8) },
    ];
    const runtime = {
      getModels: () => models,
      getModel: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      hasConfiguredAuth: () => true,
      isUsingSubscription: () => false,
      isUsingOAuth: (p: string) => p === "oauthed",
    } as unknown as TitleRuntime;
    // The OAuth provider is free, so it wins over the cheaper metered model.
    expect(resolveTitleModel(titleCatalogFromRuntime(runtime)).model.provider).toBe("oauthed");
  });
});

describe("cleanTitle", () => {
  it("strips surrounding quotes, a trailing period, and extra whitespace", () => {
    expect(cleanTitle('  "Fixing the platen roller."  ')).toBe("Fixing the platen roller");
    expect(cleanTitle("“Restoring a Vandercook”")).toBe("Restoring a Vandercook");
  });

  it("takes only the first non-empty line", () => {
    expect(cleanTitle("\n\nInk mixing basics\nand a second line")).toBe("Ink mixing basics");
  });

  it("clamps a run-on response to a bounded length", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const title = cleanTitle(long);
    expect(title.split(" ").length).toBeLessThanOrEqual(10);
  });

  it("returns empty for blank input", () => {
    expect(cleanTitle("   \n  ")).toBe("");
  });
});

describe("generateTitle", () => {
  const models: TitleModel[] = [{ provider: "local", id: "m", cost: cost(0) }];
  function fakeRuntime(response: {
    content?: Array<{ type: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  }): TitleRuntime {
    return {
      getModels: () => models,
      getModel: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      hasConfiguredAuth: () => true,
      isUsingSubscription: () => false,
      isUsingOAuth: () => false,
      complete: async () => ({
        role: "assistant",
        content: response.content ?? [{ type: "text", text: "" }],
        stopReason: response.stopReason ?? "stop",
        errorMessage: response.errorMessage,
      }),
    } as unknown as TitleRuntime;
  }

  it("returns a cleaned title from one completion", async () => {
    const runtime = fakeRuntime({ content: [{ type: "text", text: '"A tidy little title"' }] });
    expect(await generateTitle({ runtime, firstPrompt: "hello" })).toBe("A tidy little title");
  });

  it("throws on a provider error", async () => {
    const runtime = fakeRuntime({ stopReason: "error", errorMessage: "boom" });
    await expect(generateTitle({ runtime, firstPrompt: "hi" })).rejects
      .toBeInstanceOf(TitleModelUnavailableError);
  });

  it("throws on an empty response", async () => {
    const runtime = fakeRuntime({ content: [{ type: "text", text: "   " }] });
    await expect(generateTitle({ runtime, firstPrompt: "hi" })).rejects
      .toBeInstanceOf(TitleModelUnavailableError);
  });
});
