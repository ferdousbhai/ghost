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
  AnyGhostToolDefinition,
  GhostExtensionAPI,
  GhostExtensionFactory,
  GhostToolContext,
  GhostToolModel,
  GhostToolResult,
} from "../../src/extension-api.js";
import type { ToolCallEventResult } from "./harness.js";
import type { CommandResult, CommandRunner, RunCommandOptions } from "../../src/extensions/shared.js";
import { CommandError } from "../../src/extensions/shared.js";
import type {
  AvailableBackends,
  DesktopHelper,
  HelloPayload,
  RequestOptions,
} from "../../src/extensions/desktop-helper-client.js";

type AnyTool = AnyGhostToolDefinition;
type AnyHandler = (event: any, ctx: any) => unknown;

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface FixtureModelInput {
  provider: string;
  id: string;
  input?: Array<"text" | "image">;
  costInput?: number;
  costOutput?: number;
}

export type FixtureModel = GhostToolModel;

export function fixtureModel(input: FixtureModelInput): FixtureModel {
  return {
    provider: input.provider,
    id: input.id,
    ...(input.input === undefined ? {} : { input: input.input }),
  };
}


export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunCommandOptions | undefined;
}

export interface FakeRunner {
  readonly run: CommandRunner;
  readonly calls: RecordedCommand[];
  lines(): string[];
}

export type FakeCommandHandler = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult | void> | CommandResult | void;

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


export const FULL_BACKENDS: AvailableBackends = {
  hyprctl: { available: true, path: "/usr/bin/hyprctl" },
  grim: { available: true, path: "/usr/bin/grim", foreign_toplevel: true },
  wtype: { available: true, path: "/usr/bin/wtype" },
  ydotool: { available: true, usable: true, path: "/usr/bin/ydotool" },
  atspi: { available: true, interpreter: "3.14" },
  foreign_toplevel_protocol: { supported: true, error: null },
};

export interface FakeHelperOptions {
  readonly handle?: (op: string, args: Record<string, unknown>) => unknown;
  /** Backends to merge over {@link FULL_BACKENDS}. */
  readonly backends?: Partial<AvailableBackends>;
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


export interface ContextOptions {
  readonly cwd: string;
  readonly model?: FixtureModel | undefined;
}

export function makeContext(options: ContextOptions): GhostToolContext {
  return { cwd: options.cwd, model: options.model };
}

export interface DesktopHarness {
  readonly tools: Map<string, AnyTool>;
  readonly handlers: Map<string, AnyHandler[]>;
  activeTools: string[];
  toolNames(): string[];
  call(name: string, params?: Record<string, unknown>): Promise<GhostToolResult<any>>;
  toolCall(
    toolName: string,
    input?: Record<string, unknown>,
  ): Promise<ToolCallEventResult | undefined>;
  transformContext(messages: unknown[]): Promise<unknown[]>;
  sessionStart(): Promise<void>;
  beforeAgentStart(): Promise<void>;
}

export async function loadExtensionWith(
  factory: GhostExtensionFactory,
  ctx: GhostToolContext,
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
      const event = { type: "tool_call", toolCallId: "call-1", toolName, input };
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
  } as unknown as GhostExtensionAPI;

  await factory(api);
  return harness;
}

export function resultText(result: GhostToolResult<any>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function resultImages(
  result: GhostToolResult<any>,
): Array<{ type: "image"; data: string; mimeType: string }> {
  return result.content.filter(
    (part): part is { type: "image"; data: string; mimeType: string } => part.type === "image",
  );
}
