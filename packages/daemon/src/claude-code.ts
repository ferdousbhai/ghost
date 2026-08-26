/**
 * Owner-local Claude Code runtime.
 *
 * The official Claude Agent SDK drives an
 * installed, unmodified `claude` executable which reads the owner's
 * Claude Code login. Ghost never asks for, reads, stores, or proxies Claude
 * credentials. The Effect lifecycle below is adapted from T3 Code's MIT-
 * licensed Claude adapter (`apps/server/src/provider/Layers/ClaudeAdapter.ts`).
 *
 * Ghost deliberately opens one scoped query per turn instead of keeping T3's
 * query process alive forever. Our persona, memory index, and doc catalogue
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
  deriveDocCatalog,
  openGhostHome,
  type GhostToolCapabilities,
} from "@ghost/extensions";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as z from "zod";
import { createClaudePiMessagesAdapter } from "./claude-pi-messages.js";
import {
  isValidConversationId,
  requireRawConversationId,
} from "./conversation-identity.js";
import { scrubProviderEnv } from "./env-scrub.js";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
} from "./hooks.js";
import {
  resolveGhostExtensions,
  type GhostExtensionOptions,
  type RelayTransport,
} from "./extensions.js";
import { FIRST_MEETING_SECTION } from "./greeting.js";
import {
  GhostError,
  ghostPaths,
  isSeededCharacter,
  readCharacterFile,
  type Ghost,
} from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import type { RunTurnOptions } from "./session-host.js";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_DEFAULT_MODEL_ID = "default";
export const CLAUDE_CODE_BINARY_ENV = "GHOST_CLAUDE_BINARY";
export const CLAUDE_CODE_PROBE_TTL_MS = 5_000;
export const MAX_CLAUDE_CODE_PROBE_TTL_MS = 30_000;

const CLAUDE_SESSION_PREFIX = "claude-";
const CLAUDE_SESSION_SUFFIX = ".json";
const CLAUDE_SESSION_FILE_PATTERN = /^claude-[0-9a-f]{64}\.json$/u;
const MAX_CLAUDE_CODE_SESSION_ID_SCALARS = 512;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
export const CLAUDE_CODE_TOOL_CAPABILITIES: GhostToolCapabilities = { vision: true };
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
  /** Owner-initiated turns, independent of Claude's internal sampling/tool turns. */
  ownerTurnCount: number;
}

export interface ClaudeCodeQueryInput {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}

export type ClaudeCodeQueryFactory = (input: ClaudeCodeQueryInput) => Query;

export interface ClaudeCodeProbeResult {
  binaryPath: string;
  authStatus: ClaudeCodeAuthStatus;
}

export interface ClaudeCodeProbeOptions {
  /** Installed Claude Code path/name. Defaults to GHOST_CLAUDE_BINARY or `claude`. */
  binaryPath?: string;
  /** Short cache lifetime for one executable/auth snapshot. */
  ttlMs?: number;
  /** Deterministic cache clock seam. */
  now?: () => number;
  /** Test seam for executable discovery. */
  resolveExecutable?: (binaryPath: string) => Promise<string>;
  /** Test seam for the external `claude auth status` process. */
  readAuthStatus?: (binaryPath: string) => Promise<ClaudeCodeAuthStatus>;
}

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
  /** Test seam for installed-executable discovery. */
  resolveExecutable?: (binaryPath: string) => Promise<string>;
  /** Shared catalogue/turn probe. Production wires one daemon-wide instance. */
  probe?: ClaudeCodeProbe;
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

/**
 * One short-lived snapshot of the external Claude executable and auth state.
 * Successful probes (including logged-out state) are cached; process failures
 * are cached for the same bounded lifetime so a polling catalogue cannot spin
 * up a failing process on every request.
 */
export class ClaudeCodeProbe {
  private readonly binaryPath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly resolveExecutable: NonNullable<ClaudeCodeProbeOptions["resolveExecutable"]>;
  private readonly readAuthStatus: NonNullable<ClaudeCodeProbeOptions["readAuthStatus"]>;
  private generation = 0;
  private cached?: {
    outcome:
      | { ok: true; value: ClaudeCodeProbeResult }
      | { ok: false; error: unknown };
    expiresAt: number;
  };
  private inFlight?: { generation: number; promise: Promise<ClaudeCodeProbeResult> };

