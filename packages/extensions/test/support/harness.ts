/**
 * A scripted stand-in for OMP's extension runtime.
 *
 * The tests drive tool calls and lifecycle events directly against the
 * registered handlers. No model is contacted and no session is created: the
 * spike already proved the wiring against a real agent loop, and what needs
 * testing here is our logic, deterministically.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";

type AnyTool = ToolDefinition<any, any>;
type AnyHandler = (event: any, ctx: ExtensionContext) => unknown;

export interface Harness {
  readonly tools: Map<string, AnyTool>;
  readonly handlers: Map<string, AnyHandler[]>;
  toolNames(): string[];
  /** Execute a registered tool the way the runtime would. */
  call(name: string, params?: Record<string, unknown>): Promise<AgentToolResult<any>>;
  /** Fire `tool_call`, returning the first blocking result, as pi does. */
  toolCall(
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined>;
  /** Fire `before_agent_start` and return the assembled system prompt. */
  beforeAgentStart(incomingSystemPrompt?: string): Promise<string | undefined>;
}

function fakeContext(cwd: string): ExtensionContext {
  // Only `cwd` is read by these extensions; the rest of the surface is TUI and
  // session plumbing the tests deliberately do not exercise.
  return { cwd, mode: "print", hasUI: false } as unknown as ExtensionContext;
}

export async function loadExtension(
  factory: ExtensionFactory,
  cwd: string,
): Promise<Harness> {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, AnyHandler[]>();
  const ctx = fakeContext(cwd);

  const api = {
    registerTool(tool: AnyTool) {
      const parameters = tool.parameters as unknown as {
        toJsonSchema?: () => unknown;
      };
      // OMP 18's TypeBox compatibility facade returns callable omptype schemas.
      // The real harness serializes those before handing them to a provider;
      // expose that same wire shape to these schema assertions.
      tools.set(tool.name, {
        ...tool,
        parameters: typeof parameters.toJsonSchema === "function"
          ? parameters.toJsonSchema()
          : tool.parameters,
      } as AnyTool);
    },
    on(event: string, handler: AnyHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as unknown as ExtensionAPI;

  await factory(api);

  return {
    tools,
    handlers,
    toolNames: () => [...tools.keys()],
    async call(name, params = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} is not registered`);
      return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
    },
    async toolCall(toolName, input = {}) {
      const event = { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
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
            systemPrompt: systemPrompt ?? incomingSystemPrompt,
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

/** The text a tool returned, joined. */
export function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
