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
 * query process alive forever. Our persona, memory index, and Documents index
 * are rebuilt on every turn; a long-lived query would freeze those system
 * instructions at session creation. Claude's opaque session id supplies
 * continuity when the next scoped query resumes.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, readdirSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
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
  type McpServerConfig as ClaudeMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
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
  DOCUMENT_INDEX_MAX_ENTRIES,
  deriveMemoryIndex,
  deriveDocumentsIndex,
  MachineDocuments,
  openMachineDocuments,
  openGhostHome,
  openRegularFileNoFollow,
  type GhostToolCapabilities,
  type AnyGhostToolDefinition,
  type GhostToolContext,
  type GhostToolResult,
} from "@ghost/extensions";
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
} from "./machine-skills.js";
import {
  renderScheduledWorkPolicy,
  resolveScheduleUnitDirectory,
} from "./schedules.js";
import type { SettledMaintenanceTurn } from "./conversation-maintenance.js";
import type { EffectiveProjectMcpRead } from "./mcp-catalog.js";
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

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_DEFAULT_MODEL_ID = "default";
export const CLAUDE_CODE_BINARY_ENV = "GHOST_CLAUDE_BINARY";
export const CLAUDE_CODE_PROBE_TTL_MS = 5_000;
export const MAX_CLAUDE_CODE_PROBE_TTL_MS = 30_000;

const CLAUDE_SESSION_PREFIX = "claude-";
const CLAUDE_SESSION_SUFFIX = ".json";
const CLAUDE_SESSION_FILE_PATTERN = /^claude-[0-9a-f]{64}\.json$/u;
const MAX_CLAUDE_CODE_SESSION_ID_SCALARS = 512;
const MODEL_TURN_PERSISTENCE_ERROR = "Could not durably settle this owner turn.";
export const CLAUDE_SESSION_METADATA_MAX_BYTES = 16 * 1_048_576;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
export const CLAUDE_CODE_TOOL_CAPABILITIES: GhostToolCapabilities = { vision: true };
const execFileAsync = promisify(execFile);

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
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

