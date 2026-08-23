/**
 * Owner-local Claude Code runtime.
 *
 * This is the narrow T3 path: the official Claude Agent SDK drives an
 * installed, unmodified `claude` executable which reads the creator's own
 * Claude Code login. Ghost never asks for, reads, stores, or proxies Claude
 * credentials. The Effect lifecycle below is adapted from T3 Code's MIT-
 * licensed Claude adapter (`apps/server/src/provider/Layers/ClaudeAdapter.ts`).
 *
 * Ghost deliberately opens one scoped query per turn instead of keeping T3's
 * query process alive forever. Our persona, memory index, and note catalogue
 * are rebuilt on every turn; a long-lived query would freeze those system
 * instructions at session creation. Claude's opaque session id supplies
 * continuity when the next scoped query resumes.
 */
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import {
  buildGhostSystemPrompt,
  deriveMemoryIndex,
  deriveNoteCatalog,
  GHOST_LOOK_AT_IMAGE,
  openGhostHome,
} from "@ghost/extensions";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as z from "zod";
import { createClaudePiMessagesAdapter } from "./claude-pi-messages.js";
import { scrubProviderEnv } from "./env-scrub.js";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
} from "./hooks.js";
import {
  CREATOR_SCOPE,
  resolveGhostExtensions,
  type GhostExtensionOptions,
  type RelayTransport,
} from "./extensions.js";
import { GhostError, ghostPaths, type Ghost } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import type { RunTurnOptions } from "./session-host.js";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_DEFAULT_MODEL_ID = "default";
export const CLAUDE_CODE_BINARY_ENV = "GHOST_CLAUDE_BINARY";

const CLAUDE_SESSION_PREFIX = "claude-";
const CLAUDE_SESSION_SUFFIX = ".json";
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean;
  /** Claude Code's authentication source; `claude.ai` is the plan-backed path. */
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

export interface ClaudeSessionMetadata {
  version: 1;
  runtime: "claude-code";
  conversationId: string;
  sessionId: string;
  created: string;
  modified: string;
  messageCount: number;
}

export interface ClaudeCodeQueryInput {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}

export type ClaudeCodeQueryFactory = (input: ClaudeCodeQueryInput) => Query;

export interface ClaudeCodeRuntimeOptions {
  logger?: Logger;
  extensionOptions?: GhostExtensionOptions;
  browserMode?: "relay" | "profile";
  relayTransport?: RelayTransport;
  /** Installed Claude Code path/name. Defaults to GHOST_CLAUDE_BINARY or `claude`. */
  binaryPath?: string;
  /** Test seam; production always uses the official Agent SDK query(). */
  createQuery?: ClaudeCodeQueryFactory;
  /** Test seam for the external `claude auth status` preflight. */
  readAuthStatus?: (binaryPath: string) => Promise<ClaudeCodeAuthStatus>;
  /** Ghost-owned lifecycle hooks shared with the pi harness. */
  hooks?: GhostHookRunner;
}

export class ClaudeCodeProcessError extends Error {
  readonly _tag = "ClaudeCodeProcessError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeCodeProcessError";
  }
}

function credentialFreeEnvironment(): NodeJS.ProcessEnv {
  // main.ts / SessionHost already scrub provider credentials and routing
  // overrides process-wide.
  // Copy the result because the SDK replaces, rather than merges, `env`.
  const env = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "ghostd/0.0.1",
  };
  scrubProviderEnv(env);
  return env;
}

async function executableCandidate(binaryPath: string): Promise<string | null> {
  const candidates = isAbsolute(binaryPath) || binaryPath.includes("/")
    ? [resolve(binaryPath)]
    : (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, binaryPath));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH. Failure is reported once with the configured
      // binary name, not as a cascade of candidate errors.
    }
  }
  return null;
}

async function launcherPrefix(path: string): Promise<string> {
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function unwrapMiseClaudeLauncher(path: string): Promise<string> {
  const prefix = await launcherPrefix(path);
  if (!prefix.startsWith("#!") || !/\bmise\b/.test(prefix) || !/\bclaude\b/.test(prefix)) {
    return path;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("mise", ["which", "claude"], {
      encoding: "utf8",
      timeout: AUTH_STATUS_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
      env: credentialFreeEnvironment(),
    }));
  } catch (cause) {
    throw new ClaudeCodeProcessError(
      `Claude Code launcher ${JSON.stringify(path)} delegates to mise, but Ghost could not resolve `
        + "mise's underlying Claude executable.",
      { cause },
    );
  }
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [misePath] = lines;
  if (lines.length !== 1 || !misePath) {
    throw new ClaudeCodeProcessError(
      `\`mise which claude\` returned ${lines.length} executable paths; expected exactly one.`,
    );
  }
  const resolved = await executableCandidate(misePath);
  if (!resolved || resolved === path) {
    throw new ClaudeCodeProcessError(
      `mise did not resolve an executable behind Claude launcher ${JSON.stringify(path)}.`,
    );
  }
  return resolved;
}