  constructor(options: ClaudeCodeProbeOptions = {}) {
    this.binaryPath = options.binaryPath
      ?? process.env[CLAUDE_CODE_BINARY_ENV]
      ?? "claude";
    this.ttlMs = options.ttlMs ?? CLAUDE_CODE_PROBE_TTL_MS;
    if (!Number.isFinite(this.ttlMs)
      || this.ttlMs <= 0
      || this.ttlMs > MAX_CLAUDE_CODE_PROBE_TTL_MS) {
      throw new RangeError(
        `Claude Code probe ttlMs must be finite and in (0, ${MAX_CLAUDE_CODE_PROBE_TTL_MS}]`,
      );
    }
    this.now = options.now ?? Date.now;
    this.resolveExecutable = options.resolveExecutable ?? resolveClaudeCodeExecutable;
    this.readAuthStatus = options.readAuthStatus ?? readClaudeCodeAuthStatus;
  }

  async read(): Promise<ClaudeCodeProbeResult> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) {
      if (this.cached.outcome.ok) return this.cached.outcome.value;
      throw this.cached.outcome.error;
    }

    const generation = this.generation;
    if (this.inFlight?.generation === generation) return this.inFlight.promise;

    const promise = this.readFresh(generation);
    this.inFlight = { generation, promise };
    void promise.then(
      () => this.clearInFlight(promise),
      () => this.clearInFlight(promise),
    );
    return promise;
  }

  async isPlanAuthenticated(): Promise<boolean> {
    return isClaudePlanAuth((await this.read()).authStatus);
  }

  /** Drop both the settled snapshot and ownership of any older in-flight probe. */
  invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  private async readFresh(generation: number): Promise<ClaudeCodeProbeResult> {
    try {
      const binaryPath = await this.resolveExecutable(this.binaryPath);
      const authStatus = await this.readAuthStatus(binaryPath);
      if (generation !== this.generation) return this.read();
      const value = { binaryPath, authStatus };
      this.cached = { outcome: { ok: true, value }, expiresAt: this.now() + this.ttlMs };
      return value;
    } catch (error) {
      // An invalidation is a state boundary. Even callers already awaiting the
      // old generation must observe the new generation, never its stale result.
      if (generation !== this.generation) return this.read();
      this.cached = { outcome: { ok: false, error }, expiresAt: this.now() + this.ttlMs };
      throw error;
    }
  }

  private clearInFlight(promise: Promise<ClaudeCodeProbeResult>): void {
    if (this.inFlight?.promise === promise) this.inFlight = undefined;
  }
}

function claudeSessionMetadataName(conversationId: string): string {
  requireRawConversationId(conversationId);
  const digest = createHash("sha256").update(conversationId).digest("hex");
  return `${CLAUDE_SESSION_PREFIX}${digest}${CLAUDE_SESSION_SUFFIX}`;
}

export function claudeSessionMetadataPath(
  sessionDir: string,
  conversationId: string,
): string {
  return join(sessionDir, claudeSessionMetadataName(conversationId));
}

function isBoundedScalarString(value: string, maximum: number): boolean {
  let scalars = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
    scalars += 1;
    if (scalars > maximum) return false;
  }
  return scalars > 0;
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
    || !isValidConversationId(value.conversationId)
    || typeof value.sessionId !== "string"
    || !isBoundedScalarString(value.sessionId, MAX_CLAUDE_CODE_SESSION_ID_SCALARS)
    || typeof value.created !== "string"
    || typeof value.modified !== "string"
    || typeof value.messageCount !== "number"
    || !Number.isSafeInteger(value.messageCount)
    || value.messageCount < 0
    || (value.ownerTurnCount !== undefined
      && (typeof value.ownerTurnCount !== "number"
        || !Number.isSafeInteger(value.ownerTurnCount)
        || value.ownerTurnCount < 0))
    || (value.ownerTurnCount === undefined && value.messageCount % 2 !== 0)) {
    throw new GhostError(
      "claude_session_invalid",
      `${path} does not match the claude-code session metadata contract.`,
      500,
    );
  }
  return {
    ...(value as Omit<ClaudeSessionMetadata, "ownerTurnCount">),
    // Released sidecars predate ownerTurnCount and added exactly two display
    // messages per owner request. Use that once as the migration baseline;
    // every subsequent write persists the independent sequence.
    ownerTurnCount: value.ownerTurnCount ?? Math.floor(value.messageCount / 2),
  };
}

