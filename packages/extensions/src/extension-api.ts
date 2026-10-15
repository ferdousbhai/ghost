/**
 * The Ghost extension seam.
 *
 * Ghost's built-in tools are written against this surface and nothing else:
 * tool registration. The daemon serves the collected tools to a conversation's
 * harness over MCP (`ghost mcp serve`); the extensions import no harness.
 *
 * Parameter schemas are JSON Schema documents passed through from the MCP server.
 */

export type GhostToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** The result of a successful tool call. Tool *failures* throw. */
export interface GhostToolResult<TDetails = unknown> {
  content: GhostToolContent[];
  details: TDetails;
}

/**
 * What a tool execution can see of its call. `caller` names who acts — the
 * conversation, or a delegated run's own id over `ghost mcp serve` — and keys
 * the desktop lease.
 */
export interface GhostToolContext {
  readonly caller?: string | undefined;
}

export interface GhostToolDefinition<TDetails = unknown> {
  /** Tool name as the model calls it. */
  name: string;
  /** Description for the model. */
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  execute(
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: GhostToolContext,
  ): Promise<GhostToolResult<TDetails>>;
}

export interface GhostExtensionAPI {
  registerTool(definition: GhostToolDefinition): void;
}

export type GhostExtensionFactory = (
  api: GhostExtensionAPI,
) => void | Promise<void>;

export interface CollectedGhostExtension {
  readonly tools: Map<string, GhostToolDefinition>;
}

/**
 * Run a factory against a recording API to obtain its registered tools.
 */
export async function collectGhostExtension(
  factory: GhostExtensionFactory,
): Promise<CollectedGhostExtension> {
  const tools = new Map<string, GhostToolDefinition>();
  const api: GhostExtensionAPI = {
    registerTool(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`Ghost tool ${JSON.stringify(definition.name)} is registered twice.`);
      }
      tools.set(definition.name, definition);
    },
  };
  await factory(api);
  return { tools };
}
