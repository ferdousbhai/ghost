/**
 * Adapts a collected Ghost extension (the runtime-neutral seam in
 * `@ghost/extensions`) to official pi's `ExtensionFactory`: tools pass through
 * unchanged (both sides speak TypeBox JSON Schema), and Ghost's
 * `before_agent_start` hooks replace pi's assembled system prompt with the
 * persona's sections.
 */
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
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

/** Retain runtime facts without restoring pi's coding-agent identity or prose. */
export function renderPiRuntimeGuidance(options: BuildSystemPromptOptions): string {
  const toolNames = options.selectedTools ?? [];
  const toolLines = toolNames.map((name) => {
    const snippet = options.toolSnippets?.[name]?.trim();
    return snippet ? `- ${name}: ${snippet}` : `- ${name}`;
  });
  return [
    "# Runtime",
    `Current working directory: ${options.cwd.replace(/\\/gu, "/")}`,
    "Active tools:",
    ...(toolLines.length > 0 ? toolLines : ["(none)"]),
  ].join("\n");
}

export function piExtensionFromGhost(
  extension: CollectedGhostExtension,
  options: {
    dynamicSections?: () => string[];
    includeRuntimeGuidance?: boolean;
  } = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of extension.tools.values()) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: (toolCallId, params, signal, onUpdate, ctx) =>
          tool.execute(toolCallId, params as never, signal, onUpdate, ghostToolContextFromPi(ctx)),
      });
    }
    if (
      extension.beforeAgentStart.length === 0
      && !options.dynamicSections
      && !options.includeRuntimeGuidance
    ) return;
    // Sections that change between turns follow the persona's re-render, so
    // one hook owns the whole prompt.
    pi.on("before_agent_start", async (event, ctx) => ({
      systemPrompt: [
        ...(await renderPersonaPrompt(extension, ghostToolContextFromPi(ctx), event.prompt, [event.systemPrompt])),
        ...(options.dynamicSections?.() ?? []),
        ...(options.includeRuntimeGuidance
          ? [renderPiRuntimeGuidance(event.systemPromptOptions)]
          : []),
      ].join("\n\n"),
    }));
  };
}
