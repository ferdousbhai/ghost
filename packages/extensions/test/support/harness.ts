/**
 * A scripted stand-in for the daemon's extension runtime.
 *
 * The tests drive tool calls and lifecycle events directly against the
 * registered handlers. No model is contacted and no session is created: the
 * spike already proved the wiring against a real agent loop, and what needs
 * testing here is our logic, deterministically.
 */
import type {
  AnyGhostToolDefinition,
  GhostExtensionAPI,
  GhostExtensionFactory,
  GhostToolContext,
  GhostToolResult,
} from "../../src/extension-api.js";

type AnyTool = AnyGhostToolDefinition;
type AnyHandler = (event: any, ctx: GhostToolContext) => unknown;
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

export interface Harness {
  readonly tools: Map<string, AnyTool>;
  readonly handlers: Map<string, AnyHandler[]>;
  toolNames(): string[];
  call(
    name: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GhostToolResult<any>>;
  toolCall(
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined>;
  beforeAgentStart(incomingSystemPrompt?: string): Promise<string | undefined>;
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
  const handlers = new Map<string, AnyHandler[]>();
  const ctx = fakeContext(cwd);

  const api = {
    registerTool(tool: AnyTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: AnyHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as unknown as GhostExtensionAPI;

  await factory(api);

  return {
    tools,
    handlers,
    toolNames: () => [...tools.keys()],
    async call(name, params = {}, signal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} is not registered`);
      return tool.execute(`call-${name}`, params, signal, undefined, ctx);
    },
    async toolCall(toolName, input = {}) {
      const event = { type: "tool_call", toolCallId: "call-1", toolName, input };
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = (await handler(event, ctx)) as ToolCallEventResult | undefined;
        if (result?.block) return result;
      }
      return undefined;
    },
    async beforeAgentStart(incomingSystemPrompt = "You are pi, a coding agent.") {
      let systemPrompt: string | undefined;
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = (await handler(
          {
            type: "before_agent_start",
            prompt: "hello",
            systemPrompt: [systemPrompt ?? incomingSystemPrompt],
            systemPromptOptions: {},
          },
          ctx,
        )) as { systemPrompt?: string | string[] } | undefined;
        if (result?.systemPrompt !== undefined) {
          systemPrompt = Array.isArray(result.systemPrompt)
            ? result.systemPrompt.join("\n\n")
            : result.systemPrompt;
        }
      }
      return systemPrompt;
    },
  };
}

export function resultText(result: GhostToolResult<any>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
