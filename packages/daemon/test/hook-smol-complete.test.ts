import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SmolModel } from "../src/smol.js";
import {
  completeHookSmol,
  type HookSmolRuntime,
} from "../src/hook-smol-complete.js";
import { makeTempGhosts } from "./helpers/fixtures.js";

const cost = (input: number) => ({ input, output: input * 4, cacheRead: 0, cacheWrite: 0 });

describe("completeHookSmol", () => {
  it("uses the ghost's explicit smol role without setting reasoning effort", async () => {
    const temp = makeTempGhosts();
    try {
      const home = join(temp.root, "casper");
      mkdirSync(join(home, ".pi"), { recursive: true });
      writeFileSync(join(home, "character.md"), "# Casper\n", "utf8");
      writeFileSync(
        join(home, "models.json"),
        JSON.stringify({
          providers: {},
          roles: { smol_model: { provider: "local", modelId: "smol" } },
        }),
        "utf8",
      );

      const models: SmolModel[] = [
        { provider: "local", id: "chat", cost: cost(0) },
        { provider: "local", id: "smol", cost: cost(1) },
      ];
      let selectedModel = "";
      let completionOptions: unknown;
      let closed = false;
      const runtime: HookSmolRuntime = {
        getModels: () => models as never,
        getModel: (provider, id) => models.find((model) =>
          model.provider === provider && model.id === id) as never,
        hasConfiguredAuth: () => true,
        isUsingSubscription: () => false,
        isUsingOAuth: () => false,
        complete: async (model, context, options) => {
          selectedModel = `${model.provider}/${model.id}`;
          completionOptions = options;
          expect(context.messages[0]).toMatchObject({
            role: "user",
            content: "classify this turn",
          });
          return {
            role: "assistant",
            content: [{ type: "text", text: '{"state":"CONTINUE"}' }],
            stopReason: "stop",
          } as never;
        },
        close: () => {
          closed = true;
        },
      };

      await expect(completeHookSmol(
        { ghost_home: home, prompt: "classify this turn" },
        { runtimeFactory: async () => runtime },
      )).resolves.toBe('{"state":"CONTINUE"}');
      expect(selectedModel).toBe("local/smol");
      expect(completionOptions).toEqual({});
      expect(closed).toBe(true);
    } finally {
      temp.cleanup();
    }
  });
});