/** Linux/Omarchy subset of T3's executable-resolution seam. */
export async function resolveClaudeCodeExecutable(binaryPath = "claude"): Promise<string> {
  const resolved = await executableCandidate(binaryPath);
  if (resolved) return unwrapMiseClaudeLauncher(resolved);
  throw new GhostError(
    "claude_code_missing",
    `Claude Code is not installed at ${JSON.stringify(binaryPath)}. Install the official `
      + `Claude Code CLI, then run \`claude auth login\`. Override the executable with `
      + `${CLAUDE_CODE_BINARY_ENV} when needed.`,
    503,
  );
}

function authStatusFromJson(raw: string): ClaudeCodeAuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ClaudeCodeProcessError("`claude auth status --json` returned invalid JSON.", {
      cause,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClaudeCodeProcessError("`claude auth status --json` returned no status object.");
  }
  const status = parsed as Record<string, unknown>;
  if (typeof status.loggedIn !== "boolean") {
    throw new ClaudeCodeProcessError(
      "`claude auth status --json` omitted its boolean `loggedIn` field.",
    );
  }
  return {
    loggedIn: status.loggedIn,
    ...(typeof status.authMethod === "string" ? { authMethod: status.authMethod } : {}),
    ...(typeof status.apiProvider === "string" ? { apiProvider: status.apiProvider } : {}),
    ...(typeof status.subscriptionType === "string"
      ? { subscriptionType: status.subscriptionType }
      : {}),
  };
}

/** Token-free external-auth check; no SDK query and no model request. */
export async function readClaudeCodeAuthStatus(
  binaryPath: string,
): Promise<ClaudeCodeAuthStatus> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binaryPath, ["auth", "status", "--json"], {
      encoding: "utf8",
      timeout: AUTH_STATUS_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
      env: credentialFreeEnvironment(),
    }));
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stdout?: string };
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      return authStatusFromJson(error.stdout);
    }
    throw new ClaudeCodeProcessError("Failed to read Claude Code authentication status.", {
      cause,
    });
  }
  return authStatusFromJson(stdout);
}

export function isClaudePlanAuth(status: ClaudeCodeAuthStatus): boolean {
  return status.loggedIn && status.authMethod === "claude.ai";
}

export function claudeSessionMetadataPath(
  sessionDir: string,
  conversationId: string,
): string {
  const digest = createHash("sha256").update(conversationId).digest("hex");
  return join(sessionDir, `${CLAUDE_SESSION_PREFIX}${digest}${CLAUDE_SESSION_SUFFIX}`);
}

function parseMetadata(path: string, raw: string): ClaudeSessionMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GhostError(
      "claude_session_invalid",
      `${path} is not valid Claude session metadata: ${(cause as Error).message}`,
      500,
    );
  }
  const value = parsed as Partial<ClaudeSessionMetadata> | null;
  if (value?.version !== 1
    || value.runtime !== "claude-code"
    || typeof value.conversationId !== "string"
    || typeof value.sessionId !== "string"
    || typeof value.created !== "string"
    || typeof value.modified !== "string"
    || typeof value.messageCount !== "number") {
    throw new GhostError(
      "claude_session_invalid",
      `${path} does not match the claude-code session metadata contract.`,
      500,
    );
  }
  return value as ClaudeSessionMetadata;
}

