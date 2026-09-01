/**
 * Adapts a collected Ghost extension (the runtime-neutral seam in
 * `@ghost/extensions`) to official pi's `ExtensionFactory`: tools pass through
 * unchanged (both sides speak TypeBox JSON Schema), and Ghost's
 * `before_agent_start` hooks replace pi's assembled system prompt with the
 * persona's sections.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CollectedGhostExtension, GhostToolContext } from "@ghost/extensions";

export function ghostToolContextFromPi(ctx: ExtensionContext): GhostToolContext {
  const model = ctx.model;
  return {
    cwd: ctx.cwd,
    model: model === undefined
      ? undefined
      : { provider: model.provider, id: model.id, input: model.input },
  };
}

/** Fold the persona hooks over pi's prompt sections; the last hook's answer wins. */
export async function renderPersonaPrompt(
  extension: CollectedGhostExtension,
  context: GhostToolContext,
  prompt = "",
  systemPrompt: string[] = [],
): Promise<string[]> {
  let sections = systemPrompt;
  for (const hook of extension.beforeAgentStart) {
    const result = await hook({ type: "before_agent_start", prompt, systemPrompt: sections }, context);
    if (result?.systemPrompt) sections = result.systemPrompt;
  }
  return sections;
}

export function piExtensionFromGhost(
  extension: CollectedGhostExtension,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of extension.tools.values()) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: (toolCallId, params, signal, _onUpdate, ctx) =>
          tool.execute(toolCallId, params as never, signal, ghostToolContextFromPi(ctx)),
      });
    }
    if (extension.beforeAgentStart.length === 0) return;
    pi.on("before_agent_start", async (event, ctx) => ({
      systemPrompt: (await renderPersonaPrompt(
        extension,
        ghostToolContextFromPi(ctx),
        event.prompt,
        [event.systemPrompt],
      )).join("\n\n"),
    }));
  };
}
