/**
 * A scripted stand-in for the daemon's tool registry: tests call registered
 * tools directly. No harness is spawned; what needs testing here is our
 * logic, deterministically.
 */
import type {
  AnyGhostToolDefinition,
  GhostExtensionAPI,
  GhostExtensionFactory,
  GhostToolContext,
  GhostToolResult,
} from "../../src/extension-api.js";

type AnyTool = AnyGhostToolDefinition;

export interface Harness {
  readonly tools: Map<string, AnyTool>;
  toolNames(): string[];
  call(
    name: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GhostToolResult<any>>;
}

function fakeContext(cwd: string): GhostToolContext {
  // Only `cwd` is read by these extensions.
  return { cwd };
}

export async function loadExtension(
  factory: GhostExtensionFactory,
  cwd: string,
): Promise<Harness> {
  const tools = new Map<string, AnyTool>();
  const ctx = fakeContext(cwd);

  const api = {
    registerTool(tool: AnyTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as GhostExtensionAPI;

  await factory(api);

  return {
    tools,
    toolNames: () => [...tools.keys()],
    async call(name, params = {}, signal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} is not registered`);
      return tool.execute(`call-${name}`, params, signal, ctx);
    },
  };
}

export function resultText(result: GhostToolResult<any>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