async function readMetadata(
  sessionDir: string,
  conversationId: string,
): Promise<ClaudeSessionMetadata | null> {
  const path = claudeSessionMetadataPath(sessionDir, conversationId);
  try {
    return parseMetadata(path, await readFile(path, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function writeMetadata(
  sessionDir: string,
  metadata: ClaudeSessionMetadata,
): Promise<string> {
  await mkdir(sessionDir, { recursive: true });
  const path = claudeSessionMetadataPath(sessionDir, metadata.conversationId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return path;
}

async function buildPersona(homeDir: string, ghostName: string): Promise<string> {
  const home = openGhostHome(homeDir);
  const [character, memory, notes] = await Promise.all([
    home.readCharacter(),
    home.listMemory(CREATOR_SCOPE),
    home.listNotes(),
  ]);
  return buildGhostSystemPrompt({
    ghostName,
    character,
    memory: deriveMemoryIndex(memory.files),
    notes: deriveNoteCatalog(notes.notes, CREATOR_SCOPE),
    scope: CREATOR_SCOPE,
    extraSections: [
      [
        "## Runtime boundary",
        "You are running inside Ghost through Claude Code. The tools shown to you are the entire "
          + "capability boundary. You do not have Claude Code's coding, shell, arbitrary-file, skill, "
          + "plugin, or project-instruction tools. Never claim that you used one.",
      ].join("\n"),
    ],
  });
}

function captureToolDefinitions(
  factories: ReturnType<typeof resolveGhostExtensions>["factories"],
): Promise<Map<string, ToolDefinition>> {
  const definitions = new Map<string, ToolDefinition>();
  const api = {
    registerTool(definition: ToolDefinition) {
      definitions.set(definition.name, definition);
    },
    on() {},
    getActiveTools() {
      return [...definitions.keys()];
    },
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  return Promise.all(factories.map(async (factory) => {
    await factory(api);
  })).then(() => definitions);
}

function signalFromToolExtra(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | null)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function unavailableDependency(name: string): never {
  throw new ClaudeCodeProcessError(
    `Ghost tool requested pi runtime dependency ${JSON.stringify(name)} through the Claude Code bridge.`,
  );
}

function extensionContext(
  cwd: string,
  systemPrompt: string,
  signal: AbortSignal | undefined,
): ExtensionContext {
  // Ghost's screen tool checks only the image input capability. The standalone
  // look_at_image fallback is removed below because Claude can consume the
  // image block directly; no pi ModelRegistry is synthesized.
  const visionModel = { input: ["text", "image"] } as ExtensionContext["model"];
  return {
    cwd,
    mode: "rpc",
    hasUI: false,
    ui: new Proxy({}, { get: () => () => unavailableDependency("ui") }),
    sessionManager: new Proxy({}, { get: () => unavailableDependency("sessionManager") }),
    modelRegistry: new Proxy({}, { get: () => unavailableDependency("modelRegistry") }),
    model: visionModel,
    scopedModels: [],
    signal,
    isIdle: () => false,
    isProjectTrusted: () => false,
    abort: () => unavailableDependency("abort"),
    hasPendingMessages: () => false,
    shutdown: () => unavailableDependency("shutdown"),
    getContextUsage: () => undefined,
    compact: () => unavailableDependency("compact"),
    getSystemPrompt: () => systemPrompt,
  } as unknown as ExtensionContext;
}

function mcpContent(result: AgentToolResult<unknown>): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const part of result.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      content.push({
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      });
      continue;
    }
    throw new ClaudeCodeProcessError(
      `Ghost tool returned unsupported content type ${JSON.stringify((part as { type?: unknown }).type)}.`,
    );
  }
  return content;
}

function zodShapeFor(definition: ToolDefinition): Record<string, z.ZodType> {
  const parameters = definition.parameters as unknown as {
    toJsonSchema?: () => unknown;
  };
  // OMP 18's schema values are callable omptype objects. Claude's SDK wants a
  // Zod shape, so cross the provider boundary through their canonical JSON
  // representation instead of handing zod the runtime wrapper itself.
  const jsonSchema = typeof parameters.toJsonSchema === "function"
    ? parameters.toJsonSchema()
    : definition.parameters;
  const schema = z.fromJSONSchema(jsonSchema as Record<string, unknown>);
  if (!(schema instanceof z.ZodObject)) {
    throw new ClaudeCodeProcessError(
      `Ghost tool ${JSON.stringify(definition.name)} does not have an object input schema.`,
    );
  }
  return schema.shape;
}

async function buildMcpTools(
  homeDir: string,
  ghostName: string,
  systemPrompt: string,
  extensionOptions: GhostExtensionOptions,
  browserMode: "relay" | "profile",
  relayTransport: RelayTransport | undefined,
): Promise<{ tools: SdkMcpToolDefinition[]; names: string[] }> {
  const resolved = resolveGhostExtensions({
    ...extensionOptions,
    ghostName,
    browserMode,
    ...(relayTransport ? { relayTransport } : {}),
  });
  if (resolved.scope.kind !== "creator") {
    throw new GhostError(
      "claude_code_owner_only",
      "Claude Code subscription sessions are owner-local and cannot serve visitor traffic.",
      403,
    );
  }
  const definitions = await captureToolDefinitions(resolved.factories);
  // Claude is vision-capable. Keeping the pi fallback would either make a
  // second paid provider call or require inventing a ModelRegistry.
  const names = resolved.toolNames.filter((name) => name !== GHOST_LOOK_AT_IMAGE);
  const tools = names.map((name): SdkMcpToolDefinition => {
    const definition = definitions.get(name);
    if (!definition) {
      throw new ClaudeCodeProcessError(
        `Ghost declared tool ${JSON.stringify(name)} but its extension did not register it.`,
      );
    }
    return tool(
      definition.name,
      definition.description,
      zodShapeFor(definition),
      async (args, extra) => {
        try {
          const result = await definition.execute(
            randomUUID(),
            args,
            signalFromToolExtra(extra),
            undefined,
            extensionContext(homeDir, systemPrompt, signalFromToolExtra(extra)),
          );
          return { content: mcpContent(result) };
        } catch (cause) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: cause instanceof Error ? cause.message : String(cause),
            }],
          };
        }
      },
      { alwaysLoad: true },
    );
  });
  return { tools, names };
}

