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
// The `legacy-typebox` facade is deliberate: its `Type.Unsafe` validates a
// raw JSON Schema document through OMP's authoritative validator and emits it
// verbatim, where OMP's `fromJsonSchema` lowers keywords lossily.
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import type {
  AnyGhostToolDefinition,
  GhostExtensionFactory,
  GhostToolContext,
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
        const tool = definition as AnyGhostToolDefinition;
        pi.registerTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters as Record<string, unknown>),
          execute: (toolCallId, params, signal, onUpdate, ctx) =>
            tool.execute(toolCallId, params as never, signal, onUpdate, ghostToolContextFromOmp(ctx)),
        });
      },
      on(_event, handler) {
        pi.on("before_agent_start", (event, ctx) => handler(
          { type: "before_agent_start", prompt: event.prompt, systemPrompt: event.systemPrompt },
          ghostToolContextFromOmp(ctx),
        ));
      },
    });
}