async function readMetadata(
  sessionDir: string,
  conversationId: string,
): Promise<ClaudeSessionMetadata | null> {
  const path = claudeSessionMetadataPath(sessionDir, conversationId);
  try {
    const metadata = parseMetadata(path, await readFile(path, "utf8"));
    if (metadata.conversationId !== conversationId) {
      throw new GhostError(
        "session_identity_mismatch",
        "The stored Claude conversation identity does not match the requested resume id.",
        409,
      );
    }
    return metadata;
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
  const [character, memory, docs] = await Promise.all([
    home.readCharacter(),
    home.listMemory(),
    home.listDocs(),
  ]);
  return buildGhostSystemPrompt({
    ghostName,
    character,
    memory: deriveMemoryIndex(memory.files),
    docs: deriveDocCatalog(docs.docs),
    // A seeded character.md means this ghost has not met its owner yet.
    extraSections: isSeededCharacter(ghostName, readCharacterFile(homeDir))
      ? [FIRST_MEETING_SECTION]
      : [],
  });
}

function unavailableDependency(name: string): never {
  throw new ClaudeCodeProcessError(
    `Ghost tool requested pi runtime dependency ${JSON.stringify(name)} through the Claude Code bridge.`,
  );
}

function unsupportedExtensionApiMethod(name: string): () => never {
  return () => unavailableDependency(`ExtensionAPI.${name}`);
}

interface CapturedToolDefinition {
  name: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  execute: (
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}

function captureToolDefinitions(
  factories: ReturnType<typeof resolveGhostExtensions>["factories"],
): Promise<Map<string, CapturedToolDefinition>> {
  const definitions = new Map<string, CapturedToolDefinition>();
  const onExtensionEvent: ExtensionAPI["on"] = (event) => {
    // buildPersona adapts Ghost's only model hook outside OMP; this bridge
    // captures tools and rejects any other lifecycle dependency explicitly.
    if (event === "before_agent_start") return;
    unavailableDependency(`ExtensionAPI.on(${JSON.stringify(event)})`);
  };
  const registerTool: ExtensionAPI["registerTool"] = (definition) => {
    definitions.set(definition.name, {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: definition.execute,
    });
  };
  const api = {
    get logger(): ExtensionAPI["logger"] {
      return unavailableDependency("ExtensionAPI.logger");
    },
    get typebox(): ExtensionAPI["typebox"] {
      return unavailableDependency("ExtensionAPI.typebox");
    },
    get arktype(): ExtensionAPI["arktype"] {
      return unavailableDependency("ExtensionAPI.arktype");
    },
    get zod(): ExtensionAPI["zod"] {
      return unavailableDependency("ExtensionAPI.zod");
    },
    get pi(): ExtensionAPI["pi"] {
      return unavailableDependency("ExtensionAPI.pi");
    },
    on: onExtensionEvent,
    registerTool,
    registerFileWriteFallback: unsupportedExtensionApiMethod("registerFileWriteFallback"),
    registerFileDeleteFallback: unsupportedExtensionApiMethod("registerFileDeleteFallback"),
    registerCommand: unsupportedExtensionApiMethod("registerCommand"),
    registerShortcut: unsupportedExtensionApiMethod("registerShortcut"),
    registerFlag: unsupportedExtensionApiMethod("registerFlag"),
    setLabel: unsupportedExtensionApiMethod("setLabel"),
    getFlag: unsupportedExtensionApiMethod("getFlag"),
    registerMessageRenderer: unsupportedExtensionApiMethod("registerMessageRenderer"),
    registerAssistantThinkingRenderer: unsupportedExtensionApiMethod(
      "registerAssistantThinkingRenderer",
    ),
    registerComposerShape: unsupportedExtensionApiMethod("registerComposerShape"),
    sendMessage: unsupportedExtensionApiMethod("sendMessage"),
    sendUserMessage: unsupportedExtensionApiMethod("sendUserMessage"),
    appendEntry: unsupportedExtensionApiMethod("appendEntry"),
    exec: unsupportedExtensionApiMethod("exec"),
    getActiveTools() {
      return [...definitions.keys()];
    },
    getAllTools: unsupportedExtensionApiMethod("getAllTools"),
    setActiveTools: unsupportedExtensionApiMethod("setActiveTools"),
    getCommands: unsupportedExtensionApiMethod("getCommands"),
    setModel: unsupportedExtensionApiMethod("setModel"),
    getThinkingLevel: unsupportedExtensionApiMethod("getThinkingLevel"),
    setThinkingLevel: unsupportedExtensionApiMethod("setThinkingLevel"),
    getServiceTiers: unsupportedExtensionApiMethod("getServiceTiers"),
    setServiceTier: unsupportedExtensionApiMethod("setServiceTier"),
    getSessionName: unsupportedExtensionApiMethod("getSessionName"),
    setSessionName: unsupportedExtensionApiMethod("setSessionName"),
    registerProvider: unsupportedExtensionApiMethod("registerProvider"),
    unregisterProvider: unsupportedExtensionApiMethod("unregisterProvider"),
    get events(): ExtensionAPI["events"] {
      return unavailableDependency("ExtensionAPI.events");
    },
  } satisfies ExtensionAPI;
  return Promise.all(factories.map(async (factory) => {
    await factory(api);
  })).then(() => definitions);
}

function signalFromToolExtra(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | null)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function extensionContext(
  cwd: string,
  systemPrompt: string,
): ExtensionContext {
  return {
    get ui(): ExtensionContext["ui"] {
      return unavailableDependency("ExtensionContext.ui");
    },
    mode: "rpc",
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => null,
    compact: () => unavailableDependency("ExtensionContext.compact"),
    hasUI: false,
    cwd,
    get sessionManager(): ExtensionContext["sessionManager"] {
      return unavailableDependency("ExtensionContext.sessionManager");
    },
    get modelRegistry(): ExtensionContext["modelRegistry"] {
      return unavailableDependency("ExtensionContext.modelRegistry");
    },
    // Claude Code has no OMP Model instance. Keep that absence explicit so the
    // bridge never invents registry metadata just to advertise capabilities.
    model: undefined,
    get models(): ExtensionContext["models"] {
      return unavailableDependency("ExtensionContext.models");
    },
    isIdle: () => false,
    abort: () => unavailableDependency("ExtensionContext.abort"),
    hasPendingMessages: () => false,
    shutdown: () => unavailableDependency("ExtensionContext.shutdown"),
    getSystemPrompt: () => [systemPrompt],
    setInterval: () => unavailableDependency("ExtensionContext.setInterval"),
    setTimeout: () => unavailableDependency("ExtensionContext.setTimeout"),
    clearTimer: () => unavailableDependency("ExtensionContext.clearTimer"),
    // OMP's compatibility contract always reports true because project-local
    // inputs have already been loaded unconditionally by the runtime; see OMP
    // 18.0.3 src/extensibility/extensions/types.ts (`isProjectTrusted`).
    isProjectTrusted: () => true,
  } satisfies ExtensionContext;
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

function zodShapeFor(definition: CapturedToolDefinition): Record<string, z.ZodType> {
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
  const resolved = resolveGhostExtensions(
    {
      ...extensionOptions,
      ghostName,
      browserMode,
      ...(relayTransport ? { relayTransport } : {}),
    },
    homeDir,
    CLAUDE_CODE_TOOL_CAPABILITIES,
  );
  const tools = await bridgeClaudeCodeTools(
    resolved,
    homeDir,
    systemPrompt,
  );
  return { tools, names: resolved.toolNames };
}

/** Adapt Ghost's OMP-neutral extension tools to in-process Claude SDK MCP tools. */
export async function bridgeClaudeCodeTools(
  resolved: ReturnType<typeof resolveGhostExtensions>,
  homeDir: string,
  systemPrompt: string,
): Promise<SdkMcpToolDefinition[]> {
  const definitions = await captureToolDefinitions(resolved.factories);
  return resolved.toolNames.map((name): SdkMcpToolDefinition => {
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
            args as never,
            signalFromToolExtra(extra),
            undefined,
            extensionContext(homeDir, systemPrompt),
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
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: input.systemPrompt,
    },
    title: `${input.ghostName} in Ghost`,
    skills: "all",
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: input.toolNames.map((name) => `mcp__ghost__${name}`),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
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
  abortController: AbortController;
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
      input.abortController.abort();
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

/** The ghost half of a `JSON.stringify([ghostName, conversationId])` key. */
function runtimeKeyGhost(key: string): string {
  return (JSON.parse(key) as [string, string])[0];
}

function linkedTurnSignal(
  external: AbortSignal | undefined,
  lifecycle: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!external) return { signal: lifecycle, dispose: () => {} };
  const controller = new AbortController();
  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onExternal = () => forward(external);
  const onLifecycle = () => forward(lifecycle);
  if (external.aborted) forward(external);
  else external.addEventListener("abort", onExternal, { once: true });
  if (lifecycle.aborted) forward(lifecycle);
  else lifecycle.addEventListener("abort", onLifecycle, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      external.removeEventListener("abort", onExternal);
      lifecycle.removeEventListener("abort", onLifecycle);
    },
  };
}

export class ClaudeCodeRuntime {
  private readonly logger: Logger;
  private readonly extensionOptions: GhostExtensionOptions;
  private readonly browserMode: "relay" | "profile";
  private readonly relayTransport: RelayTransport | undefined;
  private readonly createQuery: ClaudeCodeQueryFactory;
  private readonly probe: ClaudeCodeProbe;
  private readonly hooks: GhostHookRunner;
  private readonly busy = new Set<string>();
  private readonly active = new Map<
    string,
    { query: Query; abortController: AbortController }
  >();
  private readonly turns = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private disposed = false;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.extensionOptions = options.extensionOptions ?? {};
    this.browserMode = options.browserMode ?? "relay";
    this.relayTransport = options.relayTransport;
    this.createQuery = options.createQuery
      ?? ((input) => query({ prompt: input.prompt, options: input.options }));
    this.probe = options.probe ?? new ClaudeCodeProbe({
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      ...(options.resolveExecutable ? { resolveExecutable: options.resolveExecutable } : {}),
      ...(options.readAuthStatus ? { readAuthStatus: options.readAuthStatus } : {}),
    });
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
  }

  invalidateAuthProbe(): void {
    this.probe.invalidate();
  }

  private assertTurnAdmitted(): void {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
  }

  isBusy(ghostName: string, conversationId: string): boolean {
    return this.busy.has(JSON.stringify([ghostName, conversationId]));
  }

  /** True while ANY conversation of this ghost is mid-turn. */
  isGhostBusy(ghostName: string): boolean {
    for (const key of this.busy) {
      if (runtimeKeyGhost(key) === ghostName) return true;
    }
    return false;
  }

  runTurn(
    ghost: Ghost,
    conversationId: string,
    modelId: string,
    options: RunTurnOptions,
  ): Promise<void> {
    this.assertTurnAdmitted();
    requireRawConversationId(conversationId);
    const key = JSON.stringify([ghost.name, conversationId]);
    if (this.busy.has(key)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }
    this.busy.add(key);
    const controller = new AbortController();
    const linked = linkedTurnSignal(options.signal, controller.signal);
    let promise!: Promise<void>;
    promise = Promise.resolve()
      .then(() => this.runAdmittedTurn(
        ghost,
        conversationId,
        modelId,
        { ...options, signal: linked.signal },
        key,
      ))
      .finally(() => {
        linked.dispose();
        this.active.delete(key);
        this.busy.delete(key);
        if (this.turns.get(key)?.promise === promise) this.turns.delete(key);
      });
    this.turns.set(key, { controller, promise });
    return promise;
  }

  private async runAdmittedTurn(
    ghost: Ghost,
    conversationId: string,
    modelId: string,
    options: RunTurnOptions,
    key: string,
  ): Promise<void> {
    const adapter = createClaudePiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
    });
    try {
      const { binaryPath, authStatus: auth } = await this.probe.read();
      this.assertTurnAdmitted();
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
      this.assertTurnAdmitted();
      let metadata = await readMetadata(paths.sessionDir, conversationId);
      this.assertTurnAdmitted();
      const ownerTurnCount = metadata?.ownerTurnCount ?? 0;
      if (ownerTurnCount >= Number.MAX_SAFE_INTEGER) {
        throw new ClaudeCodeProcessError("Claude Code's owner turn count overflowed.");
      }
      const ownerTurnId = ownerTurnCount + 1;
      const systemPrompt = await buildPersona(paths.home, ghost.name);
      this.assertTurnAdmitted();
      let beforePromptContext: string | undefined;
      if (this.hooks.hasHandlers("before_prompt")) {
        const result = await this.hooks.emitBeforePrompt({
          type: "before_prompt",
          prompt: options.prompt,
          turn_id: ownerTurnId,
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
        this.assertTurnAdmitted();
      }
      const bridge = await buildMcpTools(
        paths.home,
        ghost.name,
        systemPrompt,
        this.extensionOptions,
        this.browserMode,
        this.relayTransport,
      );
      this.assertTurnAdmitted();

      let prompt = options.prompt;
      let stopHookActive = false;
      let continuationCount = 0;
      while (!adapter.isTerminal()) {
        this.assertTurnAdmitted();
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
          abortController,
          signal: options.signal,
          onQuery: (active) => {
            if (active) this.active.set(key, { query: active, abortController });
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
        this.assertTurnAdmitted();

        if (!terminalResult) {
          throw new ClaudeCodeProcessError("Claude Code ended without a terminal result.");
        }
        const completed = terminalResult as SDKResultMessage;
        if (!Number.isSafeInteger(completed.num_turns) || completed.num_turns < 0) {
          throw new ClaudeCodeProcessError("Claude Code returned an invalid num_turns count.");
        }
        if (!isBoundedScalarString(completed.session_id, MAX_CLAUDE_CODE_SESSION_ID_SCALARS)) {
          throw new ClaudeCodeProcessError("Claude Code returned an invalid session id.");
        }
        const messageCount = (metadata?.messageCount ?? 0) + (completed.num_turns * 2);
        if (!Number.isSafeInteger(messageCount)) {
          throw new ClaudeCodeProcessError("Claude Code's cumulative message count overflowed.");
        }
        const now = new Date().toISOString();
        metadata = {
          version: 1,
          runtime: "claude-code",
          conversationId,
          sessionId: completed.session_id,
          created: metadata?.created ?? now,
          modified: now,
          messageCount,
          ownerTurnCount: ownerTurnId,
        };
        this.assertTurnAdmitted();
        await writeMetadata(paths.sessionDir, metadata);
        this.assertTurnAdmitted();
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
            turn_id: ownerTurnId,
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
        this.assertTurnAdmitted();
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
        adapter.finishError(cause, options.signal?.aborted === true || this.disposed);
      }
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
      try {
        const metadata = parseMetadata(path, await readFile(path, "utf8"));
        if (!CLAUDE_SESSION_FILE_PATTERN.test(name)
          || claudeSessionMetadataName(metadata.conversationId) !== name) {
          throw new GhostError(
            "session_identity_mismatch",
            "The stored Claude conversation identity does not match its sidecar filename.",
            409,
          );
        }
        result.push(metadata);
      } catch (cause) {
        this.logger.warn("skipping invalid Claude Code session metadata", {
          path,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  /** Close every live query of one ghost, across its conversations. */
  async closeGhost(ghostName: string): Promise<void> {
    for (const key of [...this.active.keys()]) {
      const [keyGhost, conversationId] = JSON.parse(key) as [string, string];
      if (keyGhost !== ghostName) continue;
      await this.close(ghostName, conversationId);
    }
  }

  async close(ghostName: string, conversationId: string): Promise<void> {
    const key = JSON.stringify([ghostName, conversationId]);
    const active = this.active.get(key);
    if (!active) return;
    this.active.delete(key);
    active.abortController.abort();
    try {
      await active.query.interrupt();
    } finally {
      active.query.close();
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
    const turns = [...this.turns.values()];
    const shutdown = new GhostError("shutting_down", "The daemon is shutting down.", 503);
    for (const turn of turns) turn.controller.abort(shutdown);
    await Promise.allSettled(turns.map(({ promise }) => promise));
  }
}