async function* promptMessages(
  prompt: string,
  additionalContext?: string,
): AsyncIterable<SDKUserMessage> {
  if (additionalContext) {
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: additionalContext }] },
      parent_tool_use_id: null,
      isSynthetic: true,
      shouldQuery: false,
    };
  }
  yield {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
  };
}

function queryOptions(input: {
  binaryPath: string;
  cwd: string;
  ghostName: string;
  modelId: string;
  systemPrompt: string;
  tools: SdkMcpToolDefinition[];
  toolNames: string[];
  metadata: ClaudeSessionMetadata | null;
  newSessionId: string;
  abortController: AbortController;
}): ClaudeQueryOptions {
  const mcp = createSdkMcpServer({
    name: "ghost",
    version: "1.0.0",
    tools: input.tools,
    alwaysLoad: true,
  });
  return {
    cwd: input.cwd,
    ...(input.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID ? {} : { model: input.modelId }),
    pathToClaudeCodeExecutable: input.binaryPath,
    systemPrompt: input.systemPrompt,
    title: `${input.ghostName} in Ghost`,
    settingSources: [],
    skills: [],
    plugins: [],
    tools: [],
    allowedTools: input.toolNames.map((name) => `mcp__ghost__${name}`),
    permissionMode: "dontAsk",
    strictMcpConfig: true,
    mcpServers: { ghost: mcp },
    includePartialMessages: true,
    persistSession: true,
    promptSuggestions: false,
    abortController: input.abortController,
    ...(input.metadata
      ? { resume: input.metadata.sessionId }
      : { sessionId: input.newSessionId }),
    env: credentialFreeEnvironment(),
  };
}

/**
 * Effect owns the subprocess stream and its finalizer. This is the portable
 * core copied from T3: SDK AsyncIterable -> Effect Stream, query interrupt on
 * cancellation, and query close on every exit path.
 */
function runQueryEffect(input: {
  createQuery: ClaudeCodeQueryFactory;
  prompt: string;
  additionalContext?: string;
  options: ClaudeQueryOptions;
  signal: AbortSignal | undefined;
  onQuery: (query: Query | null) => void;
  onMessage: (message: SDKMessage) => void;
}): Effect.Effect<void, ClaudeCodeProcessError> {
  return Effect.scoped(Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.try({
        try: () => input.createQuery({
          prompt: promptMessages(input.prompt, input.additionalContext),
          options: input.options,
        }),
        catch: (cause) => new ClaudeCodeProcessError(
          "Failed to start the Claude Code runtime.",
          { cause },
        ),
      }),
      (active) => Effect.sync(() => {
        input.onQuery(null);
        active.close();
      }),
    );
    input.onQuery(runtime);

    const interrupt = () => {
      void runtime.interrupt().catch(() => {
        // The scoped finalizer still closes the process. An interrupt racing a
        // natural result is not itself a second user-visible failure.
      });
    };
    if (input.signal?.aborted) interrupt();
    input.signal?.addEventListener("abort", interrupt, { once: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      input.signal?.removeEventListener("abort", interrupt);
    }));

    yield* Stream.fromAsyncIterable(
      runtime,
      (cause) => new ClaudeCodeProcessError("Claude Code's message stream failed.", { cause }),
    ).pipe(
      Stream.runForEach((message) => Effect.sync(() => input.onMessage(message))),
    );
  }));
}

