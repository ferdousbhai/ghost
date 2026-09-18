import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  lstat,
  open as openFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  collectGhostExtension,
  openGhostHome,
  resolveDocumentsDirectory,
} from "@ghost/extensions";
import {
  createAgentSession,
  createBashTool,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  readDaemonControlFile,
  writeDaemonControlFile,
  readDaemonControlLine,
} from "./control-file.js";
import {
  DEFAULT_COMPACTION_CONFIG,
  nativeCompactionSettings,
  type CompactionConfig,
} from "./compaction.js";
import { scrubProviderEnv } from "./env-scrub.js";
import { GhostHookRunner, ghostSessionStopContinuation } from "./hooks.js";
import {
  closeBrowserSession,
  piToolCapabilities,
  readGhostHomeDigest,
  resolveGhostExtensions,
  type GhostExtensionOptions,
  type GhostHomeDigest,
  type GhostHomeDigestInput,
  type GhostHomeDigestReaders,
} from "./extensions.js";
import {
  FIRST_MEETING_SECTION,
  generateGreeting,
  GreetingCache,
  localTimeString,
  wholeDaysSince,
  type GreetingContextInput,
  type GreetingResult,
} from "./greeting.js";
import {
  assertValidGhostName,
  GhostError,
  ghostPaths,
  isSeededCharacter,
  readCharacterFile,
  type Ghost,
  type GhostRegistry,
} from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  ghostCliPath,
  renderScheduledWorkPolicy,
  resolveScheduleUnitDirectory,
  sweepGhostSchedules,
} from "./schedules.js";
import type { CommandRunner } from "./tailscale-identity.js";
import {
  loadMachineSkills,
  machineSkillPaths,
  BACKGROUND_WORK_POLICY,
  HARNESS_LIMITS_POLICY,
  OMARCHY_COMPUTER_USE_POLICY,
  OWNER_DELIVERABLE_POLICY,
  OWNER_HOOKS_POLICY,
  renderOwnerContextPolicy,
} from "./machine-skills.js";
import {
  homeOperationsFor,
  type HomeMoveParticipantReservation,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import {
  userAuthPath,
  userModelsStorePath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  resolveModelRoleRef,
  type GhostModelRoleBinding,
} from "./models.js";
import {
  asRuntimeSessionEvent,
  createPiMessagesAdapter,
  type PiMessagesEvent,
  zeroUsage,
} from "./pi-messages.js";
import { type ConversationPins, readPinState, writePins } from "./pins.js";
import { type ConversationReadState, readReadState, writeReads } from "./reads.js";
import {
  conversationEnvironment,
  conversationIdentity,
  isValidConversationId,
  requireRawConversationId,
  type ConversationRuntime,
} from "./conversation-identity.js";
import { generateTitle } from "./title.js";
import type { TrashPathResult } from "./trash.js";
import {
  bindConversationId,
  conversationIdFromSessionFile,
  requireSessionFileConversationId,
  sessionFileNameFor,
} from "./session-files.js";
export {
  conversationIdFromSessionFile,
  sessionFileNameFor,
};
import { pathIsWithin } from "./path-within.js";
import type { RunningSource } from "./running-source.js";
import { renderSelfMaintenancePolicy, resolveSettingsCwd } from "./self-maintenance.js";
import { createGhostPiRuntime, type GhostPiRuntime } from "./pi-runtime.js";
import { loadGhostSettings, type GhostSettings } from "./ghost-settings.js";
import { AskBroker, AskBrokerError, type PendingAsk } from "./ask-broker.js";
import { AskCancelledError, createAskTool, type AskToolDetails } from "./ask-tool.js";
import type { AskResultItem } from "./ask-broker.js";
import { piExtensionFromGhost, renderPersonaPrompt } from "./pi-extension-bridge.js";
import { CONTEXT_WINDOW_POLICY, ghostContextWindowsExtension } from "./context-windows.js";
import { GhostMcpManager } from "./mcp-manager.js";
import { DEFAULT_ASK_TIMEOUT_SECONDS } from "./config.js";
import { validateServerName, type MCPServerConfig } from "./mcp-config.js";
import { resolveChatModel } from "./model-routing.js";
import type { Rule, Skill } from "./declarative-types.js";
import {
  buildGhostAvailableSlashCommands,
  classifyGhostBuiltin,
  executeGhostBuiltin,
  type GhostAvailableSlashCommand,
  type GhostFileCommand,
} from "./slash-commands.js";
import {
  expandMcpServerConfig,
  normalizeMcpStdioCwd,
  readEffectiveMcp,
} from "./mcp-catalog.js";
import {
  buildSessionResourceView,
  sessionSkillGroup,
  replaceSessionMcpView,
  type SessionMcpGroup,
  type SessionResourceView,
  type SessionSkillGroup,
} from "./session-resources.js";
import { loadDeclarativeSnapshot } from "./declarative-resources.js";
import {
  mergeDeclarativeSnapshots,
  renderPiDeclarativePrompt,
} from "./declarative-snapshot.js";
import {
  conversationCwdPath,
  readLegacyConversationCwd,
  readLegacyToolCwds,
  toolCwdsPath,
} from "./legacy-cwd-files.js";
import {
  readSessionCwds,
  readSessionCwdsFromFile,
  recordConversationCwd,
  recordToolCwd as appendToolCwdEntry,
} from "./session-cwds.js";

/** pi's built-in coding tools a ghost session starts with. */
export const PI_NATIVE_TOOL_NAMES: readonly string[] = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
];


/** pi persists a forced `/skill` prompt as a custom message of this type. */
const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

/** `cd ...` typed at the `!` prompt moves the conversation's working directory. */
function isPersistentShellCdCommand(command: string): boolean {
  return /^cd(?:\s|$)/.test(command.trim());
}

type BashResult = Awaited<ReturnType<AgentSession["executeBash"]>>;

interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  timestamp: number;
  excludeFromContext?: boolean;
}

function bashExecutionToText(message: BashExecutionMessage): string {
  const status = message.cancelled
    ? "[cancelled]"
    : message.exitCode === undefined || message.exitCode === 0
      ? ""
      : `[exit ${message.exitCode}]`;
  const output = message.truncated ? `${message.output}\n[output truncated]` : message.output;
  return [`$ ${message.command}`, output.trimEnd(), status].filter(Boolean).join("\n");
}

export interface UserBashCommand {
  command: string;
  excludeFromContext: boolean;
}

export function parseUserBashCommand(text: string): UserBashCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return null;
  const excludeFromContext = trimmed.startsWith("!!");
  const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
  return { command, excludeFromContext };
}

function bashExecutionText(
  command: UserBashCommand,
  result: BashResult,
): string {
  const message: BashExecutionMessage = {
    role: "bashExecution",
    command: command.command,
    output: result.output,
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    truncated: result.truncated,
    timestamp: Date.now(),
    ...(command.excludeFromContext ? { excludeFromContext: true } : {}),
  };
  return bashExecutionToText(message);
}

function tailSummary(text: string, maxLength = 800): string | undefined {
  const clean = text.trimEnd();
  if (!clean) return undefined;
  return clean.length <= maxLength ? clean : `…${clean.slice(-maxLength)}`;
}

function parseSkillInvocation(prompt: string): { name: string; args: string } | null {
  const match = /^\/skill:([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  return match ? { name: match[1] ?? "", args: (match[2] ?? "").trim() } : null;
}

/**
 * Preserve the explicit `/skill:name args` command surface. The prompt lets
 * the model discover skills; this path is the owner's force-invocation, which
 * sends the admitted skill bytes as an owner-attributed message.
 */
async function promptPiSession(
  session: AgentSession,
  prompt: string,
  skills: readonly Skill[],
): Promise<void> {
  const invocation = parseSkillInvocation(prompt);
  const skill = invocation ? skills.find((candidate) => candidate.name === invocation.name) : undefined;
  if (invocation && skill && skill.snapshotContent !== undefined) {
    const content = [
      `<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.filePath)}>`,
      skill.snapshotContent,
      "</skill>",
      ...(invocation.args ? [`Arguments: ${invocation.args}`] : []),
    ].join("\n");
    await session.sendCustomMessage({
      customType: SKILL_PROMPT_MESSAGE_TYPE,
      content,
      display: true,
      details: { attribution: "user", skill: skill.name },
    }, { triggerTurn: true, deliverAs: "steer" });
    return;
  }
  // pi expands `/name args` against the admitted Markdown commands the loader
  // was given (`promptsOverride`); everything else is the owner's message.
  await session.prompt(prompt);
}

/** Registers whichever manager the hosted MCP slot holds when pi (re)loads. */
function mcpToolsExtension(mcp: HostedMCP): ExtensionFactory {
  return (api) => {
    for (const tool of mcp.manager.getTools()) api.registerTool(tool);
  };
}

function persistedPiOwnerTurnCount(entries: readonly SessionEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const attribution = (entry.message as { attribution?: string }).attribution;
      if (attribution !== "agent") count += 1;
    } else if (entry.type === "custom_message" && customMessageAttribution(entry) === "user") {
      count += 1;
    }
    if (!Number.isSafeInteger(count)) {
      throw new Error("The persisted owner turn count overflowed.");
    }
  }
  return count;
}

type PiOwnerPassKind = "direct" | "steer" | "followUp" | "custom" | "reanswer";

const ASK_REANSWER_OWNER_MESSAGE_TYPE = "ghost-ask-reanswer-owner";
const MODEL_TURN_PERSISTENCE_ERROR = "Could not durably settle this owner turn.";

interface PendingPiOwnerPass {
  readonly id: string;
  readonly kind: PiOwnerPassKind;
  readonly ownerPrompt: string;
  readonly turnId: number;
  readonly priorEntryIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  ownerEntryId?: string;
  acknowledge?: () => void | Promise<void>;
}

interface PersistedPiPassBoundary {
  readonly pass: PendingPiOwnerPass;
  readonly assistantEntry: Extract<SessionEntry, { type: "message" }>;
}

type PersistedPiPassResult = PersistedPiPassBoundary | "superseded" | null;

interface PiSettlementResult {
  readonly settlementError?: unknown;
}

interface PiSettlementBarrier {
  readonly settled: Promise<PiSettlementResult>;
  cancel(): boolean;
}

function entryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("");
}

function customMessageAttribution(entry: Extract<SessionEntry, { type: "custom_message" }>): string | undefined {
  const details = entry.details as { attribution?: unknown } | undefined;
  return typeof details?.attribution === "string" ? details.attribution : undefined;
}

function piOwnerEntry(entry: SessionEntry): { kind: PiOwnerPassKind; prompt: string } | null {
  if (entry.type === "message" && entry.message.role === "user") {
    if ((entry.message as { attribution?: string }).attribution === "agent") return null;
    return {
      kind: "direct",
      prompt: entryText(entry.message.content),
    };
  }
  if (entry.type !== "custom_message") return null;
  if (entry.customType === ASK_REANSWER_OWNER_MESSAGE_TYPE) {
    return { kind: "reanswer", prompt: entryText(entry.content) };
  }
  if (customMessageAttribution(entry) === "user") {
    return { kind: "custom", prompt: entryText(entry.content) };
  }
  return null;
}

function passEntryMatches(
  pass: PendingPiOwnerPass,
  owner: { kind: PiOwnerPassKind; prompt: string },
): boolean {
  if (pass.kind === "direct") return owner.kind === "direct" || owner.kind === "custom";
  // pi queues steer and follow-up text as ordinary user messages.
  if (pass.kind === "steer" || pass.kind === "followUp") {
    return owner.kind === "direct" && owner.prompt === pass.ownerPrompt;
  }
  return owner.kind === pass.kind && owner.prompt === pass.ownerPrompt;
}

/**
 * Generate a title for a new conversation from its first user message. Throws
 * on failure; the caller swallows it. Injectable so a test can drive title
 * behaviour without a real model. The default reads `roles.smol_model` and
 * runs one completion on the cheapest usable model (see title.ts).
 */
