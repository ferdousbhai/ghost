/**
 * A scripted runtime for the extensions that reach outside the ghost home —
 * screen and desktop.
 *
 * `support/harness.ts` gives every extension a context with nothing but `cwd`,
 * which is all persona/memory/docs ever read. The desktop tools also run local
 * programs, and screen tests derive the explicit vision capability from a
 * realistic fixture model. So this harness adds:
 *
 * - a **fixture model** with real `input` and `cost` values, so that branch is
 *   tested against model-shaped data rather than a mock that agrees with it;
 * - a **recording command runner**, so `grim`/`hyprctl`/`notify-send` are never
 *   actually invoked and every argv the extensions build is inspectable;
 * - a fake `DesktopHelper`, so no sidecar process is spawned.
 *
 * No model is contacted and no desktop is touched.
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
import type { CommandResult, CommandRunner, RunCommandOptions } from "../../src/extensions/shared.js";
import { CommandError } from "../../src/extensions/shared.js";
import type {
  AvailableBackends,
  DesktopHelper,
  HelloPayload,
  RequestOptions,
} from "../../src/extensions/desktop-helper-client.js";

type AnyTool = ToolDefinition<any, any>;
type AnyHandler = (event: any, ctx: any) => unknown;

/** A 1×1 transparent PNG — the smallest thing that is genuinely an image. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface FixtureModelInput {
  provider: string;
  id: string;
  /** Omit entirely to model a provider entry that never declared `input`. */
  input?: Array<"text" | "image">;
  costInput?: number;
  costOutput?: number;
}

/** OMP's `Model`, taken structurally off the context the extensions receive. */
export type FixtureModel = NonNullable<ExtensionContext["model"]>;