export class ClaudeCodeRuntime {
  private readonly logger: Logger;
  private readonly extensionOptions: GhostExtensionOptions;
  private readonly browserMode: "relay" | "profile";
  private readonly relayTransport: RelayTransport | undefined;
  private readonly configuredBinaryPath: string;
  private readonly createQuery: ClaudeCodeQueryFactory;
  private readonly readAuthStatus: NonNullable<ClaudeCodeRuntimeOptions["readAuthStatus"]>;
  private readonly hooks: GhostHookRunner;
  private readonly busy = new Set<string>();
  private readonly active = new Map<string, Query>();
  private disposed = false;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.extensionOptions = options.extensionOptions ?? {};
    this.browserMode = options.browserMode ?? "relay";
    this.relayTransport = options.relayTransport;
    this.configuredBinaryPath = options.binaryPath
      ?? process.env[CLAUDE_CODE_BINARY_ENV]
      ?? "claude";
    this.createQuery = options.createQuery
      ?? ((input) => query({ prompt: input.prompt, options: input.options }));
    this.readAuthStatus = options.readAuthStatus ?? readClaudeCodeAuthStatus;
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
  }

  isBusy(ghostName: string, conversationId: string): boolean {
    return this.busy.has(JSON.stringify([ghostName, conversationId]));
  }

  async runTurn(
    ghost: Ghost,
    conversationId: string,
    modelId: string,
    options: RunTurnOptions,
  ): Promise<void> {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    const key = JSON.stringify([ghost.name, conversationId]);
    if (this.busy.has(key)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }
    if (this.extensionOptions.visitorId) {
      throw new GhostError(
        "claude_code_owner_only",
        "Claude Code subscription sessions are owner-local and cannot serve visitor traffic.",
        403,
      );
    }
    this.busy.add(key);

    const adapter = createClaudePiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
    });
    try {
      const binaryPath = await resolveClaudeCodeExecutable(this.configuredBinaryPath);
      const auth = await this.readAuthStatus(binaryPath);
      if (!isClaudePlanAuth(auth)) {
        throw new GhostError(
          "claude_code_subscription_required",
          "Claude Code is not signed into a Claude.ai plan. Run `claude auth login` in a "
            + "terminal as this desktop user, choose the Claude.ai account, then retry. "
            + "Ghost does not accept or store that login.",
          503,
        );
      }

      const paths = ghostPaths(ghost.dir);
      await mkdir(paths.sessionDir, { recursive: true });
      let metadata = await readMetadata(paths.sessionDir, conversationId);
      const turnId = Math.floor((metadata?.messageCount ?? 0) / 2);
      const systemPrompt = await buildPersona(paths.home, ghost.name);
      let beforePromptContext: string | undefined;
      if (this.hooks.hasHandlers("before_prompt")) {
        const result = await this.hooks.emitBeforePrompt({
          type: "before_prompt",
          prompt: options.prompt,
          turn_id: turnId + 1,
          session_id: metadata?.sessionId ?? conversationId,
          session_file: claudeSessionMetadataPath(paths.sessionDir, conversationId),
          signal: options.signal ?? new AbortController().signal,
          ghost_name: ghost.name,
          cwd: paths.home,
          runtime: "claude-code",
        });
        if (result?.additionalContext && !options.signal?.aborted) {
          beforePromptContext = result.additionalContext;
        }
      }
      const bridge = await buildMcpTools(
        paths.home,
        ghost.name,
        systemPrompt,
        this.extensionOptions,
        this.browserMode,
        this.relayTransport,
      );

      let prompt = options.prompt;
      let stopHookActive = false;
      let continuationCount = 0;
      while (!adapter.isTerminal()) {
        const abortController = new AbortController();
        const sdkOptions = queryOptions({
          binaryPath,
          cwd: paths.home,
          ghostName: ghost.name,
          modelId,
          systemPrompt,
          tools: bridge.tools,
          toolNames: bridge.names,
          metadata,
          newSessionId: randomUUID(),
          abortController,
        });

        let terminalResult: SDKResultMessage | null = null;
        await Effect.runPromise(runQueryEffect({
          createQuery: this.createQuery,
          prompt,
          ...(continuationCount === 0 && beforePromptContext
            ? { additionalContext: beforePromptContext }
            : {}),
          options: sdkOptions,
          signal: options.signal,
          onQuery: (active) => {
            if (active) this.active.set(key, active);
            else this.active.delete(key);
          },
          onMessage: (message) => {
            if (message.type === "result") {
              // Hold the terminal frame until its resume metadata is durable. A
              // `done` followed by a failed sidecar write would lie to the shell
              // that this conversation can survive a daemon restart.
              terminalResult = message;
            } else {
              adapter.handle(message);
            }
          },
        }));

        if (!terminalResult) {
          throw new ClaudeCodeProcessError("Claude Code ended without a terminal result.");
        }
        const completed = terminalResult as SDKResultMessage;
        if (completed.num_turns > 0) {
          const now = new Date().toISOString();
          metadata = {
            version: 1,
            runtime: "claude-code",
            conversationId,
            sessionId: completed.session_id,
            created: metadata?.created ?? now,
            modified: now,
            messageCount: (metadata?.messageCount ?? 0) + 2,
          };
          await writeMetadata(paths.sessionDir, metadata);
        }
        if (options.signal?.aborted) {
          adapter.finishError(new Error("Turn aborted."), true);
          break;
        }

        const resultText = "result" in completed && typeof completed.result === "string"
          ? completed.result
          : "";
        const lastAssistant = {
          role: "assistant",
          content: resultText ? [{ type: "text", text: resultText }] : [],
        };
        const hookResult = completed.subtype === "success" && this.hooks.hasHandlers("session_stop")
          ? await this.hooks.emitSessionStop({
            type: "session_stop",
            messages: [lastAssistant],
            turn_id: turnId,
            last_assistant_message: lastAssistant,
            session_id: completed.session_id,
            session_file: claudeSessionMetadataPath(paths.sessionDir, conversationId),
            stop_hook_active: stopHookActive,
            signal: options.signal ?? new AbortController().signal,
            ghost_name: ghost.name,
            cwd: paths.home,
            runtime: "claude-code",
          })
          : undefined;
        const additionalContext = ghostSessionStopContinuation(hookResult);
        if (!additionalContext) {
          adapter.handle(completed);
          break;
        }
        if (continuationCount >= GHOST_SESSION_STOP_CONTINUATION_CAP) {
          this.logger.warn("session_stop continuation cap reached", {
            ghost: ghost.name,
            session: completed.session_id,
            cap: GHOST_SESSION_STOP_CONTINUATION_CAP,
          });
          adapter.handle(completed);
          break;
        }
        adapter.recordUsage(completed);
        continuationCount += 1;
        stopHookActive = true;
        prompt = additionalContext;
      }
      if (!adapter.isTerminal()) {
        throw new ClaudeCodeProcessError("Claude Code result did not terminate the turn.");
      }
    } catch (cause) {
      this.logger.error("Claude Code turn failed", {
        ghost: ghost.name,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      if (!adapter.isTerminal()) {
        adapter.finishError(cause, options.signal?.aborted === true);
      }
    } finally {
      this.active.delete(key);
      this.busy.delete(key);
    }
  }

  async listSessions(ghost: Ghost): Promise<ClaudeSessionMetadata[]> {
    const { sessionDir } = ghostPaths(ghost.dir);
    await mkdir(sessionDir, { recursive: true });
    const names = await readdir(sessionDir);
    const result: ClaudeSessionMetadata[] = [];
    for (const name of names) {
      if (!name.startsWith(CLAUDE_SESSION_PREFIX) || !name.endsWith(CLAUDE_SESSION_SUFFIX)) {
        continue;
      }
      const path = join(sessionDir, name);
      result.push(parseMetadata(path, await readFile(path, "utf8")));
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async close(ghostName: string, conversationId: string): Promise<void> {
    const key = JSON.stringify([ghostName, conversationId]);
    const runtime = this.active.get(key);
    if (!runtime) return;
    this.active.delete(key);
    try {
      await runtime.interrupt();
    } finally {
      runtime.close();
    }
  }

  /** Delete one persisted resume sidecar. Returns false when none exists. */
  async deleteSession(ghost: Ghost, conversationId: string): Promise<boolean> {
    if (this.isBusy(ghost.name, conversationId)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before deleting it.",
        409,
      );
    }
    await this.close(ghost.name, conversationId);
    const path = claudeSessionMetadataPath(ghostPaths(ghost.dir).sessionDir, conversationId);
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    const active = [...this.active.values()];
    this.active.clear();
    await Promise.all(active.map(async (runtime) => {
      try {
        await runtime.interrupt();
      } catch {
        // close() below is the authoritative teardown.
      } finally {
        runtime.close();
      }
    }));
    this.busy.clear();
  }
}
