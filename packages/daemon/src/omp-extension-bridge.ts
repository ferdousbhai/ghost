/**
 * Adapts a Ghost extension (the runtime-neutral seam in `@ghost/extensions`)
 * to OMP's `ExtensionFactory`, so the OMP-hosted session sees the same tools
 * and prompt hook the Claude Code bridge sees. This is the only place the
 * two extension surfaces meet; it disappears with the OMP runtime.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import type {
  GhostExtensionFactory,
  GhostToolContext,
  GhostToolResult,
} from "@ghost/extensions";

export function ghostToolContextFromOmp(ctx: ExtensionContext): GhostToolContext {
  const model = ctx.model;
  return {
    cwd: ctx.cwd,
    model: model === undefined
      ? undefined
      : { provider: model.provider, id: model.id, input: model.input },
  };
}

export function adaptGhostExtensionForOmp(
  factory: GhostExtensionFactory,
): ExtensionFactory {
  return (pi: ExtensionAPI) =>
    factory({
      registerTool(definition) {
        pi.registerTool({
          name: definition.name,
          label: definition.label,
          description: definition.description,
          // Ghost schemas are plain JSON Schema documents; OMP validates those
          // through its `Type.Unsafe` facade rather than its own builders.
          parameters: Type.Unsafe<Record<string, unknown>>(
            definition.parameters as Record<string, unknown>,
          ),
          execute: (toolCallId, params, signal, onUpdate, ctx) =>
            definition.execute(
              toolCallId,
              params as never,
              signal,
              onUpdate === undefined
                ? undefined
                : (partial: GhostToolResult<unknown>) => onUpdate(partial as never),
              ghostToolContextFromOmp(ctx),
            ) as Promise<never>,
        });
      },
      on(_event, handler) {
        pi.on("before_agent_start", async (event, ctx) => {
          const systemPrompt = Array.isArray(event.systemPrompt)
            ? event.systemPrompt
            : [event.systemPrompt];
          const result = await handler(
            { type: "before_agent_start", prompt: event.prompt, systemPrompt },
            ghostToolContextFromOmp(ctx),
          );
          return result?.systemPrompt === undefined
            ? undefined
            : { systemPrompt: result.systemPrompt };
        });
      },
    });
}