/** A `Model` shaped exactly enough for the rules under test. */
export function fixtureModel(input: FixtureModelInput): FixtureModel {
  const model: Record<string, unknown> = {
    id: input.id,
    name: input.id,
    api: "openai-completions",
    provider: input.provider,
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    cost: {
      input: input.costInput ?? 1,
      output: input.costOutput ?? 1,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  if (input.input !== undefined) model["input"] = input.input;
  return model as unknown as FixtureModel;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunCommandOptions | undefined;
}

export interface FakeRunner {
  readonly run: CommandRunner;
  readonly calls: RecordedCommand[];
  /** Commands recorded as `"grim -g 0,0 10x10 /tmp/x.png"`, for assertions. */
  lines(): string[];
}

export type FakeCommandHandler = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult | void> | CommandResult | void;

/** A runner that records every invocation and answers from `handler`. */
export function fakeRunner(handler: FakeCommandHandler = () => undefined): FakeRunner {
  const calls: RecordedCommand[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const result = await handler(command, args);
    return result ?? { stdout: "", stderr: "" };
  };
  return {
    run,
    calls,
    lines: () => calls.map((call) => [call.command, ...call.args].join(" ")),
  };
}

/** The failure `execFile` produces for a program that is not installed. */
export function missingBinary(command: string): CommandError {
  return new CommandError(command, [], `spawn ${command} ENOENT`, { errno: "ENOENT" });
}

// ---------------------------------------------------------------------------
// Fake desktop helper (injected at the DesktopHelper boundary)
// ---------------------------------------------------------------------------

/** Every backend present and usable — the happy path a test starts from. */
export const FULL_BACKENDS: AvailableBackends = {
  hyprctl: { available: true, path: "/usr/bin/hyprctl" },
  grim: { available: true, path: "/usr/bin/grim", foreign_toplevel: true },
  wtype: { available: true, path: "/usr/bin/wtype" },
  ydotool: { available: true, usable: true, path: "/usr/bin/ydotool" },
  atspi: { available: true, interpreter: "3.14" },
  foreign_toplevel_protocol: { supported: true, error: null },
};

export interface FakeHelperOptions {
  /** Answer an op. Return the result, or throw to simulate a refusal. */
  readonly handle?: (op: string, args: Record<string, unknown>) => unknown;
  /** Backends to merge over {@link FULL_BACKENDS}. */
  readonly backends?: Partial<AvailableBackends>;
  /** Defaults to true. */
  readonly inHyprland?: boolean;
}

export interface FakeHelper extends DesktopHelper {
  readonly requests: Array<{ op: string; args: Record<string, unknown> }>;
  disposed: boolean;
}

/**
 * A `DesktopHelper` that never spawns a process. It records every request and
 * answers from `handle`, so a tool test drives the ax_query→ref→ax_perform flow,
 * dispatch routing, honesty surfacing, and backend-missing degradation without a
 * real desktop.
 */
export function fakeHelper(options: FakeHelperOptions = {}): FakeHelper {
  const backends: AvailableBackends = { ...FULL_BACKENDS, ...options.backends };
  const hello: HelloPayload = {
    type: "hello",
    helper: "ghost-desktop-helper",
    version: "0.1.0",
    protocol: 1,
    ops: ["state", "capture", "ax_query"],
    in_hyprland_session: options.inHyprland ?? true,
    "available-backends": backends,
  };
  const requests: FakeHelper["requests"] = [];
  const helper: FakeHelper = {
    requests,
    disposed: false,
    async hello() {
      return hello;
    },
    async capabilities() {
      return backends;
    },
    async request<T>(op: string, args: Record<string, unknown> = {}, _opts?: RequestOptions) {
      requests.push({ op, args });
      const result = options.handle ? options.handle(op, args) : undefined;
      return result as T;
    },
    async dispose() {
      helper.disposed = true;
    },
  };
  return helper;
}

// ---------------------------------------------------------------------------
// Context and harness
// ---------------------------------------------------------------------------

export interface ContextOptions {
  readonly cwd: string;
  readonly model?: FixtureModel | undefined;
}

export function makeContext(options: ContextOptions): ExtensionContext {
  return {
    cwd: options.cwd,
    mode: "print",
    hasUI: false,
    model: options.model,
  } as unknown as ExtensionContext;
}

export interface DesktopHarness {
  readonly tools: Map<string, AnyTool>;
  readonly handlers: Map<string, AnyHandler[]>;
  /** What `pi.setActiveTools` last left active. */
  activeTools: string[];
  toolNames(): string[];
  call(name: string, params?: Record<string, unknown>): Promise<AgentToolResult<any>>;
  toolCall(
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined>;
  /** Fire `context`, returning the messages the chain produced. */
  transformContext(messages: unknown[]): Promise<unknown[]>;
  /** Fire `session_start`. */
  sessionStart(): Promise<void>;
  /** Fire `before_agent_start`. */
  beforeAgentStart(): Promise<void>;
}

export async function loadExtensionWith(
  factory: ExtensionFactory,
  ctx: ExtensionContext,
): Promise<DesktopHarness> {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, AnyHandler[]>();

  const harness: DesktopHarness = {
    tools,
    handlers,
    activeTools: [],
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
    async transformContext(messages) {
      let current = messages;
      for (const handler of handlers.get("context") ?? []) {
        const result = (await handler({ type: "context", messages: current }, ctx)) as
          | { messages?: unknown[] }
          | undefined;
        if (result?.messages) current = result.messages;
      }
      return current;
    },
    async sessionStart() {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start" }, ctx);
      }
    },
    async beforeAgentStart() {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler(
          { type: "before_agent_start", prompt: "hello", systemPrompt: "", systemPromptOptions: {} },
          ctx,
        );
      }
    },
  };

  const api = {
    registerTool(tool: AnyTool) {
      tools.set(tool.name, tool);
      harness.activeTools = [...harness.activeTools, tool.name];
    },
    on(event: string, handler: AnyHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getActiveTools: () => [...harness.activeTools],
    setActiveTools: (names: string[]) => {
      harness.activeTools = [...names];
    },
  } as unknown as ExtensionAPI;

  await factory(api);
  return harness;
}

/** The text a tool returned, joined. */
export function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** The image blocks a tool returned. */
export function resultImages(
  result: AgentToolResult<any>,
): Array<{ type: "image"; data: string; mimeType: string }> {
  return result.content.filter(
    (part): part is { type: "image"; data: string; mimeType: string } => part.type === "image",
  );
}
