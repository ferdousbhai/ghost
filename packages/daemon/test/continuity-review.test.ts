import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContinuityReview,
  parseContinuityAdvice,
  parseContinuityClassification,
} from "../src/continuity-review.js";
import { GhostHookRunner, type GhostSessionStopEvent } from "../src/hooks.js";
import {
  openAiCompatiblePreset,
  writeGhostModels,
} from "../src/models.js";
import type { GhostOmpRuntime } from "../src/omp-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(cwd = process.cwd()): GhostSessionStopEvent {
  return {
    type: "session_stop",
    owner_prompt: "Implement the requested hook and test it.",
    messages: [{ role: "assistant", content: [{ type: "text", text: "I added the hook." }] }],
    last_assistant_message: {
      role: "assistant",
      content: [{ type: "text", text: "I added the hook." }],
    },
    turn_id: 4,
    session_id: "session-a",
    stop_hook_active: false,
    signal: new AbortController().signal,
    ghost_name: "casper",
    cwd,
    runtime: "omp",
  };
}

function assistant(model: string, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

describe("ContinuityReview", () => {
  it("uses the configured smol model as classifier and advisor role as reviewer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ghost-continuity-"));
    roots.push(cwd);
    const modelsFile = openAiCompatiblePreset({
      providerId: "fixture",
      baseUrl: "https://example.invalid/v1",
      modelId: "fast",
    });
    const provider = modelsFile.providers.fixture!;
    const configuredModels = provider.models!;
    configuredModels.push({
      ...configuredModels[0]!,
      id: "careful",
      name: "Careful",
    });
    modelsFile.roles = {
      ...modelsFile.roles,
      smol_model: { provider: "fixture", modelId: "fast" },
      advisor_model: { provider: "fixture", modelId: "careful" },
    };
    writeGhostModels(cwd, modelsFile);
    const models = [
      { provider: "fixture", id: "fast", cost: { input: 1, output: 1 } },
      { provider: "fixture", id: "careful", cost: { input: 2, output: 2 } },
    ] as Model<never>[];
    const calls: Array<{ model: string; options: Record<string, unknown> }> = [];
    const runtime = {
      getModels: () => models,
      getModel: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAvailable: async () => models,
      hasConfiguredAuth: () => true,
      isUsingSubscription: () => false,
      isUsingOAuth: () => false,
      complete: async (model: Model<never>, _context: unknown, options: Record<string, unknown>) => {
        calls.push({ model: model.id, options });
        return model.id === "fast"
          ? assistant(model.id, '{"review":true,"reason":"Tests were not reported."}')
          : assistant(model.id, '{"continue":true,"instruction":"Run and report the tests."}');
      },
    } as unknown as GhostOmpRuntime;
    const runner = new GhostHookRunner();
    const review = new ContinuityReview({
      withRuntime: async (_ghostName, use) => use(runtime),
    });
    await runner.register(review.hookFactory);

    const result = await runner.emitSessionStop(event(cwd));
    expect(result?.additionalContext).toContain("Run and report the tests.");
    expect(calls.map((call) => call.model)).toEqual(["fast", "careful"]);
    expect(calls[0]?.options.disableReasoning).toBe(true);
  });

  it("never calls the advisor more than six times for one owner turn", async () => {
    const classify = vi.fn(async () => ({ review: true, reason: "Possibly incomplete." }));
    const advise = vi.fn(async () => ({ continue: true, instruction: "Finish it." }));
    const runner = new GhostHookRunner();
    const review = new ContinuityReview({
      withRuntime: async (_ghostName, use) => use({} as GhostOmpRuntime),
      classify,
      advise,
    });
    await runner.register(review.hookFactory);

    const results = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(await runner.emitSessionStop(event()));
    }
    expect(advise).toHaveBeenCalledTimes(6);
    expect(classify).toHaveBeenCalledTimes(6);
    expect(results.slice(0, 6).every((result) => result?.continue === true)).toBe(true);
    expect(results.slice(6).every((result) => result === undefined)).toBe(true);
  });

  it("accepts classifier and advisor JSON with or without code fences", () => {
    expect(parseContinuityClassification("```json\n{\"review\":false,\"reason\":\"Complete.\"}\n```"))
      .toEqual({ review: false, reason: "Complete." });
    expect(parseContinuityAdvice('{"continue":true,"instruction":"Add the missing test."}'))
      .toEqual({ continue: true, instruction: "Add the missing test." });
    expect(parseContinuityAdvice('{"continue":true,"instruction":""}')).toBeNull();
  });
});
