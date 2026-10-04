/**
 * The Ghost extension seam.
 *
 * Ghost's built-in tools are written against this surface and nothing else:
 * tool registration. The daemon serves the collected tools to a conversation's
 * harness over MCP (`ghost mcp serve`); the extensions import no harness.
 *
 * Parameter schemas are TypeBox JSON Schema documents (`typebox` v1), which
 * every runtime and provider consumes as plain JSON.
 */
import type { Static, TSchema } from "typebox";

export type GhostToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** The result of a successful tool call. Tool *failures* throw. */
export interface GhostToolResult<TDetails = unknown> {
  content: GhostToolContent[];
  details: TDetails;
}

/**
 * What a tool execution can see of its conversation. `cwd` is the session's
 * current working directory, which for a ghost session is the ghost home
 * unless the model has changed it. `caller` names who acts — the session id
 * in-session, a delegated run's own id over `ghost mcp serve` — and keys the
 * desktop lease.
 */
export interface GhostToolContext {
  readonly cwd: string;
  readonly caller?: string | undefined;
}

export interface GhostToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> {
  /** Tool name as the model calls it. */
  name: string;
  /** Human-readable label for a UI. */
  label: string;
  /** Description for the model. */
  description: string;
  /** JSON Schema for the arguments, built with TypeBox. */
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    ctx: GhostToolContext,
  ): Promise<GhostToolResult<TDetails>>;
}

export interface GhostExtensionAPI {
  registerTool<TParams extends TSchema>(
    definition: GhostToolDefinition<TParams>,
  ): void;
}

export type GhostExtensionFactory = (
  api: GhostExtensionAPI,
) => void | Promise<void>;

/** A registered tool with its parameter type erased, as a runtime holds it. */
export type AnyGhostToolDefinition = GhostToolDefinition<TSchema, unknown>;

export interface CollectedGhostExtension {
  readonly tools: Map<string, AnyGhostToolDefinition>;
}

/**
 * Run a factory against a recording API to obtain its registered tools.
 */
export async function collectGhostExtension(
  factory: GhostExtensionFactory,
): Promise<CollectedGhostExtension> {
  const tools = new Map<string, AnyGhostToolDefinition>();
  const api: GhostExtensionAPI = {
    registerTool(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`Ghost tool ${JSON.stringify(definition.name)} is registered twice.`);
      }
      tools.set(definition.name, definition as AnyGhostToolDefinition);
    },
  };
  await factory(api);
  return { tools };
}
