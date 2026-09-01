/**
 * Owner-local Claude Code runtime.
 *
 * The official Claude Agent SDK drives an
 * installed, unmodified `claude` executable which reads the owner's
 * Claude Code login. Ghost never asks for, reads, stores, or proxies Claude
 * credentials. The Effect lifecycle below is adapted from T3 Code's MIT-
 * licensed Claude adapter (`apps/server/src/provider/Layers/ClaudeAdapter.ts`).
 *
 * One conversation keeps one streamed query warm across owner turns. Its
 * character and private-memory index are session-start state; idle expiry
 * or an explicit close drops both the query and that snapshot, and Claude's
 * opaque session id supplies continuity when the next query resumes cold.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  open as openFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SdkMcpToolDefinition,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
  McpServerConfig as ClaudeMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { AskBroker, AskBrokerError, type PendingAsk } from "./ask-broker.js";
import {
  AskCancelledError,
  isAskToolInput,
  resolveAskUserQuestion,
} from "./ask-tool.js";
import {
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "./claude-agent-sdk-loader.js";
import type {
  MCPHttpServerConfig as OmpMcpHttpServerConfig,
  MCPSseServerConfig as OmpMcpSseServerConfig,
  MCPServerConfig as OmpMcpServerConfig,
  MCPStdioServerConfig as OmpMcpStdioServerConfig,
} from "./mcp-config.js";
import { validateServerName } from "./mcp-config.js";
import {
  buildGhostSystemPrompt,
  collectGhostExtension,
  deriveMemoryIndex,
  openGhostHome,
  openRegularFileNoFollow,
  type GhostToolCapabilities,
  type AnyGhostToolDefinition,
  type CollectedGhostExtension,
  type GhostToolContext,
  type GhostToolResult,
} from "@ghost/extensions";
import * as z from "zod";
import { createClaudePiMessagesAdapter } from "./claude-pi-messages.js";
import {
  isValidConversationId,
  requireRawConversationId,
} from "./conversation-identity.js";
import {
  captureClaudeCodeEnvironment,
  captureNativeHarnessEnvironment,
} from "./env-scrub.js";
import {
  inspectNativeHarnessExecutable,
  NativeHarnessIdentityError,
  resolveNativeHarnessExecutable,
  type NativeHarnessExecutable,
} from "./native-harness-identity.js";
import {
  claudeSdkScriptLaunch,
  claudeSdkSpawnLaunch,
} from "./claude-sdk-launch.js";
import {
  ownedProcessGroupExists,
  runOwnedCommand,
  terminateOwnedProcessGroup,
  type OwnedCommandResult,
} from "./owned-process.js";
import { GhostHookRunner, ghostSessionStopContinuation } from "./hooks.js";
import {
  resolveGhostExtensions,
  type GhostExtensionOptions,
} from "./extensions.js";
import { FIRST_MEETING_SECTION } from "./greeting.js";
import {
  GhostError,
  ghostPaths,
  isSeededCharacter,
  type Ghost,
} from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  loadMachineSkills,
  machineSkillPaths,
  OMARCHY_COMPUTER_USE_POLICY,
  OWNER_DELIVERABLE_POLICY,
  SHARED_OBSIDIAN_POLICY,
} from "./machine-skills.js";
import {
  renderScheduledWorkPolicy,
  resolveScheduleUnitDirectory,
} from "./schedules.js";
import type { SettledMaintenanceTurn } from "./conversation-maintenance.js";
import type { EffectiveProjectMcpRead } from "./mcp-catalog.js";
import {
  createPrincipalTaskTools,
  PRINCIPAL_TASK_POLICY,
  PRINCIPAL_TASK_TOOL_NAMES,
  type PrincipalTaskContext,
} from "./principal-task-tools.js";
import type { RunTurnOptions } from "./session-host.js";
import { claudeSessionMetadataPath as nativeClaudeSessionMetadataPath } from "./session-files.js";
import {
  loadProjectDeclarativeSnapshot,
  type ProjectFilesystemIdentity,
} from "./project-resources.js";
import {
  declarativePromptSnapshot,
  mergeDeclarativePromptSnapshots,
  mergeProjectDeclarativeSnapshots,
  renderClaudeDeclarativePrompt,
  type DeclarativePromptSnapshot,
} from "./declarative-snapshot.js";
import { parseFrontmatter } from "./declarative-types.js";
import {
  buildSessionResourceView,
  projectSessionSkillGroup,
  type SessionMcpView,
  type SessionResourceDiagnostic,
  type SessionResourceView,
  type SessionSkillGroup,
} from "./session-resources.js";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_DEFAULT_MODEL_ID = "default";
export const CLAUDE_CODE_BINARY_ENV = "GHOST_CLAUDE_BINARY";
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.251";
export const CLAUDE_CODE_PROBE_TTL_MS = 5_000;
export const MAX_CLAUDE_CODE_PROBE_TTL_MS = 30_000;
export const CLAUDE_CODE_EXIT_WAIT_TIMEOUT_MS = 10_000;

const CLAUDE_SESSION_PREFIX = "claude-";
const CLAUDE_SESSION_SUFFIX = ".json";
const CLAUDE_SESSION_FILE_PATTERN = /^claude-[0-9a-f]{64}\.json$/u;
const MAX_CLAUDE_CODE_SESSION_ID_SCALARS = 512;
const MODEL_TURN_PERSISTENCE_ERROR = "Could not durably settle this owner turn.";
export const CLAUDE_SESSION_METADATA_MAX_BYTES = 16 * 1_048_576;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const AUTH_STATUS_METADATA_MAX_SCALARS = 128;
const AUTH_STATUS_IDENTITY_MAX_SCALARS = 512;
const CLAUDE_QUERY_TERM_GRACE_MS = 500;
const CLAUDE_QUERY_KILL_CONFIRM_MS = 2_000;
const CLAUDE_CODE_AUTH_STATUS_ARGS = [
  "--setting-sources",
  "",
  "--safe-mode",
  "--strict-mcp-config",
  "auth",
  "status",
  "--json",
] as const;
export const CLAUDE_CODE_TOOL_CAPABILITIES: GhostToolCapabilities = { vision: true };
export interface ClaudeCodeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  /** Private fixed-size hash used only to decide whether a warm query is reusable. */
  accountFingerprint?: string;
}

export interface ClaudeSessionMetadata {
  version: 1 | 2 | 3;
  runtime: "claude-code";
  conversationId: string;
  sessionId: string;
  created: string;
  modified: string;
  messageCount: number;
  ownerTurnCount: number;
  cwd?: string;
  projectSnapshot?: ClaudePersistedProjectSnapshot;
}

type LoadedClaudeSessionMetadata = ClaudeSessionMetadata & { resumeBlocked?: true };

export interface ClaudePersistedProjectSnapshot {
  root: string | null;
  identity?: ProjectFilesystemIdentity;
  declarative: DeclarativePromptSnapshot;
  mcpServers: Record<string, ClaudeMcpServerConfig>;
  mcpResources?: ClaudeMcpResourceSnapshot[];
  resourceWarnings: string[];
  mcpWarnings: string[];
}

export interface ClaudeMcpResourceSnapshot {
  name: string;
  path: string;
  status: "admitted" | "skipped" | "disabled";
  reason?: string;
}

function mcpServerRecord<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  // Object.fromEntries defines every name as an own data property, including
  // JavaScript's inherited object names. Never assign an untrusted MCP name
  // through an ordinary `{}` dictionary.
  return Object.fromEntries(entries) as Record<string, T>;
}

export interface ClaudeProjectSnapshot {
  root: string | null;
  cwd: string;
  identity?: ProjectFilesystemIdentity;
  admittedSnapshot?: ClaudePersistedProjectSnapshot;
  reportStatus?: (input: {
    status: "ready" | "degraded";
    error: { code: string; message: string } | null;
    mcpStatus: "off" | "ready" | "degraded";
  }) => Promise<void>;
}

export interface ClaudeCodeQueryInput {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}

export type ClaudeCodeQueryFactory = (input: ClaudeCodeQueryInput) => Query;
export type ClaudeCodeQueryExitObserver = (query: Query) => Promise<void>;

export interface ClaudeCodeProbeResult {
  binaryPath: string;
  executableIdentity: string;
  interpreter?: NativeHarnessExecutable;
  cliVersion: string;
  authStatus: ClaudeCodeAuthStatus;
}

export interface ClaudeCodeProbeOptions {
  /** `null` deliberately disables the ambient selector fallback. */
  binaryPath?: string | null;
  environment?: Readonly<NodeJS.ProcessEnv>;
  environmentProfile?: "principal" | "native";
  ttlMs?: number;
  now?: () => number;
  resolveExecutable?: (
    binaryPath: string | undefined,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal?: AbortSignal,
  ) => Promise<string>;
  inspectExecutable?: (
    binaryPath: string,
    literalBoundary: boolean,
    signal?: AbortSignal,
  ) => Promise<string>;
  readVersion?: (
    binaryPath: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal?: AbortSignal,
    launch?: ClaudeCodeCommandLaunch,
  ) => Promise<string>;
  readAuthStatus?: (
    binaryPath: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal?: AbortSignal,
    launch?: ClaudeCodeCommandLaunch,
  ) => Promise<ClaudeCodeAuthStatus>;
  loadSdk?: (signal?: AbortSignal) => Promise<ClaudeAgentSdkModule>;
}

export interface ClaudeCodeRuntimeOptions {
  ownerHome?: string;
  scheduleUnitDir?: string;
  machineSkillPaths?: readonly string[];
  logger?: Logger;
  extensionOptions?: GhostExtensionOptions;
  binaryPath?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  createQuery?: ClaudeCodeQueryFactory;
  readVersion?: ClaudeCodeProbeOptions["readVersion"];
  readAuthStatus?: ClaudeCodeProbeOptions["readAuthStatus"];
  resolveExecutable?: ClaudeCodeProbeOptions["resolveExecutable"];
  probe?: ClaudeCodeProbe;
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
  hooks?: GhostHookRunner;
  /** Idle lifetime of a query/persona session; tests drive it down. */
  warmIdleTtlMs?: number;
  /** Test seam for the SDK subprocess exit boundary. */
  observeQueryExit?: ClaudeCodeQueryExitObserver;
  /** Maximum close wait for an acknowledged SDK subprocess exit. */
  exitWaitTimeoutMs?: number;
  /** Daemon-owned ask deadline, read at invocation time; 0 waits forever. */
  askTimeoutMs?: () => number;
}

export class ClaudeCodeProcessError extends Error {
  readonly _tag = "ClaudeCodeProcessError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeCodeProcessError";
  }
}

export interface ClaudeCodeCommandLaunch {
  executable: string;
  prefixArguments: readonly string[];
}

export interface ClaudeCodeCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  launch?: ClaudeCodeCommandLaunch;
}

function claudeCodeCommand(
  binaryPath: string,
  args: readonly string[],
  launch: ClaudeCodeCommandLaunch | undefined,
): { executable: string; args: string[] } {
  return launch
    ? { executable: launch.executable, args: [...launch.prefixArguments, ...args] }
    : { executable: binaryPath, args: [...args] };
}

function authStatusMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const scalars = [...trimmed];
  if (!trimmed || scalars.length > AUTH_STATUS_METADATA_MAX_SCALARS) return undefined;
  if (scalars.some((scalar) => {
    const codePoint = scalar.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) return undefined;
  return trimmed;
}

function authIdentityScalar(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const scalars = [...trimmed];
  if (!trimmed || scalars.length > AUTH_STATUS_IDENTITY_MAX_SCALARS) return undefined;
  if (scalars.some((scalar) => {
    const codePoint = scalar.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) return undefined;
  return trimmed;
}

function accountFingerprint(status: Record<string, unknown>): string | undefined {
  const primaryFields = ["accountUuid", "accountId", "userId", "email"] as const;
  const primary = primaryFields.flatMap((name) => {
    const value = authIdentityScalar(status[name]);
    return value ? [[name, value] as const] : [];
  });
  if (primary.length === 0) return undefined;
  const contextFields = ["orgId", "organizationUuid"] as const;
  const context = contextFields.flatMap((name) => {
    const value = authIdentityScalar(status[name]);
    return value ? [[name, value] as const] : [];
  });
  return createHash("sha256").update(JSON.stringify([primary, context])).digest("hex");
}

async function inspectClaudeCodeExecutable(
  binaryPath: string,
  literalBoundary: boolean,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await inspectNativeHarnessExecutable(binaryPath, literalBoundary, signal);
  } catch (error) {
    throw new ClaudeCodeProcessError("Claude Code executable identity is invalid.", { cause: error });
  }
}

/** Linux/Omarchy subset of T3's executable-resolution seam. */
export async function resolveClaudeCodeExecutable(
  binaryPath: string | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = captureClaudeCodeEnvironment(),
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Claude Code executable timeout must be a finite positive number.");
  }
  try {
    return (await resolveNativeHarnessExecutable({
      harness: "claude-code",
      ...(binaryPath === undefined ? {} : { explicitBinary: binaryPath }),
      environment,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })).path;
  } catch (error) {
    if (error instanceof NativeHarnessIdentityError && error.reason === "unavailable") {
      const selectedBinary = binaryPath ?? "claude";
      throw new GhostError(
        "claude_code_missing",
        `Claude Code is not installed at ${JSON.stringify(selectedBinary)}. Install the official `
          + `Claude Code CLI, then run \`claude auth login\`. Override the executable with `
          + `${CLAUDE_CODE_BINARY_ENV} when needed.`,
        503,
      );
    }
    if (error instanceof NativeHarnessIdentityError && error.reason === "mise") {
      throw new ClaudeCodeProcessError(
        "Claude Code launcher delegates to mise, but Ghost could not resolve mise's underlying "
          + "Claude executable.",
        { cause: error },
      );
    }
    throw new ClaudeCodeProcessError("Failed to resolve the Claude Code executable.", {
      cause: error,
    });
  }
}

function authStatusFromJson(raw: string): ClaudeCodeAuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeCodeProcessError("`claude auth status --json` returned invalid JSON.");
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
  const authMethod = authStatusMetadata(status.authMethod);
  const apiProvider = authStatusMetadata(status.apiProvider);
  const subscriptionType = authStatusMetadata(status.subscriptionType);
  const result: ClaudeCodeAuthStatus = {
    loggedIn: status.loggedIn,
    ...(authMethod ? { authMethod } : {}),
    ...(apiProvider ? { apiProvider } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
  };
  const fingerprint = accountFingerprint(status);
  if (fingerprint) {
    Object.defineProperty(result, "accountFingerprint", { value: fingerprint });
  }
  return result;
}

export async function readClaudeCodeAuthStatus(
  binaryPath: string,
  environment: Readonly<NodeJS.ProcessEnv> = captureClaudeCodeEnvironment(),
  options: ClaudeCodeCommandOptions = {},
): Promise<ClaudeCodeAuthStatus> {
  const timeoutMs = options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Claude Code auth status timeout must be a finite positive number.");
  }

  let result: OwnedCommandResult;
  try {
    const command = claudeCodeCommand(
      binaryPath,
      CLAUDE_CODE_AUTH_STATUS_ARGS,
      options.launch,
    );
    result = await runOwnedCommand(command.executable, command.args, {
      environment,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ClaudeCodeProcessError("Failed to read Claude Code authentication status.");
  }

  if (result.signal || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new ClaudeCodeProcessError("Failed to read Claude Code authentication status.");
  }
  const exitCode = result.exitCode;
  const status = authStatusFromJson(result.stdout);
  if (status.loggedIn !== (exitCode === 0)) {
    throw new ClaudeCodeProcessError(
      `Claude Code authentication status disagreed with exit ${exitCode}.`,
    );
  }
  return status;
}

function versionAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = version[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

export async function readClaudeCodeVersion(
  binaryPath: string,
  environment: Readonly<NodeJS.ProcessEnv> = captureClaudeCodeEnvironment(),
  options: ClaudeCodeCommandOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Claude Code version timeout must be a finite positive number.");
  }
  let result: OwnedCommandResult;
  try {
    const command = claudeCodeCommand(binaryPath, ["--version"], options.launch);
    result = await runOwnedCommand(command.executable, command.args, {
      environment,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ClaudeCodeProcessError("Failed to read Claude Code version.");
  }
  if (result.exitCode !== 0 || result.signal) {
    throw new ClaudeCodeProcessError("Failed to read Claude Code version.");
  }
  const match = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8}) \(Claude Code\)\n?$/u
    .exec(result.stdout);
  if (!match) {
    throw new ClaudeCodeProcessError("`claude --version` returned an invalid stable version.");
  }
  const version = match.slice(1, 4).map(Number);
  const minimum = CLAUDE_CODE_MINIMUM_VERSION.split(".").map(Number);
  if (!versionAtLeast(version, minimum)) {
    throw new ClaudeCodeProcessError(
      `Claude Code ${match[1]}.${match[2]}.${match[3]} is older than required `
        + `${CLAUDE_CODE_MINIMUM_VERSION}.`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function isClaudeCodeAuthenticated(status: ClaudeCodeAuthStatus): boolean {
  return status.loggedIn;
}

/** Non-secret CLI metadata for the catalogue; never an authorization list. */
export function claudeCodeConnectionMethod(status: ClaudeCodeAuthStatus): string {
  return authStatusMetadata(status.apiProvider)
    ?? authStatusMetadata(status.authMethod)
    ?? "external";
}

/** Bounded display metadata from the native CLI; never a billing decision. */
export function claudeCodeSubscriptionType(
  status: ClaudeCodeAuthStatus,
): string | undefined {
  return authStatusMetadata(status.subscriptionType);
}

function claudeCodeAuthenticationIdentity(status: ClaudeCodeAuthStatus): string {
  return JSON.stringify([
    status.loggedIn,
    authStatusMetadata(status.authMethod) ?? null,
    authStatusMetadata(status.apiProvider) ?? null,
    authStatusMetadata(status.subscriptionType) ?? null,
    /^[0-9a-f]{64}$/u.test(status.accountFingerprint ?? "")
      ? status.accountFingerprint
      : null,
  ]);
}

function claudeCodeRuntimeIdentity(
  binaryPath: string,
  executableIdentity: string,
  cliVersion: string,
  status: ClaudeCodeAuthStatus,
  interpreter?: NativeHarnessExecutable,
): string {
  return JSON.stringify([
    binaryPath,
    executableIdentity,
    interpreter?.identity ?? null,
    cliVersion,
    claudeCodeAuthenticationIdentity(status),
  ]);
}

/**
 * One short-lived snapshot of the external Claude executable and auth state.
 * Successful probes (including logged-out state) are cached; process failures
 * are cached for the same bounded lifetime so a polling catalogue cannot spin
 * up a failing process on every request.
 */
export class ClaudeCodeProbe {
  private readonly binaryPath: string | undefined;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly resolveExecutable: NonNullable<ClaudeCodeProbeOptions["resolveExecutable"]>;
  private readonly inspectExecutable: NonNullable<ClaudeCodeProbeOptions["inspectExecutable"]>;
  private readonly readVersion: NonNullable<ClaudeCodeProbeOptions["readVersion"]>;
  private readonly readAuthStatus: NonNullable<ClaudeCodeProbeOptions["readAuthStatus"]>;
  private readonly loadSdk: ClaudeCodeProbeOptions["loadSdk"];
  private generation = 0;
  private cached?: {
    outcome:
      | { ok: true; value: ClaudeCodeProbeResult }
      | { ok: false; error: unknown };
    expiresAt: number;
  };
  private inFlight?: { generation: number; promise: Promise<ClaudeCodeProbeResult> };
  private turnInFlight?: Promise<ClaudeCodeProbeResult>;

  constructor(options: ClaudeCodeProbeOptions = {}) {
    const configuredBinary = options.binaryPath === null
      ? undefined
      : options.binaryPath ?? process.env[CLAUDE_CODE_BINARY_ENV];
    this.binaryPath = configuredBinary;
    this.environment = options.environmentProfile === "native"
      ? captureNativeHarnessEnvironment("claude-native", options.environment ?? process.env)
      : captureClaudeCodeEnvironment(options.environment ?? process.env);
    this.ttlMs = options.ttlMs ?? CLAUDE_CODE_PROBE_TTL_MS;
    if (!Number.isFinite(this.ttlMs)
      || this.ttlMs <= 0
      || this.ttlMs > MAX_CLAUDE_CODE_PROBE_TTL_MS) {
      throw new RangeError(
        `Claude Code probe ttlMs must be finite and in (0, ${MAX_CLAUDE_CODE_PROBE_TTL_MS}]`,
      );
    }
    this.now = options.now ?? Date.now;
    this.resolveExecutable = options.resolveExecutable ?? ((binaryPath, environment, signal) =>
      resolveClaudeCodeExecutable(binaryPath, environment, signal ? { signal } : {}));
    this.inspectExecutable = options.inspectExecutable ?? inspectClaudeCodeExecutable;
    this.readVersion = options.readVersion ?? ((binaryPath, environment, signal, launch) =>
      readClaudeCodeVersion(binaryPath, environment, {
        ...(signal ? { signal } : {}),
        ...(launch ? { launch } : {}),
      }));
    this.readAuthStatus = options.readAuthStatus ?? ((binaryPath, environment, signal, launch) =>
      readClaudeCodeAuthStatus(binaryPath, environment, {
        ...(signal ? { signal } : {}),
        ...(launch ? { launch } : {}),
      }));
    this.loadSdk = options.loadSdk;
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

  async isAuthenticated(): Promise<boolean> {
    return isClaudeCodeAuthenticated((await this.read()).authStatus);
  }

  /** Turn admission bypasses the catalogue TTL; unsignalled principal reads may coalesce. */
  readForTurn(signal?: AbortSignal): Promise<ClaudeCodeProbeResult> {
    if (signal) return this.probe(signal);
    if (this.turnInFlight) return this.turnInFlight;
    this.invalidate();
    const promise = this.read();
    this.turnInFlight = promise;
    void promise.then(
      () => {
        if (this.turnInFlight === promise) this.turnInFlight = undefined;
      },
      () => {
        if (this.turnInFlight === promise) this.turnInFlight = undefined;
      },
    );
    return promise;
  }

  async assertExecutable(result: ClaudeCodeProbeResult, signal?: AbortSignal): Promise<void> {
    if (result.interpreter) {
      const interpreter = await this.inspectExecutable(
        result.interpreter.path,
        true,
        signal,
      );
      if (interpreter !== result.interpreter.identity) {
        throw new ClaudeCodeProcessError("Claude Code interpreter changed after authentication.");
      }
    }
    const current = await this.inspectExecutable(
      result.binaryPath,
      this.binaryPath !== undefined,
      signal,
    );
    if (current !== result.executableIdentity) {
      throw new ClaudeCodeProcessError("Claude Code executable changed after authentication.");
    }
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  private async readFresh(generation: number): Promise<ClaudeCodeProbeResult> {
    try {
      const value = await this.probe();
      if (generation !== this.generation) return this.read();
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

  private async probe(signal?: AbortSignal): Promise<ClaudeCodeProbeResult> {
    this.assertProbeActive(signal);
    await this.loadSdk?.(signal);
    this.assertProbeActive(signal);
    const binaryPath = await this.resolveExecutable(this.binaryPath, this.environment, signal);
    this.assertProbeActive(signal);
    const executableIdentity = await this.inspectExecutable(
      binaryPath,
      this.binaryPath !== undefined,
      signal,
    );
    this.assertProbeActive(signal);
    const scriptLaunch = claudeSdkScriptLaunch(binaryPath);
    const interpreter = scriptLaunch
      ? Object.freeze({
          path: scriptLaunch.executable,
          identity: await this.inspectExecutable(scriptLaunch.executable, true, signal),
          literalBoundary: true,
        })
      : undefined;
    this.assertProbeActive(signal);
    const cliVersion = await this.readVersion(binaryPath, this.environment, signal, scriptLaunch);
    this.assertProbeActive(signal);
    if (interpreter) {
      const phaseInterpreter = await this.inspectExecutable(
        interpreter.path,
        true,
        signal,
      );
      if (phaseInterpreter !== interpreter.identity) {
        throw new ClaudeCodeProcessError("Claude Code interpreter changed between probes.");
      }
    }
    const phaseExecutable = await this.inspectExecutable(
      binaryPath,
      this.binaryPath !== undefined,
      signal,
    );
    if (phaseExecutable !== executableIdentity) {
      throw new ClaudeCodeProcessError("Claude Code executable changed between probes.");
    }
    this.assertProbeActive(signal);
    const authStatus = await this.readAuthStatus(binaryPath, this.environment, signal, scriptLaunch);
    this.assertProbeActive(signal);
    if (interpreter) {
      const confirmedInterpreter = await this.inspectExecutable(
        interpreter.path,
        true,
        signal,
      );
      if (confirmedInterpreter !== interpreter.identity) {
        throw new ClaudeCodeProcessError("Claude Code interpreter changed during authentication.");
      }
    }
    const confirmedIdentity = await this.inspectExecutable(
      binaryPath,
      this.binaryPath !== undefined,
      signal,
    );
    this.assertProbeActive(signal);
    if (confirmedIdentity !== executableIdentity) {
      throw new ClaudeCodeProcessError("Claude Code executable changed during authentication.");
    }
    return {
      binaryPath,
      executableIdentity,
      cliVersion,
      authStatus,
      ...(interpreter ? { interpreter } : {}),
    };
  }

  private assertProbeActive(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new ClaudeCodeProcessError("Claude Code probe was aborted.");
  }

  private clearInFlight(promise: Promise<ClaudeCodeProbeResult>): void {
    if (this.inFlight?.promise === promise) this.inFlight = undefined;
  }
}

export function claudeSessionMetadataPath(
  sessionDir: string,
  conversationId: string,
): string {
  return nativeClaudeSessionMetadataPath(sessionDir, conversationId);
}

export function claudeSessionResumeMarkerPaths(
  sessionDir: string,
  conversationId: string,
): { started: string; settling: string } {
  const sidecar = claudeSessionMetadataPath(sessionDir, conversationId);
  return { started: `${sidecar}.started`, settling: `${sidecar}.settling` };
}

/**
 * The Claude Code SDK's own session transcript for a resume id, when it exists.
 * The SDK persists under `$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<id>.jsonl`;
 * the directory name encoding is the SDK's, so the file is located by id.
 */
export function claudeSdkTranscriptPath(
  sessionId: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string | undefined {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(sessionId)) return undefined;
  const projects = join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
    "projects",
  );
  let directories: string[];
  try {
    directories = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const candidate = join(projects, directory, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringRecord(value: unknown): value is Record<string, string> {
  const row = objectRecord(value);
  return row !== null && Object.values(row).every((entry) => typeof entry === "string");
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

const CLAUDE_MCP_STDIO_FIELDS = new Set([
  "type",
  "command",
  "args",
  "env",
  "timeout",
  "alwaysLoad",
]);
const CLAUDE_MCP_REMOTE_FIELDS = new Set([
  "type",
  "url",
  "headers",
  "tools",
  "timeout",
  "alwaysLoad",
]);
const CLAUDE_MCP_TOOL_POLICY_FIELDS = new Set(["name", "permission_policy"]);
const CLAUDE_MCP_PERMISSION_POLICIES = new Set([
  "always_allow",
  "always_ask",
  "always_deny",
]);

function validClaudeMcpToolPolicy(value: unknown): boolean {
  const policy = objectRecord(value);
  return policy !== null
    && hasOnlyFields(policy, CLAUDE_MCP_TOOL_POLICY_FIELDS)
    && typeof policy.name === "string"
    && policy.name.length > 0
    && typeof policy.permission_policy === "string"
    && CLAUDE_MCP_PERMISSION_POLICIES.has(policy.permission_policy);
}

function validPersistedClaudeMcpConfig(value: unknown): value is ClaudeMcpServerConfig {
  const config = objectRecord(value);
  if (!config || containsEnvironmentExpansion(config)) return false;
  const type = config.type ?? "stdio";
  if (type === "stdio") {
    return hasOnlyFields(config, CLAUDE_MCP_STDIO_FIELDS)
      && (config.type === undefined || config.type === "stdio")
      && typeof config.command === "string"
      && config.command.length > 0
      && (config.args === undefined || stringArray(config.args))
      && (config.env === undefined
        || (stringRecord(config.env) && Object.keys(config.env).length === 0))
      && optionalNonNegativeNumber(config.timeout)
      && optionalBoolean(config.alwaysLoad);
  }
  if (type !== "http" && type !== "sse") return false;
  if (!hasOnlyFields(config, CLAUDE_MCP_REMOTE_FIELDS)
    || typeof config.url !== "string"
    || (config.headers !== undefined
      && (!stringRecord(config.headers) || Object.keys(config.headers).length > 0))
    || (config.tools !== undefined
      && (!Array.isArray(config.tools) || !config.tools.every(validClaudeMcpToolPolicy)))
    || !optionalNonNegativeNumber(config.timeout)
    || !optionalBoolean(config.alwaysLoad)) {
    return false;
  }
  try {
    const url = new URL(config.url);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

const CLAUDE_METADATA_COMMON_FIELDS = [
  "version",
  "runtime",
  "conversationId",
  "sessionId",
  "created",
  "modified",
  "messageCount",
  "ownerTurnCount",
] as const;
const CLAUDE_METADATA_V1_FIELDS = new Set(CLAUDE_METADATA_COMMON_FIELDS);
const CLAUDE_METADATA_V2_FIELDS = new Set([...CLAUDE_METADATA_COMMON_FIELDS, "cwd"]);
const CLAUDE_METADATA_V3_FIELDS = new Set([
  ...CLAUDE_METADATA_COMMON_FIELDS,
  "cwd",
  "projectSnapshot",
]);
const CLAUDE_RESUME_STARTED_FIELDS = new Set(["version", "runtime", "conversationId"]);
const CLAUDE_PROJECT_SNAPSHOT_FIELDS = new Set([
  "root",
  "identity",
  "declarative",
  "mcpServers",
  "mcpResources",
  "resourceWarnings",
  "mcpWarnings",
]);
const CLAUDE_PROJECT_IDENTITY_FIELDS = new Set(["dev", "ino"]);
const CLAUDE_MCP_RESOURCE_FIELDS = new Set(["name", "path", "status", "reason"]);
const CLAUDE_DECLARATIVE_FIELDS = new Set([
  "instructions",
  "skills",
  "rules",
  "prompts",
  "commands",
]);
const CLAUDE_DECLARATIVE_INSTRUCTION_FIELDS = new Set(["path", "content"]);
const CLAUDE_DECLARATIVE_NAMED_PATH_FIELDS = new Set(["name", "path", "content"]);
const CLAUDE_DECLARATIVE_RULE_FIELDS = new Set([
  "name",
  "path",
  "content",
  "alwaysApply",
]);
const CLAUDE_DECLARATIVE_NAMED_FIELDS = new Set(["name", "content"]);

function uniqueNamedResources(values: readonly unknown[]): boolean {
  const names = new Set<string>();
  for (const value of values) {
    const row = objectRecord(value);
    if (!row || typeof row.name !== "string" || row.name.length === 0 || names.has(row.name)) {
      return false;
    }
    names.add(row.name);
  }
  return true;
}

function validDeclarativePromptSnapshot(value: unknown, root: string | null): boolean {
  const snapshot = objectRecord(value);
  if (!snapshot
    || !hasOnlyFields(snapshot, CLAUDE_DECLARATIVE_FIELDS)
    || !Array.isArray(snapshot.instructions)
    || !Array.isArray(snapshot.skills)
    || !Array.isArray(snapshot.rules)
    || !Array.isArray(snapshot.prompts)
    || !Array.isArray(snapshot.commands)) {
    return false;
  }
  const validPathResource = (
    entry: unknown,
    allowed: ReadonlySet<string>,
    named: boolean,
  ): boolean => {
    const row = objectRecord(entry);
    return Boolean(row
      && hasOnlyFields(row, allowed)
      && (!named || (typeof row.name === "string" && row.name.length > 0))
      && typeof row.path === "string"
      && root !== null
      && pathWithin(root, row.path)
      && typeof row.content === "string");
  };
  const validNamedResource = (entry: unknown): boolean => {
    const row = objectRecord(entry);
    return Boolean(row
      && hasOnlyFields(row, CLAUDE_DECLARATIVE_NAMED_FIELDS)
      && typeof row.name === "string"
      && row.name.length > 0
      && typeof row.content === "string");
  };
  const validRule = (entry: unknown): boolean => {
    const row = objectRecord(entry);
    return validPathResource(entry, CLAUDE_DECLARATIVE_RULE_FIELDS, true)
      && (row?.alwaysApply === undefined || typeof row.alwaysApply === "boolean");
  };
  if (!snapshot.instructions.every((entry) =>
    validPathResource(entry, CLAUDE_DECLARATIVE_INSTRUCTION_FIELDS, false))
    || !snapshot.skills.every((entry) =>
      validPathResource(entry, CLAUDE_DECLARATIVE_NAMED_PATH_FIELDS, true))
    || !snapshot.rules.every(validRule)
    || !snapshot.prompts.every(validNamedResource)
    || !snapshot.commands.every(validNamedResource)
    || !uniqueNamedResources(snapshot.skills)
    || !uniqueNamedResources(snapshot.rules)
    || !uniqueNamedResources(snapshot.prompts)
    || !uniqueNamedResources(snapshot.commands)) {
    return false;
  }
  return root !== null || Object.values(snapshot).every((entries) =>
    Array.isArray(entries) && entries.length === 0);
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
  const record = objectRecord(parsed);
  const value = record as Partial<ClaudeSessionMetadata> | null;
  const allowed = value?.version === 1
    ? CLAUDE_METADATA_V1_FIELDS
    : value?.version === 2 ? CLAUDE_METADATA_V2_FIELDS : CLAUDE_METADATA_V3_FIELDS;
  if (!record
    || (value?.version !== 1 && value?.version !== 2 && value?.version !== 3)
    || !hasOnlyFields(record, allowed)
    || value.runtime !== "claude-code"
    || typeof value.conversationId !== "string"
    || !isValidConversationId(value.conversationId)
    || typeof value.sessionId !== "string"
    || !isBoundedScalarString(value.sessionId, MAX_CLAUDE_CODE_SESSION_ID_SCALARS)
    || !exactIsoTimestamp(value.created)
    || !exactIsoTimestamp(value.modified)
    || typeof value.messageCount !== "number"
    || !Number.isSafeInteger(value.messageCount)
    || value.messageCount < 0
    || (value.ownerTurnCount !== undefined
      && (typeof value.ownerTurnCount !== "number"
        || !Number.isSafeInteger(value.ownerTurnCount)
        || value.ownerTurnCount < 0))
    || (value.ownerTurnCount === undefined && value.messageCount % 2 !== 0)
    || (value.version === 1 && (value.cwd !== undefined || value.projectSnapshot !== undefined))
    || ((value.version === 2 || value.version === 3)
      && (typeof value.cwd !== "string" || !isAbsolute(value.cwd)))
    || (value.version === 2 && value.projectSnapshot !== undefined)
    || (value.version === 3 && !validPersistedProjectSnapshot(value.projectSnapshot))) {
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

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validClaudeMcpResources(
  resources: unknown,
  root: string | null,
  servers: Record<string, ClaudeMcpServerConfig>,
): resources is ClaudeMcpResourceSnapshot[] | undefined {
  if (resources === undefined) return true;
  if (!Array.isArray(resources)) return false;
  const admittedNames = new Set(Object.keys(servers));
  if (root === null) return resources.length === 0 && admittedNames.size === 0;
  const sourcePaths = new Set([
    join(root, ".omp", "mcp.json"),
    join(root, ".omp", ".mcp.json"),
  ]);
  const resourceNames = new Set<string>();
  for (const resource of resources) {
    const row = objectRecord(resource);
    if (!row || !hasOnlyFields(row, CLAUDE_MCP_RESOURCE_FIELDS)
      || typeof row.name !== "string" || validateServerName(row.name) !== undefined
      || resourceNames.has(row.name)
      || typeof row.path !== "string" || !sourcePaths.has(row.path)
      || (row.status !== "admitted" && row.status !== "skipped" && row.status !== "disabled")
      || (row.reason !== undefined && typeof row.reason !== "string")
      || (row.status === "admitted") !== admittedNames.has(row.name)) {
      return false;
    }
    resourceNames.add(row.name);
  }
  return [...admittedNames].every((name) => resourceNames.has(name));
}

function validPersistedProjectSnapshot(value: unknown): value is ClaudePersistedProjectSnapshot {
  const record = objectRecord(value);
  if (!record || !hasOnlyFields(record, CLAUDE_PROJECT_SNAPSHOT_FIELDS)) return false;
  const snapshot = record as Partial<ClaudePersistedProjectSnapshot>;
  if (snapshot.root !== null && (typeof snapshot.root !== "string" || !isAbsolute(snapshot.root))) {
    return false;
  }
  if (!validDeclarativePromptSnapshot(snapshot.declarative, snapshot.root ?? null)
    || !snapshot.mcpServers
    || typeof snapshot.mcpServers !== "object"
    || Array.isArray(snapshot.mcpServers)
    || !Array.isArray(snapshot.resourceWarnings)
    || !snapshot.resourceWarnings.every((warning) => typeof warning === "string")
    || !Array.isArray(snapshot.mcpWarnings)
    || !snapshot.mcpWarnings.every((warning) => typeof warning === "string")) {
    return false;
  }
  if (!Object.entries(snapshot.mcpServers).every(([name, config]) =>
    validateServerName(name) === undefined
    && validPersistedClaudeMcpConfig(config))) {
    return false;
  }
  if (!validClaudeMcpResources(
    snapshot.mcpResources,
    snapshot.root,
    snapshot.mcpServers,
  )) {
    return false;
  }
  if (snapshot.root === null) {
    return snapshot.identity === undefined
      && Object.keys(snapshot.mcpServers).length === 0
      && (snapshot.mcpResources === undefined || snapshot.mcpResources.length === 0)
      && snapshot.resourceWarnings.length === 0
      && snapshot.mcpWarnings.length === 0;
  }
  const identity = objectRecord(snapshot.identity);
  return Boolean(identity
    && hasOnlyFields(identity, CLAUDE_PROJECT_IDENTITY_FIELDS)
    && typeof identity.dev === "string" && /^\d+$/u.test(identity.dev)
    && typeof identity.ino === "string" && /^\d+$/u.test(identity.ino));
}

function invalidMetadataFile(path: string): GhostError {
  return new GhostError(
    "claude_session_invalid",
    `${path} does not match the secure Claude session sidecar contract.`,
    500,
  );
}

/**
 * Read one sidecar through a pinned non-following descriptor. `afterStat` is a
 * deterministic race-test seam; production callers omit it.
 */
export async function readClaudeSessionMetadataFile(
  path: string,
  afterStat?: (path: string) => void | Promise<void>,
): Promise<string> {
  let file: Awaited<ReturnType<typeof openRegularFileNoFollow>> | undefined;
  try {
    file = await openRegularFileNoFollow(path, "Claude session sidecar");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw invalidMetadataFile(path);
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()
      || before.nlink !== 1n
      || (Number(before.mode) & 0o777) !== 0o600
      || before.size > BigInt(CLAUDE_SESSION_METADATA_MAX_BYTES)) {
      throw invalidMetadataFile(path);
    }
    await afterStat?.(path);
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await file.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (!after.isFile()
      || after.nlink !== 1n
      || (Number(after.mode) & 0o777) !== 0o600
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || after.size !== BigInt(length)
      || after.size > BigInt(CLAUDE_SESSION_METADATA_MAX_BYTES)) {
      throw invalidMetadataFile(path);
    }
    const live = await lstat(path, { bigint: true });
    if (!live.isFile()
      || live.nlink !== 1n
      || (Number(live.mode) & 0o777) !== 0o600
      || live.dev !== after.dev
      || live.ino !== after.ino
      || live.size !== after.size
      || live.mtimeNs !== after.mtimeNs
      || live.ctimeNs !== after.ctimeNs) {
      throw invalidMetadataFile(path);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw invalidMetadataFile(path);
    }
  } catch (error) {
    if (error instanceof GhostError && error.code === "claude_session_invalid") throw error;
    throw invalidMetadataFile(path);
  } finally {
    await file.close().catch(() => {});
  }
}

/** Read one already-published sidecar without running resume recovery or writing state. */
export async function readPublishedClaudeSessionMetadata(
  sessionDir: string,
  conversationId: string,
): Promise<ClaudeSessionMetadata | null> {
  const path = claudeSessionMetadataPath(sessionDir, conversationId);
  try {
    const metadata = parseMetadata(path, await readClaudeSessionMetadataFile(path));
    if (metadata.conversationId !== conversationId) {
      throw new GhostError(
        "session_identity_mismatch",
        "The stored Claude conversation identity does not match the requested resume id.",
        409,
      );
    }
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readMetadata(
  sessionDir: string,
  conversationId: string,
): Promise<LoadedClaudeSessionMetadata | null> {
  const path = claudeSessionMetadataPath(sessionDir, conversationId);
  const { settling, started } = claudeSessionResumeMarkerPaths(sessionDir, conversationId);
  let recovery: ClaudeSessionMetadata | null = null;
  try {
    recovery = parseMetadata(settling, await readClaudeSessionMetadataFile(settling));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (recovery) {
    if (recovery.conversationId !== conversationId) throw invalidMetadataFile(settling);
    await writeMetadata(sessionDir, recovery);
    await removeResumeMarkers(path);
  }
  let resumeBlocked = false;
  if (!recovery) {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readClaudeSessionMetadataFile(started));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw cause;
        throw invalidMetadataFile(started);
      }
      const record = objectRecord(parsed);
      if (!record
        || !hasOnlyFields(record, CLAUDE_RESUME_STARTED_FIELDS)
        || record.version !== 1
        || record.runtime !== "claude-code"
        || record.conversationId !== conversationId) {
        throw invalidMetadataFile(started);
      }
      resumeBlocked = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  try {
    const metadata = recovery
      ?? parseMetadata(path, await readClaudeSessionMetadataFile(path));
    if (metadata.conversationId !== conversationId) {
      throw new GhostError(
        "session_identity_mismatch",
        "The stored Claude conversation identity does not match the requested resume id.",
        409,
      );
    }
    return resumeBlocked ? { ...metadata, resumeBlocked: true } : metadata;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    file = await openFile(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await openFile(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeMetadata(
  sessionDir: string,
  metadata: ClaudeSessionMetadata,
): Promise<string> {
  const path = claudeSessionMetadataPath(sessionDir, metadata.conversationId);
  await writeDurableJson(path, metadata);
  return path;
}

async function markResumeStarted(sessionDir: string, conversationId: string): Promise<void> {
  const { started } = claudeSessionResumeMarkerPaths(sessionDir, conversationId);
  await writeDurableJson(started, {
    version: 1,
    runtime: "claude-code",
    conversationId,
  });
}

async function settleResumeMetadata(
  sessionDir: string,
  metadata: ClaudeSessionMetadata,
): Promise<void> {
  const path = claudeSessionMetadataPath(sessionDir, metadata.conversationId);
  const { settling } = claudeSessionResumeMarkerPaths(sessionDir, metadata.conversationId);
  await writeDurableJson(settling, metadata);
  await writeMetadata(sessionDir, metadata);
  await removeResumeMarkers(path);
}

async function removeResumeMarkers(metadataPath: string): Promise<boolean> {
  let removed = false;
  // Settling is the recovery authority, so it is always removed last. A crash
  // between unlinks remains recoverable rather than degrading to started-only.
  for (const suffix of [".started", ".settling"]) {
    try {
      await unlink(`${metadataPath}${suffix}`);
      removed = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  if (removed) await syncDirectory(dirname(metadataPath));
  return removed;
}

async function buildPersona(
  homeDir: string,
  ghostName: string,
  scheduleUnitDir: string,
  includeTaskDelegation: boolean,
): Promise<string> {
  const home = openGhostHome(homeDir);
  const [character, memory] = await Promise.all([
    home.readCharacter(),
    home.listMemory(),
  ]);
  return buildGhostSystemPrompt({
    ghostName,
    character,
    memoryRoot: home.memoryDir,
    memory: deriveMemoryIndex(memory.files),
    extraSections: [
      OMARCHY_COMPUTER_USE_POLICY,
      OWNER_DELIVERABLE_POLICY,
      SHARED_OBSIDIAN_POLICY,
      ...(includeTaskDelegation ? [PRINCIPAL_TASK_POLICY] : []),
      renderScheduledWorkPolicy(ghostName, scheduleUnitDir),
      // A seeded character.md means this ghost has not met its owner yet.
      ...(isSeededCharacter(ghostName, character?.body ?? null)
        ? [FIRST_MEETING_SECTION]
        : []),
    ],
  });
}

function signalFromToolExtra(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | null)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function mcpContent(result: GhostToolResult<unknown>): Array<
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

function zodShapeFor(definition: AnyGhostToolDefinition): Record<string, z.ZodType> {
  // Ghost schemas are plain JSON Schema documents; Claude's SDK wants a Zod
  // shape, so cross the boundary through that canonical representation.
  const schema = z.fromJSONSchema(definition.parameters as Record<string, unknown>);
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
  extensionOptions: GhostExtensionOptions,
  sdk: ClaudeAgentSdkModule,
): Promise<{ tools: SdkMcpToolDefinition[]; names: string[] }> {
  const resolved = resolveGhostExtensions(
    { ...extensionOptions, ghostName },
    homeDir,
    CLAUDE_CODE_TOOL_CAPABILITIES,
  );
  const tools = await bridgeClaudeCodeTools(resolved, homeDir, sdk);
  return { tools, names: resolved.toolNames };
}

async function withPrincipalTaskTools(
  bridge: { tools: SdkMcpToolDefinition[]; names: string[] },
  principalTasks: PrincipalTaskContext,
  sdk: ClaudeAgentSdkModule,
): Promise<{ tools: SdkMcpToolDefinition[]; names: string[] }> {
  const taskExtension = await collectGhostExtension(createPrincipalTaskTools(principalTasks));
  return {
    tools: [
      ...bridge.tools,
      ...bridgeCollectedClaudeCodeTools(
        taskExtension,
        PRINCIPAL_TASK_TOOL_NAMES,
        { cwd: principalTasks.cwd },
        sdk,
      ),
    ],
    names: [...bridge.names, ...PRINCIPAL_TASK_TOOL_NAMES],
  };
}

export async function bridgeClaudeCodeTools(
  resolved: ReturnType<typeof resolveGhostExtensions>,
  homeDir: string,
  sdk: ClaudeAgentSdkModule,
): Promise<SdkMcpToolDefinition[]> {
  // buildPersona adapts Ghost's prompt hook outside the session runtime; this
  // bridge needs the tools alone. Claude Code has no pi Model instance, so the
  // tool context deliberately carries none.
  const definitions = (await collectGhostExtension(resolved.ghost)).tools;
  const context: GhostToolContext = { cwd: homeDir };
  return bridgeCollectedClaudeCodeTools(
    { tools: definitions },
    resolved.toolNames,
    context,
    sdk,
  );
}

function bridgeCollectedClaudeCodeTools(
  extension: Pick<CollectedGhostExtension, "tools">,
  names: readonly string[],
  context: GhostToolContext,
  sdk: ClaudeAgentSdkModule,
): SdkMcpToolDefinition[] {
  return names.map((name): SdkMcpToolDefinition => {
    const definition = extension.tools.get(name);
    if (!definition) {
      throw new ClaudeCodeProcessError(
        `Ghost declared tool ${JSON.stringify(name)} but its extension did not register it.`,
      );
    }
    return sdk.tool(
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
            context,
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

function queryOptions(input: {
  sdk: ClaudeAgentSdkModule;
  binaryPath: string;
  cwd: string;
  ghostName: string;
  modelId: string;
  systemPrompt: string;
  tools: SdkMcpToolDefinition[];
  toolNames: string[];
  metadata: LoadedClaudeSessionMetadata | null;
  newSessionId: string;
  abortController: AbortController;
  internalMcpServerName: string;
  projectMcpServers: Record<string, ClaudeMcpServerConfig>;
  canUseTool: NonNullable<ClaudeQueryOptions["canUseTool"]>;
  environment: Readonly<NodeJS.ProcessEnv>;
  spawnClaudeCodeProcess?: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
}): ClaudeQueryOptions {
  const mcp = input.sdk.createSdkMcpServer({
    name: input.internalMcpServerName,
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
    // The subprocess cwd must not implicitly authorize project settings,
    // hooks, plugins, or MCP. Ghost injects the approved declarative snapshot
    // and project MCP explicitly at the session boundary.
    settingSources: [],
    skills: [],
    plugins: [],
    strictMcpConfig: true,
    // Keep the complete native tool vocabulary Claude was trained against.
    // `allowedTools` pre-approves additive Ghost MCP tools; it does not filter
    // the native preset, and Ghost deliberately supplies no denylist.
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: input.toolNames.map((name) =>
      `mcp__${input.internalMcpServerName}__${name}`),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Ordinary permission requests remain bypassed. AskUserQuestion is not an
    // approval request: its callback pauses in Ghost's owner-question broker.
    canUseTool: input.canUseTool,
    toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
    mcpServers: mcpServerRecord([
      ...Object.entries(input.projectMcpServers),
      [input.internalMcpServerName, mcp],
    ]),
    includePartialMessages: true,
    persistSession: true,
    promptSuggestions: false,
    abortController: input.abortController,
    ...(input.spawnClaudeCodeProcess
      ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess }
      : {}),
    ...(input.metadata && input.metadata.resumeBlocked !== true
      ? { resume: input.metadata.sessionId }
      : { sessionId: input.newSessionId }),
    env: input.environment,
  };
}

async function answerClaudeQuestion(
  broker: AskBroker,
  rawInput: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Awaited<ReturnType<NonNullable<ClaudeQueryOptions["canUseTool"]>>>> {
  if (!isAskToolInput(rawInput)) {
    return {
      behavior: "deny",
      message: "AskUserQuestion received malformed questions, so the owner was not prompted.",
    };
  }
  try {
    const resolution = await resolveAskUserQuestion(broker, rawInput, {
      signal,
      timeout: timeoutMs,
    });
    if (resolution.kind === "chat") {
      return {
        behavior: "deny",
        message: resolution.output.response
          ?? "The owner chose to discuss these questions instead of answering them.",
      };
    }
    return {
      behavior: "allow",
      updatedInput: {
        ...rawInput,
        answers: resolution.output.answers,
        ...(resolution.output.annotations
          ? { annotations: resolution.output.annotations }
          : {}),
        ...(resolution.output.autoAnsweredAfterMs
          ? { afkTimeoutMs: resolution.output.autoAnsweredAfterMs }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof AskCancelledError) {
      return { behavior: "deny", message: "The owner dismissed these questions." };
    }
    throw error;
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function projectMcpServers(
  effective: EffectiveProjectMcpRead,
  root: string,
): {
  servers: Record<string, ClaudeMcpServerConfig>;
  warnings: string[];
  resources: ClaudeMcpResourceSnapshot[];
} {
  const entries: Array<[string, ClaudeMcpServerConfig]> = [];
  const warnings: string[] = [];
  const rejectionReasons = new Map<string, string>();
  const reject = (name: string, reason: string): void => {
    warnings.push(`${name}: ${reason}`);
    rejectionReasons.set(name, reason);
  };
  for (const server of effective.servers) {
    if (server.errors.length > 0) {
      reject(server.name, server.errors.join("; "));
      continue;
    }
    const config = server.config as OmpMcpServerConfig;
    if (config.enabled === false) continue;
    if (claudeMcpConfigCarriesSecrets(config)) {
      throw new GhostError(
        "claude_project_mcp_secrets_unsupported",
        `Claude project MCP ${JSON.stringify(server.name)} uses environment expansion or `
          + "secret-bearing env, header, auth, OAuth, or URL fields. Phase 1 does not persist "
          + "those values in Claude resume metadata.",
        409,
      );
    }
    if (config.timeout !== undefined && config.timeout < 1_000) {
      reject(
        server.name,
        "row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
      );
      continue;
    }
    const type = config.type ?? "stdio";
    if (type === "stdio") {
      const stdio = config as OmpMcpStdioServerConfig;
      if (stdio.cwd) {
        reject(
          server.name,
          "row rejected because Claude project MCP does not support an explicit cwd.",
        );
        continue;
      }
      entries.push([server.name, {
        type: "stdio",
        command: stdio.command,
        alwaysLoad: true,
        ...(stdio.args ? { args: stdio.args } : {}),
        ...(stdio.env ? { env: stdio.env } : {}),
        ...(stdio.timeout !== undefined ? { timeout: stdio.timeout } : {}),
      }]);
      continue;
    }
    if (type === "http" || type === "sse") {
      const remote = config as OmpMcpHttpServerConfig | OmpMcpSseServerConfig;
      entries.push([server.name, {
        type,
        url: remote.url,
        alwaysLoad: true,
        ...(remote.headers ? { headers: remote.headers } : {}),
        ...(remote.timeout !== undefined ? { timeout: remote.timeout } : {}),
      }]);
      continue;
    }
    reject(server.name, `unsupported MCP transport ${String(type)}.`);
  }
  const admitted = new Set(entries.map(([name]) => name));
  const skipped = new Map(effective.skipped.flatMap((diagnostic) => {
    const marker = "#mcpServers.";
    const index = diagnostic.path.indexOf(marker);
    const name = index < 0 ? "" : diagnostic.path.slice(index + marker.length);
    return name ? [[name, diagnostic] as const] : [];
  }));
  const resources = effective.claimedNames.map((name): ClaudeMcpResourceSnapshot => {
    const server = effective.servers.find((candidate) => candidate.name === name);
    const disabled = effective.disabled?.find((candidate) => candidate.name === name);
    const diagnostic = skipped.get(name);
    const diagnosticPath = diagnostic?.path.split("#", 1)[0];
    const path = server?.source.absolutePath ?? disabled?.source.absolutePath
      ?? (diagnosticPath ? resolve(root, diagnosticPath) : join(root, ".omp", "mcp.json"));
    if (admitted.has(name)) return { name, path, status: "admitted" };
    if (disabled) {
      return {
        name,
        path,
        status: "disabled",
        reason: "Disabled in the admitted configuration.",
      };
    }
    return {
      name,
      path,
      status: "skipped",
      reason: rejectionReasons.get(name) ?? diagnostic?.reason ?? "The server was not admitted.",
    };
  });
  return { servers: mcpServerRecord(entries), warnings, resources };
}

function internalMcpServerName(
  projectMcpServers: Record<string, ClaudeMcpServerConfig>,
): string {
  let suffix = 0;
  for (;;) {
    const candidate = suffix === 0 ? "ghost" : `ghost-${suffix}`;
    if (!Object.hasOwn(projectMcpServers, candidate)) return candidate;
    suffix += 1;
  }
}

function containsEnvironmentExpansion(value: unknown): boolean {
  if (typeof value === "string") return /\$\{[^}]+\}/u.test(value);
  if (Array.isArray(value)) return value.some(containsEnvironmentExpansion);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsEnvironmentExpansion);
}

function projectMcpWarningPath(root: string | null, warning: string, fallback: string): string {
  if (!root) return fallback;
  const relativePath = [".omp/mcp.json", ".omp/.mcp.json"]
    .find((candidate) => warning.startsWith(candidate));
  return relativePath ? resolve(root, relativePath) : fallback;
}

function nonEmptyRecord(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0);
}

function claudeMcpConfigCarriesSecrets(config: OmpMcpServerConfig): boolean {
  if (containsEnvironmentExpansion(config)) return true;
  if (nonEmptyRecord(config.auth) || nonEmptyRecord(config.oauth)) return true;
  const type = config.type ?? "stdio";
  if (type === "stdio") return nonEmptyRecord((config as OmpMcpStdioServerConfig).env);
  const remote = config as OmpMcpHttpServerConfig | OmpMcpSseServerConfig;
  if (nonEmptyRecord(remote.headers)) return true;
  try {
    const url = new URL(remote.url);
    return Boolean(url.username || url.password || url.search || url.hash);
  } catch {
    // Validation reports malformed URLs before this point. Treat any remaining
    // unparsable value as unsafe instead of persisting an opaque credential.
    return true;
  }
}

async function loadClaudeProjectSnapshot(
  root: string | null,
  identity?: ProjectFilesystemIdentity,
): Promise<ClaudePersistedProjectSnapshot> {
  if (!root) {
    return {
      root: null,
      declarative: mergeDeclarativePromptSnapshots([]),
      mcpServers: mcpServerRecord([]),
      resourceWarnings: [],
      mcpWarnings: [],
    };
  }
  if (!identity) {
    throw new GhostError(
      "project_identity_missing",
      "A trusted filesystem identity is required for a bound Claude project.",
      409,
    );
  }
  const snapshot = await loadProjectDeclarativeSnapshot(root, {
    level: "project",
    expectedIdentity: identity,
  });
  const approvedMcp = projectMcpServers(snapshot.mcp, root);
  const mcpWarningSet = new Set(snapshot.mcpWarnings);
  return {
    root,
    identity: { dev: identity.dev, ino: identity.ino },
    declarative: declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([snapshot])),
    mcpServers: approvedMcp.servers,
    mcpResources: approvedMcp.resources,
    resourceWarnings: snapshot.warnings.filter((warning) => !mcpWarningSet.has(warning)),
    mcpWarnings: [...snapshot.mcpWarnings, ...approvedMcp.warnings],
  };
}

function withRepresentableClaudeMcpTimeouts(
  snapshot: ClaudePersistedProjectSnapshot,
): ClaudePersistedProjectSnapshot {
  const entries: Array<[string, ClaudeMcpServerConfig]> = [];
  const mcpWarnings = [...snapshot.mcpWarnings];
  const resources = snapshot.mcpResources
    ? snapshot.mcpResources.map((resource) => ({ ...resource }))
    : Object.keys(snapshot.mcpServers).map((name): ClaudeMcpResourceSnapshot => ({
        name,
        path: snapshot.root ? join(snapshot.root, ".omp", "mcp.json") : "",
        status: "admitted",
      }));
  for (const [name, config] of Object.entries(snapshot.mcpServers)) {
    const timeout = "timeout" in config ? config.timeout : undefined;
    if (timeout !== undefined && timeout < 1_000) {
      const warning = `${name}: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.`;
      if (!mcpWarnings.includes(warning)) mcpWarnings.push(warning);
      const resource = resources.find((candidate) => candidate.name === name);
      if (resource) {
        resource.status = "skipped";
        resource.reason = warning.slice(name.length + 2);
      }
      continue;
    }
    entries.push([name, config]);
  }
  return {
    ...snapshot,
    mcpServers: mcpServerRecord(entries),
    ...(snapshot.root ? { mcpResources: resources } : {}),
    mcpWarnings,
  };
}

function requireMatchingClaudeProjectSnapshot(
  metadata: ClaudeSessionMetadata | null,
  project: Pick<ClaudeProjectSnapshot, "root" | "identity">,
): Promise<ClaudePersistedProjectSnapshot> | ClaudePersistedProjectSnapshot {
  if (!metadata) return loadClaudeProjectSnapshot(project.root, project.identity);
  if (metadata.version !== 3 || !metadata.projectSnapshot) {
    if (project.root) {
      throw new GhostError(
        "claude_project_snapshot_missing",
        "This legacy Claude conversation cannot safely resume a bound project; start a new conversation.",
        409,
      );
    }
    return {
      root: null,
      declarative: mergeDeclarativePromptSnapshots([]),
      mcpServers: mcpServerRecord([]),
      resourceWarnings: [],
      mcpWarnings: [],
    };
  }
  const snapshot = metadata.projectSnapshot;
  const identityMatches = snapshot.root === null
    ? project.identity === undefined
    : Boolean(project.identity
      && snapshot.identity?.dev === project.identity.dev
      && snapshot.identity.ino === project.identity.ino);
  if (snapshot.root !== project.root || !identityMatches) {
    throw new GhostError(
      "project_metadata_mismatch",
      "Claude resume metadata does not match the conversation's trusted project snapshot.",
      409,
    );
  }
  return withRepresentableClaudeMcpTimeouts(snapshot);
}

/**
 * How long a conversation's Claude process is kept alive with nothing to do.
 * Deliberately the same 30 minutes as `DEFAULT_SESSION_IDLE_TTL_MS` for a pi
 * hosted session — a warm query is the same kind of resource and the two
 * runtimes should not disagree about how long "idle" is. It is duplicated
 * rather than imported because session-host.ts already imports this module.
 */
export const CLAUDE_WARM_QUERY_IDLE_TTL_MS = 30 * 60_000;

/**
 * The owner's side of a warm query's input. The SDK takes one AsyncIterable for
 * the life of the query, so turns after the first are pushed into this channel
 * rather than starting a second query.
 */
interface ClaudeInputChannel {
  readonly messages: AsyncIterable<SDKUserMessage>;
  push: (prompt: string, additionalContext?: string) => void;
  close: () => void;
}

interface ClaudeProcessExitBoundary {
  readonly exited: Promise<void>;
  readonly spawn: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
  terminate: () => void;
}

/** Own the SDK CLI and every descendant as one isolated Linux process group. */
function claudeProcessExitBoundary(): ClaudeProcessExitBoundary {
  let settled = false;
  let spawned = false;
  let leaderExited = false;
  let terminationRequested = false;
  let pid: number | undefined;
  let quiescing: Promise<void> | undefined;
  let resolveExit!: () => void;
  let rejectExit!: (cause: unknown) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const resolveOnce = () => {
    if (settled) return;
    settled = true;
    resolveExit();
  };
  const rejectOnce = (cause: unknown) => {
    if (settled) return;
    settled = true;
    rejectExit(cause);
  };
  const quiesce = () => {
    if (settled || quiescing || pid === undefined) return;
    quiescing = terminateOwnedProcessGroup(
      pid,
      CLAUDE_QUERY_TERM_GRACE_MS,
      CLAUDE_QUERY_KILL_CONFIRM_MS,
    );
    void quiescing.then(() => {
      // Process-group termination can observe the direct child as a zombie
      // before Node delivers its exit event. Keep the SDK boundary ordered
      // behind that event while treating orphan zombies as fully stopped.
      if (leaderExited) resolveOnce();
    }, rejectOnce);
  };
  return {
    exited,
    spawn: (options) => {
      if (spawned) {
        throw new ClaudeCodeProcessError("Claude Code tried to spawn more than one CLI process.");
      }
      spawned = true;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd,
          detached: process.platform === "linux",
          env: options.env,
          signal: options.signal,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch (cause) {
        resolveOnce();
        throw cause;
      }
      // A negative PID is safe only when this child was made the leader of a
      // new Linux process group. Never risk signaling ghostd's own group on a
      // platform where `detached` has different semantics.
      pid = process.platform === "linux" ? child.pid : undefined;
      if (terminationRequested) quiesce();
      child.once("exit", () => {
        leaderExited = true;
        if (pid !== undefined && ownedProcessGroupExists(pid)) quiesce();
        else resolveOnce();
      });
      child.once("error", () => {
        if (pid === undefined) resolveOnce();
        else quiesce();
      });
      return child as unknown as ClaudeSpawnedProcess;
    },
    terminate: () => {
      terminationRequested = true;
      quiesce();
    },
  };
}

function claudeInputChannel(): ClaudeInputChannel {
  const queued: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    messages: (async function* messages(): AsyncIterable<SDKUserMessage> {
      while (true) {
        while (queued.length > 0) yield queued.shift() as SDKUserMessage;
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
    push: (prompt, additionalContext) => {
      if (closed) throw new ClaudeCodeProcessError("Claude Code's input channel is closed.");
      if (additionalContext) {
        queued.push({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: additionalContext }] },
          parent_tool_use_id: null,
          isSynthetic: true,
          shouldQuery: false,
        } as SDKUserMessage);
      }
      queued.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      nudge();
    },
    close: () => {
      closed = true;
      nudge();
    },
  };
}

/**
 * A conversation's live Claude process. The identity fields are everything the
 * query was constructed from and cannot be changed afterwards — the SDK has no
 * `setSystemPrompt` — so a turn that disagrees with any of them retires this
 * query and starts a new one rather than answering under a stale prompt.
 */
interface WarmClaudeQuery {
  readonly query: Query;
  readonly messages: AsyncIterator<SDKMessage>;
  readonly input: ClaudeInputChannel;
  readonly abortController: AbortController;
  readonly runtimeIdentity: string;
  readonly identity: string;
  readonly exited: Promise<void>;
  readonly terminateProcessGroup: () => void;
  readonly principalTasks?: ClaudePrincipalTaskContextLease;
  readonly ask: AskBroker;
  readonly resources: SessionResourceView;
  projectMcpFailed: boolean;
}

interface ClaudeSessionPersona {
  readonly prompt: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface ClaudePrincipalTaskContextLease {
  readonly context: PrincipalTaskContext;
  retire(): void;
}

export type ClaudePrincipalTaskContextFactory = (
  ghostName: string,
  conversationId: string,
  cwd: string,
) => Promise<ClaudePrincipalTaskContextLease>;

/**
 * Everything a warm query cannot change after construction. Compared verbatim,
 * so anything added to `queryOptions` that the SDK fixes at startup belongs
 * here too, or a stale query would silently answer under the old value.
 */
function warmQueryIdentity(input: {
  runtimeIdentity: string;
  cwd: string;
  modelId: string;
  systemPrompt: string;
  toolNames: readonly string[];
  projectMcpServers: Record<string, ClaudeMcpServerConfig>;
}): string {
  return JSON.stringify([
    input.runtimeIdentity,
    input.cwd,
    input.modelId,
    input.systemPrompt,
    [...input.toolNames].sort(),
    Object.keys(input.projectMcpServers).sort()
      .map((name) => [name, input.projectMcpServers[name]]),
  ]);
}

/**
 * Pull one owner turn out of a live query. The SDK emits exactly one `result`
 * per turn and leaves the stream open for the next one, so the turn ends at
 * that frame rather than at the end of the iterator.
 */
async function pumpClaudeTurn(
  warm: WarmClaudeQuery,
  onMessage: (message: SDKMessage) => void,
): Promise<SDKResultMessage> {
  for (;;) {
    let step: IteratorResult<SDKMessage>;
    try {
      step = await warm.messages.next();
    } catch (cause) {
      throw new ClaudeCodeProcessError("Claude Code's message stream failed.", { cause });
    }
    if (step.done) {
      throw new ClaudeCodeProcessError("Claude Code ended without a terminal result.");
    }
    if (step.value.type === "result") return step.value;
    onMessage(step.value);
  }
}

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
  private readonly createQuery: ClaudeCodeQueryFactory | undefined;
  private readonly probe: ClaudeCodeProbe;
  private readonly loadSdk: () => Promise<ClaudeAgentSdkModule>;
  private readonly hooks: GhostHookRunner;
  private principalTaskContext: ClaudePrincipalTaskContextFactory | undefined;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly ownerHome: string;
  private readonly scheduleUnitDir: string;
  private readonly warmIdleTtlMs: number;
  private readonly exitWaitTimeoutMs: number;
  private readonly observeQueryExit: ClaudeCodeQueryExitObserver | undefined;
  private readonly machineSkills: string[];
  private readonly askTimeoutMs: () => number;
  private readonly busy = new Set<string>();
  private readonly active = new Map<
    string,
    { query: Query; abortController: AbortController }
  >();
  private readonly turns = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  // The character file and private-memory index are session-start state,
  // not per-turn state. Explicit close and idle expiry drop this snapshot so
  // the next cold resume starts from disk. Live truth remains available there
  // through the native file tools throughout the session.
  private readonly personas = new Map<string, ClaudeSessionPersona>();
  // One live Claude process per warm conversation. Turn one starts it; later
  // turns push into its open input channel, so the persona, the project MCP
  // servers, and Claude's own transcript all stay loaded between turns.
  private readonly warm = new Map<string, WarmClaudeQuery>();
  // Exit promises outlive warm-map removal. Whole-home moves must still wait
  // for every retired SDK subprocess to acknowledge exit.
  private readonly retiring = new Map<string, Set<Promise<void>>>();
  private disposed = false;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.ownerHome = resolve(options.ownerHome ?? homedir());
    if (!isAbsolute(this.ownerHome)) throw new TypeError("ownerHome must be absolute");
    // SessionHost supplies the shared production value. A directly constructed
    // runtime stays under its explicit ownerHome instead of ambient XDG state.
    const scheduleUnitDir = options.scheduleUnitDir
      ?? resolveScheduleUnitDirectory(this.ownerHome, {});
    if (!isAbsolute(scheduleUnitDir)) {
      throw new TypeError("scheduleUnitDir must be absolute");
    }
    this.scheduleUnitDir = resolve(scheduleUnitDir);
    this.environment = captureClaudeCodeEnvironment(options.environment ?? process.env);
    const warmIdleTtlMs = options.warmIdleTtlMs ?? CLAUDE_WARM_QUERY_IDLE_TTL_MS;
    if (!Number.isFinite(warmIdleTtlMs) || warmIdleTtlMs <= 0) {
      throw new RangeError("warmIdleTtlMs must be a finite positive number");
    }
    this.warmIdleTtlMs = warmIdleTtlMs;
    const exitWaitTimeoutMs = options.exitWaitTimeoutMs ?? CLAUDE_CODE_EXIT_WAIT_TIMEOUT_MS;
    if (!Number.isFinite(exitWaitTimeoutMs) || exitWaitTimeoutMs <= 0) {
      throw new RangeError("exitWaitTimeoutMs must be a finite positive number");
    }
    this.exitWaitTimeoutMs = exitWaitTimeoutMs;
    this.observeQueryExit = options.observeQueryExit;
    this.askTimeoutMs = options.askTimeoutMs ?? (() => 0);
    this.machineSkills = options.machineSkillPaths
      ? [...options.machineSkillPaths]
      : machineSkillPaths(this.ownerHome);
    this.logger = options.logger ?? silentLogger;
    this.extensionOptions = options.extensionOptions ?? {};
    if (options.loadSdk) {
      this.loadSdk = options.loadSdk;
    } else {
      const sdkLoader = new ClaudeAgentSdkLoader({ ownerHome: this.ownerHome });
      this.loadSdk = () => sdkLoader.load();
    }
    this.createQuery = options.createQuery;
    this.probe = options.probe ?? new ClaudeCodeProbe({
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      environment: this.environment,
      ...(options.resolveExecutable ? { resolveExecutable: options.resolveExecutable } : {}),
      ...(options.readVersion ? { readVersion: options.readVersion } : {}),
      ...(options.readAuthStatus ? { readAuthStatus: options.readAuthStatus } : {}),
    });
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
  }

  /** Install principal task tools before this runtime admits any conversation. */
  attachPrincipalTaskTools(factory: ClaudePrincipalTaskContextFactory): void {
    if (this.principalTaskContext) {
      throw new Error("Principal task tools are already attached to Claude Code.");
    }
    if (this.disposed || this.busy.size > 0 || this.active.size > 0
      || this.turns.size > 0 || this.warm.size > 0 || this.personas.size > 0) {
      throw new Error("Principal task tools must be attached before Claude Code activity.");
    }
    this.principalTaskContext = factory;
  }

  invalidateAuthProbe(): void {
    this.probe.invalidate();
  }

  private assertTurnAdmitted(signal?: AbortSignal): void {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Turn aborted.");
    }
  }

  isBusy(ghostName: string, conversationId: string): boolean {
    return this.busy.has(JSON.stringify([ghostName, conversationId]));
  }

  sessionResources(ghostName: string, conversationId: string): SessionResourceView | null {
    requireRawConversationId(conversationId);
    return this.warm.get(JSON.stringify([ghostName, conversationId]))?.resources ?? null;
  }

  pendingAsk(ghostName: string, conversationId: string): PendingAsk | null {
    requireRawConversationId(conversationId);
    return this.warm.get(JSON.stringify([ghostName, conversationId]))?.ask.pending ?? null;
  }

  answerAsk(
    ghostName: string,
    conversationId: string,
    askId: string,
    answer: unknown,
  ): void {
    requireRawConversationId(conversationId);
    const broker = this.warm.get(JSON.stringify([ghostName, conversationId]))?.ask;
    if (!broker) {
      throw new AskBrokerError("ask_not_pending", "This conversation is not waiting for an answer.");
    }
    broker.answer(askId, answer);
  }

  /** Cwd/rebind defaults derived solely from durable Claude resume metadata. */
  async projectDefaults(
    ghost: Ghost,
    conversationId: string,
  ): Promise<{ cwd?: string; canRebind: boolean }> {
    requireRawConversationId(conversationId);
    const paths = ghostPaths(ghost.dir);
    const metadata = await readMetadata(paths.sessionDir, conversationId);
    if (!metadata) return { canRebind: true };
    return {
      cwd: (metadata.version === 2 || metadata.version === 3) && metadata.cwd
        ? resolve(metadata.cwd)
        : paths.home,
      canRebind: metadata.ownerTurnCount === 0,
    };
  }

  isGhostBusy(ghostName: string): boolean {
    for (const key of this.busy) {
      if (runtimeKeyGhost(key) === ghostName) return true;
    }
    return false;
  }

  /**
   * Validate and capture the exact project inputs before an HTTP turn can
   * publish its stream. A first turn scans once here; a resume validates and
   * reuses its persisted v3 snapshot without reopening project resources.
   */
  async admitProjectSnapshot(
    ghost: Ghost,
    conversationId: string,
    project: Pick<ClaudeProjectSnapshot, "root" | "cwd" | "identity">,
  ): Promise<ClaudePersistedProjectSnapshot> {
    this.assertTurnAdmitted();
    requireRawConversationId(conversationId);
    const metadata = await readMetadata(ghostPaths(ghost.dir).sessionDir, conversationId);
    this.assertTurnAdmitted();
    return await requireMatchingClaudeProjectSnapshot(metadata, project);
  }

  runTurn(
    ghost: Ghost,
    conversationId: string,
    modelId: string,
    options: RunTurnOptions,
    project: ClaudeProjectSnapshot,
    finishMaintenance?: (turn?: SettledMaintenanceTurn) => Promise<void>,
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
    // Claim a warm query synchronously with admission. Its idle deadline must
    // not expire while this turn is awaiting auth, persona, hooks, or MCP setup.
    const persona = this.personas.get(key);
    if (persona?.idleTimer) clearTimeout(persona.idleTimer);
    if (persona) persona.idleTimer = undefined;
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
        project,
        finishMaintenance,
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
    project: ClaudeProjectSnapshot,
    finishMaintenance?: (turn?: SettledMaintenanceTurn) => Promise<void>,
  ): Promise<void> {
    const logger = this.logger.child({ ghost: ghost.name, conversation: conversationId });
    // The turn's trusted working directory, resolved below before any tool can
    // run. `tool_execution_start.cwd` is activity-local by contract, and a
    // Claude conversation cannot move its cwd mid-turn.
    let turnCwd = process.cwd();
    const adapter = createClaudePiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
      getCwd: () => turnCwd,
    });
    let settledTurn: SettledMaintenanceTurn | undefined;
    let pendingTerminalResult: SDKResultMessage | undefined;
    let pendingFailure: { cause: unknown; aborted: boolean } | undefined;
    let terminalEmissionFailure: { cause: unknown } | undefined;
    // A result has advanced Claude's transcript. Until all durable side effects
    // for that result settle, any failure must prevent another prompt from
    // entering this live process; the next turn resumes cold from its sidecar.
    let postQueryWorkPending = false;
    try {
      this.assertTurnAdmitted(options.signal);
      const paths = ghostPaths(ghost.dir);
      let metadata = await readMetadata(paths.sessionDir, conversationId);
      this.assertTurnAdmitted(options.signal);
      let probed: ClaudeCodeProbeResult;
      try {
        probed = await this.probe.readForTurn();
      } catch (cause) {
        this.retireWarm(key);
        throw cause;
      }
      const { binaryPath, executableIdentity, cliVersion, authStatus: auth } = probed;
      this.assertTurnAdmitted(options.signal);
      if (!isClaudeCodeAuthenticated(auth)) {
        this.retireWarm(key);
        throw new GhostError(
          "claude_code_auth_required",
          "Claude Code did not report a usable native authentication method. Configure or "
            + "sign into the installed `claude` executable as this desktop user, then retry. "
            + "Ghost does not accept or store that credential.",
          503,
        );
      }
      const runtimeIdentity = claudeCodeRuntimeIdentity(
        binaryPath,
        executableIdentity,
        cliVersion,
        auth,
        probed.interpreter,
      );
      const authenticatedWarm = this.warm.get(key);
      const stableAccount = /^[0-9a-f]{64}$/u.test(auth.accountFingerprint ?? "");
      if (authenticatedWarm && (
        !stableAccount || authenticatedWarm.runtimeIdentity !== runtimeIdentity
      )) {
        logger.debug?.("retiring Claude query whose executable or authentication changed");
        this.retireWarm(key, authenticatedWarm);
      }

      await mkdir(paths.sessionDir, { recursive: true });
      this.assertTurnAdmitted(options.signal);
      const runtimeCwd = metadata
        ? (metadata.version === 2 || metadata.version === 3) && metadata.cwd
          ? resolve(metadata.cwd)
          : paths.home
        : resolve(project.cwd || this.ownerHome);
      if (metadata && resolve(runtimeCwd) !== resolve(project.cwd)) {
        throw new GhostError(
          "project_metadata_mismatch",
          "Claude resume metadata does not match the conversation's trusted working directory.",
          409,
        );
      }
      if (project.root && !pathWithin(project.root, runtimeCwd)) {
        throw new GhostError(
          "cwd_outside_project",
          "Claude resume metadata points outside the trusted project.",
          409,
        );
      }
      turnCwd = runtimeCwd;
      const ownerTurnCount = metadata?.ownerTurnCount ?? 0;
      if (ownerTurnCount >= Number.MAX_SAFE_INTEGER) {
        throw new ClaudeCodeProcessError("Claude Code's owner turn count overflowed.");
      }
      const ownerTurnId = ownerTurnCount + 1;
      const admittedSdkSessionId = metadata && metadata.resumeBlocked !== true
        ? metadata.sessionId
        : randomUUID();
      const [persona, machineSkills, ghostDeclarative] = await Promise.all([
        this.sessionPersona(key, paths.home, ghost.name),
        loadMachineSkills(this.ownerHome, { paths: this.machineSkills }),
        loadProjectDeclarativeSnapshot(paths.home, { level: "user" }),
      ]);
      this.assertTurnAdmitted(options.signal);
      const approvedProject = project.admittedSnapshot
        ?? await requireMatchingClaudeProjectSnapshot(metadata, project);
      this.assertTurnAdmitted(options.signal);
      const sdkMcpServerName = internalMcpServerName(approvedProject.mcpServers);
      adapter.setInternalMcpServerName(sdkMcpServerName);
      const effectiveDeclarative = mergeDeclarativePromptSnapshots([
        declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([
          ...(machineSkills ? [machineSkills] : []),
          ghostDeclarative,
        ])),
        approvedProject.declarative,
      ]);
      const declarativeAppend = renderClaudeDeclarativePrompt(effectiveDeclarative);
      const systemPrompt = declarativeAppend ? `${persona}\n\n${declarativeAppend}` : persona;
      for (const warning of ghostDeclarative.warnings) {
        logger.warn("Claude Ghost resource stayed disabled", {
          warning,
        });
      }
      for (const warning of machineSkills?.warnings ?? []) {
        logger.warn("Claude machine skill stayed disabled", { warning });
      }
      for (const warning of approvedProject.resourceWarnings) {
        logger.warn("Claude project resource stayed disabled", {
          project: project.root,
          warning,
        });
      }
      for (const warning of approvedProject.mcpWarnings) {
        logger.warn("Claude project MCP stayed disabled", {
          project: project.root,
          warning,
        });
      }
      const configuredProjectMcp = Object.keys(approvedProject.mcpServers);
      const projectMcpPath = approvedProject.root
        ? join(approvedProject.root, ".omp", "mcp.json")
        : runtimeCwd;
      const mcpServers: SessionMcpView[] = (approvedProject.mcpResources
        ?? configuredProjectMcp.map((name): ClaudeMcpResourceSnapshot => ({
          name,
          path: projectMcpPath,
          status: "admitted",
        }))).map((resource) => ({
          name: resource.name,
          path: resource.path,
          source: "project",
          precedence: 2,
          enabled: resource.status === "admitted",
          status: resource.status,
          ...(resource.reason ? { reason: resource.reason } : {}),
        }));
      const mcpDiagnostics: SessionResourceDiagnostic[] = approvedProject.mcpWarnings
        .filter((warning) => !mcpServers.some((server) =>
          server.status === "skipped" && warning.startsWith(`${server.name}: `)))
        .map((reason) => ({
          source: "project",
          path: projectMcpWarningPath(approvedProject.root, reason, projectMcpPath),
          reason,
        }));
      const skillGroups: SessionSkillGroup[] = [
        ...(machineSkills
          ? [projectSessionSkillGroup(
              "machine",
              0,
              machineSkills,
              machineSkills.skillDiagnostics.map((diagnostic) => ({
                source: "machine" as const,
                ...diagnostic,
              })),
            )]
          : []),
        projectSessionSkillGroup("ghost", 1, ghostDeclarative),
        ...(approvedProject.root
          ? [{
              source: "project" as const,
              precedence: 2,
              skills: approvedProject.declarative.skills.map((skill) => {
                const { frontmatter } = parseFrontmatter(skill.content);
                return {
                  name: skill.name,
                  path: skill.path,
                  ...(typeof frontmatter.description === "string"
                    ? { description: frontmatter.description }
                    : {}),
                  hidden: frontmatter["disable-model-invocation"] === true,
                };
              }),
              diagnostics: approvedProject.resourceWarnings.map((reason) => ({
                source: "project" as const,
                reason,
              })),
            }]
          : []),
      ];
      const obsidianSkillPath = join(
        this.ownerHome,
        ".agents",
        "skills",
        "obsidian-cli",
        "SKILL.md",
      );
      const resources = buildSessionResourceView({
        runtime: "claude-code",
        skillGroups,
        obsidian: { path: obsidianSkillPath, installed: existsSync(obsidianSkillPath) },
        mcpServers,
        mcpDiagnostics,
      });
      const publishProjectMcpStatus = async (failed: boolean): Promise<void> => {
        if (!project.reportStatus || !project.root) return;
        await project.reportStatus({
          status: failed ? "degraded" : "ready",
          error: failed
            ? {
                code: "project_mcp_degraded",
                message: "One or more project MCP resources could not be loaded.",
              }
            : null,
          mcpStatus: failed
            ? "degraded"
            : configuredProjectMcp.length > 0 ? "ready" : "off",
        });
      };
      let beforePromptContext: string | undefined;
      let beforePromptAcknowledge: (() => void | Promise<void>) | undefined;
      if (this.hooks.hasHandlers("before_prompt")) {
        const result = await this.hooks.emitBeforePrompt({
          type: "before_prompt",
          prompt: options.prompt,
          turn_id: ownerTurnId,
          session_id: admittedSdkSessionId,
          session_file: claudeSessionMetadataPath(paths.sessionDir, conversationId),
          signal: options.signal ?? new AbortController().signal,
          ghost_name: ghost.name,
          ghost_home: paths.home,
          cwd: runtimeCwd,
          runtime: "claude-code",
          conversation_runtime: "claude-code",
          conversation_id: conversationId,
        });
        if (result?.additionalContext && !options.signal?.aborted) {
          beforePromptContext = result.additionalContext;
          beforePromptAcknowledge = result.acknowledge;
        }
        this.assertTurnAdmitted(options.signal);
      }
      const sdk = await this.loadSdk();
      this.assertTurnAdmitted(options.signal);
      const baseBridge = await buildMcpTools(
        paths.home,
        ghost.name,
        this.extensionOptions,
        sdk,
      );
      this.assertTurnAdmitted(options.signal);
      try {
        await this.probe.assertExecutable(probed);
      } catch (cause) {
        this.retireWarm(key);
        throw cause;
      }
      this.assertTurnAdmitted(options.signal);

      let prompt = options.prompt;
      let stopHookActive = false;
      const identity = warmQueryIdentity({
        runtimeIdentity,
        cwd: runtimeCwd,
        modelId,
        systemPrompt,
        toolNames: this.principalTaskContext
          ? [...baseBridge.names, ...PRINCIPAL_TASK_TOOL_NAMES]
          : baseBridge.names,
        projectMcpServers: approvedProject.mcpServers,
      });
      // Nothing the query was built from may have changed under a warm process;
      // the SDK fixes all of it at startup and offers no way to set it again.
      const stale = this.warm.get(key);
      if (stale && stale.identity !== identity) {
        logger.debug?.("retiring Claude query whose startup options changed");
        this.retireWarm(key);
      }
      await publishProjectMcpStatus(
        approvedProject.mcpWarnings.length > 0
          || this.warm.get(key)?.projectMcpFailed === true,
      );
      this.assertTurnAdmitted(options.signal);

      while (!adapter.isTerminal()) {
        this.assertTurnAdmitted(options.signal);
        let warm = this.warm.get(key);
        if (!warm) {
          const abortController = new AbortController();
          const input = claudeInputChannel();
          const processExit = this.observeQueryExit ? undefined : claudeProcessExitBoundary();
          if (processExit) {
            await this.probe.assertExecutable(probed, options.signal);
            this.assertTurnAdmitted(options.signal);
          }
          const spawnClaudeCodeProcess = processExit
            ? (spawnOptions: ClaudeSpawnOptions): ClaudeSpawnedProcess => {
                const launch = claudeSdkSpawnLaunch(
                  {
                    path: binaryPath,
                    identity: executableIdentity,
                    literalBoundary: true,
                  },
                  probed.interpreter,
                  spawnOptions,
                  runtimeCwd,
                );
                return processExit.spawn({
                  ...spawnOptions,
                  command: launch.executable,
                  args: [...launch.args],
                });
              }
            : undefined;
          let principalTasks: ClaudePrincipalTaskContextLease | undefined;
          const ask = new AskBroker();
          let bridge = baseBridge;
          try {
            principalTasks = this.principalTaskContext
              ? await this.principalTaskContext(ghost.name, conversationId, runtimeCwd)
              : undefined;
            this.assertTurnAdmitted(options.signal);
            if (principalTasks) {
              bridge = await withPrincipalTaskTools(baseBridge, principalTasks.context, sdk);
              this.assertTurnAdmitted(options.signal);
            }
          } catch (cause) {
            input.close();
            principalTasks?.retire();
            throw cause;
          }
          let sdkOptions: ClaudeQueryOptions;
          try {
            sdkOptions = queryOptions({
              sdk,
              binaryPath,
              cwd: runtimeCwd,
              ghostName: ghost.name,
              modelId,
              systemPrompt,
              tools: bridge.tools,
              toolNames: bridge.names,
              metadata,
              newSessionId: admittedSdkSessionId,
              abortController,
              internalMcpServerName: sdkMcpServerName,
              projectMcpServers: approvedProject.mcpServers,
              canUseTool: async (toolName, permissionInput, permissionOptions) =>
                toolName === "AskUserQuestion"
                  ? answerClaudeQuestion(
                      ask,
                      permissionInput,
                      permissionOptions.signal,
                      this.askTimeoutMs(),
                    )
                  : { behavior: "allow" },
              environment: this.environment,
              ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
            });
          } catch (cause) {
            input.close();
            principalTasks?.retire();
            throw cause;
          }
          let created: Query;
          try {
            created = this.createQuery
              ? this.createQuery({ prompt: input.messages, options: sdkOptions })
              : sdk.query({ prompt: input.messages, options: sdkOptions });
          } catch (cause) {
            input.close();
            principalTasks?.retire();
            throw new ClaudeCodeProcessError("Failed to start the Claude Code runtime.", { cause });
          }
          let exited: Promise<void>;
          try {
            exited = this.observeQueryExit
              ? Promise.resolve(this.observeQueryExit(created))
              : processExit?.exited ?? Promise.reject(new ClaudeCodeProcessError(
                "Claude Code did not install its subprocess exit boundary.",
              ));
          } catch (cause) {
            exited = Promise.reject(cause);
          }
          // Retirement owns this promise later. Install a rejection handler
          // now in case the SDK adapter itself is incompatible.
          void exited.catch(() => {});
          warm = {
            query: created,
            messages: created[Symbol.asyncIterator]() as AsyncIterator<SDKMessage>,
            input,
            abortController,
            runtimeIdentity,
            identity,
            exited,
            terminateProcessGroup: processExit?.terminate ?? (() => {}),
            ...(principalTasks ? { principalTasks } : {}),
            ask,
            resources,
            projectMcpFailed: false,
          };
          this.warm.set(key, warm);
        }
        const live = warm;
        const onMessage = (message: SDKMessage): void => {
          if (message.type === "system" && message.subtype === "init") {
            const statuses = new Map(
              (message.mcp_servers ?? []).map((server) => [server.name, server.status]),
            );
            live.projectMcpFailed = configuredProjectMcp.some((name) =>
              statuses.get(name) !== "connected");
          }
          adapter.handle(message);
        };
        this.active.set(key, { query: live.query, abortController: live.abortController });
        // Cancellation is forceful: SDK close/abort owns transport teardown.
        // `interrupt()` is a request over that same transport, so sending it and
        // immediately closing can only race the request.
        const interrupt = () => {
          this.retireWarm(key, live);
        };
        const turnSignal = options.signal;
        if (turnSignal?.aborted) interrupt();
        turnSignal?.addEventListener("abort", interrupt, { once: true });
        let completed: SDKResultMessage;
        try {
          await markResumeStarted(paths.sessionDir, conversationId);
          this.assertTurnAdmitted(options.signal);
          live.input.push(
            prompt,
            ...(!stopHookActive && beforePromptContext ? [beforePromptContext] : []),
          );
          completed = await pumpClaudeTurn(live, onMessage);
          postQueryWorkPending = true;
        } catch (cause) {
          this.retireWarm(key, live);
          throw cause;
        } finally {
          turnSignal?.removeEventListener("abort", interrupt);
          this.active.delete(key);
        }
        await publishProjectMcpStatus(
          approvedProject.mcpWarnings.length > 0 || live.projectMcpFailed,
        );
        this.assertTurnAdmitted(options.signal);

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
          version: 3,
          runtime: "claude-code",
          conversationId,
          sessionId: completed.session_id,
          created: metadata?.created ?? now,
          modified: now,
          messageCount,
          ownerTurnCount: ownerTurnId,
          cwd: runtimeCwd,
          projectSnapshot: approvedProject,
        };
        this.assertTurnAdmitted(options.signal);
        await settleResumeMetadata(paths.sessionDir, metadata);
        this.assertTurnAdmitted(options.signal);
        if (beforePromptAcknowledge) {
          const acknowledge = beforePromptAcknowledge;
          beforePromptAcknowledge = undefined;
          try {
            await acknowledge();
          } catch {
            // The notice was durably delivered but not durably acknowledged.
            // Keep the owner-visible result, but never feed another prompt to
            // the process whose post-query bookkeeping was incomplete.
            this.retireWarm(key, live);
            logger.warn("before_prompt hook acknowledgement failed", {
              runtime: "claude-code",
            });
          }
        }
        if (options.signal?.aborted) {
          this.retireWarm(key, live);
          postQueryWorkPending = false;
          settledTurn = undefined;
          pendingFailure = { cause: new Error("Turn aborted."), aborted: true };
          break;
        }

        const resultText = "result" in completed && typeof completed.result === "string"
          ? completed.result
          : "";
        settledTurn = {
          source: {
            runtime: "claude-code",
            createdAt: metadata.created,
            resumeId: completed.session_id,
          },
          sourceRevision: { kind: "claude-owner-turn", value: ownerTurnId },
          cwd: runtimeCwd,
          ownerPrompt: options.prompt,
          assistantText: resultText,
          outcome: completed.subtype === "success" ? "completed" : "failed",
        };
        if (completed.subtype !== "success") {
          // Terminal SDK errors have a valid resume id and accounting, but the
          // stream itself is no longer a trustworthy place for another turn.
          this.retireWarm(key, live);
        }
        const lastAssistant = {
          role: "assistant",
          content: resultText ? [{ type: "text", text: resultText }] : [],
        };
        const emitsSessionStop = completed.subtype === "success"
          && this.hooks.hasHandlers("session_stop");
        const sdkTranscript = emitsSessionStop
          ? claudeSdkTranscriptPath(completed.session_id, this.environment)
          : undefined;
        const hookResult = emitsSessionStop
          ? await this.hooks.emitSessionStop({
            type: "session_stop",
            messages: [lastAssistant],
            turn_id: ownerTurnId,
            last_assistant_message: lastAssistant,
            session_id: completed.session_id,
            session_file: claudeSessionMetadataPath(paths.sessionDir, conversationId),
            ...(sdkTranscript ? { transcript_path: sdkTranscript } : {}),
            stop_hook_active: stopHookActive,
            owner_prompt: options.prompt,
            signal: options.signal ?? new AbortController().signal,
            ghost_name: ghost.name,
            ghost_home: paths.home,
            cwd: runtimeCwd,
            runtime: "claude-code",
            conversation_runtime: "claude-code",
            conversation_id: conversationId,
          })
          : undefined;
        this.assertTurnAdmitted(options.signal);
        const additionalContext = ghostSessionStopContinuation(hookResult);
        if (!additionalContext) {
          postQueryWorkPending = false;
          pendingTerminalResult = completed;
          break;
        }
        adapter.recordUsage(completed);
        stopHookActive = true;
        prompt = additionalContext;
        postQueryWorkPending = false;
      }
      if (!adapter.isTerminal() && !pendingTerminalResult && !pendingFailure) {
        throw new ClaudeCodeProcessError("Claude Code result did not terminate the turn.");
      }
    } catch (cause) {
      if (postQueryWorkPending) this.retireWarm(key);
      if (options.signal?.aborted) {
        this.retireWarm(key);
        settledTurn = undefined;
      } else if (settledTurn) settledTurn = { ...settledTurn, outcome: "failed" };
      logger.error("Claude Code turn failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      if (!adapter.isTerminal()) pendingFailure = {
        cause,
        aborted: options.signal?.aborted === true || this.disposed,
      };
    } finally {
      try {
        await finishMaintenance?.(settledTurn);
      } catch {
        this.retireWarm(key);
        logger.warn("conversation maintenance turn record failed", {
          runtime: "claude-code",
        });
        pendingTerminalResult = undefined;
        pendingFailure = {
          cause: new Error(MODEL_TURN_PERSISTENCE_ERROR),
          aborted: false,
        };
      }
      try {
        if (pendingTerminalResult && !adapter.isTerminal()) {
          adapter.handle(pendingTerminalResult);
        } else if (pendingFailure && !adapter.isTerminal()) {
          adapter.finishError(pendingFailure.cause, pendingFailure.aborted);
        }
      } catch (cause) {
        this.retireWarm(key);
        terminalEmissionFailure = { cause };
      }
      // Whatever survived the turn starts its idle countdown here, so a warm
      // process is never held by a conversation nobody is talking to.
      this.armSessionIdle(key);
    }
    if (terminalEmissionFailure) throw terminalEmissionFailure.cause;
  }

  async listSessions(ghost: Ghost): Promise<ClaudeSessionMetadata[]> {
    const logger = this.logger.child({ ghost: ghost.name });
    const { sessionDir } = ghostPaths(ghost.dir);
    await mkdir(sessionDir, { recursive: true });
    const names = await readdir(sessionDir);
    const result: ClaudeSessionMetadata[] = [];
    const candidates = new Set<string>();
    for (const name of names) {
      const base = name.endsWith(`${CLAUDE_SESSION_SUFFIX}.settling`)
        ? name.slice(0, -".settling".length)
        : name;
      if (base.startsWith(CLAUDE_SESSION_PREFIX) && base.endsWith(CLAUDE_SESSION_SUFFIX)) {
        candidates.add(base);
      }
    }
    for (const name of candidates) {
      const path = join(sessionDir, name);
      const settling = `${path}.settling`;
      let inspectedPath = settling;
      try {
        let admitted: ClaudeSessionMetadata;
        try {
          admitted = parseMetadata(settling, await readClaudeSessionMetadataFile(settling));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          inspectedPath = path;
          admitted = parseMetadata(path, await readClaudeSessionMetadataFile(path));
        }
        if (!CLAUDE_SESSION_FILE_PATTERN.test(name)
          || claudeSessionMetadataPath(sessionDir, admitted.conversationId) !== path) {
          throw new GhostError(
            "session_identity_mismatch",
            "The stored Claude conversation identity does not match its sidecar filename.",
            409,
          );
        }
        const loaded = await readMetadata(sessionDir, admitted.conversationId);
        if (!loaded) continue;
        const metadata: ClaudeSessionMetadata = { ...loaded };
        delete (metadata as LoadedClaudeSessionMetadata).resumeBlocked;
        result.push(metadata);
      } catch (cause) {
        logger.warn("skipping invalid Claude Code session metadata", {
          path: inspectedPath,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async closeGhost(ghostName: string): Promise<void> {
    // Start every close together so all admitted turns are aborted before this
    // method waits for any one of them to finish its current setup boundary.
    const liveKeys = new Set([
      ...this.turns.keys(),
      ...this.active.keys(),
      ...this.warm.keys(),
      ...this.retiring.keys(),
      ...this.personas.keys(),
    ]);
    await Promise.all([...liveKeys].flatMap((key) => {
      const [keyGhost, conversationId] = JSON.parse(key) as [string, string];
      return keyGhost === ghostName ? [this.close(ghostName, conversationId)] : [];
    }));
  }

  /**
   * Drop a conversation's live query. Called whenever the process must not be
   * reused: idle expiry, an aborted or failed turn that leaves the message
   * stream at an unknown point, a changed persona or project, or shutdown.
   */
  private retireWarm(key: string, expected?: WarmClaudeQuery): void {
    const warm = this.warm.get(key);
    if (!warm || (expected && warm !== expected)) return;
    this.warm.delete(key);
    warm.ask.close();
    warm.principalTasks?.retire();
    let exits = this.retiring.get(key);
    if (!exits) {
      exits = new Set();
      this.retiring.set(key, exits);
    }
    exits.add(warm.exited);
    void warm.exited.then(() => {
      const current = this.retiring.get(key);
      current?.delete(warm.exited);
      if (current?.size === 0) this.retiring.delete(key);
    }, () => {
      // An unacknowledged exit remains visible so close/quiesce fails closed
      // and a later retry can observe the same boundary again.
    });
    warm.input.close();
    try {
      warm.query.close();
    } catch {
      // A query whose process is already gone is exactly what we wanted.
    }
    warm.terminateProcessGroup();
    warm.abortController.abort();
  }

  /** Start one session-idle countdown, even when its query already failed. */
  private armSessionIdle(key: string): void {
    const persona = this.personas.get(key);
    if (!persona) return;
    if (persona.idleTimer) clearTimeout(persona.idleTimer);
    const timer = setTimeout(() => {
      // Clearing a timer cannot dequeue an already-ready callback. The timer
      // identity prevents an admitted replacement turn from expiring itself.
      if (this.personas.get(key) !== persona || persona.idleTimer !== timer) return;
      this.logger.debug?.("expiring idle Claude session", { key });
      this.deletePersona(key, persona);
      this.retireWarm(key);
    }, this.warmIdleTtlMs);
    persona.idleTimer = timer;
    timer.unref?.();
  }

  /** A conversation's persona, held until close or idle expiry drops it. */
  private async sessionPersona(
    key: string,
    home: string,
    ghostName: string,
  ): Promise<string> {
    const cached = this.personas.get(key);
    if (cached !== undefined) return cached.prompt;
    const prompt = await buildPersona(
      home,
      ghostName,
      this.scheduleUnitDir,
      this.principalTaskContext !== undefined,
    );
    // A turn racing another turn of the same conversation is already refused by
    // `busy`, so the first derivation wins and there is nothing to reconcile.
    this.personas.set(key, { prompt });
    return prompt;
  }

  async close(ghostName: string, conversationId: string): Promise<void> {
    const key = JSON.stringify([ghostName, conversationId]);
    const turn = this.turns.get(key);
    turn?.controller.abort(new Error("Conversation closed."));
    this.retireSessionState(key);
    if (turn) await Promise.allSettled([turn.promise]);
    // Async setup may have completed a persona derivation after the first
    // retirement. Closing does not finish until that admitted turn drains, and
    // the second pass makes resurrection impossible after the returned promise.
    this.retireSessionState(key);
    await this.awaitQueryExits(key);
  }

  private retireSessionState(key: string): void {
    this.deletePersona(key);
    const active = this.active.get(key);
    this.active.delete(key);
    this.retireWarm(key);
    // Active and warm normally identify the same SDK query. Keep close
    // authoritative if an injected implementation violates that invariant.
    if (active && !active.abortController.signal.aborted) {
      active.abortController.abort();
      try {
        active.query.close();
      } catch {
        // The query is already retired.
      }
    }
  }

  private deletePersona(key: string, expected?: ClaudeSessionPersona): void {
    const persona = this.personas.get(key);
    if (!persona || (expected && persona !== expected)) return;
    this.personas.delete(key);
    if (persona.idleTimer) clearTimeout(persona.idleTimer);
  }

  private async awaitQueryExits(key: string): Promise<void> {
    const exits = [...(this.retiring.get(key) ?? [])];
    if (exits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(exits),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("exit wait timed out")), this.exitWaitTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      throw new GhostError(
        "claude_code_exit_unconfirmed",
        "Claude Code did not confirm that its subprocess exited. Retry after it finishes shutting down.",
        503,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
    const removedMarkers = await removeResumeMarkers(path);
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return removedMarkers;
      throw error;
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    const keys = new Set([
      ...this.turns.keys(),
      ...this.active.keys(),
      ...this.warm.keys(),
      ...this.retiring.keys(),
      ...this.personas.keys(),
    ]);
    const turns = [...this.turns.values()];
    const shutdown = new GhostError("shutting_down", "The daemon is shutting down.", 503);
    for (const turn of turns) turn.controller.abort(shutdown);
    await Promise.all([...keys].map(async (key) => {
      const [ghostName, conversationId] = JSON.parse(key) as [string, string];
      await this.close(ghostName, conversationId);
    }));
  }
}