export type TitleGenerator = (input: {
  runtime: GhostPiRuntime;
  configDir: string;
  firstPrompt: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface TitleTimeoutTimer {
  unref?(): void;
  dispose(): void;
}

export interface TitleConfig {
  enabled?: boolean;
  timeoutMs?: number;
  generate?: TitleGenerator;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => TitleTimeoutTimer;
}

const DEFAULT_TITLE_TIMEOUT_MS = 15_000;

/** The smol binding and the chat provider it follows; a broken models.json means neither. */
function backgroundRoleRefs(configDir: string): {
  ref: GhostModelRoleBinding | null;
  chatProvider: string | null;
} {
  try {
    const models = readGhostModels(configDir);
    return {
      ref: resolveModelRoleRef(models, "smol_model"),
      chatProvider: resolveChatModelRef(models)?.provider ?? null,
    };
  } catch {
    return { ref: null, chatProvider: null };
  }
}

const defaultTitleGenerator: TitleGenerator = async (
  { runtime, configDir, firstPrompt, signal },
) => {
  const { ref, chatProvider } = backgroundRoleRefs(configDir);
  return generateTitle({ runtime, firstPrompt, ref, chatProvider, signal });
};

function scheduleTitleTimeout(
  callback: () => void,
  timeoutMs: number,
): TitleTimeoutTimer {
  const timer = setTimeout(callback, timeoutMs);
  return {
    unref: () => timer.unref?.(),
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Write the greeting that opens an empty chat. Injectable so a test can drive
 * the route and the cache without a model. The default resolves `smol_model`
 * against a runtime for this ghost and runs one completion (see greeting.ts).
 */
export type GreetingGenerator = (input: {
  ghost: Ghost;
  context: GreetingContextInput;
}) => Promise<string | null>;

export interface GreetingConfig {
  enabled?: boolean;
  ttlMs?: number;
  generate?: GreetingGenerator;
  readRawCharacter?: typeof readCharacterFile;
  inputReaders?: GhostHomeDigestReaders;
  /** Test seam for pausing the short-lived greeting runtime. */
  createRuntime?: typeof createGhostPiRuntime;
}

export interface SessionRetentionTimer {
  unref?(): void;
  dispose(): void;
}

export interface SessionRetentionConfig {
  idleTtlMs?: number;
  maxSessions?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => SessionRetentionTimer;
}

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_CACHED_SESSIONS = 24;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;

function scheduleSessionRetention(
  callback: () => void,
  intervalMs: number,
): SessionRetentionTimer {
  const timer = setInterval(callback, intervalMs);
  return {
    unref: () => timer.unref?.(),
    dispose: () => clearInterval(timer),
  };
}

export type SessionTransactionProbeStage =
  | "fork-staged"
  | "fork-cleanup-unlink"
  | "fork-cleanup-verify"
  | "fork-cleanup-fsync"
  | "fork-marker-unlink"
  | "fork-marker-fsync"
  | "delete-intent-recorded"
  | "delete-artifact-fsync"
  | "delete-artifact-renamed"
  | "delete-receipt-write"
  | "delete-artifact-recorded"
  | "draft-abandon-unlink"
  | "draft-abandon-fsync"
  | "draft-abandon-complete";

export interface SessionHostOptions {
  registry: GhostRegistry;
  ownerHome?: string;
  /** One absolute systemd user-unit directory for prompts and lifecycle. */
  scheduleUnitDir?: string;
  /** The `ghost` executable timer units name; defaults to the one on the daemon's PATH. */
  scheduleCliPath?: string;
  /** Runtime systemd user-unit directory; main supplies the XDG-resolved path. */
  scheduleRuntimeUnitDir?: string;
  /** What runs this daemon, for the self-maintenance policy. Unknown when absent. */
  runningSource?: RunningSource;
  /** Test seam over schedule lifecycle's `systemctl --user` calls. */
  scheduleCommandRunner?: CommandRunner;
  /** Test seam; production discovers the standard owner-machine skill paths. */
  machineSkillPaths?: readonly string[];
  /** Test seam for retiring the process-wide browser entry before a home move. */
  browserSessionClose?: (homeDir: string) => Promise<void>;
  sessionStartupProbe?: (
    stage: "model-runtime" | "mcp" | "session-manager" | "agent-session",
    runtime: GhostPiRuntime,
  ) => void | Promise<void>;
  /** Test seam for fault-injecting durable per-tool cwd publication. */
  /** Test seams for pausing owner sidebar-state publication. */
  pinWriter?: typeof writePins;
  readWriter?: typeof writeReads;
  /** Test seam at conversation-file path ownership boundaries. */
  conversationFileProbe?: (
    operation:
      | "title-write"
      | "transcript-read"
      | "fork-read",
    path: string,
  ) => void | Promise<void>;
  /** Deterministic fault seam around durable fork/delete transaction boundaries. */
  transactionProbe?: (
    stage: SessionTransactionProbeStage,
    path: string,
  ) => void | Promise<void>;
  /** Test seam for failures before or after atomic transaction publication. */
  transactionWriter?: typeof writeTransaction;
  /** Test seam for marker lstat failures; production always uses fs.lstat. */
  transactionMarkerLstat?: (path: string) => Promise<unknown>;
  /** Test seam for classifying a registry move that threw. */
  ghostHomeLstat?: (path: string) => Promise<unknown>;
  logger?: Logger;
  offline?: boolean;
  /**
   * Background conversation-title generation. Enabled by default; a title is
   * generated once, after the first turn of a conversation, fire-and-forget.
   */
  title?: TitleConfig;
  /**
   * The greeting that opens an empty chat, and the onboarding flag that rides
   * with it. Enabled by default; cached per ghost.
   */
  greeting?: GreetingConfig;
  /** Passed to the `@ghost/extensions` factories. */
  extensionOptions?: GhostExtensionOptions;
  /**
   * Seconds a question waits before it settles itself. Daemon-wide; see
   * DaemonConfig.askTimeoutSeconds for why it is not a property of the ghost.
   * `0` (the default here) waits forever; Ghost's `ask` tool reads it per call.
   */
  askTimeoutSeconds?: number;
  /**
   * pi's native compaction, thresholded by Ghost. Defaults to enabled at 80%
   * of the active model's context window.
   */
  compaction?: CompactionConfig;
  hooks?: GhostHookRunner;
  homeOperations?: HomeOperationCoordinator;
  retention?: SessionRetentionConfig;
}

export interface RunTurnOptions {
  sessionId?: string | null;
  prompt: string;
  emit: (event: PiMessagesEvent) => void;
  signal?: AbortSignal;
  /** Off by default because reasoning blocks are private. */
  includeThinking?: boolean;
}

export interface AdmittedTurnOptions {
  emit: (event: PiMessagesEvent) => void;
  signal?: AbortSignal;
  includeThinking?: boolean;
}

export interface TurnAdmission {
  run(options: AdmittedTurnOptions): Promise<void>;
  release(): void;
}

export interface RunAskReanswerOptions {
  sessionId?: string | null;
  entryId: string;
  emit: (event: PiMessagesEvent) => void;
  signal?: AbortSignal;
  includeThinking?: boolean;
}

export interface GhostSessionHandle {
  ghost: Ghost;
  sessionKey: string;
  session: AgentSession;
  sessionFile: string | undefined;
  model: { provider: string; id: string } | null;
  /** The admitted skills, for `/skill:` force-invocation. */
  skills: readonly Skill[];
  /** The admitted rules, rendered into the persona prompt. */
  rules: readonly Rule[];
  /** The admitted Markdown commands and prompt templates, for `/` discovery. */
  commands: readonly GhostFileCommand[];
}

export interface QueuedMessages {
  streaming: boolean;
  count: number;
  steering: readonly string[];
  followUp: readonly string[];
}

export interface TrashedConversationFileArtifact extends TrashPathResult {
  artifact: "transcript" | "conversation-cwd" | "tool-cwds";
  source: string;
}

export interface TrashedConversation {
  artifacts: TrashedConversationFileArtifact[];
}

export type QueueMode = "steer" | "followUp";

interface McpSource {
  path: string;
}

interface HostedMCP {
  manager: GhostMcpManager;
  /** The rows the manager was built from, kept for reconnects. */
  configs: Map<string, MCPServerConfig>;
  sources: Map<string, McpSource>;
  /** Serialized dynamic tool refreshes; never rejects. */
  refresh?: Promise<void>;
  /** Serialized config reconnects; concurrent mutations must not interleave. */
  reload?: Promise<void>;
}

interface HostedSession extends GhostSessionHandle {
  logger: Logger;
  resources: SessionResourceView;
  /** The session's working directory; `!cd` moves it and reopens the session. */
  cwd: string;
  /** Mirrors the transcript's cwd entries so a render need not rescan it. */
  toolCwds: Map<string, string>;
  busy: boolean;
  lastUsedAt: number;
  unsubscribeOwnership?: () => void;
  /** The abort signal of the most recent agent run, captured at `agent_start`. */
  runSignal?: AbortSignal;
  pendingOwnerPasses: PendingPiOwnerPass[];
  /** Serial durability and hook drain shared by every owner-action path. */
  ownerPassSettlement?: Promise<void>;
  /** Live SSE emit for the exclusive owner turn, if one is in flight. */
  streamEmit?: (event: PiMessagesEvent) => void;
  /** Reconstructed from the persisted branch and reserved synchronously per owner action. */
  nextOwnerTurnId: number;
  settlingDeferred?: Promise<void>;
  ask: AskBroker;
  /**
   * The runtime this session's model was bound from, kept so a later model
   * switch can re-resolve against the same catalogue the session was built
   * with (see `rebindModel`).
   */
  modelRuntime: GhostPiRuntime;
  /** The ghost's own settings.yml, read when the session opened. */
  settings: GhostSettings;
  /**
   * Set when a model switch arrived during a turn. The model is rebound after
   * that exclusive owner releases the AgentSession.
   */
  pendingRebind?: boolean;
  pendingAuthRefresh?: boolean;
  pendingMcpReload?: boolean;
  mcpTransitions?: number;
  /**
   * The in-flight background title generation, if any. `listSessions` awaits it
   * so a just-generated title shows up in the listing; it never blocks a turn.
   * Resolves (never rejects) when title generation settles.
   */
  title?: Promise<void>;
  titleAbort?: AbortController;
  /** The short atomic manager/tool publication phase of an MCP transition. */
  mcpPublication?: Promise<void>;
  releaseMcpPublication?: () => void;
  /** Close the borrowed runtime exactly once across graceful/forced teardown. */
  modelRuntimeClosed?: boolean;
  /** Successful cleanup stages shared by graceful, retried, and forced paths. */
  bashAbortStarted?: boolean;
  abortTask?: Promise<void>;
  abortCompleted?: boolean;
  askClosed?: boolean;
  ownershipDetached?: boolean;
  titleAborted?: boolean;
  mcpReloadSettled?: boolean;
  mcpDisconnected?: boolean;
  mcpRefreshSettled?: boolean;
  sessionDisposed?: boolean;
  forceDisposeStarted?: boolean;
  mcp?: HostedMCP;
}

const DEFAULT_SESSION_KEY = "default";

/**
 * Encode a (ghost, conversation) pair into an unambiguous cache key.
 *
 * `JSON.stringify([ghostName, sessionId])` is collision-proof where a plain
 * delimiter is not: a sessionId containing the delimiter (a space, say) could
 * otherwise be read as belonging to a different ghost. A missing sessionId
 * selects DEFAULT_SESSION_KEY; an explicit raw id must satisfy the shared
 * identity grammar before it can enter an in-memory or on-disk key.
 */
export function sessionKeyOf(
  ghostName: string,
  sessionId: string | null | undefined,
): string {
  return JSON.stringify([
    ghostName,
    requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY),
  ]);
}

function sessionKeyParts(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

function deletionKeyOf(
  ghostName: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  return JSON.stringify([ghostName, runtime, conversationId]);
}

function deletionKeyGhost(key: string): string {
  return (JSON.parse(key) as [string, ConversationRuntime, string])[0];
}

function conversationTransactionStem(conversationId: string): string {
  return sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
}

function forkTransactionPath(sessionDir: string, conversationId: string): string {
  return join(sessionDir, `.ghost-fork-${conversationTransactionStem(conversationId)}.pending.json`);
}

function deleteTransactionPath(
  sessionDir: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  return join(
    sessionDir,
    `.ghost-delete-${conversationTransactionStem(conversationId)}.${runtime}.pending.json`,
  );
}

interface ForkTransactionRecord {
  version: 4;
  kind: "fork";
  conversationId: string;
  tempTranscript: string;
  /** v3 staged two cwd sidecars beside the transcript; both now live in it. */
  tempConversationCwd?: string;
  tempToolCwds?: string;
}

const DELETE_ARTIFACT_KINDS = new Set<TrashedConversationFileArtifact["artifact"]>([
  "transcript",
  "conversation-cwd",
  "tool-cwds",
]);

/**
 * The kind a stored delete receipt names, or null when it names nothing Ghost
 * writes. `omp-transcript` is the transcript under the name a build that still
 * had a second runtime wrote; a marker left by one has to finish.
 */
function deleteArtifactKind(value: unknown): TrashedConversationFileArtifact["artifact"] | null {
  if (typeof value !== "string") return null;
  const kind = value === "omp-transcript" ? "transcript" : value;
  return DELETE_ARTIFACT_KINDS.has(kind as TrashedConversationFileArtifact["artifact"])
    ? kind as TrashedConversationFileArtifact["artifact"]
    : null;
}

interface DeleteTransactionRecord {
  version: 1 | 2 | 3 | 4;
  kind: "delete";
  runtime: ConversationRuntime;
  conversationId: string;
  artifacts: TrashedConversationFileArtifact[];
  trashRoot: string | null;
  pending: TrashedConversationFileArtifact | null;
}

const TRANSACTION_MARKER_MAX_BYTES = 1_048_576;

function emptyDeleteTransaction(
  runtime: ConversationRuntime,
  conversationId: string,
): DeleteTransactionRecord {
  return {
    version: 4,
    kind: "delete",
    runtime,
    conversationId,
    artifacts: [],
    trashRoot: null,
    pending: null,
  };
}

type TransactionMarkerState =
  | { state: "absent" | "present" }
  | { state: "indeterminate"; error: unknown };

async function transactionMarkerState(
  path: string,
  inspect: (path: string) => Promise<unknown>,
): Promise<TransactionMarkerState> {
  try {
    await inspect(path);
    return { state: "present" };
  } catch (error) {
    // Absence is the only evidence that a transaction does not own this row.
    // Permission, I/O, and unexpected-path errors are indeterminate; each
    // caller decides whether that fails closed or rethrows, and none reads
    // attacker-controlled marker bytes or follows a symbolic link.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "indeterminate", error };
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await openFile(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * One conversation transaction marker, written the way every other daemon
 * control file is: same temporary name, same `wx` + 0600, same
 * write/sync/rename/fsync-parent, same cleanup on failure. It had its own copy
 * of that sequence; the only difference was the wording of the size error.
 */
async function writeTransaction(path: string, value: unknown): Promise<void> {
  await writeDaemonControlFile(path, `${JSON.stringify(value)}\n`, TRANSACTION_MARKER_MAX_BYTES);
}

function exactSessionChild(sessionDir: string, path: string): boolean {
  const root = resolve(sessionDir);
  return isAbsolute(path) && path === join(root, basename(path));
}

function exactForkTemporaryPath(
  sessionDir: string,
  temporary: string,
  final: string,
  transcript: boolean,
): boolean {
  if (!exactSessionChild(sessionDir, temporary) || !exactSessionChild(sessionDir, final)) {
    return false;
  }
  const finalName = basename(final);
  const temporaryName = basename(temporary);
  const prefixes = transcript ? [`.${finalName}.`, `${finalName}.`] : [`${finalName}.`];
  return prefixes.some((prefix) => {
    if (!temporaryName.startsWith(prefix) || !temporaryName.endsWith(".pending")) return false;
    const token = temporaryName.slice(prefix.length, -".pending".length);
    return /^[A-Za-z0-9_-]+$/u.test(token);
  });
}

const TRANSACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exactDeleteTrashRoot(ghostDir: string, path: string): boolean {
  const parent = join(ghostDir, ".trash");
  const name = basename(path);
  return path === join(parent, name)
    && name.startsWith(".conversation-")
    && TRANSACTION_UUID.test(name.slice(".conversation-".length));
}

function exactDeleteTrashChild(
  trashRoot: string,
  artifact: TrashedConversationFileArtifact,
  index: number,
): boolean {
  const name = basename(artifact.trash);
  if (artifact.trash !== join(trashRoot, name)) return false;
  const prefix = `${String(index).padStart(3, "0")}-`;
  const suffix = `-${basename(artifact.source)}`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  return TRANSACTION_UUID.test(name.slice(prefix.length, -suffix.length));
}

function exactDeleteStaticSource(
  ghostDir: string,
  conversationId: string,
  artifact: TrashedConversationFileArtifact,
): boolean {
  const sessionDir = ghostPaths(ghostDir).sessionDir;
  switch (artifact.artifact) {
    case "transcript":
      return artifact.source === join(sessionDir, sessionFileNameFor(conversationId));
    case "conversation-cwd":
      return artifact.source === conversationCwdPath(sessionDir, conversationId);
    case "tool-cwds":
      return artifact.source === toolCwdsPath(sessionDir, conversationId);
  }
}

function persistentCdTarget(command: string, cwd: string, ownerHome: string): string | null {
  if (!isPersistentShellCdCommand(command)) return null;
  let rest = command.trim().slice(2).trim();
  if (rest === "" || rest === "--") return ownerHome;
  if (rest.startsWith("-- ")) rest = rest.slice(3).trimStart();
  const quote = rest[0];
  if ((quote === '"' || quote === "'") && rest.endsWith(quote)) rest = rest.slice(1, -1);
  if (rest === "~") return ownerHome;
  if (rest.startsWith("~/")) return resolve(ownerHome, rest.slice(2));
  // `cd -` depends on mutable shell history and cannot be authorized before it mutates.
  if (rest === "-") return null;
  return isAbsolute(rest) ? resolve(rest) : resolve(cwd, rest);
}

const PI_SESSION_HEADER_MAX_BYTES = 64 * 1024;
/** A whole transcript, for the pre-open cwd scan. Bounded like any control file. */
const PI_SESSION_MAX_BYTES = 64 * 1_048_576;

/** The cwd pi recorded when it created the transcript, for conversations that never moved. */
async function piSessionHeaderCwd(path: string): Promise<string | undefined> {
  try {
    const first = await readDaemonControlLine(path, PI_SESSION_HEADER_MAX_BYTES);
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    return header.type === "session"
      && typeof header.cwd === "string"
      && !header.cwd.includes("\0")
      && isAbsolute(header.cwd)
      ? resolve(header.cwd)
      : undefined;
  } catch {
    return undefined;
  }
}

type StoredSessionRow = Omit<SessionSummary, "pinned" | "unread">;

/**
 * The pinned row ids. A v1 file keyed pins by bare conversation id, so its
 * entries are matched against the rows to recover the runtime-qualified id.
 */
function pinnedRowIds(
  state: ConversationPins,
  rows: readonly StoredSessionRow[],
): Set<string> {
  if (state.version !== 1) return new Set(state.pinned);
  const expanded = new Set<string>();
  for (const conversationId of state.pinned) {
    for (const row of rows) {
      if (row.conversationId === conversationId) expanded.add(row.id);
    }
  }
  return expanded;
}

/** Read timestamps by row id, expanding a v1 file the way `pinnedRowIds` does. */
function readsByRowId(
  state: ConversationReadState,
  rows: readonly StoredSessionRow[],
): Record<string, string> {
  if (state.version !== 1) return { ...state.reads };
  const expanded: Record<string, string> = {};
  for (const [conversationId, readAt] of Object.entries(state.reads)) {
    for (const row of rows) {
      if (row.conversationId === conversationId) expanded[row.id] = readAt;
    }
  }
  return expanded;
}

export interface SessionSummary {
  /** Runtime-qualified public row/action identity. */
  id: string;
  conversationId: string;
  runtime: ConversationRuntime;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  unread: boolean;
}

export interface ConversationUpdatedEvent {
  type: "conversation-updated";
  id: string;
  conversationId: string;
  runtime: ConversationRuntime;
  updatedAt: string;
}

export type ConversationEventListener = (event: ConversationUpdatedEvent) => void;

interface ConversationEventSubscription {
  listener: ConversationEventListener;
  close: () => void;
}

export const SESSION_STOP_CONTINUATION_TYPE = "session-stop-continuation";

export interface TranscriptMessage {
  role: "user" | "assistant" | "hook";
  content: unknown;
  timestamp?: number;
  entryId: string;
  parentId: string | null;
  /** Present when the stored text was cut at the journal's per-text bound. */
  contentTruncated?: true;
}

export type AskSettlement = "submitted" | "cancelled" | "timedOut" | "chat";

/**
 * What a persisted `ask` still offers a reader. Branching off a message forks
 * the conversation rather than walking siblings in place, so the only sibling
 * left to describe is the ask's own: re-answering commits a new one here.
 */
export interface AskBranchNavigation {
  resultEntryId: string;
  settled: AskSettlement;
}

/**
 * How an ask closed survives only in the tool result pi wrote. A cancel or an
 * abort throws out of the tool, leaving an error entry with empty details; an
 * answer carries the selections, either as `results` for a multi-question ask
 * or flattened onto details for a single one. Without reading that back, a
 * restored transcript cannot tell an answer from a question nobody ever saw.
 */
function askSettlement(details: AskToolDetails | null | undefined): AskSettlement {
  if (!details) return "cancelled";
  if (details.chatRedirect === true) return "chat";
  const timedOut = (result: AskResultItem) => result.timedOut === true;
  if (details.results && details.results.length > 0) {
    return details.results.some(timedOut) ? "timedOut" : "submitted";
  }
  if (details.selectedOptions || typeof details.customInput === "string") {
    return details.timedOut === true ? "timedOut" : "submitted";
  }
  return "cancelled";
}

export interface Transcript {
  id: string;
  conversationId: string;
  runtime: ConversationRuntime;
  title: string | null;
  messages: TranscriptMessage[];
  total: number;
  truncated: boolean;
  /** True when turns before `messages[0]`'s page existed but are unavailable. */
  historyTruncated: boolean;
}

export const DEFAULT_TRANSCRIPT_LIMIT = 1_000;
export const MAX_TRANSCRIPT_LIMIT = 2_000;

function clampTranscriptLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_TRANSCRIPT_LIMIT;
  return Math.max(1, Math.min(MAX_TRANSCRIPT_LIMIT, Math.floor(limit)));
}

function clampTranscriptOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/**
 * One paging rule for every transcript projection. The shell verifies `total`
 * and `truncated` across pages, so the arithmetic must not drift between
 * runtimes.
 */
function pageTranscript(
  all: TranscriptMessage[],
  options: { limit?: number; offset?: number },
): Pick<Transcript, "messages" | "total" | "truncated"> {
  const total = all.length;
  const limit = clampTranscriptLimit(options.limit);
  const offset = Math.min(clampTranscriptOffset(options.offset), total);
  const messages = all.slice(offset, offset + limit);
  return {
    messages,
    total,
    truncated: offset > 0 || offset + messages.length < total,
  };
}

/**
 * Project one session message entry to a renderable transcript message, or null
 * to drop it. Keeps user and assistant messages (the assistant's `toolCall`
 * blocks included, exactly as the live stream sends them); drops internal
 * `toolResult` messages and any private `thinking` content.
 *
 * A dropped `toolResult` is the only record that a call failed, so the one bit
 * of it a reader needs — `failed` — is carried onto the call it belongs to.
 * Without it a restored transcript shows every recovered tool as having
 * succeeded, which is the one thing a tool card must never get wrong.
 */
function projectTranscriptMessage(
  entry: Extract<SessionEntry, { type: "message" }>,
  askBranches: ReadonlyMap<string, AskBranchNavigation>,
  failedToolCalls: ReadonlySet<string>,
  toolCwds: ReadonlyMap<string, string>,
): TranscriptMessage | null {
  const message = entry.message;
  const role = (message as { role?: unknown } | null)?.role;
  if (role === "bashExecution") {
    const bashMessage = message as BashExecutionMessage;
    return {
      role: "assistant",
      content: [{ type: "text", text: bashExecutionToText(bashMessage) }],
      entryId: entry.id,
      parentId: entry.parentId,
      ...(typeof bashMessage.timestamp === "number" ? { timestamp: bashMessage.timestamp } : {}),
    };
  }
  if (role !== "user" && role !== "assistant") return null;
  let content = (message as { content?: unknown }).content;
  if (role === "assistant" && Array.isArray(content)) {
    content = content.filter(
      (part) => (part as { type?: unknown } | null)?.type !== "thinking",
    ).map((part) => {
      const toolCall = part as { type?: unknown; id?: unknown } | null;
      if (toolCall?.type !== "toolCall" || typeof toolCall.id !== "string") return part;
      const askBranch = askBranches.get(toolCall.id);
      const failed = failedToolCalls.has(toolCall.id);
      return {
        ...(part as object),
        cwd: toolCwds.get(toolCall.id) ?? null,
        ...(askBranch ? { ghostAsk: askBranch } : {}),
        ...(failed ? { failed: true } : {}),
      };
    });
  }
  const projected: TranscriptMessage = {
    role,
    content,
    entryId: entry.id,
    parentId: entry.parentId,
  };
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number") projected.timestamp = timestamp;
  return projected;
}

function editableUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

const COPY_COUNTER_TITLE = /^(.*\S)\s+\((\d+)\)$/;

/**
 * Name a branched-off conversation the way a file manager names a copy:
 * `<title> (2)`, then `(3)`, `(4)` as more branches come off the same base.
 *
 * The counter is stripped before it is re-applied, so branching "Weekend trip
 * (2)" gives "Weekend trip (3)" rather than "Weekend trip (2) (2)", and the
 * first free counter is chosen against the ghost's existing conversation
 * titles. An untitled source stays untitled: nothing here invents a name, and
 * a copy carries history, so the background titler will never name it either.
 */
export function forkConversationTitle(
  sourceTitle: string | null,
  existingTitles: Iterable<string | null>,
): string | null {
  const title = sourceTitle?.trim();
  if (!title) return null;
  const base = COPY_COUNTER_TITLE.exec(title)?.[1] ?? title;
  const taken = new Set<string>();
  for (const existing of existingTitles) {
    const normalized = existing?.trim();
    if (normalized) taken.add(normalized);
  }
  let counter = 2;
  while (taken.has(`${base} (${counter})`)) counter += 1;
  return `${base} (${counter})`;
}

/** Connect the ghost's own `mcp.json` servers; disabled and malformed rows are reported, not started. */
async function connectGhostMcp(
  manager: GhostMcpManager,
  ghostRoot: string,
  logger: Logger,
): Promise<{
  configs: Map<string, MCPServerConfig>;
  sources: Map<string, McpSource>;
  admission: SessionMcpGroup[];
}> {
  const configs = new Map<string, MCPServerConfig>();
  const sources = new Map<string, McpSource>();
  const effective = await readEffectiveMcp(ghostRoot);
  const admission: SessionMcpGroup[] = [{ source: "ghost", precedence: 1, root: ghostRoot, effective }];
  for (const skipped of effective.skipped) {
    logger.error("MCP config failed to load", { path: skipped.path, code: "mcp_connection_failed" });
  }
  for (const server of effective.servers) {
    if (server.errors.length > 0) {
      logger.error("MCP server failed to load", {
        path: server.source.relativePath,
        ...(validateServerName(server.name) ? {} : { server: server.name }),
        code: "mcp_connection_failed",
      });
      continue;
    }
    const config = server.config as MCPServerConfig;
    if (config.enabled === false) continue;
    configs.set(server.name, normalizeMcpStdioCwd(expandMcpServerConfig(config), ghostRoot));
    sources.set(server.name, { path: server.source.absolutePath });
  }
  if (configs.size === 0) return { configs, sources, admission };
  try {
    const connected = await manager.connectServers(Object.fromEntries(configs));
    for (const [name, error] of connected.errors) {
      logger.error("ghost MCP server failed to load", {
        path: sources.get(name)?.path ?? `mcp:${name}`,
        server: name,
        code: error,
      });
    }
  } catch {
    logger.error("ghost MCP failed to load", { path: ghostRoot, code: "mcp_connection_failed" });
  }
  return { configs, sources, admission };
}

export class SessionHost {
  private readonly registry: GhostRegistry;
  private readonly ownerHome: string;
  private readonly scheduleUnitDir: string;
  private readonly scheduleCliPath: string;
  private readonly scheduleRuntimeUnitDir: string;
  private readonly runningSource: RunningSource | null;
  private readonly scheduleCommandRunner: CommandRunner | undefined;
  private readonly machineSkills: string[];
  private readonly browserSessionClose: (homeDir: string) => Promise<void>;
  private readonly sessionStartupProbe: NonNullable<SessionHostOptions["sessionStartupProbe"]>;
  private readonly pinWriter: typeof writePins;
  private readonly readWriter: typeof writeReads;
  private readonly conversationFileProbe: NonNullable<SessionHostOptions["conversationFileProbe"]>;
  private readonly transactionProbe: NonNullable<SessionHostOptions["transactionProbe"]>;
  private readonly transactionWriter: typeof writeTransaction;
  private readonly transactionMarkerLstat: NonNullable<SessionHostOptions["transactionMarkerLstat"]>;
  private readonly ghostHomeLstat: NonNullable<SessionHostOptions["ghostHomeLstat"]>;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly extensionOptions: GhostExtensionOptions;
  private readonly compactionConfig: CompactionConfig;
  private readonly titleEnabled: boolean;
  private readonly titleTimeoutMs: number;
  private readonly titleTimeoutScheduler: NonNullable<TitleConfig["scheduleTimeout"]>;
  private readonly askTimeoutSeconds: number;
  private readonly generateTitle: TitleGenerator;
  private readonly greetingEnabled: boolean;
  private readonly greetings: GreetingCache;
  private readonly generateGreetingFor: GreetingGenerator;
  private readonly greetingReadRawCharacter: typeof readCharacterFile;
  private readonly greetingInputReaders: GhostHomeDigestReaders | undefined;
  private readonly createGreetingRuntime: typeof createGhostPiRuntime;
  private readonly hooks: GhostHookRunner;
  private readonly homeOperations: HomeOperationCoordinator;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly conversationListeners = new Map<string, Set<ConversationEventSubscription>>();
  /** Prevents parallel turns from constructing duplicate sessions. */
  private readonly opening = new Map<string, Promise<HostedSession>>();
  /** In-flight closes, so a reopen cannot race a still-disposing session. */
  private readonly closing = new Map<
    string,
    { hosted: HostedSession; promise: Promise<void> }
  >();
  private readonly cleanupRetries = new Map<string, HostedSession>();
  private readonly deleting = new Set<string>();
  /** Turn calls reserve a conversation before their first asynchronous open. */
  private readonly turnAdmissions = new Set<string>();
  /** External open/close calls hold a conversation reservation across awaits. */
  private readonly lifecycleAdmissions = new Map<string, number>();
  /** Fork markers owned by this process are not crash-recovered mid-publication. */
  private readonly activeForks = new Set<string>();
  private readonly forkRecoveries = new Map<string, Promise<void>>();
  private readonly mcpReloadGhosts = new Set<string>();
  /** Whole-home delete and rename reserve a ghost name across every await. */
  private readonly reservedGhosts = new Set<string>();
  /** Route-level claims bridge preclaim and host mutation admission. */
  private readonly homeMoveClaims = new Set<string>();
  private readonly unregisterHomeMoveParticipant: (() => void) | undefined;
  private readonly retentionIdleTtlMs: number;
  private readonly retentionMaxSessions: number;
  private readonly retentionNow: () => number;
  private readonly retentionTimer: SessionRetentionTimer;
  private retentionSweep?: Promise<void>;
  private shutdownTasks?: readonly Promise<unknown>[];
  private disposePromise?: Promise<void>;
  private disposed = false;

  constructor(options: SessionHostOptions) {
    this.registry = options.registry;
    this.ownerHome = resolve(options.ownerHome ?? homedir());
    if (!isAbsolute(this.ownerHome)) throw new TypeError("ownerHome must be absolute");
    // main.ts supplies the XDG-resolved production value. Direct/test hosts
    // stay under their own ownerHome rather than inheriting the live desktop.
    const scheduleUnitDir = options.scheduleUnitDir
      ?? resolveScheduleUnitDirectory(this.ownerHome, {});
    if (!isAbsolute(scheduleUnitDir)) {
      throw new TypeError("scheduleUnitDir must be absolute");
    }
    this.scheduleUnitDir = resolve(scheduleUnitDir);
    this.scheduleCliPath = options.scheduleCliPath ?? ghostCliPath();
    const scheduleRuntimeUnitDir = options.scheduleRuntimeUnitDir
      ?? join(this.ownerHome, ".runtime", "systemd", "user");
    if (!isAbsolute(scheduleRuntimeUnitDir)) {
      throw new TypeError("scheduleRuntimeUnitDir must be absolute");
    }
    this.scheduleRuntimeUnitDir = resolve(scheduleRuntimeUnitDir);
    this.runningSource = options.runningSource ?? null;
    this.scheduleCommandRunner = options.scheduleCommandRunner;
    this.machineSkills = options.machineSkillPaths
      ? [...options.machineSkillPaths]
      : machineSkillPaths(this.ownerHome);
    this.browserSessionClose = options.browserSessionClose ?? closeBrowserSession;
    this.sessionStartupProbe = options.sessionStartupProbe ?? (() => {});
    this.pinWriter = options.pinWriter ?? writePins;
    this.readWriter = options.readWriter ?? writeReads;
    this.conversationFileProbe = options.conversationFileProbe ?? (() => {});
    this.transactionProbe = options.transactionProbe ?? (() => {});
    this.transactionWriter = options.transactionWriter ?? writeTransaction;
    this.transactionMarkerLstat = options.transactionMarkerLstat ?? lstat;
    this.ghostHomeLstat = options.ghostHomeLstat ?? lstat;
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.extensionOptions = options.extensionOptions ?? {};
    this.compactionConfig = options.compaction ?? DEFAULT_COMPACTION_CONFIG;
    this.titleEnabled = options.title?.enabled ?? true;
    this.titleTimeoutMs = options.title?.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
    if (!Number.isFinite(this.titleTimeoutMs) || this.titleTimeoutMs <= 0) {
      throw new RangeError("title.timeoutMs must be a finite positive number");
    }
    this.titleTimeoutScheduler = options.title?.scheduleTimeout ?? scheduleTitleTimeout;
    this.askTimeoutSeconds = options.askTimeoutSeconds ?? DEFAULT_ASK_TIMEOUT_SECONDS;
    this.generateTitle = options.title?.generate ?? defaultTitleGenerator;
    this.greetingEnabled = options.greeting?.enabled ?? true;
    this.greetings = new GreetingCache(
      options.greeting?.ttlMs === undefined ? {} : { ttlMs: options.greeting.ttlMs },
    );
    this.generateGreetingFor = options.greeting?.generate
      ?? ((input) => this.defaultGreeting(input));
    this.greetingReadRawCharacter = options.greeting?.readRawCharacter ?? readCharacterFile;
    this.greetingInputReaders = options.greeting?.inputReaders;
    this.createGreetingRuntime = options.greeting?.createRuntime ?? createGhostPiRuntime;
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
    this.homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
    this.unregisterHomeMoveParticipant = this.homeOperations.registerMoveParticipant({
      preclaim: (ghostName) => {
        if (this.ghostBusy(ghostName)) {
          throw new GhostError(
            "ghost_busy",
            "Wait for this ghost's conversations to finish before moving it.",
            409,
          );
        }
      },
      reserve: (ghostName): HomeMoveParticipantReservation => {
        if (this.homeMoveClaims.has(ghostName)) {
          throw new GhostError("ghost_busy", "Another whole-home move is already in progress.", 409);
        }
        this.homeMoveClaims.add(ghostName);
        let released = false;
        return {
          drained: Promise.resolve(),
          release: () => {
            if (released) return;
            released = true;
            this.homeMoveClaims.delete(ghostName);
          },
        };
      },
    });
    this.retentionIdleTtlMs = options.retention?.idleTtlMs
      ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.retentionMaxSessions = options.retention?.maxSessions
      ?? DEFAULT_MAX_CACHED_SESSIONS;
    const sweepIntervalMs = options.retention?.sweepIntervalMs
      ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
    if (!Number.isFinite(this.retentionIdleTtlMs) || this.retentionIdleTtlMs < 0) {
      throw new RangeError("retention.idleTtlMs must be a finite non-negative number");
    }
    if (!Number.isInteger(this.retentionMaxSessions) || this.retentionMaxSessions < 1) {
      throw new RangeError("retention.maxSessions must be a positive integer");
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new RangeError("retention.sweepIntervalMs must be a finite positive number");
    }
    this.retentionNow = options.retention?.now ?? Date.now;
    this.retentionTimer = (options.retention?.schedule ?? scheduleSessionRetention)(
      () => {
        void this.sweepRetainedSessions().catch((error) => {
          this.logger.warn("session retention sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      sweepIntervalMs,
    );
    this.retentionTimer.unref?.();
    // Idempotent: main.ts already scrubbed at boot. Repeated here so that a
    // library consumer (or a test) that skips main.ts still cannot leak an
    // ambient provider key or routing override into a ghost.
    const { removed } = scrubProviderEnv(process.env, { offline: this.offline });
    if (removed.length > 0) {
      this.logger.warn("scrubbed inherited provider credentials and routing overrides", {
        removed,
      });
    }
  }

  private keyOf(ghostName: string, sessionId: string | null | undefined): string {
    return sessionKeyOf(ghostName, sessionId);
  }

  private ghostMoveReserved(ghostName: string): boolean {
    return this.reservedGhosts.has(ghostName) || this.homeMoveClaims.has(ghostName);
  }

  get cachedSessionCount(): number {
    return this.sessions.size;
  }

  private touchSession(hosted: HostedSession): void {
    hosted.lastUsedAt = this.retentionNow();
  }

  private sessionProtectedFromRetention(hosted: HostedSession): boolean {
    const [, conversationId] = sessionKeyParts(hosted.sessionKey);
    return this.sessionOwned(hosted)
      || hosted.session.isCompacting
      || hosted.title !== undefined
      || hosted.settlingDeferred !== undefined
      || hosted.pendingRebind === true
      || hosted.pendingAuthRefresh === true
      || hosted.pendingMcpReload === true
      || (hosted.mcpTransitions ?? 0) > 0
      || this.opening.has(hosted.sessionKey)
      || this.ghostMoveReserved(hosted.ghost.name)
      || this.deleting.has(deletionKeyOf(hosted.ghost.name, "pi", conversationId));
  }

  private sweepRetainedSessions(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.retentionSweep) return this.retentionSweep;
    const sweep = this.doSweepRetainedSessions().finally(() => {
      if (this.retentionSweep === sweep) this.retentionSweep = undefined;
    });
    this.retentionSweep = sweep;
    return sweep;
  }

  private async doSweepRetainedSessions(protectedKey?: string): Promise<void> {
    const oldestFirst = () => [...this.sessions.values()]
      .filter((hosted) => hosted.sessionKey !== protectedKey)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const now = this.retentionNow();
    if (this.retentionIdleTtlMs > 0) {
      for (const hosted of oldestFirst()) {
        if (now - hosted.lastUsedAt < this.retentionIdleTtlMs) break;
        if (this.sessionProtectedFromRetention(hosted)) continue;
        this.retireHostedSession(hosted.sessionKey);
      }
    }
    while (this.sessions.size > this.retentionMaxSessions) {
      const candidate = oldestFirst()
        .find((hosted) => !this.sessionProtectedFromRetention(hosted));
      if (!candidate) break;
      this.retireHostedSession(candidate.sessionKey);
    }
  }

  /** Remove cache admission synchronously; a failed teardown gates replacement opens. */
  private retireHostedSession(key: string): void {
    void this.closeHostedSession(key).catch((error) => {
      const [ghost, conversation] = sessionKeyParts(key);
      this.logger.child({ ghost, conversation }).warn("retained session disposal failed", {
        session: key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  subscribeConversationEvents(
    ghostName: string,
    listener: ConversationEventListener,
    close: () => void = () => {},
  ): () => void {
    this.registry.get(ghostName);
    const listeners = this.conversationListeners.get(ghostName) ?? new Set();
    const subscription = { listener, close };
    listeners.add(subscription);
    this.conversationListeners.set(ghostName, listeners);
    return () => {
      listeners.delete(subscription);
      if (listeners.size === 0 && this.conversationListeners.get(ghostName) === listeners) {
        this.conversationListeners.delete(ghostName);
      }
    };
  }

  private closeConversationEventStreams(ghostName: string): void {
    const listeners = this.conversationListeners.get(ghostName);
    if (!listeners) return;
    this.conversationListeners.delete(ghostName);
    for (const subscription of [...listeners]) {
      try {
        subscription.close();
      } catch (error) {
        this.logger.child({ ghost: ghostName }).warn("conversation event stream close failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    listeners.clear();
  }

  private async announceConversationUpdated(
    ghostName: string,
    conversationId: string,
  ): Promise<void> {
    const listeners = this.conversationListeners.get(ghostName);
    if (!listeners || listeners.size === 0) return;
    const identity = conversationIdentity(conversationId);
    const event: ConversationUpdatedEvent = {
      type: "conversation-updated",
      ...identity,
      updatedAt: new Date().toISOString(),
    };
    for (const { listener } of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.child({ ghost: ghostName, conversation: identity.conversationId }).warn("conversation event listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async open(
    ghostName: string,
    sessionId?: string | null,
  ): Promise<GhostSessionHandle> {
    return this.openInternal(ghostName, sessionId, false);
  }

  /** Continue an open admitted by a home lease that predates any waiting move. */
  private openLeased(
    ghostName: string,
    sessionId?: string | null,
  ): Promise<GhostSessionHandle> {
    return this.openInternal(ghostName, sessionId, true);
  }

  private async openInternal(
    ghostName: string,
    sessionId: string | null | undefined,
    homeLeaseHeld: boolean,
  ): Promise<GhostSessionHandle> {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    if (!homeLeaseHeld && this.ghostMoveReserved(ghostName)) {
      throw new GhostError(
        "ghost_busy",
        "Wait for this ghost to finish moving before opening a conversation.",
        409,
      );
    }
    if (this.mcpReloadGhosts.has(ghostName)) {
      throw new GhostError("session_busy", "Wait for this ghost's MCP reload to finish.", 409);
    }
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    const releaseAdmission = this.reserveLifecycleAdmission(ghostName, conversationId);
    try {
    const key = this.keyOf(ghostName, conversationId);
    const closing = this.closing.get(key);
    if (closing) {
      await closing.promise.catch(() => {});
      if (this.disposed) {
        throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
      }
    }
    if (this.cleanupRetries.has(key)) {
      try {
        await this.closeHostedSession(key);
      } catch {
        throw new GhostError(
          "session_cleanup_pending",
          "The previous session is still cleaning up; retry opening this conversation.",
          503,
        );
      }
    }
    if (this.deleting.has(deletionKeyOf(
      ghostName,
      "pi",
      conversationId,
    ))) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish deleting before opening it.",
        409,
      );
    }
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    await this.recoverForkTransactions(paths.sessionDir, ghostName);
    if (await this.transactionMarkerEntryExists(
      forkTransactionPath(paths.sessionDir, conversationId),
    )) {
      throw new GhostError("session_busy", "This conversation is still being published.", 409);
    }
    if (await this.transactionMarkerEntryExists(
      deleteTransactionPath(paths.sessionDir, "pi", conversationId),
    )) {
      throw new GhostError("session_deleting", "This conversation has an unfinished deletion.", 409);
    }
    const sessionFile = join(paths.sessionDir, sessionFileNameFor(conversationId));
    if (existsSync(sessionFile)) {
      await requireSessionFileConversationId(sessionFile, conversationId);
    }
    const closingAfterMetadataRead = this.closing.get(key);
    if (closingAfterMetadataRead) {
      await closingAfterMetadataRead.promise;
      if (this.disposed) {
        throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
      }
    }
    const existing = this.sessions.get(key);
    if (existing) {
      this.touchSession(existing);
      return existing;
    }
    const pending = this.opening.get(key);
    if (pending) return pending;

    const promise = this.createSession(ghostName, conversationId, key)
      .then(async (hosted) => {
        if (this.disposed) {
          this.cleanupRetries.set(key, hosted);
          await this.closeHostedSession(key).catch(() => {});
          throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
        }
        this.sessions.set(key, hosted);
        await this.doSweepRetainedSessions(key);
        return hosted;
      })
      .finally(() => {
        this.opening.delete(key);
      });
    this.opening.set(key, promise);
    return await promise;
    } finally {
      releaseAdmission();
    }
  }

  async availableCommands(
    ghostName: string,
    sessionId?: string | null,
  ): Promise<GhostAvailableSlashCommand[]> {
    const hosted = await this.idleHostedSession(
      ghostName,
      sessionId,
      "Wait for this conversation to finish before refreshing its commands.",
    );
    try {
      return buildGhostAvailableSlashCommands(hosted.commands);
    } finally {
      await this.releaseSessionClaim(hosted, ghostName);
    }
  }

  async admittedResources(
    ghostName: string,
    sessionId?: string | null,
  ): Promise<SessionResourceView> {
    this.registry.get(ghostName);
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    const existing = this.sessions.get(this.keyOf(ghostName, conversationId));
    if (existing) return structuredClone(existing.resources);
    const hosted = await this.idleHostedSession(
      ghostName,
      conversationId,
      "Wait for this conversation to finish before inspecting its resources.",
    );
    try {
      return structuredClone(hosted.resources);
    } finally {
      await this.releaseSessionClaim(hosted, ghostName);
    }
  }

  /** The cwd a brand-new conversation starts in: `settings.yml cwd:` or the owner home. */
  private defaultCwd(ghost: Ghost): string {
    return resolveSettingsCwd(loadGhostSettings(ghost.dir), this.ownerHome) ?? this.ownerHome;
  }

  /**
   * Where a pi conversation runs: the `!cd` sidecar, else the cwd pi recorded
   * when it created the transcript, else the ghost's default. Refuses a
   * conversation whose fork or deletion is still being published.
   */
  async conversationCwd(ghostName: string, conversationId: string): Promise<string> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    await this.recoverForkTransactions(paths.sessionDir, ghostName);
    if (await this.transactionMarkerEntryExists(forkTransactionPath(paths.sessionDir, conversationId))) {
      throw new GhostError("session_busy", "This conversation is still being published.", 409);
    }
    if (await this.transactionMarkerEntryExists(
      deleteTransactionPath(paths.sessionDir, "pi", conversationId),
    )) {
      throw new GhostError("session_deleting", "This conversation has an unfinished deletion.", 409);
    }
    const sessionFile = join(paths.sessionDir, sessionFileNameFor(conversationId));
    return (await readSessionCwdsFromFile(sessionFile, PI_SESSION_MAX_BYTES)).cwd
      ?? await piSessionHeaderCwd(sessionFile)
      ?? this.defaultCwd(ghost);
  }

  private reserveLifecycleAdmission(ghostName: string, conversationId: string): () => void {
    const key = this.keyOf(ghostName, conversationId);
    this.lifecycleAdmissions.set(key, (this.lifecycleAdmissions.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.lifecycleAdmissions.get(key) ?? 1) - 1;
      if (remaining === 0) this.lifecycleAdmissions.delete(key);
      else this.lifecycleAdmissions.set(key, remaining);
    };
  }

  private async createSession(
    ghostName: string,
    sessionKey: string,
    key: string,
  ): Promise<HostedSession> {
    const ghost = this.registry.get(ghostName);
    const logger = this.logger.child({ ghost: ghostName, conversation: sessionKey });
    const paths = ghostPaths(ghost.dir);
    const runtimeCwd = await this.conversationCwd(ghostName, sessionKey);
    mkdirSync(paths.agentDir, { recursive: true });
    mkdirSync(paths.sessionDir, { recursive: true });

    const settings = loadGhostSettings(paths.home);
    const [sessionCharacter, machineSkills, ghostSnapshot] = await Promise.all([
      openGhostHome(paths.home).readCharacter(),
      loadMachineSkills(this.ownerHome, { paths: this.machineSkills }),
      loadDeclarativeSnapshot(paths.home, { level: "user" }),
    ]);
    const rootSnapshots = [
      ...(machineSkills ? [machineSkills] : []),
      ghostSnapshot,
    ];
    const skillGroups: SessionSkillGroup[] = [
      ...(machineSkills
        ? [sessionSkillGroup(
            "machine",
            0,
            machineSkills,
            machineSkills.skillDiagnostics.map((diagnostic) => ({
              source: "machine" as const,
              ...diagnostic,
            })),
          )]
        : []),
      sessionSkillGroup("ghost", 1, ghostSnapshot),
    ];
    const effectiveDeclarative = mergeDeclarativeSnapshots(rootSnapshots);
    const fileCommands: GhostFileCommand[] = [
      ...effectiveDeclarative.slashCommands,
      ...effectiveDeclarative.promptTemplates,
    ];
    const declarativeSection = renderPiDeclarativePrompt(effectiveDeclarative, {
      disabledRules: settings.getStringList("ttsr.disabledRules"),
    });
    // A seeded character marks a first meeting until the ghost writes its own.
    const extraSections = [
      ...(this.extensionOptions.extraSections ?? []),
      OMARCHY_COMPUTER_USE_POLICY,
      OWNER_DELIVERABLE_POLICY,
      HARNESS_LIMITS_POLICY,
      BACKGROUND_WORK_POLICY,
      CONTEXT_WINDOW_POLICY,
      OWNER_HOOKS_POLICY,
      renderOwnerContextPolicy(resolveDocumentsDirectory(process.env, this.ownerHome)),
      renderScheduledWorkPolicy(ghostName, this.scheduleUnitDir, this.scheduleCliPath),
      renderSelfMaintenancePolicy({
        ghostName,
        running: this.runningSource,
        sessionId: sessionKey,
      }),
      ...(declarativeSection ? [declarativeSection] : []),
      ...(isSeededCharacter(ghostName, sessionCharacter?.body ?? null)
        ? [FIRST_MEETING_SECTION]
        : []),
    ];
    const extensions = resolveGhostExtensions(
      {
        ghostName,
        ...this.extensionOptions,
        extraSections,
      },
      paths.home,
      piToolCapabilities,
    );
    // The persona's own prompt is also the session's base prompt, so the
    // transcript, compaction, and any reader between turns see the ghost
    // rather than pi's default; the hook re-renders it before every turn.
    const ghostExtension = await collectGhostExtension(extensions.ghost);
    const personaSections = await renderPersonaPrompt(ghostExtension, { cwd: runtimeCwd });
    const extensionFactories: ExtensionFactory[] = [
      piExtensionFromGhost(ghostExtension),
    ];

    const modelRuntime = await createGhostPiRuntime({
      authPath: userAuthPath(),
      modelsStorePath: userModelsStorePath(),
      modelsPath: ghostModelsPath(paths.home),
      // Provider catalogs are fetched only when the daemon is not offline.
      allowModelNetwork: !this.offline,
    });

    let mcp: HostedMCP | undefined;
    let sessionManager: SessionManager | undefined;
    let createdSession: AgentSession | undefined;
    try {
    await this.sessionStartupProbe("model-runtime", modelRuntime);
    const manager = new GhostMcpManager({ cwd: runtimeCwd, logger });
    const mcpResult = await connectGhostMcp(manager, paths.home, logger);
    const resources = buildSessionResourceView({
      runtime: "pi",
      skillGroups,
      mcpGroups: mcpResult.admission,
    });
    mcp = { manager, configs: mcpResult.configs, sources: mcpResult.sources };
    await this.sessionStartupProbe("mcp", modelRuntime);

    const sessionFile = join(paths.sessionDir, sessionFileNameFor(sessionKey));
    const sessionFileExists = existsSync(sessionFile);
    if (sessionFileExists) {
      await requireSessionFileConversationId(sessionFile, sessionKey);
    }
    // pi defers a new transcript until its first assistant message; Ghost
    // persists direct bash turns and hook context before any model pass, so
    // it hands pi an empty file, which pi initializes and appends to from then on.
    if (!sessionFileExists) {
      mkdirSync(paths.sessionDir, { recursive: true });
      writeFileSync(sessionFile, "", { flag: "wx", mode: 0o600 });
    }
    // The cwd sidecar outranks the header, which only records where pi started.
    sessionManager = SessionManager.open(sessionFile, paths.sessionDir, runtimeCwd);
    await this.sessionStartupProbe("session-manager", modelRuntime);
    if (!sessionFileExists) bindConversationId(sessionManager, sessionKey);

    const ask = new AskBroker();
    const liveMcp = mcp;
    extensionFactories.push(mcpToolsExtension(liveMcp));
    const chatRef = resolveChatModelRef(readGhostModels(paths.home));
    const chatModel = resolveChatModel(chatRef, modelRuntime.getAvailableSnapshot());
    const compaction = nativeCompactionSettings(this.compactionConfig, chatModel?.contextWindow);
    extensionFactories.push(ghostContextWindowsExtension(compaction));
    if (chatRef && (chatModel?.provider !== chatRef.provider || chatModel.id !== chatRef.modelId)) {
      logger.warn("configured chat model is not available", {
        provider: chatRef.provider,
        modelId: chatRef.modelId,
      });
    }
    const settingsManager = SettingsManager.inMemory({
      compaction,
      defaultTools: [...PI_NATIVE_TOOL_NAMES],
      enableSkillCommands: false,
    }, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd: runtimeCwd,
      agentDir: paths.agentDir,
      settingsManager,
      extensionFactories,
      noExtensions: true,
      noSkills: false,
      additionalSkillPaths: this.machineSkills,
      noPromptTemplates: true,
      promptsOverride: () => ({
        prompts: fileCommands.map((command) => ({
          name: command.name,
          description: command.description,
          content: command.content,
          filePath: command.source,
          sourceInfo: createSyntheticSourceInfo(command.source, { source: "ghost" }),
        })),
        diagnostics: [],
      }),
      noThemes: true,
      noContextFiles: true,
      // The persona extension supplies the complete provider-facing prompt
      // before every turn; pi's own prose never crosses this boundary.
      systemPrompt: personaSections.join("\n\n"),
    });
    await resourceLoader.reload();
    const askTool = createAskTool({
      broker: ask,
      timeoutMs: () => this.askTimeoutSeconds * 1000,
    });
    const created = await createAgentSession({
      cwd: runtimeCwd,
      agentDir: paths.agentDir,
      modelRuntime: modelRuntime.runtime,
      ...(chatModel ? { model: chatModel } : {}),
      sessionManager,
      settingsManager,
      resourceLoader,
      customTools: [
        askTool as ToolDefinition,
        // pi's own bash, with the conversation's identity in the environment
        // so a command can address it (`ghost say --follow-up`).
        createBashTool(runtimeCwd, {
          spawnHook: (context) => ({
            ...context,
            env: { ...context.env, ...conversationEnvironment(ghost.name, sessionKey) },
          }),
        }) as ToolDefinition,
      ],
    });
    const { session, extensionsResult } = created;
    createdSession = session;
    await this.sessionStartupProbe("agent-session", modelRuntime);

    for (const error of extensionsResult.errors ?? []) {
      logger.error("extension failed to load", {
        path: error.path,
        error: String(error.error),
      });
    }

    const toolNames = session.getActiveToolNames();
    const toolCwds = await this.adoptLegacyCwdSidecars(
      session.sessionManager,
      paths.sessionDir,
      sessionKey,
      logger,
    );
    const initialModel = session.model;
    const model = initialModel
      ? { provider: initialModel.provider, id: initialModel.id }
      : null;

    logger.info("ghost session opened", {
      session: sessionKey,
      tools: toolNames.length,
      model: model ? `${model.provider}/${model.id}` : null,
    });

    const hosted: HostedSession = {
      logger,
      resources,
      ghost,
      sessionKey: key,
      session,
      sessionFile: session.sessionFile,
      model,
      modelRuntime,
      cwd: runtimeCwd,
      toolCwds,
      busy: false,
      lastUsedAt: this.retentionNow(),
      pendingOwnerPasses: [],
      nextOwnerTurnId: persistedPiOwnerTurnCount(sessionManager.getBranch()),
      ask,
      settings,
      skills: effectiveDeclarative.skills,
      rules: effectiveDeclarative.rules,
      commands: fileCommands,
      ...(mcp ? { mcp } : {}),
    };
    // A tool catalog change on a live server re-registers the MCP extension.
    liveMcp.manager.setOnToolsChanged(() => this.refreshHostedMcpTools(hosted));
    hosted.unsubscribeOwnership = this.watchExternalTurns(hosted);
    return hosted;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => createdSession?.dispose()),
        Promise.resolve().then(() => mcp?.manager.disconnectAll()),
        Promise.resolve().then(() => modelRuntime.close()),
      ]);
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], "Session startup and cleanup both failed.");
      }
      throw error;
    }
  }

  /**
   * Settle turns that bypass `runTurn` and drive the raw AgentSession
   * directly. HTTP/ask owners publish their terminal frame after the same
   * durability barrier; while one owns the session this watcher stays out so
   * two settlement loops never race one attempt.
   */
  private watchExternalTurns(hosted: HostedSession): () => void {
    const [ghostName, conversationId] = sessionKeyParts(hosted.sessionKey);
    return hosted.session.subscribe((event) => {
      this.touchSession(hosted);
      if (event.type === "agent_start") {
        hosted.runSignal = hosted.session.agent.signal;
      }
      if (event.type === "tool_execution_start") {
        this.recordToolCwd(hosted, event.toolCallId, hosted.session.sessionManager.getCwd());
      }
      if (event.type !== "agent_settled" || hosted.busy) return;
      void (async () => {
        await this.settlePiOwnerPasses(hosted);
        await this.announceConversationUpdated(ghostName, conversationId);
        await this.settleDeferredSession(hosted);
      })().catch((error) => {
        hosted.logger.warn("deferred session update after external turn failed", {
          session: hosted.sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  pendingAsk(
    ghostName: string,
    sessionId?: string | null,
  ): PendingAsk | null {
    this.registry.get(ghostName);
    return this.sessions.get(this.keyOf(ghostName, sessionId))?.ask.pending ?? null;
  }

  answerAsk(
    ghostName: string,
    sessionId: string | null | undefined,
    askId: string,
    answer: unknown,
  ): void {
    this.registry.get(ghostName);
    const hosted = this.sessions.get(this.keyOf(ghostName, sessionId));
    if (!hosted) {
      throw new GhostError("ask_not_pending", "This conversation is not waiting for an answer.", 409);
    }
    try {
      hosted.ask.answer(askId, answer);
    } catch (error) {
      if (error instanceof AskBrokerError) {
        throw new GhostError(
          error.code,
          error.message,
          error.code === "invalid_ask_answer" ? 400 : 409,
        );
      }
      throw error;
    }
  }

  queuedMessages(
    ghostName: string,
    sessionId?: string | null,
  ): QueuedMessages {
    this.registry.get(ghostName);
    const hosted = this.sessions.get(this.keyOf(ghostName, sessionId));
    if (!hosted) return { streaming: false, count: 0, steering: [], followUp: [] };
    return {
      streaming: hosted.session.isStreaming,
      count: hosted.session.pendingMessageCount,
      steering: [...hosted.session.getSteeringMessages()],
      followUp: [...hosted.session.getFollowUpMessages()],
    };
  }

  async queueMessage(
    ghostName: string,
    sessionId: string | null | undefined,
    mode: QueueMode,
    text: string,
  ): Promise<QueuedMessages> {
    this.registry.get(ghostName);
    const hosted = this.sessions.get(this.keyOf(ghostName, sessionId));
    if (!hosted?.session.isStreaming) {
      throw new GhostError(
        "session_not_streaming",
        "This conversation is not currently streaming; send a normal message instead.",
        409,
      );
    }
    const pass = await this.preparePiOwnerPass(hosted, {
      kind: mode,
      ownerPrompt: text,
      delivery: mode,
    });
    try {
      if (mode === "followUp") await hosted.session.followUp(text);
      else await hosted.session.steer(text);
    } catch (error) {
      hosted.pendingOwnerPasses = hosted.pendingOwnerPasses.filter((candidate) => candidate !== pass);
      throw error;
    }
    return this.queuedMessages(ghostName, sessionId);
  }

  /**
   * Re-bind the chat model on every live session for one ghost.
   *
   * A cached `AgentSession` gets its initial model from `createAgentSession`.
   * The model switcher writes a new
   * `roles.chat_model` to models.json but holds no reference to a running
   * session, so without this a switch never reaches a conversation that is
   * already open: `GET /model` would report the new model while every further
   * turn kept answering on the old one (there is no idle eviction).
   * `ModelCatalog.setChatModel` calls this right after the write.
   *
   * A busy session is not yanked mid-turn — the active owner keeps the model
   * it started on. It is flagged instead and rebound once that owner releases
   * the AgentSession.
   *
   */
  async rebindModel(ghostName: string): Promise<void> {
    this.registry.get(ghostName);
    const opening = [...this.opening.entries()]
      .filter(([key]) => sessionKeyParts(key)[0] === ghostName)
      .map(([, promise]) => promise);
    if (opening.length > 0) await Promise.allSettled(opening);

    const sessions = [...this.sessions.values()]
      .filter((hosted) => hosted.ghost.name === ghostName);
    for (const hosted of sessions) hosted.pendingRebind = true;
    await Promise.all(sessions.map((hosted) => this.settleDeferredSession(hosted)));
  }

  /**
   * Reload credentials and credential-scoped model state after a successful login.
   * Idle sessions update before this resolves; active owners coalesce one refresh
   * at their release boundary so an in-flight turn keeps a stable runtime.
   */
  async refreshAuth(ghostName: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.registry.get(ghostName);
    const opening = [...this.opening.entries()]
      .filter(([key]) => sessionKeyParts(key)[0] === ghostName)
      .map(([, promise]) => promise);
    if (opening.length > 0) await Promise.allSettled(opening);
    signal?.throwIfAborted();

    const sessions = [...this.sessions.values()]
      .filter((hosted) => hosted.ghost.name === ghostName);
    const refreshing: Promise<void>[] = [];
    for (const hosted of sessions) {
      signal?.throwIfAborted();
      if (this.sessionOwned(hosted)) {
        hosted.pendingAuthRefresh = true;
        continue;
      }
      hosted.busy = true;
      refreshing.push(this.refreshSessionAuth(hosted, ghostName, signal)
        .catch((error) => {
          if (signal?.aborted) {
            this.retireHostedSession(hosted.sessionKey);
          }
          throw error;
        })
        .finally(() => {
          hosted.busy = false;
          this.touchSession(hosted);
        }));
    }
    await Promise.all(refreshing);
  }

  private async refreshSessionAuth(
    hosted: HostedSession,
    ghostName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.awaitUnlessAborted(
      hosted.modelRuntime.runtime.refresh({ allowNetwork: false, ...(signal ? { signal } : {}) }),
      signal,
    );
    signal?.throwIfAborted();
    await this.rebindSessionModel(hosted, ghostName);
  }

  private async awaitUnlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(resolvePromise, rejectPromise).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  mcpConnectionStatus(
    ghostName: string,
    serverName: string,
  ): "connected" | "connecting" | "disconnected" | "mixed" | "not_loaded" {
    this.registry.get(ghostName);
    const statuses: Array<"connected" | "connecting" | "disconnected"> = [];
    for (const hosted of this.sessions.values()) {
      if (hosted.ghost.name !== ghostName || !hosted.mcp) continue;
      statuses.push(hosted.mcp.manager.getConnectionStatus(serverName));
    }
    if (statuses.length === 0) return "not_loaded";
    const unique = new Set(statuses);
    return unique.size === 1 ? (statuses[0] ?? "not_loaded") : "mixed";
  }

  /**
   * Re-read the ghost MCP file for every open pi conversation.
   * Turns coalesce changes into one deferred reload at their settle boundary;
   * idle sessions reconnect immediately.
   */
  async reloadMcp(ghostName: string): Promise<void> {
    await this.withMcpReload(ghostName, async () => {});
  }

  async withMcpReload<T>(ghostName: string, mutation: () => Promise<T>): Promise<T> {
    this.registry.get(ghostName);
    if (this.ghostMoveReserved(ghostName)
      || this.mcpReloadGhosts.has(ghostName)
      || this.ghostHasTurnAdmission(ghostName)
      || [...this.deleting].some((key) => deletionKeyGhost(key) === ghostName)) {
      throw new GhostError(
        "session_busy",
        "Wait for active turns to finish before reloading MCP.",
        409,
      );
    }
    this.mcpReloadGhosts.add(ghostName);
    try {
      const value = await mutation();
      const opening = [...this.opening.entries()]
        .filter(([key]) => sessionKeyParts(key)[0] === ghostName)
        .map(([, promise]) => promise);
      if (opening.length > 0) await Promise.allSettled(opening);

      const reloads: Promise<void>[] = [];
      for (const hosted of this.sessions.values()) {
        if (hosted.ghost.name !== ghostName || !hosted.mcp) continue;
        if (this.sessionOwned(hosted)) {
          hosted.pendingMcpReload = true;
          continue;
        }
        reloads.push(this.reloadHostedMcp(hosted));
      }
      await Promise.all(reloads);
      return value;
    } finally {
      this.mcpReloadGhosts.delete(ghostName);
    }
  }

  async reconnectMcp(
    ghostName: string,
    serverName: string,
  ): Promise<"connected" | "connecting" | "disconnected" | "mixed" | "not_loaded" | "deferred"> {
    return this.homeOperations.withLease(ghostName, () =>
      this.reconnectMcpLeased(ghostName, serverName)
    );
  }

  /** The caller already owns this ghost home's identity lease. */
  async reconnectMcpLeased(
    ghostName: string,
    serverName: string,
  ): Promise<"connected" | "connecting" | "disconnected" | "mixed" | "not_loaded" | "deferred"> {
    this.registry.get(ghostName);
    if (this.mcpReloadGhosts.has(ghostName)
      || this.ghostHasTurnAdmission(ghostName)
      || [...this.deleting].some((key) => deletionKeyGhost(key) === ghostName)) {
      throw new GhostError(
        "session_busy",
        "Wait for active turns to finish before reconnecting MCP.",
        409,
      );
    }
    this.mcpReloadGhosts.add(ghostName);
    try {
      const managers = [...this.sessions.values()]
        .filter((hosted) => hosted.ghost.name === ghostName && hosted.mcp);
      if (managers.length === 0) return "not_loaded";
      const deferred = managers.filter((hosted) => this.sessionOwned(hosted));
      for (const hosted of deferred) hosted.pendingMcpReload = true;
      await Promise.all(managers
        .filter((hosted) => !this.sessionOwned(hosted))
        .map((hosted) => this.reconnectHostedMcp(hosted, serverName)));
      if (deferred.length > 0) return "deferred";
      return this.mcpConnectionStatus(ghostName, serverName);
    } finally {
      this.mcpReloadGhosts.delete(ghostName);
    }
  }

  private reloadHostedMcp(hosted: HostedSession): Promise<void> {
    const mcp = hosted.mcp;
    if (!mcp) return Promise.resolve();
    hosted.mcpTransitions = (hosted.mcpTransitions ?? 0) + 1;
    const reload = (mcp.reload ?? Promise.resolve()).then(async () => {
      // Connect a complete candidate before replacing the live manager. A
      // malformed or unavailable new server therefore cannot create a window
      // where the old catalog has already been torn down.
      const candidate = this.createHostedMcpCandidate(hosted);
      const connected = await connectGhostMcp(candidate, hosted.ghost.dir, hosted.logger);
      await this.replaceHostedMcpManager(hosted, candidate, connected.configs, connected.sources);
      hosted.resources = replaceSessionMcpView(hosted.resources, connected.admission);
    });
    const tracked = reload.finally(() => {
      if (mcp.reload === tracked) mcp.reload = undefined;
      hosted.mcpTransitions = Math.max(0, (hosted.mcpTransitions ?? 1) - 1);
      this.touchSession(hosted);
    });
    mcp.reload = tracked;
    return tracked;
  }

  private sessionOwned(hosted: HostedSession): boolean {
    return hosted.busy
      || hosted.pendingOwnerPasses.length > 0
      || hosted.ownerPassSettlement !== undefined
      || hosted.session.isStreaming
      || hosted.session.isBashRunning;
  }

  private async preparePiOwnerPass(
    hosted: HostedSession,
    input: {
      kind: PiOwnerPassKind;
      ownerPrompt: string;
      signal?: AbortSignal;
      delivery?: "steer" | "followUp";
    },
  ): Promise<PendingPiOwnerPass> {
    const [ghostName, conversationId] = sessionKeyParts(hosted.sessionKey);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's move to finish.", 409);
    }
    const passSignal = input.signal ?? new AbortController().signal;
    const priorEntryIds = new Set(hosted.session.sessionManager.getBranch().map((entry) => entry.id));
    hosted.nextOwnerTurnId += 1;
    const pass: PendingPiOwnerPass = {
      id: randomUUID(),
      kind: input.kind,
      ownerPrompt: input.ownerPrompt,
      turnId: hosted.nextOwnerTurnId,
      priorEntryIds,
      signal: passSignal,
    };
    if (this.hooks.hasHandlers("before_prompt")) {
      const ghost = this.registry.get(ghostName);
      const result = await this.hooks.emitBeforePrompt({
        type: "before_prompt",
        prompt: input.ownerPrompt,
        turn_id: pass.turnId,
        session_id: hosted.session.sessionId,
        ...(hosted.session.sessionFile ? { session_file: hosted.session.sessionFile } : {}),
        signal: passSignal,
        ghost_name: ghostName,
        ghost_home: ghost.dir,
        cwd: hosted.session.sessionManager.getCwd(),
        runtime: "pi",
        conversation_runtime: "pi",
        conversation_id: conversationId,
      });
      if (result?.additionalContext && !passSignal.aborted) {
        await hosted.session.sendCustomMessage({
          customType: "before-prompt-hook-context",
          content: result.additionalContext,
          display: false,
        }, {
          triggerTurn: false,
          ...(input.delivery ? { deliverAs: input.delivery } : {}),
        });
        // pi writes nothing to disk before the first assistant message, so
        // the hook is acknowledged once the pass has settled durably.
        if (result.acknowledge) pass.acknowledge = result.acknowledge;
      }
    }
    hosted.pendingOwnerPasses.push(pass);
    return pass;
  }

  private persistedPiPassBoundary(
    hosted: HostedSession,
    pass: PendingPiOwnerPass,
    claimedOwnerEntries: Set<string>,
  ): PersistedPiPassResult {
    const branch = hosted.session.sessionManager.getBranch();
    let ownerIndex = pass.ownerEntryId
      ? branch.findIndex((entry) => entry.id === pass.ownerEntryId)
      : -1;
    if (ownerIndex < 0) {
      for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index];
        if (!entry || pass.priorEntryIds.has(entry.id) || claimedOwnerEntries.has(entry.id)) continue;
        const owner = piOwnerEntry(entry);
        if (owner && passEntryMatches(pass, owner)) {
          ownerIndex = index;
          pass.ownerEntryId = entry.id;
          claimedOwnerEntries.add(entry.id);
          break;
        }
      }
    }
    if (ownerIndex < 0) return null;
    let assistantEntry: Extract<SessionEntry, { type: "message" }> | undefined;
    for (let index = ownerIndex + 1; index < branch.length; index += 1) {
      const entry = branch[index];
      if (!entry) continue;
      if (piOwnerEntry(entry)) return assistantEntry ? { pass, assistantEntry } : "superseded";
      if (entry.type === "message" && entry.message.role === "assistant"
        && entry.message.stopReason !== "toolUse") assistantEntry = entry;
    }
    return assistantEntry ? { pass, assistantEntry } : null;
  }

  private async emitPiSessionStop(
    hosted: HostedSession,
    pass: PendingPiOwnerPass,
    assistantEntry: Extract<SessionEntry, { type: "message" }>,
  ): Promise<void> {
    if (!this.hooks.hasHandlers("session_stop") || pass.signal.aborted) return;
    const [ghostName, conversationId] = sessionKeyParts(hosted.sessionKey);
    const ghost = this.registry.get(ghostName);
    let stopHookActive = false;
    let latestAssistantEntry = assistantEntry;
    while (!pass.signal.aborted) {
      const assistant = latestAssistantEntry.message;
      if (assistant.role !== "assistant") return;
      const sessionFile = hosted.session.sessionFile;
      const result = await this.hooks.emitSessionStop({
        type: "session_stop",
        messages: [assistant],
        turn_id: pass.turnId,
        last_assistant_message: assistant,
        session_id: hosted.session.sessionId,
        ...(sessionFile ? { session_file: sessionFile, transcript_path: sessionFile } : {}),
        stop_hook_active: stopHookActive,
        owner_prompt: pass.ownerPrompt,
        signal: pass.signal,
        ghost_name: ghostName,
        ghost_home: ghost.dir,
        cwd: hosted.session.sessionManager.getCwd(),
        runtime: "pi",
        conversation_runtime: "pi",
        conversation_id: conversationId,
      });
      const additionalContext = ghostSessionStopContinuation(result);
      if (!additionalContext) return;
      // Codex: the hook owns the loop. Ghost sets stop_hook_active so a hook
      // that wants to stop looping can, and does not impose a host bound.
      stopHookActive = true;
      hosted.streamEmit?.({ type: "session_stop_continued", reason: additionalContext });
      await hosted.session.sendCustomMessage({
        customType: SESSION_STOP_CONTINUATION_TYPE,
        content: additionalContext,
        display: false,
      }, { triggerTurn: true });
      const nextAssistant = hosted.session.sessionManager.getBranch().findLast((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
      );
      if (nextAssistant?.type === "message") latestAssistantEntry = nextAssistant;
    }
  }

  private settlePiOwnerPasses(hosted: HostedSession): Promise<void> {
    if (hosted.ownerPassSettlement) return hosted.ownerPassSettlement;
    let settling!: Promise<void>;
    settling = (async () => {
      const claimedOwnerEntries = new Set<string>();
      const completed = new Set<PendingPiOwnerPass>();
      try {
        for (const pass of [...hosted.pendingOwnerPasses]) {
          const boundary = this.persistedPiPassBoundary(hosted, pass, claimedOwnerEntries);
          if (!boundary) continue;
          completed.add(pass);
          if (pass.acknowledge) {
            try {
              await pass.acknowledge();
            } catch {
              hosted.logger.warn("before_prompt hook acknowledgement failed", {
                runtime: "pi",
              });
            }
          }
          if (boundary === "superseded") continue;
          const assistantEntry = boundary.assistantEntry;
          const assistant = assistantEntry.message;
          // An abort that lands while a tool runs surfaces on the follow-up
          // model call as a provider error; the run's own signal is the fact.
          const aborted = assistant.role === "assistant"
            && (assistant.stopReason === "aborted"
              || (assistant.stopReason === "error" && hosted.runSignal?.aborted === true));
          if (assistant.role !== "assistant" || aborted || pass.signal.aborted) continue;
          await this.emitPiSessionStop(hosted, pass, assistantEntry);
        }
      } finally {
        hosted.pendingOwnerPasses = hosted.pendingOwnerPasses.filter(
          (pass) => !completed.has(pass),
        );
      }
      if (!hosted.session.isStreaming && hosted.session.pendingMessageCount === 0) {
        hosted.pendingOwnerPasses.splice(0);
      }
    })().finally(() => {
      if (hosted.ownerPassSettlement === settling) hosted.ownerPassSettlement = undefined;
    });
    hosted.ownerPassSettlement = settling;
    return settling;
  }

  private async abandonPiOwnerPasses(hosted: HostedSession): Promise<void> {
    await hosted.ownerPassSettlement?.catch(() => {});
    hosted.pendingOwnerPasses.splice(0);
  }

  private deferPiSettlement(hosted: HostedSession): PiSettlementBarrier {
    const completed = Promise.withResolvers<PiSettlementResult>();
    let armed = true;
    const unsubscribe = hosted.session.subscribe((event) => {
      if (!armed || event.type !== "agent_settled") return;
      armed = false;
      unsubscribe();
      void (async () => {
        let result: PiSettlementResult;
        try {
          result = await this.settlePiNow(hosted);
        } catch (error) {
          result = { settlementError: error };
        }
        completed.resolve(result);
      })();
    });
    return {
      settled: completed.promise,
      cancel: () => {
        if (!armed) return false;
        armed = false;
        unsubscribe();
        return true;
      },
    };
  }

  private async settlePiNow(hosted: HostedSession): Promise<PiSettlementResult> {
    let settlementError: unknown;
    try {
      await this.settlePiOwnerPasses(hosted);
    } catch (error) {
      settlementError = error;
      hosted.logger.warn("Pi owner pass settlement failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.abandonPiOwnerPasses(hosted);
    }
    return settlementError === undefined ? {} : { settlementError };
  }

  private async publishMcpCandidate<T>(
    hosted: HostedSession,
    publish: () => Promise<T>,
  ): Promise<T> {
    while (hosted.mcpPublication) await hosted.mcpPublication;
    const publication = Promise.withResolvers<void>();
    hosted.mcpPublication = publication.promise;
    hosted.releaseMcpPublication = publication.resolve;
    try {
      return await publish();
    } finally {
      if (hosted.mcpPublication === publication.promise) {
        hosted.releaseMcpPublication?.();
        hosted.mcpPublication = undefined;
        hosted.releaseMcpPublication = undefined;
      }
    }
  }

  private createHostedMcpCandidate(hosted: HostedSession): GhostMcpManager {
    return new GhostMcpManager({
      cwd: hosted.session.sessionManager.getCwd(),
      logger: hosted.logger,
    });
  }

  /**
   * Re-register the MCP tool extension on the live session so pi's tool
   * registry follows the manager's current catalog. Serialized; never rejects.
   */
  private refreshHostedMcpTools(hosted: HostedSession): Promise<void> {
    const mcp = hosted.mcp;
    if (!mcp) return Promise.resolve();
    const run = (mcp.refresh ?? Promise.resolve()).then(async () => {
      if (hosted.sessionDisposed) return;
      await hosted.session.reload();
    });
    mcp.refresh = run.catch(() => {
      hosted.logger.warn("ghost MCP tool refresh failed", {
        code: "mcp_tool_load_failed",
      });
    });
    return run;
  }

  private async replaceHostedMcpManager(
    hosted: HostedSession,
    candidate: GhostMcpManager,
    configs: Map<string, MCPServerConfig>,
    sources: Map<string, McpSource>,
  ): Promise<void> {
    const mcp = hosted.mcp;
    if (!mcp) {
      await candidate.disconnectAll().catch(() => {});
      return;
    }
    await this.publishMcpCandidate(hosted, async () => {
      const previous = mcp.manager;
      previous.setOnToolsChanged(undefined);
      candidate.setOnToolsChanged(() => this.refreshHostedMcpTools(hosted));
      mcp.manager = candidate;
      mcp.configs = configs;
      mcp.sources = sources;
      try {
        await this.refreshHostedMcpTools(hosted);
      } catch (error) {
        mcp.manager = previous;
        previous.setOnToolsChanged(() => this.refreshHostedMcpTools(hosted));
        await this.refreshHostedMcpTools(hosted).catch(() => {});
        await candidate.disconnectAll().catch(() => {});
        throw error;
      }
      await previous.disconnectAll().catch(() => {
        hosted.logger.warn("previous MCP manager did not close cleanly", {
          code: "mcp_connection_failed",
        });
      });
    });
  }

  private reconnectHostedMcp(hosted: HostedSession, serverName: string): Promise<void> {
    const mcp = hosted.mcp;
    if (!mcp?.configs.has(serverName)) return Promise.resolve();
    hosted.mcpTransitions = (hosted.mcpTransitions ?? 0) + 1;
    const reconnect = (mcp.reload ?? Promise.resolve()).then(async () => {
      const candidate = this.createHostedMcpCandidate(hosted);
      const configs = new Map(mcp.configs);
      const sources = new Map(mcp.sources);
      let published = false;
      try {
        await candidate.connectServers(Object.fromEntries(configs));
        await this.replaceHostedMcpManager(hosted, candidate, configs, sources);
        published = true;
      } catch (error) {
        if (!published) await candidate.disconnectAll().catch(() => {});
        throw error;
      }
    });
    const tracked = reconnect.finally(() => {
      if (mcp.reload === tracked) mcp.reload = undefined;
      hosted.mcpTransitions = Math.max(0, (hosted.mcpTransitions ?? 1) - 1);
      this.touchSession(hosted);
    });
    mcp.reload = tracked;
    return tracked;
  }

  /**
   * Take over a home written before the cwd state moved into the transcript.
   * The sidecars are copied in as entries once and then unlinked; a home that
   * never had them, or has already been adopted, does no work and no writes.
   */
  private async adoptLegacyCwdSidecars(
    manager: SessionManager,
    sessionDir: string,
    conversationId: string,
    logger: Logger,
  ): Promise<Map<string, string>> {
    const current = readSessionCwds(manager);
    const [legacyCwd, legacyToolCwds] = await Promise.all([
      readLegacyConversationCwd(sessionDir, conversationId),
      readLegacyToolCwds(sessionDir, conversationId),
    ]);
    if (legacyCwd === undefined && legacyToolCwds.size === 0) return current.toolCwds;
    try {
      if (legacyCwd !== undefined && current.cwd === undefined) {
        recordConversationCwd(manager, legacyCwd);
      }
      for (const [toolCallId, cwd] of legacyToolCwds) {
        if (current.toolCwds.has(toolCallId)) continue;
        appendToolCwdEntry(manager, toolCallId, cwd);
      }
    } catch (error) {
      // The conversation still opens; it just keeps its sidecars for next time.
      logger.warn("could not adopt legacy cwd sidecars", {
        session: conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map([...legacyToolCwds, ...current.toolCwds]);
    }
    await Promise.all([
      unlink(conversationCwdPath(sessionDir, conversationId)).catch(() => {}),
      unlink(toolCwdsPath(sessionDir, conversationId)).catch(() => {}),
    ]);
    logger.info("adopted legacy cwd sidecars", { session: conversationId });
    return readSessionCwds(manager).toolCwds;
  }

  /**
   * pi's session file is the store, so persisting is an append through the
   * writer that already owns it — no debounce, no version watermark, and no
   * flush before teardown, which is what a second file needed.
   */
  private recordToolCwd(hosted: HostedSession, toolCallId: string, cwd: string): void {
    const absolute = resolve(cwd);
    hosted.toolCwds.delete(toolCallId);
    hosted.toolCwds.set(toolCallId, absolute);
    try {
      appendToolCwdEntry(hosted.session.sessionManager, toolCallId, absolute);
    } catch (error) {
      hosted.logger.warn("could not persist a tool working directory", {
        toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Apply queued owner changes, then atomically release this session claim. */
  private async releaseSessionClaim(hosted: HostedSession, ghostName: string): Promise<void> {
    try {
      while (hosted.pendingAuthRefresh || hosted.pendingRebind || hosted.pendingMcpReload) {
        if (hosted.pendingAuthRefresh) {
          hosted.pendingAuthRefresh = false;
          await this.refreshSessionAuth(hosted, ghostName);
        }
        if (hosted.pendingRebind) {
          hosted.pendingRebind = false;
          await this.rebindSessionModel(hosted, ghostName);
        }
        if (hosted.pendingMcpReload) {
          hosted.pendingMcpReload = false;
          await this.reloadHostedMcp(hosted);
        }
      }
    } finally {
      hosted.busy = false;
      this.touchSession(hosted);
    }
  }

  /**
   * Drain model/MCP changes after an owner that bypassed SessionHost settles.
   * One promise per hosted session prevents two agent_end boundaries from
   * applying the same queued change concurrently.
   */
  private settleDeferredSession(hosted: HostedSession): Promise<void> {
    if (this.disposed || this.sessions.get(hosted.sessionKey) !== hosted) return Promise.resolve();
    if (hosted.settlingDeferred) return hosted.settlingDeferred;
    if (this.sessionOwned(hosted)) return Promise.resolve();
    hosted.busy = true;
    const settling = this.releaseSessionClaim(hosted, hosted.ghost.name)
      .finally(() => {
        if (hosted.settlingDeferred === settling) hosted.settlingDeferred = undefined;
      });
    hosted.settlingDeferred = settling;
    return settling;
  }

  /**
   * Re-resolve `roles.chat_model` from the ghost's models.json and rebind it on
   * one idle session, against the runtime the session was built with. Never
   * throws — a failure leaves the previous binding in place and is logged.
   */
  private async rebindSessionModel(hosted: HostedSession, ghostName: string): Promise<void> {
    const configDir = ghostPaths(hosted.ghost.dir).home;
    try {
      hosted.model = await this.selectModel(
        hosted.session,
        hosted.modelRuntime,
        configDir,
        ghostName,
      );
    } catch (error) {
      hosted.logger.warn("model rebind failed", {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Rebind the ghost's chat model after an owner changes its routing.
   *
   * Provider-agnostic by construction: the (provider, modelId) pair comes
   * from the ghost's own `models.json`, and an unresolvable pair is a warning
   * rather than a hard failure — the catalogue default still applies,
   * and the turn will report a clean error if there is nothing to run on.
   */
  private async selectModel(
    session: AgentSession,
    modelRuntime: GhostPiRuntime,
    configDir: string,
    ghostName: string,
  ): Promise<{ provider: string; id: string } | null> {
    let ref: ReturnType<typeof resolveChatModelRef> = null;
    try {
      ref = resolveChatModelRef(readGhostModels(configDir));
    } catch (error) {
      this.logger.error("models.json is unusable", {
        ghost: ghostName,
        error: (error as Error).message,
      });
      const current = session.model;
      return current ? { provider: current.provider, id: current.id } : null;
    }
    const model = resolveChatModel(ref, modelRuntime.getAvailableSnapshot());
    if (ref && (model?.provider !== ref.provider || model.id !== ref.modelId)) {
      this.logger.warn("configured chat model is not available", {
        ghost: ghostName,
        provider: ref.provider,
        modelId: ref.modelId,
      });
    }
    if (model) {
      // Await the live rebind so the next prompt cannot race onto the prior model.
      await session.setModel(model);
      return { provider: model.provider, id: model.id };
    }
    const current = session.model;
    return current ? { provider: current.provider, id: current.id } : null;
  }

  private async runUserBash(
    ghostName: string,
    command: UserBashCommand,
    options: RunTurnOptions,
  ): Promise<void> {
    const conversationId = options.sessionId ?? DEFAULT_SESSION_KEY;
    const hosted = await this.idleHostedSession(
      ghostName,
      options.sessionId,
      "This ghost is already working in this conversation.",
    );
    const id = `bash-${randomUUID()}`;
    const executionCwd = resolve(hosted.session.sessionManager.getCwd());
    let streamedTail = "";
    let lastUpdate = 0;
    let toolFinished = false;
    let pendingTerminal: Extract<PiMessagesEvent, { type: "done" | "error" }> | undefined;
    const onAbort = () => hosted.session.abortBash();
    try {
      options.emit({ type: "start" });
      options.emit({
        type: "tool_execution_start",
        id,
        toolName: "bash",
        arguments: {
          command: command.command,
          excludeFromContext: command.excludeFromContext,
        },
        cwd: executionCwd,
        intent: "Run a local command",
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const result = await hosted.session.executeBash(
        command.command,
        (chunk) => {
          streamedTail = `${streamedTail}${chunk}`.slice(-4_000);
          const now = Date.now();
          if (now - lastUpdate < 75) return;
          lastUpdate = now;
          options.emit({
            type: "tool_execution_update",
            id,
            toolName: "bash",
            summary: tailSummary(streamedTail),
          });
        },
        { excludeFromContext: command.excludeFromContext },
      );

      if (
        isPersistentShellCdCommand(command.command)
        && !result.cancelled
        && result.exitCode === 0
      ) {
        const target = persistentCdTarget(command.command, executionCwd, this.ownerHome);
        const nextCwd = target ? resolve(target) : null;
        if (nextCwd && nextCwd !== resolve(hosted.session.sessionManager.getCwd())) {
          recordConversationCwd(hosted.session.sessionManager, nextCwd);
          hosted.cwd = nextCwd;
          await this.announceConversationUpdated(ghostName, conversationId);
        }
      }

      const isError = result.cancelled
        || (result.exitCode !== undefined && result.exitCode !== 0);
      options.emit({
        type: "tool_execution_end",
        id,
        toolName: "bash",
        isError,
        summary: tailSummary(result.output)
          ?? (result.cancelled ? "Command cancelled" : `Exit ${result.exitCode ?? 0}`),
      });
      toolFinished = true;

      const text = bashExecutionText(command, result);
      options.emit({ type: "text_start", contentIndex: 0 });
      options.emit({ type: "text_delta", contentIndex: 0, delta: text });
      options.emit({ type: "text_end", contentIndex: 0, content: text });
      if (options.signal?.aborted) {
        pendingTerminal = {
          type: "error",
          reason: "aborted",
          usage: zeroUsage(),
          errorMessage: "Command aborted.",
        };
      } else {
        pendingTerminal = { type: "done", reason: "stop", usage: zeroUsage() };
      }
    } catch (error) {
      hosted.logger.error("direct bash command failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!toolFinished) {
        options.emit({
          type: "tool_execution_end",
          id,
          toolName: "bash",
          isError: true,
          summary: error instanceof Error ? error.message : String(error),
        });
      }
      pendingTerminal = {
        type: "error",
        reason: options.signal?.aborted ? "aborted" : "error",
        usage: zeroUsage(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      try {
        if (pendingTerminal) options.emit(pendingTerminal);
      } finally {
        await this.releaseSessionClaim(hosted, ghostName);
      }
    }
  }

  private async runBuiltinCommand(
    hosted: HostedSession,
    dispatch: Exclude<ReturnType<typeof classifyGhostBuiltin>, { kind: "not_builtin" }>,
    options: RunTurnOptions,
  ): Promise<void> {
    options.emit({ type: "start" });
    if (dispatch.kind === "unsupported") {
      options.emit({
        type: "command_output",
        command: dispatch.command,
        output: dispatch.reason,
        isError: true,
        code: "unsupported_command",
      });
      options.emit({ type: "done", reason: "stop", usage: zeroUsage() });
      return;
    }

    try {
      const output = await executeGhostBuiltin(dispatch, {
        session: hosted.session,
        cwd: hosted.session.sessionManager.getCwd(),
        ghostHome: hosted.ghost.dir,
      });
      options.emit({ type: "command_output", command: dispatch.command, output });
      options.emit({ type: "done", reason: "stop", usage: zeroUsage() });
    } catch (error) {
      options.emit({
        type: "command_output",
        command: dispatch.command,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        code: "command_failed",
      });
      options.emit({ type: "done", reason: "stop", usage: zeroUsage() });
    }
  }

  /**
   * Reserve and fully validate a turn before an HTTP caller publishes SSE
   * headers. The returned admission freezes runtime selection across the turn.
   */
  async admitTurn(
    ghostName: string,
    options: Pick<RunTurnOptions, "sessionId" | "prompt">,
  ): Promise<TurnAdmission> {
    const conversationId = requireRawConversationId(options.sessionId ?? DEFAULT_SESSION_KEY);
    const admissionKey = this.keyOf(ghostName, conversationId);
    this.registry.get(ghostName);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError(
        "ghost_busy",
        "Wait for this ghost to finish moving before starting a turn.",
        409,
      );
    }
    if (this.mcpReloadGhosts.has(ghostName)) {
      throw new GhostError("session_busy", "Wait for this ghost's MCP reload to finish.", 409);
    }
    if (this.turnAdmissions.has(admissionKey)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }
    this.turnAdmissions.add(admissionKey);
    let released = false;
    let started = false;
    const release = () => {
      if (released) return;
      released = true;
      this.turnAdmissions.delete(admissionKey);
    };
    try {
      const bashCommand = parseUserBashCommand(options.prompt);
      if (bashCommand && !bashCommand.command) {
        throw new GhostError("invalid_request", "Write a command after ! or !!.", 400);
      }
      return {
        run: async (streamOptions: AdmittedTurnOptions) => {
          if (started || released) {
            throw new GhostError("session_busy", "This turn admission is no longer available.", 409);
          }
          started = true;
          try {
            await this.runAdmittedTurn(ghostName, {
              sessionId: conversationId,
              prompt: options.prompt,
              ...streamOptions,
            });
          } finally {
            release();
          }
        },
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Run one turn, streaming pi-messages events to `emit`.
   *
   * Exactly one terminal `done` or `error` is emitted, always — the pinned
   * client treats a stream that ends without one as a failure.
   */
  async runTurn(ghostName: string, options: RunTurnOptions): Promise<void> {
    const admission = await this.admitTurn(ghostName, options);
    try {
      await admission.run({
        emit: options.emit,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.includeThinking === undefined
          ? {}
          : { includeThinking: options.includeThinking }),
      });
    } finally {
      admission.release();
    }
  }

  private async runAdmittedTurn(
    ghostName: string,
    options: RunTurnOptions,
  ): Promise<void> {
    const conversationId = requireRawConversationId(options.sessionId ?? DEFAULT_SESSION_KEY);
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const key = this.keyOf(ghostName, conversationId);
    const bashCommand = parseUserBashCommand(options.prompt);
    if (bashCommand) {
      await this.runUserBash(ghostName, bashCommand, options);
      // pi binds a session's cwd when it opens; a `!cd` takes effect by
      // reopening the conversation at its new operational cwd.
      const moved = this.sessions.get(key);
      if (moved && resolve(moved.cwd) !== resolve(moved.session.sessionManager.getCwd())) {
        await this.closePi(ghostName, conversationId);
      }
      await this.announceConversationUpdated(ghostName, options.sessionId ?? DEFAULT_SESSION_KEY);
      return;
    }
    const hosted = await this.idleHostedSession(
      ghostName,
      options.sessionId,
      "This ghost is already answering in this conversation.",
    );

    // Known builtins are commands even when Ghost cannot safely run them.
    // Consume them before hooks, title generation, and especially
    // before AgentSession.prompt(), where unknown slash text becomes a model
    // message.
    const builtin = classifyGhostBuiltin(options.prompt);
    if (builtin.kind !== "not_builtin") {
      let pendingTerminal: Extract<PiMessagesEvent, { type: "done" | "error" }> | undefined;
      const emitAfterActivityDurability = (event: PiMessagesEvent) => {
        if (event.type === "done" || event.type === "error") pendingTerminal = event;
        else options.emit(event);
      };
      try {
        await this.runBuiltinCommand(hosted, builtin, {
          ...options,
          emit: emitAfterActivityDurability,
        });
        if (pendingTerminal) options.emit(pendingTerminal);
      } finally {
        await this.releaseSessionClaim(hosted, ghostName);
      }
      await this.announceConversationUpdated(ghostName, conversationId);
      return;
    }

    // Decide, BEFORE prompting, whether this turn should name the conversation:
    // titling is on, the conversation has no title yet, and this is its first
    // turn (no assistant message so far — a resumed transcript already has one).
    // `options.prompt` is then the first user message the title is built from.
    const shouldTitle = this.titleEnabled
      && !hosted.session.sessionName
      && !hosted.session.messages.some((message) => message.role === "assistant");

    let pendingTerminal: Extract<PiMessagesEvent, { type: "done" | "error" }> | undefined;
    // The terminal frame goes last, after the settlement events (branch and
    // conversation updates) that a caller needs in order to read it correctly.
    const emitAfterSettlement = (event: PiMessagesEvent) => {
      if (event.type === "done" || event.type === "error") pendingTerminal = event;
      else options.emit(event);
    };
    hosted.streamEmit = emitAfterSettlement;
    const adapter = createPiMessagesAdapter(emitAfterSettlement, {
      includeThinking: options.includeThinking,
      getCwd: () => hosted.session.sessionManager.getCwd(),
      // The shell rendered the POST's prompt before opening the stream. pi
      // emits it again as the run's first user message; only later dequeued
      // steering/follow-ups belong on the live wire.
      skipOwnerMessages: 1,
      // Ghost owns the settle boundary so session_stop can continue this same
      // HTTP turn before its one terminal frame is emitted.
      deferAgentEnd: true,
    });
    const unsubscribe = hosted.session.subscribe((event: AgentSessionEvent) => {
      adapter.handle(asRuntimeSessionEvent(event));
    });

    const onAbort = () => {
      void hosted.session.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let settlementBarrier: PiSettlementBarrier | undefined;
    let turnFailure: { error: unknown; aborted: boolean } | undefined;

    try {
      await this.preparePiOwnerPass(hosted, {
        kind: "direct",
        ownerPrompt: options.prompt,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      settlementBarrier = this.deferPiSettlement(hosted);
      await promptPiSession(hosted.session, options.prompt, hosted.skills);
    } catch (error) {
      hosted.logger.error("turn failed", {
        error: (error as Error).message,
      });
      turnFailure = { error, aborted: options.signal?.aborted === true };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      const settlement = settlementBarrier
        ? settlementBarrier.cancel()
          ? await this.settlePiNow(hosted)
          : await settlementBarrier.settled
        : await this.settlePiNow(hosted);
      if (settlement.settlementError !== undefined) {
        pendingTerminal = {
          type: "error",
          reason: "error",
          usage: adapter.totalUsage(),
          errorMessage: MODEL_TURN_PERSISTENCE_ERROR,
        };
      } else if (turnFailure) {
        adapter.finishError(turnFailure.error, turnFailure.aborted);
      } else {
        adapter.finishDone();
      }
      unsubscribe();
      hosted.streamEmit = undefined;
      if (pendingTerminal) options.emit(pendingTerminal);
      // A model switch that arrived mid-turn was deferred rather than applied to
      // the running prompt; apply it now the turn has settled, before the next
      // turn starts.
      await this.releaseSessionClaim(hosted, ghostName);
      // Name the conversation from its first message, fire-and-forget. Runs
      // after the reply is fully delivered and never blocks the next turn.
      if (shouldTitle) {
        this.startBackgroundTitle(hosted, ghostName, paths.home, options.prompt);
      }
      await this.announceConversationUpdated(ghostName, conversationId);
    }
  }

  /**
   * Fire-and-forget conversation titling. Non-blocking by construction: the
   * promise is stored on the session so `listSessions` can await it before
   * reading titles, but this method never awaits and never throws — a failure
   * is logged and the conversation simply stays untitled. Generation is a
   * single completion on the smol_model (see title.ts); the result is stored
   * as pi's `session_info` name, which never enters the model's context.
   */
  private startBackgroundTitle(
    hosted: HostedSession,
    ghostName: string,
    configDir: string,
    firstPrompt: string,
  ): void {
    const controller = new AbortController();
    hosted.titleAbort?.abort();
    hosted.titleAbort = controller;
    let timedOut = false;
    const timer = this.titleTimeoutScheduler(() => {
      timedOut = true;
      controller.abort();
    }, this.titleTimeoutMs);
    timer.unref?.();
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => rejectAborted(new Error(
      timedOut ? "Conversation title generation timed out." : "Conversation title generation aborted.",
    ));
    controller.signal.addEventListener("abort", onAbort, { once: true });

    const generation = Promise.resolve().then(() => this.generateTitle({
      runtime: hosted.modelRuntime,
      configDir,
      firstPrompt,
      signal: controller.signal,
    }));
    const promise = Promise.race([generation, aborted])
      .then(async (raw) => {
        const title = raw.trim();
        // A concurrent turn may have titled it first; do not overwrite.
        if (!title || hosted.session.sessionName) return;
        hosted.session.setSessionName(title);
        hosted.logger.info("named ghost conversation", {
          session: hosted.session.sessionId,
          title,
        });
        const [, conversationId] = sessionKeyParts(hosted.sessionKey);
        await this.announceConversationUpdated(ghostName, conversationId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted && !timedOut) return;
        hosted.logger.warn("conversation title generation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const tracked: Promise<void> = promise.finally(() => {
      timer.dispose();
      controller.signal.removeEventListener("abort", onAbort);
      if (hosted.titleAbort === controller) hosted.titleAbort = undefined;
      if (hosted.title === tracked) hosted.title = undefined;
      void this.sweepRetainedSessions();
    });
    hosted.title = tracked;
  }

  async greeting(ghostName: string): Promise<GreetingResult> {
    return this.homeOperations.withLease(ghostName, () => this.greetingLeased(ghostName));
  }

  private async greetingLeased(ghostName: string): Promise<GreetingResult> {
    const ghost = this.registry.get(ghostName);
    const logger = this.logger.child({ ghost: ghost.name });
    const unavailable = new Set<GhostHomeDigestInput>();
    const reportUnavailable = (input: GhostHomeDigestInput) => {
      if (unavailable.has(input)) return;
      unavailable.add(input);
      logger.warn("greeting input unavailable", { input });
    };
    let character: string | null = null;
    let characterAvailable = true;
    try {
      character = this.greetingReadRawCharacter(ghost.dir);
    } catch {
      characterAvailable = false;
      reportUnavailable("character");
    }
    // An unreadable character is not evidence that this is a new ghost. Failing
    // closed avoids replaying onboarding over an already-written persona.
    const onboarding = characterAvailable && isSeededCharacter(ghost.name, character);
    if (!this.greetingEnabled) return { greeting: null, onboarding };

    // The character file IS the cache key's second half: writing it is exactly
    // the event that must produce a different greeting immediately.
    const fingerprint = createHash("sha256")
      .update(characterAvailable ? "available\0" : "unavailable\0")
      .update(character ?? "")
      .digest("hex");
    return this.greetings.get(ghost.name, fingerprint, async () => {
      try {
        const context = await this.greetingContext(ghost, onboarding, reportUnavailable);
        return { greeting: await this.generateGreetingFor({ ghost, context }), onboarding };
      } catch {
        logger.warn("greeting generation failed");
        return { greeting: null, onboarding };
      }
    });
  }

  /**
   * Assemble the greeting prompt's inputs. Every part is best-effort: a ghost
   * home that cannot be read still gets a greeting, just a less specific one.
   */
  private async greetingContext(
    ghost: Ghost,
    onboarding: boolean,
    onUnavailable: (input: GhostHomeDigestInput) => void,
  ): Promise<GreetingContextInput> {
    const logger = this.logger.child({ ghost: ghost.name });
    const paths = ghostPaths(ghost.dir);
    const digest: GhostHomeDigest = await readGhostHomeDigest(
      paths.home,
      { readers: this.greetingInputReaders, onUnavailable },
    );

    let daysSinceLastConversation: number | null = null;
    try {
      // The most recent conversation is the last time the owner and this ghost
      // actually spoke. Taken as a max rather than off the head of the
      // listing, which is ordered pinned-first.
      const newest = (await this.collectSessionsLeased(ghost))
        .reduce<string | null>(
          (latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest),
          null,
        );
      if (newest) daysSinceLastConversation = wholeDaysSince(newest);
    } catch {
      logger.warn("greeting conversation recency unavailable");
    }

    return {
      ghostName: ghost.name,
      character: digest.character,
      localTime: localTimeString(),
      daysSinceLastConversation,
      onboarding,
    };
  }

  private async defaultGreeting(input: {
    ghost: Ghost;
    context: GreetingContextInput;
  }): Promise<string | null> {
    const paths = ghostPaths(input.ghost.dir);
    const { ref, chatProvider } = backgroundRoleRefs(paths.home);
    return this.withGreetingRuntime(input.ghost, (runtime) =>
      generateGreeting({ runtime, context: input.context, ref, chatProvider }));
  }

  /**
   * A runtime to `complete()` on, outside any session.
   *
   * A live conversation already has one bound to this ghost's credentials, so
   * reuse it rather than building a second one for one throwaway
   * call; with nothing open, build one exactly as `createSession` does and close
   * it again. (Reusing a live one can race a concurrent `closePi`, which closes
   * that runtime — the completion then fails and the greeting is null, which is
   * the same answer every other failure gives.)
   */
  private async withGreetingRuntime<T>(
    ghost: Ghost,
    use: (runtime: GhostPiRuntime) => Promise<T>,
  ): Promise<T> {
    for (const hosted of this.sessions.values()) {
      if (hosted.ghost.name === ghost.name) return use(hosted.modelRuntime);
    }
    const paths = ghostPaths(ghost.dir);
    const runtime = await this.createGreetingRuntime({
      authPath: userAuthPath(),
      modelsStorePath: userModelsStorePath(),
      modelsPath: ghostModelsPath(paths.home),
      allowModelNetwork: !this.offline,
    });
    try {
      return await use(runtime);
    } finally {
      runtime.close();
    }
  }

  /**
   * The ghost's conversations, pinned first and newest-updated first within
   * each group.
   *
   * Any in-flight title write for this ghost is awaited first, so a title
   * generated by the turn that just finished is already visible here.
   */
  async listSessions(ghostName: string): Promise<SessionSummary[]> {
    return this.homeOperations.withLease(ghostName, () => this.listSessionsLeased(ghostName));
  }

  private async listSessionsLeased(ghostName: string): Promise<SessionSummary[]> {
    const inflightTitles = [...this.sessions.values()]
      .filter((hosted) => hosted.ghost.name === ghostName && hosted.title)
      .map((hosted) => hosted.title as Promise<void>);
    if (inflightTitles.length > 0) await Promise.allSettled(inflightTitles);

    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const [rows, pinState, readState] = await Promise.all([
      this.collectSessionsLeased(ghost),
      readPinState(paths.sessionDir),
      readReadState(paths.sessionDir),
    ]);
    // A pin whose conversation is gone is simply not seen here; the next write
    // prunes it.
    const pinned = pinnedRowIds(pinState, rows);
    const reads = readsByRowId(readState, rows);
    return rows
      .map((row) => {
        const readAt = reads[row.id];
        return {
          ...row,
          pinned: pinned.has(row.id),
          unread: readAt === undefined || row.updatedAt > readAt,
        };
      })
      .sort((a, b) => (a.pinned === b.pinned
        ? b.updatedAt.localeCompare(a.updatedAt)
        : (a.pinned ? -1 : 1)));
  }

  /**
   * Pin or unpin one conversation. Idempotent, and unknown ids are a 404
   * rather than a pin nothing will ever match.
   *
   * The file is rewritten even when the pin state did not change, because that
   * write is also what prunes ids whose conversations have since been deleted
   * by something other than `deleteSession`.
   */
  async setPinned(
    ghostName: string,
    sessionId: string | null | undefined,
    pinned: boolean,
  ): Promise<void> {
    return this.homeOperations.withLease(ghostName, () =>
      this.setPinnedLeased(ghostName, sessionId, pinned)
    );
  }

  private async setPinnedLeased(
    ghostName: string,
    sessionId: string | null | undefined,
    pinned: boolean,
  ): Promise<void> {
    const ghost = this.registry.get(ghostName);
    const conversationId = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(conversationId);
    const paths = ghostPaths(ghost.dir);
    const rows = await this.collectSessionsLeased(ghost);
    const existing = new Set(rows.map((row) => row.id));
    if (!existing.has(identity.id)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(identity.id)}.`,
        404,
      );
    }
    const state = await readPinState(paths.sessionDir);
    const stored = pinnedRowIds(state, rows);
    stored.delete(identity.id);
    const kept = [...stored].filter((pin) => existing.has(pin));
    await this.pinWriter(paths.sessionDir, pinned ? [...kept, identity.id] : kept);
    await this.announceConversationUpdated(ghostName, conversationId);
  }

  /**
   * Record that the owner opened one stored conversation. Rewriting the whole
   * validated map also prunes ids whose conversations disappeared elsewhere.
   */
  async markRead(
    ghostName: string,
    sessionId: string | null | undefined,
    openedAt = new Date(),
  ): Promise<string> {
    return this.homeOperations.withLease(ghostName, () =>
      this.markReadLeased(ghostName, sessionId, openedAt)
    );
  }

  private async markReadLeased(
    ghostName: string,
    sessionId: string | null | undefined,
    openedAt: Date,
  ): Promise<string> {
    const ghost = this.registry.get(ghostName);
    const conversationId = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(conversationId);
    const paths = ghostPaths(ghost.dir);
    const rows = await this.collectSessionsLeased(ghost);
    const existing = new Set(rows.map((row) => row.id));
    if (!existing.has(identity.id)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(identity.id)}.`,
        404,
      );
    }
    const state = await readReadState(paths.sessionDir);
    const reads = readsByRowId(state, rows);
    const kept = Object.fromEntries(
      Object.entries(reads).filter(([id]) => existing.has(id)),
    );
    const readAt = openedAt.toISOString();
    await this.readWriter(paths.sessionDir, { ...kept, [identity.id]: readAt });
    await this.announceConversationUpdated(ghostName, conversationId);
    return readAt;
  }

  /**
   * Name one conversation through pi's `session_info`. The background titler
   * only names a conversation that has no name yet, so it cannot undo a rename.
   *
   * Naming an open conversation uses AgentSession's native path, including
   * while a turn is active.
   */
  async renameConversation(
    ghostName: string,
    conversationId: string | null | undefined,
    title: string,
  ): Promise<string> {
    if (!/\P{C}/u.test(title)) {
      throw new GhostError(
        "invalid_request",
        "A conversation title needs at least one printable character.",
        400,
      );
    }
    return this.homeOperations.withLease(ghostName, () =>
      this.renameConversationLeased(ghostName, conversationId, title)
    );
  }

  private async renameConversationLeased(
    ghostName: string,
    conversationId: string | null | undefined,
    title: string,
  ): Promise<string> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const id = conversationId ?? DEFAULT_SESSION_KEY;
    const key = this.keyOf(ghostName, conversationId);
    const sessionFile = join(paths.sessionDir, sessionFileNameFor(id));
    await this.conversationFileProbe("title-write", sessionFile);
    if (!existsSync(sessionFile) && !this.sessions.has(key) && !this.opening.has(key)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(id)}.`,
        404,
      );
    }
    if (existsSync(sessionFile)) await requireSessionFileConversationId(sessionFile, id);
    if (this.deleting.has(deletionKeyOf(ghostName, "pi", id))) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish deleting before renaming it.",
        409,
      );
    }
    // An open in flight owns this transcript a moment from now; renaming
    // through a second SessionManager would put two writers on one file.
    const opening = this.opening.get(key);
    if (opening) await opening.catch(() => {});

    const hosted = this.sessions.get(key);
    const cwd = hosted?.cwd ?? await this.conversationCwd(ghostName, id);
    // A manager opened for this write alone is simply dropped afterwards; the
    // live session keeps its own, and the next turn re-opens an idle
    // conversation.
    const manager = hosted?.session.sessionManager ?? SessionManager.open(
      sessionFile,
      paths.sessionDir,
      cwd,
    );
    const stored = this.applySessionName(hosted?.session, manager, title);
    (hosted?.logger ?? this.logger.child({ ghost: ghostName, conversation: id })).info("renamed ghost conversation", {
      session: id,
      title: stored,
    });
    await this.announceConversationUpdated(ghostName, id);
    return stored;
  }

  /**
   * Write one name through pi and answer with what it kept — pi trims the
   * name, so the stored name is the honest one to hand back. A name with
   * nothing printable in it is a bad request rather than a silent no-op.
   */
  private applySessionName(
    session: AgentSession | undefined,
    manager: SessionManager,
    title: string,
  ): string {
    if (session) session.setSessionName(title);
    else manager.appendSessionInfo(title);
    const stored = manager.getSessionName();
    if (!stored) {
      throw new GhostError(
        "invalid_request",
        "A conversation title needs at least one printable character.",
        400,
      );
    }
    return stored;
  }

  /** Marker presence, treating an unreadable marker as owned (fail closed). */
  private async transactionMarkerEntryExists(path: string): Promise<boolean> {
    return (await transactionMarkerState(path, this.transactionMarkerLstat)).state !== "absent";
  }

  /** Marker presence, rethrowing an unreadable marker to its caller. */
  private async transactionEntryExists(path: string): Promise<boolean> {
    const probe = await transactionMarkerState(path, this.transactionMarkerLstat);
    if (probe.state === "indeterminate") throw probe.error;
    return probe.state === "present";
  }

  private async readDeleteTransaction(
    marker: string,
    runtime: ConversationRuntime,
    conversationId: string,
    ghostDir: string,
  ): Promise<DeleteTransactionRecord> {
    const invalidMarker = () => new GhostError(
      "delete_recovery_pending",
      "This conversation has an invalid or unreadable deletion transaction.",
      500,
    );
    try {
      const value = JSON.parse(await readDaemonControlFile(
        marker,
        TRANSACTION_MARKER_MAX_BYTES,
      )) as Record<string, unknown>;
      if (value.kind !== "delete" || value.runtime !== runtime
        || value.conversationId !== conversationId
        || (value.version !== 1 && value.version !== 2
          && value.version !== 3 && value.version !== 4)) {
        throw invalidMarker();
      }
      if (value.version === 1) return emptyDeleteTransaction(runtime, conversationId);
      if (!Array.isArray(value.artifacts)) {
        throw invalidMarker();
      }
      const artifacts: TrashedConversationFileArtifact[] = [];
      const parseArtifact = (row: unknown): TrashedConversationFileArtifact | null => {
        if (!row || typeof row !== "object") {
          return null;
        }
        const artifact = (row as Record<string, unknown>).artifact;
        const source = (row as Record<string, unknown>).source;
        const trash = (row as Record<string, unknown>).trash;
        const kind = (row as Record<string, unknown>).kind;
        const artifactKind = deleteArtifactKind(artifact);
        if (artifactKind === null
          || typeof source !== "string" || !isAbsolute(source)
          || typeof trash !== "string" || !isAbsolute(trash)
          || (kind !== "freedesktop" && kind !== "fallback")) {
          return null;
        }
        return {
          artifact: artifactKind,
          source,
          trash,
          kind,
        };
      };
      for (const row of value.artifacts) {
        const artifact = parseArtifact(row);
        if (!artifact) throw invalidMarker();
        artifacts.push(artifact);
      }
      const current = value.version === 3 || value.version === 4;
      const trashRoot = current ? value.trashRoot : null;
      const pending = current && value.pending !== null
        ? parseArtifact(value.pending)
        : null;
      // Delegated-task groups no longer exist; a marker still carrying one is ambiguous.
      if (value.version === 4 && value.delegatedTasks != null) throw invalidMarker();
        if ((current && value.pending !== null && !pending)
        || (current && trashRoot !== null
          && (typeof trashRoot !== "string" || !exactDeleteTrashRoot(ghostDir, trashRoot)))
        || (current && pending && typeof trashRoot !== "string")
        || (current && pending && (pending.kind !== "fallback"
          || !exactDeleteTrashChild(
            trashRoot as string,
            pending,
            artifacts.length + 1,
          )))) {
        throw invalidMarker();
      }
      const allArtifacts = [...artifacts, ...(pending ? [pending] : [])];
      const sources = allArtifacts.map((artifact) => artifact.source);
      const destinations = allArtifacts.map((artifact) => artifact.trash);
      if (new Set(sources).size !== sources.length
        || new Set(destinations).size !== destinations.length
        || sources.some((source) => destinations.includes(source))) {
        throw invalidMarker();
      }
      for (const artifact of allArtifacts) {
        if (!exactDeleteStaticSource(ghostDir, conversationId, artifact)) {
          throw invalidMarker();
        }
      }
      for (const artifact of artifacts) {
        if (await this.transactionEntryExists(artifact.source)
          || !(await this.transactionEntryExists(artifact.trash))) {
          throw invalidMarker();
        }
      }
      return {
        version: 4,
        kind: "delete",
        runtime,
        conversationId,
        artifacts,
        trashRoot: trashRoot as string | null,
        pending,
      };
    } catch (error) {
      // A malformed marker continues to own the id. Never erase it or start a
      // fresh deletion from unvalidated recovery bytes.
      if (error instanceof GhostError && error.code === "delete_recovery_pending") throw error;
      throw invalidMarker();
    }
  }

  private async retireDeleteMarker(
    sessionDir: string,
    marker: string,
    record: DeleteTransactionRecord,
  ): Promise<void> {
    await unlink(marker);
    try {
      await fsyncDirectory(sessionDir);
    } catch (error) {
      try {
        await this.transactionWriter(marker, record);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Deletion marker removal was not durable and its live marker could not be restored.",
        );
      }
      throw error;
    }
  }

  private async ensureDeleteTrashRoot(
    ghostDir: string,
    marker: string,
    record: DeleteTransactionRecord,
  ): Promise<string> {
    if (record.trashRoot) return record.trashRoot;
    const fallbackRoot = join(ghostDir, ".trash");
    mkdirSync(fallbackRoot, { recursive: true, mode: 0o700 });
    await fsyncDirectory(ghostDir);
    let trashRoot: string;
    for (;;) {
      trashRoot = join(fallbackRoot, `.conversation-${randomUUID()}`);
      try {
        mkdirSync(trashRoot, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await fsyncDirectory(fallbackRoot);
    record.trashRoot = trashRoot;
    await this.transactionWriter(marker, record);
    return trashRoot;
  }

  private async reconcileDeleteMove(
    marker: string,
    record: DeleteTransactionRecord,
  ): Promise<void> {
    const pending = record.pending;
    if (!pending) return;
    const sourceExists = await this.transactionEntryExists(pending.source);
    const trashExists = await this.transactionEntryExists(pending.trash);
    if (sourceExists && trashExists) {
      throw new GhostError(
        "delete_recovery_conflict",
        "Deletion recovery found both the source and its reserved Trash destination.",
        409,
      );
    }
    if (!sourceExists && !trashExists) {
      throw new GhostError(
        "delete_recovery_incomplete",
        "Deletion recovery could not find either the source or its reserved Trash destination.",
        500,
      );
    }
    if (sourceExists) await rename(pending.source, pending.trash);
    await this.transactionProbe("delete-artifact-fsync", pending.source);
    await fsyncDirectory(resolve(pending.source, ".."));
    await fsyncDirectory(resolve(pending.trash, ".."));
    await this.transactionProbe("delete-artifact-renamed", pending.source);
    record.artifacts = [...record.artifacts, pending];
    record.pending = null;
    await this.transactionProbe("delete-receipt-write", pending.source);
    await this.transactionWriter(marker, record);
    await this.transactionProbe("delete-artifact-recorded", pending.source);
  }

  private async unlinkForkArtifact(path: string): Promise<void> {
    await this.transactionProbe("fork-cleanup-unlink", path);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async verifyForkArtifactAbsent(path: string): Promise<void> {
    await this.transactionProbe("fork-cleanup-verify", path);
    if (await this.transactionEntryExists(path)) {
      throw new Error(`Fork cleanup left an artifact at ${path}.`);
    }
  }

  private async retireForkMarker(
    sessionDir: string,
    marker: string,
    record: ForkTransactionRecord,
  ): Promise<void> {
    await this.transactionProbe("fork-marker-unlink", marker);
    await unlink(marker);
    try {
      await this.transactionProbe("fork-marker-fsync", sessionDir);
      await fsyncDirectory(sessionDir);
    } catch (error) {
      try {
        await this.transactionWriter(marker, record);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Fork marker removal was not durable and its live marker could not be restored.",
        );
      }
      throw error;
    }
  }

  private async finishForkArtifactState(
    sessionDir: string,
    marker: string,
    record: ForkTransactionRecord,
    absent: readonly string[],
    present: readonly string[],
  ): Promise<void> {
    for (const path of [...new Set(absent)]) await this.verifyForkArtifactAbsent(path);
    for (const path of [...new Set(present)]) {
      if (!(await this.transactionEntryExists(path))) {
        throw new Error(`Fork publication is missing an artifact at ${path}.`);
      }
    }
    await this.transactionProbe("fork-cleanup-fsync", sessionDir);
    await fsyncDirectory(sessionDir);
    await this.retireForkMarker(sessionDir, marker, record);
  }

  private async rollbackForkTransaction(
    sessionDir: string,
    marker: string,
    record: ForkTransactionRecord,
    artifacts: readonly string[],
  ): Promise<void> {
    for (const path of [...new Set(artifacts)]) await this.unlinkForkArtifact(path);
    await this.finishForkArtifactState(sessionDir, marker, record, artifacts, []);
  }

  private recoverForkTransactions(sessionDir: string, ghostName: string): Promise<void> {
    const existing = this.forkRecoveries.get(sessionDir);
    if (existing) return existing;
    const recovery = this.recoverForkTransactionsOnce(sessionDir, ghostName).finally(() => {
      if (this.forkRecoveries.get(sessionDir) === recovery) {
        this.forkRecoveries.delete(sessionDir);
      }
    });
    this.forkRecoveries.set(sessionDir, recovery);
    return recovery;
  }

  private async recoverForkTransactionsOnce(sessionDir: string, ghostName: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((entry) => entry.startsWith(".ghost-fork-") && entry.endsWith(".pending.json"))) {
      const marker = join(sessionDir, name);
      if (this.activeForks.has(marker)) continue;
      let markerValidated = false;
      let conversationId: string | undefined;
      try {
        const value = JSON.parse(await readDaemonControlFile(
          marker,
          TRANSACTION_MARKER_MAX_BYTES,
        )) as {
          version?: unknown;
          kind?: unknown;
          conversationId?: unknown;
          tempTranscript?: unknown;
          tempConversationCwd?: unknown;
          tempToolCwds?: unknown;
        };
        // v4 stages one file. A v3 marker predates the cwd move and still
        // names two sidecars, so its fork is finished the way it was started.
        const legacy = value.version === 3;
        if ((value.version !== 4 && !legacy) || value.kind !== "fork"
          || typeof value.conversationId !== "string" || !isValidConversationId(value.conversationId)
          || typeof value.tempTranscript !== "string" || !isAbsolute(value.tempTranscript)
          || !pathIsWithin(sessionDir, value.tempTranscript)
          || (legacy && (typeof value.tempConversationCwd !== "string"
            || !isAbsolute(value.tempConversationCwd)
            || !pathIsWithin(sessionDir, value.tempConversationCwd)
            || typeof value.tempToolCwds !== "string" || !isAbsolute(value.tempToolCwds)
            || !pathIsWithin(sessionDir, value.tempToolCwds)))
          || marker !== forkTransactionPath(sessionDir, value.conversationId)) {
          throw new Error("invalid fork transaction marker");
        }
        const record: ForkTransactionRecord = {
          version: 4,
          kind: "fork",
          conversationId: value.conversationId,
          tempTranscript: value.tempTranscript,
          ...(legacy
            ? {
              tempConversationCwd: value.tempConversationCwd as string,
              tempToolCwds: value.tempToolCwds as string,
            }
            : {}),
        };
        const transcript = join(sessionDir, sessionFileNameFor(record.conversationId));
        const conversationCwd = conversationCwdPath(sessionDir, record.conversationId);
        const toolCwds = toolCwdsPath(sessionDir, record.conversationId);
        const pairs = (legacy
          ? [
            [record.tempConversationCwd as string, conversationCwd],
            [record.tempToolCwds as string, toolCwds],
            [record.tempTranscript, transcript],
          ]
          : [[record.tempTranscript, transcript]]) as ReadonlyArray<readonly [string, string]>;
        if (!exactForkTemporaryPath(sessionDir, record.tempTranscript, transcript, true)
          || (legacy && (
            !exactForkTemporaryPath(sessionDir, record.tempConversationCwd as string, conversationCwd, false)
            || !exactForkTemporaryPath(sessionDir, record.tempToolCwds as string, toolCwds, false)))
          || pairs.some(([temporary, final]) => temporary === final)
          || new Set(pairs.flat()).size !== pairs.length * 2) {
          throw new Error("invalid fork transaction artifact paths");
        }
        markerValidated = true;
        conversationId = record.conversationId;
        let recoverable = true;
        for (const [temporary, final] of pairs) {
          if (!(await this.transactionEntryExists(temporary))
            && !(await this.transactionEntryExists(final))) {
            recoverable = false;
            break;
          }
        }
        if (recoverable) {
          for (const [temporary, final] of pairs) {
            if (!(await this.transactionEntryExists(final))) await rename(temporary, final);
            else await this.unlinkForkArtifact(temporary);
          }
          await this.finishForkArtifactState(
            sessionDir,
            marker,
            record,
            pairs.map(([temporary]) => temporary),
            pairs.map(([, final]) => final),
          );
          continue;
        }
        await this.rollbackForkTransaction(sessionDir, marker, record, [
          ...pairs.flat(),
        ]);
      } catch {
        const logger = this.logger.child({
          ghost: ghostName,
          ...(conversationId ? { conversation: conversationId } : {}),
        });
        logger.error(markerValidated ? "fork recovery is still pending" : "fork recovery marker is invalid", {
          path: marker,
          code: markerValidated ? "fork_recovery_pending" : "fork_marker_invalid",
        });
      }
    }
  }

  private collectSessions(ghostName: string): Promise<StoredSessionRow[]> {
    return this.homeOperations.withLease(ghostName, () =>
      this.collectSessionsLeased(this.registry.get(ghostName))
    );
  }

  private async collectSessionsLeased(ghost: Ghost): Promise<StoredSessionRow[]> {
    const paths = ghostPaths(ghost.dir);
    mkdirSync(paths.sessionDir, { recursive: true });
    await this.recoverForkTransactions(paths.sessionDir, ghost.name);
    const sessions = await SessionManager.listAll(paths.sessionDir);
    const scannedPiSessions = await Promise.all(sessions.map(async (info) => {
      let conversationId: string | null;
      try {
        conversationId = await conversationIdFromSessionFile(info.path);
      } catch {
        // A concurrently removed or unreadable transcript is omitted without
        // making its valid siblings disappear from the listing.
        return null;
      }
      if (conversationId === null) return null;
      return {
        ...conversationIdentity(conversationId),
        title: info.name ?? null,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
      };
    }));
    const rows: StoredSessionRow[] = scannedPiSessions.filter(
      (row): row is Exclude<(typeof scannedPiSessions)[number], null> => row !== null,
    );
    const visibleRows = await Promise.all(rows.map(async (row) => {
      if (await this.transactionMarkerEntryExists(
        deleteTransactionPath(paths.sessionDir, row.runtime, row.conversationId),
      )) return null;
      if (await this.transactionMarkerEntryExists(
        forkTransactionPath(paths.sessionDir, row.conversationId),
      )) return null;
      return row;
    }));
    return visibleRows.filter((row): row is StoredSessionRow => row !== null);
  }

  /**
   * Read one conversation's messages so the shell can rehydrate it (issue #26).
   *
   * Reuses pi's own session read: the transcript file is opened read-only and
   * its message entries are projected to the same `{ role, content }` shape a
   * pi-messages client renders. Private reasoning (`thinking` blocks) and
   * internal `toolResult` messages are dropped — exactly what the live wire
   * omits — so a resumed conversation shows what the user actually saw.
   * Capped/paged via `limit`/`offset` for a very long transcript.
   */
  async readTranscript(
    ghostName: string,
    conversationId: string | null | undefined,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Transcript> {
    return this.homeOperations.withLease(ghostName, () =>
      this.readTranscriptLeased(ghostName, conversationId, options)
    );
  }

  private async readTranscriptLeased(
    ghostName: string,
    conversationId: string | null | undefined,
    options: { limit?: number; offset?: number },
  ): Promise<Transcript> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const id = conversationId ?? DEFAULT_SESSION_KEY;
    const path = join(paths.sessionDir, sessionFileNameFor(id));
    await this.conversationFileProbe("transcript-read", path);
    if (!existsSync(path)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(id)}.`,
        404,
      );
    }
    await requireSessionFileConversationId(path, id);
    // Await an in-flight title for this exact conversation, so a resume made
    // right after the first turn carries the freshly generated title.
    const hosted = this.sessions.get(this.keyOf(ghostName, conversationId));
    if (hosted?.title) await hosted.title.catch(() => {});
    const cwd = hosted?.cwd ?? await this.conversationCwd(ghostName, id);

    const manager = SessionManager.open(path, paths.sessionDir, cwd);
    return this.transcriptFromManager(id, manager, options, readSessionCwds(manager).toolCwds);
  }

  private transcriptFromManager(
    id: string,
    manager: SessionManager,
    options: { limit?: number; offset?: number } = {},
    toolCwds: ReadonlyMap<string, string> = new Map(),
  ): Transcript {
    const active = manager.getBranch();

    // Which persisted `ask` a re-answer would branch from, and how that ask
    // ended. Branching a message forks the conversation now, so the tree walk
    // that described every sibling went with the navigator it fed.
    const askBranches = new Map<string, AskBranchNavigation>();
    const failedToolCalls = new Set<string>();
    for (const entry of active) {
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      if (entry.message.isError === true) failedToolCalls.add(entry.message.toolCallId);
      if (entry.message.toolName !== "ask") continue;
      askBranches.set(entry.message.toolCallId, {
        resultEntryId: entry.id,
        settled: askSettlement(entry.message.details as AskToolDetails | undefined),
      });
    }

    const all: TranscriptMessage[] = [];
    for (const entry of active) {
      if (entry.type === "custom_message" && entry.customType === SESSION_STOP_CONTINUATION_TYPE) {
        const text = entryText(entry.content);
        if (text) {
          all.push({
            role: "hook",
            content: [{ type: "text", text }],
            entryId: entry.id,
            parentId: entry.parentId,
          });
        }
        continue;
      }
      if (entry.type !== "message") continue;
      const message = projectTranscriptMessage(entry, askBranches, failedToolCalls, toolCwds);
      if (message) all.push(message);
    }
    return {
      ...conversationIdentity(id),
      title: manager.getSessionName() ?? null,
      ...pageTranscript(all, options),
      // Pi's own JSONL is the complete durable history.
      historyTruncated: false,
    };
  }

  private async idleHostedSession(
    ghostName: string,
    conversationId: string | null | undefined,
    busyMessage: string,
    homeLeaseHeld = false,
  ): Promise<HostedSession> {
    const hosted = (await (homeLeaseHeld
      ? this.openLeased(ghostName, conversationId)
      : this.open(ghostName, conversationId))) as HostedSession;
    if (this.sessionOwned(hosted)) {
      throw new GhostError(
        "session_busy",
        busyMessage,
        409,
      );
    }
    await hosted.mcp?.reload;
    if (this.sessionOwned(hosted)) {
      throw new GhostError(
        "session_busy",
        busyMessage,
        409,
      );
    }
    // An exclusive caller must claim before this async helper returns: doing
    // it in the caller leaves a microtask where another owner can pass both checks.
    // Every caller claims; opening one without claiming it would hand the same
    // session to a second owner.
    hosted.busy = true;
    return hosted;
  }

  /**
   * Branch off one user message into a NEW conversation, rewound to just
   * before it, and leave the source conversation exactly as it was.
   *
   * A branch is a copy, not an in-file sibling: `SessionManager.forkFrom`
   * writes every non-header entry of the source verbatim into a fresh
   * transcript (entry ids and all), so the caller's `entryId` still resolves
   * inside the copy and the rewind — pi's `navigateTree`, which returns the
   * message text as `editorText` — runs on the copy alone. The source keeps
   * its leaf, its entries, and its title.
   */
  async forkConversation(
    ghostName: string,
    conversationId: string | null | undefined,
    entryId: string,
  ): Promise<{
    id: string;
    conversationId: string;
    runtime: "pi";
    sessionId: string;
    title: string | null;
    draft: string;
    transcript: Transcript;
  }> {
    return this.homeOperations.withLease(ghostName, () =>
      this.forkConversationLeased(ghostName, conversationId, entryId)
    );
  }

  private async forkConversationLeased(
    ghostName: string,
    conversationId: string | null | undefined,
    entryId: string,
  ): Promise<{
    id: string;
    conversationId: string;
    runtime: "pi";
    sessionId: string;
    title: string | null;
    draft: string;
    transcript: Transcript;
  }> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const sourceId = conversationId ?? DEFAULT_SESSION_KEY;
    const sourceFile = join(paths.sessionDir, sessionFileNameFor(sourceId));
    await this.conversationFileProbe("fork-read", sourceFile);
    // `open` would happily create the conversation being branched from; an id
    // that names neither a live session nor a stored transcript is a 404, not a
    // brand-new empty conversation.
    if (!this.sessions.has(this.keyOf(ghostName, conversationId))
      && !existsSync(sourceFile)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(sourceId)}.`,
        404,
      );
    }
    if (existsSync(sourceFile)) await requireSessionFileConversationId(sourceFile, sourceId);
    const forkId = `branch-${randomUUID()}`;
    const forkFile = join(paths.sessionDir, sessionFileNameFor(forkId));
    const forkMarker = forkTransactionPath(paths.sessionDir, forkId);
    const temporaryForkFile = join(
      paths.sessionDir,
      `.${sessionFileNameFor(forkId)}.${randomUUID()}.pending`,
    );
    let stagedFork: {
      title: string | null;
      draft: string;
      transcript: Transcript;
    } | undefined;
    const source = await this.idleHostedSession(
      ghostName,
      conversationId,
      "Wait for this conversation to finish before changing branches.",
      true,
    );
    const forkRecord: ForkTransactionRecord = {
      version: 4,
      kind: "fork",
      conversationId: forkId,
      tempTranscript: temporaryForkFile,
    };
    const forkArtifacts = [temporaryForkFile, forkFile];
    this.activeForks.add(forkMarker);
    try {
      await this.transactionWriter(forkMarker, forkRecord);
      const sourceManager = source.session.sessionManager;
      const entry = sourceManager.getEntry(entryId);
      if (entry?.type !== "message" || entry.message.role !== "user") {
        throw new GhostError("invalid_branch", "Only a persisted user message can start an editable branch.", 400);
      }
      // Hold the source for the copy only. It is never written to: the claim
      // keeps a turn from appending to the transcript being copied.
      // A title generated by the turn that just finished may still be in
      // flight; the copy is named after it.
      if (source.title) await source.title.catch(() => {});
      const sourceHeader = sourceManager.getHeader();
      if (!sourceHeader) {
        throw new GhostError("invalid_branch", "This conversation has no transcript to branch from.", 400);
      }
      // Names to avoid colliding with, straight from the session listing. The
      // full `listSessions` would also read the pins and wait on unrelated
      // titles, for one `(n)`.
      const title = forkConversationTitle(
        sourceManager.getSessionName() ?? null,
        (await SessionManager.listAll(paths.sessionDir)).map((info) => info.name ?? null),
      );
      // A branch is a copy rewound to just before the chosen message: the
      // source's entries up to that message's parent, under a new header, and
      // the copy's own title. Entry ids are kept so the caller's id resolves.
      const kept: SessionEntry[] = entry.parentId ? sourceManager.getBranch(entry.parentId) : [];
      const lastId = kept.at(-1)?.id ?? null;
      const forkHeader = {
        type: "session" as const,
        version: sourceHeader.version,
        id: forkId,
        timestamp: new Date().toISOString(),
        cwd: sourceManager.getCwd(),
        parentSession: sourceHeader.id,
      };
      const forkEntries: unknown[] = [forkHeader, ...kept];
      if (title) {
        forkEntries.push({
          type: "session_info",
          id: `ghost-fork-title-${randomUUID().slice(0, 8)}`,
          parentId: lastId,
          timestamp: forkHeader.timestamp,
          name: title,
        });
      }
      const staged = await openFile(temporaryForkFile, "wx", 0o600);
      try {
        await staged.writeFile(`${forkEntries.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
        await staged.sync();
      } finally {
        await staged.close();
      }
      const forked = SessionManager.open(temporaryForkFile, paths.sessionDir, sourceManager.getCwd());
      const draft = editableUserText(entry.message.content);
      stagedFork = {
        title: forked.getSessionName() ?? null,
        draft,
        // The branch carries the source's cwd entries up to the fork point, so
        // the copy rebuilds them from itself rather than inheriting the live map.
        transcript: this.transcriptFromManager(forkId, forked, {}, readSessionCwds(forked).toolCwds),
      };
      const transcript = await openFile(temporaryForkFile, "r");
      try {
        await transcript.sync();
      } finally {
        await transcript.close();
      }
      // The whole fork is staged and durable here, and nothing can see it yet.
      await this.transactionProbe("fork-staged", temporaryForkFile);
      // One file carries the whole fork, so publishing it is a single rename
      // and there is no window where a reader can see a partial fork.
      await rename(temporaryForkFile, forkFile);
      await this.finishForkArtifactState(
        paths.sessionDir,
        forkMarker,
        forkRecord,
        [temporaryForkFile],
        [forkFile],
      );
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (await this.transactionEntryExists(forkMarker)) {
          await this.rollbackForkTransaction(
            paths.sessionDir,
            forkMarker,
            forkRecord,
            forkArtifacts,
          );
        }
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Fork publication failed and its transaction remains pending recovery.",
        );
      }
      throw error;
    } finally {
      this.activeForks.delete(forkMarker);
      await this.releaseSessionClaim(source, ghostName);
    }

    if (!stagedFork) throw new Error("Fork publication completed without a rewound snapshot.");
    // Navigation and its durable flush happened while the transcript still
    // had a hidden pending name. From here readers can see only that rewound
    // snapshot; an announcement failure still retracts the publication.
    try {
      await this.announceConversationUpdated(ghostName, forkId);
      return {
        ...conversationIdentity(forkId),
        sessionId: forkId,
        ...stagedFork,
      };
    } catch (error) {
      await this.discardFork(ghostName, forkId, true);
      throw error;
    }
  }

  private async discardForkLeased(ghostName: string, forkId: string): Promise<void> {
    try {
      const ghost = this.registry.get(ghostName);
      const paths = ghostPaths(ghost.dir);
      await this.closePi(ghostName, forkId);
      const rowsBefore = await this.collectSessionsLeased(ghost);
      const forkIdentity = conversationIdentity(forkId);
      const sessionFile = join(paths.sessionDir, sessionFileNameFor(forkId));
      try {
        if (existsSync(sessionFile)) {
          await requireSessionFileConversationId(sessionFile, forkId);
        }
        await unlink(sessionFile);
        await Promise.all([
          unlink(conversationCwdPath(paths.sessionDir, forkId)).catch(() => {}),
          unlink(toolCwdsPath(paths.sessionDir, forkId)).catch(() => {}),
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const remainingIds = new Set(rowsBefore
        .filter((row) => row.id !== forkIdentity.id)
        .map((row) => row.id));
      const pinState = await readPinState(paths.sessionDir);
      const pins = pinnedRowIds(pinState, rowsBefore);
      pins.delete(forkIdentity.id);
      await this.pinWriter(paths.sessionDir, [...pins].filter((pin) => remainingIds.has(pin)));
      const readState = await readReadState(paths.sessionDir);
      const reads = readsByRowId(readState, rowsBefore);
      delete reads[forkIdentity.id];
      await this.readWriter(paths.sessionDir, Object.fromEntries(
        Object.entries(reads).filter(([id]) => remainingIds.has(id)),
      ));
    } catch (error) {
      this.logger.child({ ghost: ghostName, conversation: forkId }).warn("could not discard an abandoned branch copy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private discardFork(
    ghostName: string,
    forkId: string,
    homeLeaseHeld = false,
  ): Promise<void> {
    return homeLeaseHeld
      ? this.discardForkLeased(ghostName, forkId)
      : this.homeOperations.withLease(ghostName, () =>
          this.discardForkLeased(ghostName, forkId)
        );
  }

  /**
   * The persisted ask a re-answer would revise: the `ask` tool result at
   * `entryId`, the assistant call it answered, and that call's questions.
   */
  private reopenableAsk(
    hosted: HostedSession,
    entryId: string,
  ): {
    questions: Parameters<ReturnType<typeof createAskTool>["execute"]>[1]["questions"];
    assistantEntryId: string;
    resultMessage: Extract<AgentMessage, { role: "toolResult" }>;
  } | null {
    const manager = hosted.session.sessionManager;
    const entry = manager.getEntry(entryId);
    if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "ask") {
      return null;
    }
    const resultMessage = entry.message;
    let assistantId = entry.parentId;
    while (assistantId) {
      const candidate = manager.getEntry(assistantId);
      if (!candidate) return null;
      if (candidate.type === "message" && candidate.message.role === "assistant") {
        const call = candidate.message.content.find((part) =>
          part.type === "toolCall" && part.id === resultMessage.toolCallId);
        if (call?.type !== "toolCall") return null;
        const questions = (call.arguments as { questions?: unknown } | undefined)?.questions;
        if (!Array.isArray(questions) || questions.length === 0) return null;
        return {
          questions: questions as Parameters<ReturnType<typeof createAskTool>["execute"]>[1]["questions"],
          assistantEntryId: candidate.id,
          resultMessage,
        };
      }
      assistantId = candidate.parentId;
    }
    return null;
  }

  /**
   * Re-open a historical `ask`, commit the new answer as a sibling
   * toolResult, rebuild the active branch, then resume the model on that branch.
   */
  async runAskReanswer(
    ghostName: string,
    options: RunAskReanswerOptions,
  ): Promise<void> {
    const conversationId = requireRawConversationId(options.sessionId ?? DEFAULT_SESSION_KEY);
    const admissionKey = this.keyOf(ghostName, conversationId);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's move to finish.", 409);
    }
    if (this.turnAdmissions.has(admissionKey)) {
      throw new GhostError("session_busy", "This conversation already has an owner action.", 409);
    }
    this.turnAdmissions.add(admissionKey);
    let pendingTerminal: Extract<PiMessagesEvent, { type: "done" | "error" }> | undefined;
    // The terminal frame goes last, after the settlement events (branch and
    // conversation updates) that a caller needs in order to read it correctly.
    const emitAfterSettlement = (event: PiMessagesEvent) => {
      if (event.type === "done" || event.type === "error") pendingTerminal = event;
      else options.emit(event);
    };
    const adapter = createPiMessagesAdapter(emitAfterSettlement, {
      includeThinking: options.includeThinking,
      deferAgentEnd: true,
      // The callback is rebound below after the session is claimed.
      getCwd: () => this.sessions.get(this.keyOf(ghostName, options.sessionId))
        ?.session.sessionManager.getCwd() ?? this.ownerHome,
    });
    let hosted: HostedSession;
    try {
      hosted = await this.idleHostedSession(
        ghostName,
        conversationId,
        "Wait for this conversation to finish before changing this answer.",
      );
      hosted.streamEmit = emitAfterSettlement;
    } catch (error) {
      this.turnAdmissions.delete(admissionKey);
      throw error;
    }
    let unsubscribe: (() => void) | undefined;
    const onAbort = () => {
      hosted.ask.close();
      void hosted.session.abort();
    };
    const syntheticId = `ask-reanswer-${options.entryId}`;
    let settlementBarrier: PiSettlementBarrier | undefined;
    let turnFailure: { error: unknown; aborted: boolean } | undefined;
    try {
      unsubscribe = hosted.session.subscribe((event: AgentSessionEvent) => adapter.handle(asRuntimeSessionEvent(event)));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const reopen = this.reopenableAsk(hosted, options.entryId);
      if (!reopen) {
        throw new GhostError(
          "ask_not_reanswerable",
          "That branch point is not a recoverable ask result.",
          400,
        );
      }
      adapter.handle({
        type: "tool_execution_start",
        toolCallId: syntheticId,
        toolName: "ask",
        args: { questions: reopen.questions },
        intent: "Re-answer an earlier question",
      });
      this.recordToolCwd(hosted, syntheticId, hosted.session.sessionManager.getCwd());

      const askTool = createAskTool({ broker: hosted.ask, timeoutMs: () => this.askTimeoutSeconds * 1000 });
      let result: Awaited<ReturnType<typeof askTool.execute>>;
      try {
        result = await askTool.execute(
          syntheticId,
          { questions: reopen.questions },
          options.signal,
          undefined,
          {} as never,
        );
      } catch (error) {
        adapter.handle({ type: "tool_execution_end", toolCallId: syntheticId, toolName: "ask", result: undefined, isError: true });
        throw error;
      }
      if (result.details.chatRedirect) {
        throw new GhostError(
          "ask_chat_unavailable",
          "Chat about this is not available while re-answering a branch; submit an answer instead.",
          409,
        );
      }
      adapter.handle({
        type: "tool_execution_end",
        toolCallId: syntheticId,
        toolName: "ask",
        result,
        isError: false,
      });

      // Commit the revised answer as a sibling tool result under the same
      // assistant call, then rebuild the model's context on that branch.
      const manager = hosted.session.sessionManager;
      manager.branch(reopen.assistantEntryId);
      const previous = reopen.resultMessage;
      manager.appendMessage({
        ...previous,
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: Date.now(),
      });
      hosted.session.agent.state.messages = manager.buildSessionContext().messages;
      options.emit({
        type: "branch_changed",
        transcript: this.transcriptFromManager(
          options.sessionId ?? DEFAULT_SESSION_KEY,
          hosted.session.sessionManager,
          {},
          hosted.toolCwds,
        ),
      });

      const ownerPrompt = entryText(result.content).trim();
      if (!ownerPrompt) {
        throw new GhostError("ask_reanswer_failed", "The revised answer was empty.", 409);
      }
      await this.preparePiOwnerPass(hosted, {
        kind: "reanswer",
        ownerPrompt,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      manager.appendCustomMessageEntry(
        ASK_REANSWER_OWNER_MESSAGE_TYPE,
        ownerPrompt,
        false,
        { attribution: "user", askResultEntryId: options.entryId },
      );
      settlementBarrier = this.deferPiSettlement(hosted);
      await hosted.session.agent.continue();
      await hosted.session.waitForIdle();
    } catch (error) {
      turnFailure = {
        error: error instanceof AskCancelledError ? new Error("Ask re-answer cancelled.") : error,
        aborted: options.signal?.aborted === true,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      try {
        const settlement = settlementBarrier
          ? settlementBarrier.cancel()
            ? await this.settlePiNow(hosted)
            : await settlementBarrier.settled
          : await this.settlePiNow(hosted);
        if (settlement.settlementError !== undefined) {
          pendingTerminal = {
            type: "error",
            reason: "error",
            usage: adapter.totalUsage(),
            errorMessage: MODEL_TURN_PERSISTENCE_ERROR,
          };
        } else if (turnFailure) {
          adapter.finishError(turnFailure.error, turnFailure.aborted);
        } else {
          adapter.finishDone();
        }
        unsubscribe?.();
        hosted.streamEmit = undefined;
        if (pendingTerminal) options.emit(pendingTerminal);
        await this.releaseSessionClaim(hosted, ghostName);
        await this.announceConversationUpdated(ghostName, conversationId);
      } finally {
        unsubscribe?.();
        this.turnAdmissions.delete(admissionKey);
      }
    }
  }

  /** Drop one hosted session (aborting an in-flight turn). */
  async close(ghostName: string, sessionId?: string | null): Promise<void> {
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    const releaseAdmission = this.reserveLifecycleAdmission(ghostName, conversationId);
    try {
      await this.closePi(ghostName, conversationId);
    } finally {
      releaseAdmission();
    }
  }

  async deleteSession(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): Promise<TrashedConversation> {
    const ghost = this.registry.get(ghostName);
    const id = sessionId ?? DEFAULT_SESSION_KEY;
    const paths = ghostPaths(ghost.dir);
    const identity = conversationIdentity(id);
    const piKey = this.keyOf(ghostName, sessionId);
    const deleteKey = deletionKeyOf(ghostName, runtime, id);
    const tombstone = deleteTransactionPath(paths.sessionDir, runtime, id);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's filesystem move to finish.", 409);
    }
    const hosted = this.sessions.get(piKey);
    const runtimeBusy = this.opening.has(piKey)
      || (hosted !== undefined
        && (this.sessionOwned(hosted) || (hosted.mcpTransitions ?? 0) > 0));
    const busy = this.mcpReloadGhosts.has(ghostName)
      || (this.lifecycleAdmissions.get(piKey) ?? 0) > 0
      || this.turnAdmissions.has(piKey)
      || runtimeBusy;
    if (this.deleting.has(deleteKey) || busy) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before deleting it.",
        409,
      );
    }
    let runtimeRetired = false;
    const retireRuntime = async (): Promise<void> => {
      if (runtimeRetired) return;
      await this.closePi(ghostName, sessionId);
      runtimeRetired = true;
    };
    this.deleting.add(deleteKey);
    try {
      const { state: deleteState } = await transactionMarkerState(
        tombstone,
        this.transactionMarkerLstat,
      );
      if (deleteState === "indeterminate") {
        await retireRuntime();
        throw new GhostError(
          "delete_recovery_pending",
          "This conversation has an invalid or unreadable deletion transaction.",
          500,
        );
      }
      const resumingDeletion = deleteState === "present";
      if (!resumingDeletion) {
        mkdirSync(paths.sessionDir, { recursive: true });
        try {
          await this.transactionWriter(tombstone, emptyDeleteTransaction(runtime, id));
        } catch (error) {
          const { state: published } = await transactionMarkerState(
            tombstone,
            this.transactionMarkerLstat,
          );
          if (published !== "absent") await retireRuntime();
          throw error;
        }
      }
      const deleteRecord = await this.readDeleteTransaction(
        tombstone,
        runtime,
        id,
        ghost.dir,
      );
      await this.reconcileDeleteMove(tombstone, deleteRecord);
      // Title generation can still append to an otherwise-idle transcript.
      // Let it settle before disposal so deletion cannot race a late write.
      const background = [hosted?.title]
        .filter((task): task is Promise<void> => task !== undefined);
      if (background.length > 0) await Promise.allSettled(background);

      await retireRuntime();
      const piPath = join(paths.sessionDir, sessionFileNameFor(id));
      const conversationCwd = conversationCwdPath(paths.sessionDir, id);
      const cwdPath = toolCwdsPath(paths.sessionDir, id);
      if (await this.transactionEntryExists(piPath)) {
        await requireSessionFileConversationId(piPath, id);
      }
      const rowsBefore = await this.collectSessions(ghost.name);
      const candidates: Array<{
        artifact: TrashedConversationFileArtifact["artifact"];
        path: string;
      }> = [
        { artifact: "transcript", path: piPath },
        { artifact: "tool-cwds", path: cwdPath },
        { artifact: "conversation-cwd", path: conversationCwd },
      ];
      const artifacts = [...deleteRecord.artifacts];
      const recorded = new Set(artifacts.map((entry) =>
        JSON.stringify([entry.artifact, entry.source])
      ));
      for (const candidate of candidates) {
        const candidateKey = JSON.stringify([candidate.artifact, candidate.path]);
        if (recorded.has(candidateKey)) continue;
        if (!(await this.transactionEntryExists(candidate.path))) continue;
        const trashRoot = await this.ensureDeleteTrashRoot(ghost.dir, tombstone, deleteRecord);
        const trash = join(
          trashRoot,
          `${String(artifacts.length + 1).padStart(3, "0")}-${randomUUID()}-${basename(candidate.path)}`,
        );
        deleteRecord.pending = {
          artifact: candidate.artifact,
          source: candidate.path,
          trash,
          kind: "fallback",
        };
        await this.transactionWriter(tombstone, deleteRecord);
        await this.transactionProbe("delete-intent-recorded", candidate.path);
        await this.reconcileDeleteMove(tombstone, deleteRecord);
        const artifact = deleteRecord.artifacts.at(-1);
        if (!artifact) throw new Error("Deletion move completed without a durable receipt.");
        artifacts.push(artifact);
        recorded.add(candidateKey);
      }
      if (artifacts.length === 0 && !resumingDeletion) {
        await this.retireDeleteMarker(paths.sessionDir, tombstone, deleteRecord);
        throw new GhostError(
          "not_found",
          `This ghost has no conversation ${JSON.stringify(identity.id)}.`,
          404,
        );
      }
      const remainingIds = new Set(rowsBefore
        .filter((row) => row.id !== identity.id)
        .map((row) => row.id));
      const pinState = await readPinState(paths.sessionDir);
      const pins = pinnedRowIds(pinState, rowsBefore);
      pins.delete(identity.id);
      await this.pinWriter(paths.sessionDir, [...pins].filter((pin) => remainingIds.has(pin)));
      const readState = await readReadState(paths.sessionDir);
      const reads = readsByRowId(readState, rowsBefore);
      delete reads[identity.id];
      await this.readWriter(paths.sessionDir, Object.fromEntries(
        Object.entries(reads).filter(([key]) => remainingIds.has(key)),
      ));
      deleteRecord.artifacts = [...artifacts];
      await this.retireDeleteMarker(paths.sessionDir, tombstone, deleteRecord);
      this.logger.child({ ghost: ghostName, conversation: id }).info("trashed ghost conversation", {
        session: identity.id,
        artifacts: [
          ...artifacts.map((entry) => entry.artifact),
        ],
      });
      await this.announceConversationUpdated(ghostName, id);
      return { artifacts };
    } finally {
      this.deleting.delete(deleteKey);
      // A marker left behind means the deletion resumes later; keep no live
      // runtime on a conversation whose files are mid-move.
      const { state: markerState } = await transactionMarkerState(tombstone, this.transactionMarkerLstat);
      if (markerState !== "absent") await retireRuntime();
    }
  }

  /** Create one ghost only while its spelling is not reserved by a whole-home move. */
  createGhost(name: string): Ghost {
    assertValidGhostName(name);
    if (this.ghostMoveReserved(name)) {
      throw new GhostError(
        "ghost_busy",
        "Wait for the previous ghost home to finish moving before reusing this name.",
        409,
      );
    }
    return this.registry.create(name);
  }

  private async ghostMovePathState(
    path: string,
  ): Promise<"present" | "absent" | "indeterminate"> {
    try {
      await this.ghostHomeLstat(path);
      return "present";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "absent"
        : "indeterminate";
    }
  }

  private async settleFailedGhostMove(
    ghost: Ghost,
  ): Promise<"pending" | "moved" | "indeterminate"> {
    const pathState = await this.ghostMovePathState(ghost.dir);
    if (pathState === "present") return "pending";
    if (pathState === "indeterminate") return "indeterminate";
    this.forgetGhost(ghost.name);
    return "moved";
  }

  /**
   * Trash one whole ghost: close its conversations, then move its home aside.
   *
   * The move is the registry's (`trash`) — into the system trash, where a
   * trash tool or file manager can restore it — and it is a move rather than a
   * removal: the ghost home holds the only copy of a persona and its memory.
   * Nothing here follows up with a recursive delete.
   */
  async deleteGhost(ghostName: string): Promise<{ trash: string }> {
    const ghost = this.registry.get(ghostName);
    this.reserveGhosts([ghost.name], "deleting it");
    let moveState: "pending" | "moved" | "indeterminate" = "pending";
    try {
      await this.quiesceGhost(ghost, "deleted");
      let trashed: { trash: string };
      try {
        trashed = this.registry.trash(ghost.name);
        moveState = "moved";
      } catch (error) {
        moveState = await this.settleFailedGhostMove(ghost);
        if (moveState === "indeterminate") {
          throw new GhostError(
            "ghost_move_recovery_pending",
            "The ghost home move outcome could not be confirmed safely; retry after checking its path.",
            503,
          );
        }
        throw error;
      }
      this.forgetGhost(ghost.name);
      this.logger.info("trashed ghost", { ghost: ghost.name, trash: trashed.trash });
      return trashed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
    }
  }

  /**
   * Rename one whole ghost: close its conversations, then move its home.
   *
   * The name IS the directory name, so this is one same-filesystem rename and
   * nothing else — persona, memory, conversations, pins, and credentials
   * are all inside the directory that moved, including the transcript identity
   * metadata. Nothing is copied, so nothing can be half-copied.
   *
   * The gate is the one deletion uses: renaming is the same whole-home move,
   * and a conversation mid-turn holds paths under the old name.
   */
  async renameGhost(ghostName: string, nextName: string): Promise<Ghost> {
    assertValidGhostName(nextName);
    const ghost = this.registry.get(ghostName);
    // Renaming a ghost to what it is already called is a no-op, not a
    // collision with itself.
    if (nextName === ghost.name) return ghost;
    // Anything at all under the new name is a collision: renaming onto an
    // occupied path would bury whatever the owner keeps there.
    if (existsSync(join(this.registry.root, nextName))) {
      throw new GhostError(
        "already_exists",
        `A ghost named ${JSON.stringify(nextName)} already exists.`,
        409,
      );
    }
    this.reserveGhosts([ghost.name, nextName], "renaming it");
    let moveState: "pending" | "moved" | "indeterminate" = "pending";
    try {
      await this.quiesceGhost(ghost, "renamed");
      let renamed: Ghost;
      try {
        renamed = this.registry.rename(ghost.name, nextName);
        moveState = "moved";
      } catch (error) {
        moveState = await this.settleFailedGhostMove(ghost);
        if (moveState === "indeterminate") {
          throw new GhostError(
            "ghost_move_recovery_pending",
            "The ghost home move outcome could not be confirmed safely; retry after checking its path.",
            503,
          );
        }
        throw error;
      }
      this.forgetGhost(ghost.name);
      this.logger.info("renamed ghost", { ghost: ghost.name, name: renamed.name });
      return renamed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
      this.reservedGhosts.delete(nextName);
    }
  }

  /** Retire every trigger attached to a name before that name can be reused. */
  private async retireGhostSchedules(
    ghostName: string,
    outcome: "deleted" | "renamed",
  ): Promise<void> {
    try {
      await sweepGhostSchedules(ghostName, {
        unitDir: this.scheduleUnitDir,
        runtimeUnitDir: this.scheduleRuntimeUnitDir,
        ...(this.scheduleCommandRunner === undefined
          ? {}
          : { run: this.scheduleCommandRunner }),
        logger: this.logger,
      });
    } catch (error) {
      this.logger.error(`could not clean up a ghost's schedules before it was ${outcome}`, {
        ghost: ghostName,
        error: (error as Error).message,
      });
      throw new GhostError(
        "schedule_cleanup_failed",
        `Could not stop and remove this ghost's schedules. The ghost was not ${outcome}; retry after checking its systemd user timers.`,
        503,
      );
    }
  }

  /** Atomically claim ghost names for one whole-home move. */
  private reserveGhosts(ghostNames: readonly string[], operation: string): void {
    for (const ghostName of ghostNames) {
      if (this.reservedGhosts.has(ghostName) || this.ghostBusy(ghostName)) {
        throw new GhostError(
          "ghost_busy",
          `Wait for this ghost's conversations to finish before ${operation}.`,
          409,
        );
      }
    }
    for (const ghostName of ghostNames) this.reservedGhosts.add(ghostName);
  }

  /**
   * Let go of one ghost's home so it can move: settle the background writes
   * that would otherwise land in a directory that is no longer there, then
   * dispose every session holding a path inside it.
   */
  private async quiesceGhost(
    ghost: Ghost,
    outcome: "deleted" | "renamed",
  ): Promise<void> {
    const ghostName = ghost.name;
    const alreadyClosing = [...this.closing.entries()]
      .filter(([key]) => sessionKeyParts(key)[0] === ghostName)
      .map(([, closing]) => closing.promise);
    if (alreadyClosing.length > 0) await Promise.all(alreadyClosing);
    const hosted = [...this.sessions].filter(([key]) => sessionKeyParts(key)[0] === ghostName);
    // Title generation can still append to an otherwise-idle transcript. Let
    // it settle before the home moves out from under it.
    const background: Promise<unknown>[] = hosted
      .map(([, entry]) => entry.title)
      .filter((task) => task !== undefined);
    if (background.length > 0) await Promise.allSettled(background);

    for (const [key] of hosted) await this.closePi(ghostName, sessionKeyParts(key)[1]);
    try {
      await this.browserSessionClose(ghost.dir);
    } catch {
      throw new GhostError(
        "browser_cleanup_pending",
        "The ghost's browser session did not close. Restore the browser relay and retry.",
        503,
      );
    }
    await this.retireGhostSchedules(ghost.name, outcome);
  }

  /**
   * Drop everything the daemon still holds under a name or a home that moved.
   * A ghost re-summoned (or renamed) into this name must not inherit the
   * previous one's opening line.
   */
  private forgetGhost(ghostName: string): void {
    this.greetings.clear(ghostName);
    this.closeConversationEventStreams(ghostName);
  }

  private ghostBusy(ghostName: string): boolean {
    for (const key of this.turnAdmissions) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    for (const key of this.lifecycleAdmissions.keys()) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    for (const [key, hosted] of this.sessions) {
      if (sessionKeyParts(key)[0] !== ghostName) continue;
      if (this.sessionOwned(hosted)) return true;
    }
    for (const key of this.opening.keys()) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    for (const key of this.closing.keys()) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    for (const key of this.cleanupRetries.keys()) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    for (const key of this.deleting) {
      if (deletionKeyGhost(key) === ghostName) return true;
    }
    return this.mcpReloadGhosts.has(ghostName);
  }

  private ghostHasTurnAdmission(ghostName: string): boolean {
    for (const key of this.turnAdmissions) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    return false;
  }

  private async closePi(ghostName: string, sessionId?: string | null): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    await this.closeHostedSession(key);
  }

  private closeHostedSession(key: string): Promise<void> {
    const [_ghostName, _conversationId] = sessionKeyParts(key);
    const alreadyClosing = this.closing.get(key);
    if (alreadyClosing) return alreadyClosing.promise;
    const hosted = this.cleanupRetries.get(key) ?? this.sessions.get(key);
    if (!hosted) return Promise.resolve();

    // Remove admission before the first await. Every potentially fallible
    // teardown action lives inside the settled cleanup below. The retry map is
    // installed synchronously so no open can create a replacement between the
    // active-cache removal and the first failed stage.
    this.sessions.delete(key);
    this.cleanupRetries.set(key, hosted);
    const closing = (async () => {
      await this.disposePiSession(hosted);
      if (this.cleanupRetries.get(key) === hosted) this.cleanupRetries.delete(key);
    })().finally(() => {
      if (this.closing.get(key)?.promise === closing) this.closing.delete(key);
    });
    this.closing.set(key, { hosted, promise: closing });
    return closing;
  }

  private closeModelRuntime(hosted: HostedSession): void {
    if (hosted.modelRuntimeClosed) return;
    hosted.modelRuntime.close();
    hosted.modelRuntimeClosed = true;
  }


  private abortHostedBash(hosted: HostedSession): void {
    if (hosted.bashAbortStarted) return;
    hosted.session.abortBash();
    hosted.bashAbortStarted = true;
  }

  private abortHostedSession(hosted: HostedSession): Promise<void> {
    if (hosted.abortCompleted) return Promise.resolve();
    if (hosted.abortTask) return hosted.abortTask;
    let abort: Promise<void>;
    try {
      abort = Promise.resolve(hosted.session.abort());
    } catch (error) {
      abort = Promise.reject(error);
    }
    const task = abort.then(() => {
      hosted.abortCompleted = true;
    }).finally(() => {
      if (hosted.abortTask === task) hosted.abortTask = undefined;
    });
    hosted.abortTask = task;
    return task;
  }

  private closeHostedAsk(hosted: HostedSession): void {
    if (hosted.askClosed) return;
    hosted.ask.close();
    hosted.askClosed = true;
  }

  private detachHostedOwnership(hosted: HostedSession): void {
    if (hosted.ownershipDetached) return;
    const unsubscribe = hosted.unsubscribeOwnership;
    unsubscribe?.();
    hosted.unsubscribeOwnership = undefined;
    hosted.ownershipDetached = true;
  }

  private abortHostedTitle(hosted: HostedSession): void {
    if (hosted.titleAborted) return;
    hosted.titleAbort?.abort();
    hosted.titleAborted = true;
  }

  private async settleHostedMcpReload(hosted: HostedSession): Promise<void> {
    if (hosted.mcpReloadSettled) return;
    const reload = hosted.mcp?.reload;
    if (reload) {
      try {
        await reload;
      } catch (error) {
        if (hosted.mcp?.reload === reload) hosted.mcp.reload = undefined;
        throw error;
      }
    }
    hosted.mcpReloadSettled = true;
  }

  private async disconnectHostedMcp(hosted: HostedSession): Promise<void> {
    if (hosted.mcpDisconnected) return;
    await hosted.mcp?.manager.disconnectAll();
    hosted.mcpDisconnected = true;
  }

  private async settleHostedMcpRefresh(hosted: HostedSession): Promise<void> {
    if (hosted.mcpRefreshSettled) return;
    const refresh = hosted.mcp?.refresh;
    if (refresh) {
      try {
        await refresh;
      } catch (error) {
        if (hosted.mcp?.refresh === refresh) hosted.mcp.refresh = undefined;
        throw error;
      }
    }
    hosted.mcpRefreshSettled = true;
  }


  private async disposeHostedAgentSession(hosted: HostedSession): Promise<void> {
    if (hosted.sessionDisposed) return;
    await hosted.session.dispose();
    hosted.sessionDisposed = true;
  }

  private async collectCleanupFailure(
    failures: unknown[],
    action: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }

  private reportCleanupFailure(hosted: HostedSession | undefined, stage: string, error: unknown): void {
    try {
      (hosted?.logger ?? this.logger).warn("session cleanup failed", {
        ...(hosted ? { session: hosted.sessionKey } : {}),
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Cleanup must continue even if an injected/test logger is faulty.
    }
  }

  private launchCleanupStep(
    hosted: HostedSession | undefined,
    stage: string,
    action: () => unknown | Promise<unknown>,
  ): void {
    try {
      const result = action();
      void Promise.resolve(result).catch((error) => {
        this.reportCleanupFailure(hosted, stage, error);
      });
    } catch (error) {
      this.reportCleanupFailure(hosted, stage, error);
    }
  }

  private async disposePiSession(hosted: HostedSession): Promise<void> {
    const failures: unknown[] = [];
    await this.collectCleanupFailure(failures, () => this.detachHostedOwnership(hosted));
    await this.collectCleanupFailure(failures, () => this.abortHostedBash(hosted));
    await this.collectCleanupFailure(failures, () => this.abortHostedSession(hosted));
    await this.collectCleanupFailure(failures, () => this.abandonPiOwnerPasses(hosted));
    await this.collectCleanupFailure(failures, () => this.closeHostedAsk(hosted));
    await this.collectCleanupFailure(failures, () => this.abortHostedTitle(hosted));
    if (hosted.mcp) {
      await this.collectCleanupFailure(failures, () => this.settleHostedMcpReload(hosted));
      await this.collectCleanupFailure(failures, () => this.disconnectHostedMcp(hosted));
      await this.collectCleanupFailure(failures, () => this.settleHostedMcpRefresh(hosted));
    }
    await this.collectCleanupFailure(failures, () => this.disposeHostedAgentSession(hosted));
    await this.collectCleanupFailure(failures, () => this.closeModelRuntime(hosted));
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to fully dispose session ${hosted.sessionKey}.`);
    }
  }

  /** Stop new work and synchronously trip every active owner's cancellation. */
  beginShutdown(): void {
    if (this.shutdownTasks) return;
    this.disposed = true;
    this.launchCleanupStep(undefined, "retention timer", () => this.retentionTimer.dispose());
    this.shutdownTasks = [];
    for (const hosted of this.sessions.values()) {
      this.launchCleanupStep(hosted, "abort bash", () => this.abortHostedBash(hosted));
      this.launchCleanupStep(hosted, "close ask", () => this.closeHostedAsk(hosted));
      this.launchCleanupStep(hosted, "abort title", () => this.abortHostedTitle(hosted));
      this.launchCleanupStep(hosted, "abort session", () => this.abortHostedSession(hosted));
    }
  }

  disposeAll(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.beginShutdown();
    const dispose = (async () => {
      await Promise.allSettled([...this.opening.values()]);
      const sessionKeys = [...new Set([
        ...this.sessions.keys(),
        ...this.cleanupRetries.keys(),
      ])];
      const sessionResults = await Promise.allSettled(
        sessionKeys.map((key) => this.closeHostedSession(key)),
      );
      for (const [index, result] of sessionResults.entries()) {
        if (result.status === "rejected") {
          this.reportCleanupFailure(
            this.cleanupRetries.get(sessionKeys[index] ?? ""),
            "daemon shutdown session",
            result.reason,
          );
        }
      }
      await Promise.allSettled([...this.closing.values()].map(({ promise }) => promise));
      const shutdownResults = await Promise.allSettled(this.shutdownTasks ?? []);
      for (const result of shutdownResults) {
        if (result.status === "rejected") {
          this.reportCleanupFailure(undefined, "daemon shutdown controller", result.reason);
        }
      }
      this.unregisterHomeMoveParticipant?.();
      this.sessions.clear();
    })().finally(() => {
      if (this.disposePromise === dispose && this.cleanupRetries.size > 0) {
        this.disposePromise = undefined;
      }
    });
    this.disposePromise = dispose;
    return dispose;
  }

  /**
   * Best-effort terminal stage after the graceful deadline. The caller still
   * owns a hard process deadline because third-party providers can ignore abort.
   */
  forceDisposeAll(): Promise<void> {
    this.beginShutdown();
    const hosted = [...new Set([
      ...this.sessions.values(),
      ...[...this.closing.values()].map(({ hosted: entry }) => entry),
      ...this.cleanupRetries.values(),
    ])];
    for (const entry of hosted) {
      this.sessions.delete(entry.sessionKey);
      this.cleanupRetries.set(entry.sessionKey, entry);
      this.launchCleanupStep(entry, "force abort bash", () => this.abortHostedBash(entry));
      this.launchCleanupStep(entry, "force close ask", () => this.closeHostedAsk(entry));
      this.launchCleanupStep(entry, "force abort title", () => this.abortHostedTitle(entry));
      this.launchCleanupStep(entry, "force detach ownership", () => this.detachHostedOwnership(entry));
      this.launchCleanupStep(entry, "force abort session", () => this.abortHostedSession(entry));
      if (entry.mcp) {
        this.launchCleanupStep(
          entry,
          "force disconnect MCP",
          () => this.disconnectHostedMcp(entry),
        );
      }
      this.launchCleanupStep(entry, "force close model runtime", () => this.closeModelRuntime(entry));
      if (!entry.sessionDisposed && !entry.forceDisposeStarted) {
        entry.forceDisposeStarted = true;
        this.launchCleanupStep(entry, "force dispose session", async () => {
          try {
            await entry.session.dispose();
            entry.sessionDisposed = true;
          } finally {
            entry.forceDisposeStarted = false;
          }
        });
      }
    }
    return Promise.resolve();
  }
}
