/**
 * The Ghost extension seam.
 *
 * Ghost's built-in extensions are written against this surface and nothing
 * else. It is the deliberately small subset of a pi-style extension API that
 * Ghost supports: tool registration and the one prompt hook that replaces the
 * provider-facing system prompt every turn. The daemon adapts it to whichever
 * runtime hosts the session; the extensions never import a runtime package.
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

/** The model the session is bound to, as far as a tool needs to know. */
export interface GhostToolModel {
  readonly provider: string;
  readonly id: string;
  /** Input modalities the model accepts; `"image"` enables vision paths. */
  readonly input?: readonly string[];
}

/**
 * What a tool execution or hook can see of its session. `cwd` is the session's
 * current working directory, which for a ghost session is the ghost home
 * unless the model has changed it; `model` is absent when the runtime has no
 * model instance (the Claude Code bridge).
 */
export interface GhostToolContext {
  readonly cwd: string;
  readonly model?: GhostToolModel | undefined;
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

export interface GhostBeforeAgentStartEvent {
  readonly type: "before_agent_start";
  /** The user prompt that starts this turn. */
  readonly prompt: string;
  /** The system prompt sections assembled so far. */
  readonly systemPrompt: readonly string[];
}

export interface GhostBeforeAgentStartResult {
  /** Replaces the whole system prompt; sections are joined by blank lines. */
  systemPrompt?: string[];
}

export type GhostBeforeAgentStartHandler = (
  event: GhostBeforeAgentStartEvent,
  ctx: GhostToolContext,
) => Promise<GhostBeforeAgentStartResult | undefined | void>
  | GhostBeforeAgentStartResult
  | undefined
  | void;

export interface GhostExtensionAPI {
  registerTool<TParams extends TSchema>(
    definition: GhostToolDefinition<TParams>,
  ): void;
  on(event: "before_agent_start", handler: GhostBeforeAgentStartHandler): void;
}

export type GhostExtensionFactory = (
  api: GhostExtensionAPI,
) => void | Promise<void>;

/** A registered tool with its parameter type erased, as a runtime holds it. */
export type AnyGhostToolDefinition = GhostToolDefinition<TSchema, unknown>;

export interface CollectedGhostExtension {
  readonly tools: Map<string, AnyGhostToolDefinition>;
  readonly beforeAgentStart: GhostBeforeAgentStartHandler[];
}

/**
 * Run a factory against a recording API. Runtimes and tests use this to obtain
 * the registered tools and hooks without a session.
 */
export async function collectGhostExtension(
  factory: GhostExtensionFactory,
): Promise<CollectedGhostExtension> {
  const tools = new Map<string, AnyGhostToolDefinition>();
  const beforeAgentStart: GhostBeforeAgentStartHandler[] = [];
  const api: GhostExtensionAPI = {
    registerTool(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`Ghost tool ${JSON.stringify(definition.name)} is registered twice.`);
      }
      tools.set(definition.name, definition as AnyGhostToolDefinition);
    },
    on(_event, handler) {
      beforeAgentStart.push(handler);
    },
  };
  await factory(api);
  return { tools, beforeAgentStart };
}
