/**
 * Conversation titling, against fixtures — no real model.
 *
 * Which model writes a title is the smol lane's business (`smol.test.ts`);
 * these tests pin the title text cleanup and the one-completion generator that
 * rides on it.
 */
import { describe, expect, it } from "vitest";
import { SmolModelUnavailableError, type SmolModel, type SmolRuntime } from "../src/smol.js";
import { cleanTitle, generateTitle } from "../src/title.js";

const cost = (input: number) => ({ input, output: input * 4, cacheRead: 0, cacheWrite: 0 });

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
  const models: SmolModel[] = [{ provider: "local", id: "m", cost: cost(0) }];
  function fakeRuntime(response: {
    content?: Array<{ type: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  }): SmolRuntime {
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
    } as unknown as SmolRuntime;
  }

  it("returns a cleaned title from one completion", async () => {
    const runtime = fakeRuntime({ content: [{ type: "text", text: '"A tidy little title"' }] });
    expect(await generateTitle({ runtime, firstPrompt: "hello" })).toBe("A tidy little title");
  });

  it("throws on a provider error", async () => {
    const runtime = fakeRuntime({ stopReason: "error", errorMessage: "boom" });
    await expect(generateTitle({ runtime, firstPrompt: "hi" })).rejects
      .toBeInstanceOf(SmolModelUnavailableError);
  });

  it("throws on an empty response", async () => {
    const runtime = fakeRuntime({ content: [{ type: "text", text: "   " }] });
    await expect(generateTitle({ runtime, firstPrompt: "hi" })).rejects
      .toBeInstanceOf(SmolModelUnavailableError);
  });
});
