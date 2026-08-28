import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { GhostExtensionFactory } from "@ghost/extensions";
import { adaptGhostExtensionForOmp, ghostToolContextFromOmp } from "../src/omp-extension-bridge.js";

interface Registered {
  name: string;
  parameters: { toJsonSchema(): unknown; safeParse(input: unknown): { success: boolean } };
  execute: (...args: unknown[]) => Promise<unknown>;
}

function fakeOmp() {
  const tools = new Map<string, Registered>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const api = {
    registerTool: (definition: Registered) => {
      tools.set(definition.name, definition);
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return { api, tools, handlers };
}

const ompContext = {
  cwd: "/ghosts/test",
  model: { provider: "openai", id: "gpt", input: ["text", "image"] },
} as unknown as ExtensionContext;

describe("adaptGhostExtensionForOmp", () => {
  it("registers Ghost tools with an OMP-validating schema and a projected context", async () => {
    const seen: unknown[] = [];
    const ghost: GhostExtensionFactory = (api) => {
      api.registerTool({
        name: "ghost_probe",
        label: "Probe",
        description: "probe",
        parameters: Type.Object({ count: Type.Integer({ minimum: 1 }) }),
        execute: async (_id, params, _signal, _onUpdate, ctx) => {
          seen.push({ params, ctx });
          return { content: [{ type: "text", text: `count ${params.count}` }], details: {} };
        },
      });
    };
    const omp = fakeOmp();
    await adaptGhostExtensionForOmp(ghost)(omp.api);

    const tool = omp.tools.get("ghost_probe");
    expect(tool).toBeDefined();
    expect(tool!.parameters.toJsonSchema()).toMatchObject({
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
    });
    expect(tool!.parameters.safeParse({ count: 0 }).success).toBe(false);
    expect(tool!.parameters.safeParse({ count: 2 }).success).toBe(true);

    const result = await tool!.execute("call-1", { count: 2 }, undefined, undefined, ompContext);
    expect(result).toEqual({ content: [{ type: "text", text: "count 2" }], details: {} });
    expect(seen).toEqual([{
      params: { count: 2 },
      ctx: { cwd: "/ghosts/test", model: { provider: "openai", id: "gpt", input: ["text", "image"] } },
    }]);
  });

  it("forwards before_agent_start and lets Ghost replace the whole prompt", async () => {
    const ghost: GhostExtensionFactory = (api) => {
      api.on("before_agent_start", (event, ctx) => ({
        systemPrompt: [`ghost:${ctx.cwd}`, ...event.systemPrompt],
      }));
    };
    const omp = fakeOmp();
    await adaptGhostExtensionForOmp(ghost)(omp.api);
    const [handler] = omp.handlers.get("before_agent_start") ?? [];
    expect(handler).toBeDefined();
    const replaced = await handler!(
      { type: "before_agent_start", prompt: "hi", systemPrompt: ["omp"], systemPromptOptions: {} },
      ompContext,
    );
    expect(replaced).toEqual({ systemPrompt: ["ghost:/ghosts/test", "omp"] });

    const silent = await adaptGhostExtensionForOmp((api) => {
      api.on("before_agent_start", () => undefined);
    });
    const quiet = fakeOmp();
    await silent(quiet.api);
    expect(await quiet.handlers.get("before_agent_start")![0]!(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "one", systemPromptOptions: {} },
      ompContext,
    )).toBeUndefined();
  });

  it("projects only cwd and the model identity from an OMP context", () => {
    expect(ghostToolContextFromOmp({ cwd: "/x", model: undefined } as ExtensionContext))
      .toEqual({ cwd: "/x", model: undefined });
  });
});