export interface ClaudePersistedProjectSnapshot {
  root: string | null;
  identity?: ProjectFilesystemIdentity;
  declarative: DeclarativePromptSnapshot;
  mcpServers: Record<string, ClaudeMcpServerConfig>;
  resourceWarnings: string[];
  mcpWarnings: string[];
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

export interface ClaudeCodeProbeResult {
  binaryPath: string;
  authStatus: ClaudeCodeAuthStatus;
}

export interface ClaudeCodeProbeOptions {
  binaryPath?: string;
  ttlMs?: number;
  now?: () => number;
  resolveExecutable?: (binaryPath: string) => Promise<string>;
  readAuthStatus?: (binaryPath: string) => Promise<ClaudeCodeAuthStatus>;
}

export interface ClaudeCodeRuntimeOptions {
  ownerHome?: string;
  scheduleUnitDir?: string;
  machineSkillPaths?: readonly string[];
  logger?: Logger;
  extensionOptions?: GhostExtensionOptions;
  binaryPath?: string;
  createQuery?: ClaudeCodeQueryFactory;
  readAuthStatus?: (binaryPath: string) => Promise<ClaudeCodeAuthStatus>;
  resolveExecutable?: (binaryPath: string) => Promise<string>;
  probe?: ClaudeCodeProbe;
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

export function claudeSessionMetadataPath(
  sessionDir: string,
  conversationId: string,
): string {
  return nativeClaudeSessionMetadataPath(sessionDir, conversationId);
}

/**
 * The Claude Code SDK's own session transcript for a resume id, when it exists.
 * The SDK persists under `$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<id>.jsonl`;
 * the directory name encoding is the SDK's, so the file is located by id.
 */
export function claudeSdkTranscriptPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(sessionId)) return undefined;
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
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
const CLAUDE_PROJECT_SNAPSHOT_FIELDS = new Set([
  "root",
  "identity",
  "declarative",
  "mcpServers",
  "resourceWarnings",
  "mcpWarnings",
]);
const CLAUDE_PROJECT_IDENTITY_FIELDS = new Set(["dev", "ino"]);
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
    name !== "ghost"
    && validateServerName(name) === undefined
    && validPersistedClaudeMcpConfig(config))) {
    return false;
  }
  if (snapshot.root === null) {
    return snapshot.identity === undefined
      && Object.keys(snapshot.mcpServers).length === 0
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

async function readMetadata(
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
  let file: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    file = await openFile(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await openFile(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return path;
}

async function buildPersona(
  homeDir: string,
  ghostName: string,
  scheduleUnitDir: string,
  configuredDocuments?: MachineDocuments | string,
): Promise<string> {
  const home = openGhostHome(homeDir);
  const documents = configuredDocuments instanceof MachineDocuments
    ? configuredDocuments
    : openMachineDocuments(configuredDocuments);
  const [character, memory, documentPage] = await Promise.all([
    home.readCharacter(),
    home.listMemory(),
    documents.listDirectory("", { limit: DOCUMENT_INDEX_MAX_ENTRIES }),
  ]);
  return buildGhostSystemPrompt({
    ghostName,
    character,
    memoryRoot: home.memoryDir,
    memory: deriveMemoryIndex(memory.files),
    docs: deriveDocumentsIndex(documentPage),
    extraSections: [
      OMARCHY_COMPUTER_USE_POLICY,
      OWNER_DELIVERABLE_POLICY,
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
): Promise<{ tools: SdkMcpToolDefinition[]; names: string[] }> {
  const resolved = resolveGhostExtensions(
    { ...extensionOptions, ghostName },
    homeDir,
    CLAUDE_CODE_TOOL_CAPABILITIES,
  );
  const tools = await bridgeClaudeCodeTools(resolved, homeDir);
  return { tools, names: resolved.toolNames };
}

export async function bridgeClaudeCodeTools(
  resolved: ReturnType<typeof resolveGhostExtensions>,
  homeDir: string,
): Promise<SdkMcpToolDefinition[]> {
  // buildPersona adapts Ghost's prompt hook outside the session runtime; this
  // bridge needs the tools alone. Claude Code has no pi Model instance, so the
  // tool context deliberately carries none.
  const definitions = (await collectGhostExtension(resolved.ghost)).tools;
  const context: GhostToolContext = { cwd: homeDir };
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
  projectMcpServers: Record<string, ClaudeMcpServerConfig>;
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
    // The subprocess cwd must not implicitly authorize project settings,
    // hooks, plugins, or MCP. Ghost injects the approved declarative snapshot
    // and project MCP explicitly at the session boundary.
    settingSources: [],
    skills: [],
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: input.toolNames.map((name) => `mcp__ghost__${name}`),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    mcpServers: mcpServerRecord([
      ...Object.entries(input.projectMcpServers),
      ["ghost", mcp],
    ]),
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

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function projectMcpServers(
  effective: EffectiveProjectMcpRead,
): {
  servers: Record<string, ClaudeMcpServerConfig>;
  warnings: string[];
} {
  const entries: Array<[string, ClaudeMcpServerConfig]> = [];
  const warnings: string[] = [];
  for (const server of effective.servers) {
    if (server.name === "ghost") {
      warnings.push("ghost: this MCP name is reserved by the Ghost runtime.");
      continue;
    }
    if (server.errors.length > 0) {
      warnings.push(`${server.name}: ${server.errors.join("; ")}`);
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
      warnings.push(
        `${server.name}: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.`,
      );
      continue;
    }
    const type = config.type ?? "stdio";
    if (type === "stdio") {
      const stdio = config as OmpMcpStdioServerConfig;
      if (stdio.cwd) {
        warnings.push(
          `${server.name}: row rejected because Claude project MCP does not support an explicit cwd.`,
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
    warnings.push(`${server.name}: unsupported MCP transport ${String(type)}.`);
  }
  return { servers: mcpServerRecord(entries), warnings };
}

function containsEnvironmentExpansion(value: unknown): boolean {
  if (typeof value === "string") return /\$\{[^}]+\}/u.test(value);
  if (Array.isArray(value)) return value.some(containsEnvironmentExpansion);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsEnvironmentExpansion);
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
  const approvedMcp = projectMcpServers(snapshot.mcp);
  const mcpWarningSet = new Set(snapshot.mcpWarnings);
  return {
    root,
    identity: { dev: identity.dev, ino: identity.ino },
    declarative: declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([snapshot])),
    mcpServers: approvedMcp.servers,
    resourceWarnings: snapshot.warnings.filter((warning) => !mcpWarningSet.has(warning)),
    mcpWarnings: [...snapshot.mcpWarnings, ...approvedMcp.warnings],
  };
}

function withRepresentableClaudeMcpTimeouts(
  snapshot: ClaudePersistedProjectSnapshot,
): ClaudePersistedProjectSnapshot {
  const entries: Array<[string, ClaudeMcpServerConfig]> = [];
  const mcpWarnings = [...snapshot.mcpWarnings];
  for (const [name, config] of Object.entries(snapshot.mcpServers)) {
    const timeout = "timeout" in config ? config.timeout : undefined;
    if (timeout !== undefined && timeout < 1_000) {
      const warning = `${name}: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.`;
      if (!mcpWarnings.includes(warning)) mcpWarnings.push(warning);
      continue;
    }
    entries.push([name, config]);
  }
  return { ...snapshot, mcpServers: mcpServerRecord(entries), mcpWarnings };
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
 * Effect owns the subprocess stream and its finalizer. This is the portable
 * core: SDK AsyncIterable consumed to completion, query interrupt on
 * cancellation, and query close on every exit path.
 */
async function runQuery(input: {
  createQuery: ClaudeCodeQueryFactory;
  prompt: string;
  additionalContext?: string;
  options: ClaudeQueryOptions;
  abortController: AbortController;
  signal: AbortSignal | undefined;
  onQuery: (query: Query | null) => void;
  onMessage: (message: SDKMessage) => void;
}): Promise<void> {
  let runtime: Query;
  try {
    runtime = input.createQuery({
      prompt: promptMessages(input.prompt, input.additionalContext),
      options: input.options,
    });
  } catch (cause) {
    throw new ClaudeCodeProcessError("Failed to start the Claude Code runtime.", { cause });
  }
  input.onQuery(runtime);
  const interrupt = () => {
    input.abortController.abort();
    void runtime.interrupt().catch(() => {
      // The finally block still closes the process. An interrupt racing a
      // natural result is not itself a second user-visible failure.
    });
  };
  if (input.signal?.aborted) interrupt();
  input.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    for await (const message of runtime) input.onMessage(message);
  } catch (cause) {
    throw new ClaudeCodeProcessError("Claude Code's message stream failed.", { cause });
  } finally {
    input.signal?.removeEventListener("abort", interrupt);
    input.onQuery(null);
    runtime.close();
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
  private readonly createQuery: ClaudeCodeQueryFactory;
  private readonly probe: ClaudeCodeProbe;
  private readonly hooks: GhostHookRunner;
  private readonly ownerHome: string;
  private readonly scheduleUnitDir: string;
  private readonly machineSkills: string[];
  private readonly busy = new Set<string>();
  private readonly active = new Map<
    string,
    { query: Query; abortController: AbortController }
  >();
  private readonly turns = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  // The character file and the memory/Documents indexes are session-start
  // state, not per-turn state. One scoped query per turn would otherwise derive
  // them again for every owner turn; this keeps a conversation's persona fixed
  // for as long as the daemon holds it, and `close` drops it so the next turn
  // starts from disk. Live truth stays on disk, where the native file tools
  // read it.
  private readonly personas = new Map<string, string>();
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
    this.machineSkills = options.machineSkillPaths
      ? [...options.machineSkillPaths]
      : machineSkillPaths(this.ownerHome);
    this.logger = options.logger ?? silentLogger;
    this.extensionOptions = options.extensionOptions ?? {};
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
    const adapter = createClaudePiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
    });
    let settledTurn: SettledMaintenanceTurn | undefined;
    let pendingTerminalResult: SDKResultMessage | undefined;
    let pendingFailure: { cause: unknown; aborted: boolean } | undefined;
    try {
      const paths = ghostPaths(ghost.dir);
      let metadata = await readMetadata(paths.sessionDir, conversationId);
      this.assertTurnAdmitted();
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

      await mkdir(paths.sessionDir, { recursive: true });
      this.assertTurnAdmitted();
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
      const ownerTurnCount = metadata?.ownerTurnCount ?? 0;
      if (ownerTurnCount >= Number.MAX_SAFE_INTEGER) {
        throw new ClaudeCodeProcessError("Claude Code's owner turn count overflowed.");
      }
      const ownerTurnId = ownerTurnCount + 1;
      const [persona, machineSkills, ghostDeclarative] = await Promise.all([
        this.sessionPersona(key, paths.home, ghost.name),
        loadMachineSkills(this.ownerHome, { paths: this.machineSkills }),
        loadProjectDeclarativeSnapshot(paths.home, { level: "user" }),
      ]);
      const approvedProject = project.admittedSnapshot
        ?? await requireMatchingClaudeProjectSnapshot(metadata, project);
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
      await publishProjectMcpStatus(approvedProject.mcpWarnings.length > 0);
      this.assertTurnAdmitted();
      let beforePromptContext: string | undefined;
      let beforePromptAcknowledge: (() => void | Promise<void>) | undefined;
      if (this.hooks.hasHandlers("before_prompt")) {
        const result = await this.hooks.emitBeforePrompt({
          type: "before_prompt",
          prompt: options.prompt,
          turn_id: ownerTurnId,
          session_id: metadata?.sessionId ?? conversationId,
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
        this.assertTurnAdmitted();
      }
      const bridge = await buildMcpTools(
        paths.home,
        ghost.name,
        this.extensionOptions,
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
          cwd: runtimeCwd,
          ghostName: ghost.name,
          modelId,
          systemPrompt,
          tools: bridge.tools,
          toolNames: bridge.names,
          metadata,
          newSessionId: randomUUID(),
          abortController,
          projectMcpServers: approvedProject.mcpServers,
        });

        let terminalResult: SDKResultMessage | null = null;
        let observedProjectMcpFailure = false;
        await runQuery({
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
            if (message.type === "system" && message.subtype === "init") {
              const statuses = new Map(
                (message.mcp_servers ?? []).map((server) => [server.name, server.status]),
              );
              observedProjectMcpFailure = configuredProjectMcp.some((name) =>
                statuses.get(name) !== "connected");
            }
            if (message.type === "result") {
              // Hold the terminal frame until its resume metadata is durable. A
              // `done` followed by a failed sidecar write would lie to the shell
              // that this conversation can survive a daemon restart.
              terminalResult = message;
            } else {
              adapter.handle(message);
            }
          },
        });
        await publishProjectMcpStatus(
          approvedProject.mcpWarnings.length > 0 || observedProjectMcpFailure,
        );
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
        this.assertTurnAdmitted();
        await writeMetadata(paths.sessionDir, metadata);
        this.assertTurnAdmitted();
        if (beforePromptAcknowledge) {
          const acknowledge = beforePromptAcknowledge;
          beforePromptAcknowledge = undefined;
          try {
            await acknowledge();
          } catch {
            logger.warn("before_prompt hook acknowledgement failed", {
              runtime: "claude-code",
            });
          }
        }
        if (options.signal?.aborted) {
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
        const lastAssistant = {
          role: "assistant",
          content: resultText ? [{ type: "text", text: resultText }] : [],
        };
        const emitsSessionStop = completed.subtype === "success"
          && this.hooks.hasHandlers("session_stop");
        const sdkTranscript = emitsSessionStop
          ? claudeSdkTranscriptPath(completed.session_id)
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
        this.assertTurnAdmitted();
        const additionalContext = ghostSessionStopContinuation(hookResult);
        if (!additionalContext) {
          pendingTerminalResult = completed;
          break;
        }
        if (continuationCount >= GHOST_SESSION_STOP_CONTINUATION_CAP) {
          logger.warn("session_stop continuation cap reached", {
            session: completed.session_id,
            cap: GHOST_SESSION_STOP_CONTINUATION_CAP,
          });
          pendingTerminalResult = completed;
          break;
        }
        adapter.recordUsage(completed);
        continuationCount += 1;
        stopHookActive = true;
        prompt = additionalContext;
      }
      if (!adapter.isTerminal() && !pendingTerminalResult && !pendingFailure) {
        throw new ClaudeCodeProcessError("Claude Code result did not terminate the turn.");
      }
    } catch (cause) {
      if (options.signal?.aborted) settledTurn = undefined;
      else if (settledTurn) settledTurn = { ...settledTurn, outcome: "failed" };
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
        logger.warn("conversation maintenance turn record failed", {
          runtime: "claude-code",
        });
        pendingTerminalResult = undefined;
        pendingFailure = {
          cause: new Error(MODEL_TURN_PERSISTENCE_ERROR),
          aborted: false,
        };
      }
      if (pendingTerminalResult && !adapter.isTerminal()) {
        adapter.handle(pendingTerminalResult);
      } else if (pendingFailure && !adapter.isTerminal()) {
        adapter.finishError(pendingFailure.cause, pendingFailure.aborted);
      }
    }
  }

  async listSessions(ghost: Ghost): Promise<ClaudeSessionMetadata[]> {
    const logger = this.logger.child({ ghost: ghost.name });
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
        const metadata = parseMetadata(path, await readClaudeSessionMetadataFile(path));
        if (!CLAUDE_SESSION_FILE_PATTERN.test(name)
          || claudeSessionMetadataPath(sessionDir, metadata.conversationId) !== path) {
          throw new GhostError(
            "session_identity_mismatch",
            "The stored Claude conversation identity does not match its sidecar filename.",
            409,
          );
        }
        result.push(metadata);
      } catch (cause) {
        logger.warn("skipping invalid Claude Code session metadata", {
          path,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async closeGhost(ghostName: string): Promise<void> {
    for (const key of [...this.personas.keys()]) {
      if (runtimeKeyGhost(key) === ghostName) this.personas.delete(key);
    }
    for (const key of [...this.active.keys()]) {
      const [keyGhost, conversationId] = JSON.parse(key) as [string, string];
      if (keyGhost !== ghostName) continue;
      await this.close(ghostName, conversationId);
    }
  }

  /** A conversation's persona, derived once and held until `close` drops it. */
  private async sessionPersona(
    key: string,
    home: string,
    ghostName: string,
  ): Promise<string> {
    const cached = this.personas.get(key);
    if (cached !== undefined) return cached;
    const persona = await buildPersona(
      home,
      ghostName,
      this.scheduleUnitDir,
      this.extensionOptions.documents,
    );
    // A turn racing another turn of the same conversation is already refused by
    // `busy`, so the first derivation wins and there is nothing to reconcile.
    this.personas.set(key, persona);
    return persona;
  }

  async close(ghostName: string, conversationId: string): Promise<void> {
    const key = JSON.stringify([ghostName, conversationId]);
    this.personas.delete(key);
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
    this.personas.clear();
  }
}
