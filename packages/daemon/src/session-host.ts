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
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { collectGhostExtension, openGhostHome } from "@ghost/extensions";
import {
  convertToLlm,
  createAgentSession,
  createLocalBashOperations,
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
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeRuntime,
  claudeSessionMetadataPath,
  claudeSessionResumeMarkerPaths,
  type ClaudeProjectSnapshot,
  type ClaudeCodeRuntimeOptions,
} from "./claude-code.js";
import {
  readDaemonControlFile,
  readDaemonControlLine,
} from "./control-file.js";
import {
  DEFAULT_COMPACTION_CONFIG,
  GHOST_COMPACTION_PROMPT,
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
  renderScheduledWorkPolicy,
  resolveScheduleUnitDirectory,
  sweepGhostSchedules,
} from "./schedules.js";
import type { CommandRunner } from "./tailscale-identity.js";
import {
  loadMachineSkills,
  machineSkillPaths,
  OMARCHY_COMPUTER_USE_POLICY,
  OWNER_DELIVERABLE_POLICY,
  renderSharedObsidianPolicy,
} from "./machine-skills.js";
import {
  maintenanceStatePath,
  type ConversationMaintenance,
  type MaintenanceConversationDeleteOutcome,
  type MaintenanceDrainReservation,
  type MaintenanceIdentity,
  type MaintenanceOwnerActivity,
  type MaintenanceOwnerAdmission,
  type SettledMaintenanceTurn,
} from "./conversation-maintenance.js";
import {
  homeOperationsFor,
  type HomeMoveParticipantReservation,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import {
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  resolveSmolModelRef,
  type GhostModelRoleBinding,
} from "./models.js";
import {
  asRuntimeSessionEvent,
  createPiMessagesAdapter,
  type PiMessagesEvent,
  zeroUsage,
} from "./pi-messages.js";
import { readPinState, writePins } from "./pins.js";
import { readReadState, writeReads } from "./reads.js";
import {
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
import { createGhostPiRuntime, type GhostPiRuntime } from "./pi-runtime.js";
import { loadGhostSettings, type GhostSettings } from "./ghost-settings.js";
import { loadGhostHookExtensions } from "./artifact-root.js";
import { AskBroker, AskBrokerError, type PendingAsk } from "./ask-broker.js";
import { AskCancelledError, createAskTool, type AskToolDetails } from "./ask-tool.js";
import type { AskResultItem } from "./ask-broker.js";
import {
  type CancelJobOutcome,
  createBashTool,
  createJobsTool,
  formatJobResult,
  type GhostJob,
  GhostJobManager,
  type GhostJobSnapshot,
  JOB_RESULT_MESSAGE_TYPE,
  jobSnapshot,
} from "./jobs.js";
import { piExtensionFromGhost, renderPersonaPrompt } from "./pi-extension-bridge.js";
import { createInspectImageTool } from "./inspect-image.js";
import {
  createPlanModeGuard,
  createProposePlanTool,
  createTodoTool,
  PlanBook,
  planSections,
  type PlanState,
  type TodoPhase,
} from "./plan-mode.js";
import { GhostMcpManager } from "./mcp-manager.js";
import { validateServerName, type MCPServerConfig } from "./mcp-config.js";
import { resolveChatModel } from "./model-routing.js";
import { buildRecapPrompt, normalizeRecap } from "./recap.js";
import { assistantText } from "./smol.js";
import type { Rule, Skill } from "./declarative-types.js";
import {
  buildGhostAvailableSlashCommands,
  classifyGhostBuiltin,
  executeGhostBuiltin,
  type GhostAvailableSlashCommand,
  type GhostFileCommand,
} from "./slash-commands.js";
import {
  LiveVoiceManager,
  type LiveVoiceStatus,
} from "./live-voice.js";
import {
  CollaborationManager,
  type CollaborationStatus,
} from "./collaboration.js";
import {
  expandMcpServerConfig,
  normalizeMcpStdioCwd,
  readEffectiveProjectMcp,
  type EffectiveProjectMcpRead,
} from "./mcp-catalog.js";
import { resolveMcpServerSecrets, type SecretResolver } from "./secret-resolution.js";
import {
  projectBindingPath,
  ProjectBindingStore,
  type ProjectBindingState,
  type ProjectPreview,
} from "./project-binding.js";
import {
  loadProjectDeclarativeSnapshot,
  type ProjectDeclarativeSnapshot,
} from "./project-resources.js";
import {
  mergeProjectDeclarativeSnapshots,
  renderPiDeclarativePrompt,
} from "./declarative-snapshot.js";
import {
  piProjectSnapshotPath,
  piProjectSnapshotPaths,
  readPiProjectSnapshot,
} from "./project-snapshot.js";
import { readToolCwds, toolCwdsPath, writeToolCwds } from "./tool-cwds.js";

type SessionConversationMaintenance = Pick<ConversationMaintenance,
  | "admitOwnerAction"
  | "recordOwnerActivity"
  | "reserveConversationDelete"
  | "completeConversationDelete"
  | "reserveGhostMove"
  | "completeGhostRename"
  | "completeGhostDelete"
  | "beginShutdown"
  | "disposeAll"
>;

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

const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";

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

/** Ghost's summary briefing replaces pi's default compaction instructions. */
const ghostCompactionExtension: ExtensionFactory = (api) => {
  api.on("session_before_compact", (event) => {
    if (event.customInstructions !== undefined) return undefined;
    (event as { customInstructions?: string }).customInstructions = GHOST_COMPACTION_PROMPT;
    return undefined;
  });
};

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

type PiOwnerPassKind = "direct" | "steer" | "followUp" | "collaboration" | "voice" | "reanswer";

const ASK_REANSWER_OWNER_MESSAGE_TYPE = "ghost-ask-reanswer-owner";
const DEFAULT_AUTO_BACKGROUND_MS = 60_000;
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
  finish(turn?: SettledMaintenanceTurn): Promise<void>;
}

interface PersistedPiPassBoundary {
  readonly pass: PendingPiOwnerPass;
  readonly assistantEntry: Extract<SessionEntry, { type: "message" }>;
}

type PersistedPiPassResult = PersistedPiPassBoundary | "superseded" | null;

interface PiSettlementResult {
  readonly toolCwdError?: unknown;
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
  if (entry.customType === LIVE_DELEGATION_MESSAGE_TYPE) {
    return { kind: "voice", prompt: entryText(entry.content) };
  }
  if (customMessageAttribution(entry) === "user") {
    return { kind: "collaboration", prompt: entryText(entry.content) };
  }
  return null;
}

function passEntryMatches(
  pass: PendingPiOwnerPass,
  owner: { kind: PiOwnerPassKind; prompt: string },
): boolean {
  if (pass.kind === "direct") return owner.kind === "direct" || owner.kind === "collaboration";
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
  session: AgentSession;
  runtime: GhostPiRuntime;
  ghostName: string;
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

export const DEFAULT_TITLE_TIMEOUT_MS = 15_000;

const defaultTitleGenerator: TitleGenerator = async ({ runtime, configDir, firstPrompt, signal }) => {
  let ref = null;
  try {
    ref = resolveSmolModelRef(readGhostModels(configDir));
  } catch {
    // A broken models.json is not fatal to titling: fall back to cheapest usable.
    ref = null;
  }
  return generateTitle({ runtime, firstPrompt, ref, signal });
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

export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_CACHED_SESSIONS = 24;
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;

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
  /** Runtime systemd user-unit directory; main supplies the XDG-resolved path. */
  scheduleRuntimeUnitDir?: string;
  /** Test seam over schedule lifecycle's `systemctl --user` calls. */
  scheduleCommandRunner?: CommandRunner;
  /** Test seam; production discovers the standard owner-machine skill paths. */
  machineSkillPaths?: readonly string[];
  projectBindings?: ProjectBindingStore;
  /** Test seam for retiring the process-wide browser entry before a home move. */
  browserSessionClose?: (homeDir: string) => Promise<void>;
  sessionStartupProbe?: (
    stage: "model-runtime" | "mcp" | "session-manager" | "agent-session",
    runtime: GhostPiRuntime,
  ) => void | Promise<void>;
  /** Test seam for fault-injecting durable per-tool cwd publication. */
  toolCwdWriter?: typeof writeToolCwds;
  /** Test seams for pausing owner sidebar-state publication. */
  pinWriter?: typeof writePins;
  readWriter?: typeof writeReads;
  /** Test seam at conversation-file path ownership boundaries. */
  conversationFileProbe?: (
    operation:
      | "plan-read"
      | "plan-write"
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
  /** Test seam for marker lstat failures; production always uses fs.lstat. */
  transactionMarkerLstat?: (path: string) => Promise<unknown>;
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
  /**
   * Background jobs: a foreground `bash` call that runs longer than
   * `autoBackgroundMs` continues as a job (default 60s; 0 disables).
   */
  jobs?: { autoBackgroundMs?: number };
  /**
   * Owner-local Claude Code harness. It is dormant unless
   * `roles.chat_model.provider` is `claude-code`; options are chiefly the
   * executable override and test seams.
   */
  claudeCode?: Omit<
    ClaudeCodeRuntimeOptions,
    | "logger"
    | "extensionOptions"
    | "hooks"
    | "machineSkillPaths"
    | "ownerHome"
    | "scheduleUnitDir"
  >;
  liveVoice?: LiveVoiceManager;
  collaboration?: CollaborationManager;
  hooks?: GhostHookRunner;
  maintenance?: SessionConversationMaintenance;
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

type ConfiguredTurnRuntime =
  | { readonly runtime: "pi" }
  | { readonly runtime: "claude-code"; readonly modelId: string };

type SelectedTurnRuntime =
  | { readonly runtime: "pi" }
  | {
      readonly runtime: "claude-code";
      readonly modelId: string;
      readonly project: ClaudeProjectSnapshot;
    };

export interface RunAskReanswerOptions {
  sessionId?: string | null;
  runtime?: ConversationRuntime;
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

export interface PlanStateView {
  planning: boolean;
  plan: (PlanState["plan"] & { content: string | null }) | null;
  todo: TodoPhase[];
}

function planStateView(book: PlanBook): PlanStateView {
  const state = book.getState();
  return {
    planning: state.planning,
    plan: state.plan ? { ...state.plan, content: book.planContent() } : null,
    todo: book.getTodo(),
  };
}

export interface QueuedMessages {
  streaming: boolean;
  count: number;
  steering: readonly string[];
  followUp: readonly string[];
}

export interface TrashedConversationArtifact extends TrashPathResult {
  artifact: "omp-transcript" | "claude-sidecar"
    | "project-binding" | "project-snapshot" | "tool-cwds" | "maintenance-state";
  source: string;
}

export interface TrashedConversation {
  artifacts: TrashedConversationArtifact[];
}

export type QueueMode = "steer" | "followUp";

interface McpSource {
  path: string;
  level: "user" | "project";
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

interface HostedRecap {
  controller: AbortController;
  task: Promise<string | null>;
}

interface HostedSession extends GhostSessionHandle {
  logger: Logger;
  project: ProjectBindingState;
  projectSnapshot: ProjectDeclarativeSnapshot | null;
  toolCwds: Map<string, string>;
  toolCwdWrite?: Promise<void>;
  /** Monotonic in-memory revision, retained across failed publications. */
  toolCwdVersion: number;
  /** Last revision known to be file-and-directory durable. */
  toolCwdPersistedVersion: number;
  busy: boolean;
  lastUsedAt: number;
  unsubscribeOwnership?: () => void;
  /** The abort signal of the most recent agent run, captured at `agent_start`. */
  runSignal?: AbortSignal;
  pendingOwnerPasses: PendingPiOwnerPass[];
  /** Serial durability and hook drain shared by every owner-action path. */
  ownerPassSettlement?: Promise<void>;
  /** Reconstructed from the persisted branch and reserved synchronously per owner action. */
  nextOwnerTurnId: number;
  settlingDeferred?: Promise<void>;
  liveVoiceTransitions?: number;
  /** Lets a concurrent stop wait for an admitted startup. */
  liveVoiceStart?: Promise<LiveVoiceStatus>;
  ask: AskBroker;
  jobs: GhostJobManager;
  plan: PlanBook;
  /** Jobs that settled while an owner held the session without streaming. */
  pendingJobResults: GhostJob[];
  /**
   * The runtime this session's model was bound from, kept so a later model
   * switch can re-resolve against the same catalogue the session was built
   * with (see `rebindModel`).
   */
  modelRuntime: GhostPiRuntime;
  /** The ghost's own settings.yml, read when the session opened. */
  settings: GhostSettings;
  /** A `!cd` moved the working directory; the session reopens on release. */
  /**
   * Set when a model switch arrived during a turn or live voice. The model is
   * rebound after that exclusive owner releases the AgentSession.
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
  /** One abortable, non-persisted completion over the current Pi context. */
  recap?: HostedRecap;
  collaborationTransitions?: number;
  rawCollaborationPrompts?: number;
  rawCollaborationIdle?: Promise<void>;
  releaseRawCollaborationIdle?: () => void;
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
  voiceStopped?: boolean;
  collaborationStopped?: boolean;
  toolCwdsFlushed?: boolean;
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

function draftAbandonTransactionPath(
  sessionDir: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  return join(
    sessionDir,
    `.ghost-draft-abandon-${conversationTransactionStem(conversationId)}.${runtime}.pending.json`,
  );
}

function draftAbandonReceiptPath(
  sessionDir: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  return join(
    sessionDir,
    `.ghost-draft-abandon-${conversationTransactionStem(conversationId)}.${runtime}.complete.json`,
  );
}

interface ForkTransactionRecord {
  version: 1 | 2;
  kind: "fork";
  conversationId: string;
  tempTranscript: string;
  tempProjectBinding: string;
  tempProjectSnapshot: string | null;
  projectSnapshotGeneration: number | null;
  tempToolCwds: string;
}

const DELETE_ARTIFACT_KINDS = new Set<TrashedConversationArtifact["artifact"]>([
  "omp-transcript",
  "claude-sidecar",
  "project-binding",
  "project-snapshot",
  "tool-cwds",
  "maintenance-state",
]);

interface DeleteMoveIntent extends TrashedConversationArtifact {}

interface DeleteTransactionRecord {
  version: 1 | 2 | 3;
  kind: "delete";
  runtime: ConversationRuntime;
  conversationId: string;
  artifacts: TrashedConversationArtifact[];
  trashRoot: string | null;
  pending: DeleteMoveIntent | null;
}

interface DraftAbandonTransactionRecord {
  version: 1;
  kind: "project-draft-abandon";
  runtime: ConversationRuntime;
  conversationId: string;
  artifacts: string[];
}

const TRANSACTION_MARKER_MAX_BYTES = 1_048_576;

function emptyDeleteTransaction(
  runtime: ConversationRuntime,
  conversationId: string,
): DeleteTransactionRecord {
  return {
    version: 3,
    kind: "delete",
    runtime,
    conversationId,
    artifacts: [],
    trashRoot: null,
    pending: null,
  };
}

type TransactionMarkerState = "absent" | "present" | "indeterminate";

async function transactionMarkerState(
  path: string,
  inspect: (path: string) => Promise<unknown> = lstat,
): Promise<TransactionMarkerState> {
  try {
    await inspect(path);
    return "present";
  } catch (error) {
    // Absence is the only evidence that a transaction does not own this row.
    // Permission, I/O, and unexpected-path errors fail closed without reading
    // attacker-controlled marker bytes or following a symbolic link.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "indeterminate";
  }
}

async function transactionMarkerEntryExists(path: string): Promise<boolean> {
  return await transactionMarkerState(path) !== "absent";
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await openFile(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeTransaction(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > TRANSACTION_MARKER_MAX_BYTES) {
    throw new Error(`Conversation transaction exceeds its ${TRANSACTION_MARKER_MAX_BYTES}-byte limit.`);
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    file = await openFile(temporary, "wx", 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await fsyncDirectory(resolve(path, ".."));
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
  artifact: TrashedConversationArtifact,
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
  runtime: ConversationRuntime,
  conversationId: string,
  artifact: TrashedConversationArtifact,
): boolean {
  const sessionDir = ghostPaths(ghostDir).sessionDir;
  switch (artifact.artifact) {
    case "omp-transcript":
      return runtime === "pi"
        && artifact.source === join(sessionDir, sessionFileNameFor(conversationId));
    case "claude-sidecar": {
      const sidecar = claudeSessionMetadataPath(sessionDir, conversationId);
      const markers = claudeSessionResumeMarkerPaths(sessionDir, conversationId);
      return runtime === "claude-code"
        && (artifact.source === sidecar
          || artifact.source === markers.started
          || artifact.source === markers.settling);
    }
    case "project-binding":
      return artifact.source === projectBindingPath(sessionDir, runtime, conversationId);
    case "tool-cwds":
      return runtime === "pi"
        && artifact.source === toolCwdsPath(sessionDir, conversationId);
    case "maintenance-state":
      return artifact.source === maintenanceStatePath(sessionDir, runtime, conversationId);
    case "project-snapshot": {
      if (runtime !== "pi" || artifact.source !== join(sessionDir, basename(artifact.source))) {
        return false;
      }
      const prefix = `${conversationTransactionStem(conversationId)}.pi.project-snapshot.`;
      const name = basename(artifact.source);
      return name.startsWith(prefix) && /^\d+\.json$/u.test(name.slice(prefix.length));
    }
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

const LEGACY_PI_SESSION_HEADER_MAX_BYTES = 64 * 1024;

async function legacyPiSessionCwd(path: string): Promise<string | undefined> {
  try {
    const first = await readDaemonControlLine(path, LEGACY_PI_SESSION_HEADER_MAX_BYTES);
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

function expandLegacyPins(
  stored: readonly string[],
  rows: readonly StoredSessionRow[],
): Set<string> {
  const expanded = new Set<string>();
  for (const conversationId of stored) {
    for (const row of rows) {
      if (row.conversationId === conversationId) expanded.add(row.id);
    }
  }
  return expanded;
}

function expandLegacyReads(
  stored: Readonly<Record<string, string>>,
  rows: readonly StoredSessionRow[],
): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [conversationId, readAt] of Object.entries(stored)) {
    for (const row of rows) {
      if (row.conversationId === conversationId) expanded[row.id] = readAt;
    }
  }
  return expanded;
}

function assertPiConversation(runtime: ConversationRuntime, feature: string): void {
  if (runtime !== "pi") {
    throw new GhostError(
      "not_supported",
      `${feature} is unavailable for a Claude Code conversation.`,
      409,
    );
  }
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
  reason?: "project";
}

export type ConversationEventListener = (event: ConversationUpdatedEvent) => void;

interface ConversationEventSubscription {
  listener: ConversationEventListener;
  close: () => void;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: unknown;
  timestamp?: number;
  entryId: string;
  parentId: string | null;
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
  runtime: "pi";
  title: string | null;
  messages: TranscriptMessage[];
  total: number;
  truncated: boolean;
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

interface ProjectMcpConnectionResult {
  projectConfigured: number;
  projectFailed: number;
}

function rejectedProjectMcpCount(effective: EffectiveProjectMcpRead): number {
  return effective.skipped.length
    + effective.servers.filter((server) => server.errors.length > 0).length;
}

function summarizeProjectMcpConnection(
  sources: ReadonlyMap<string, McpSource>,
  errors: ReadonlyMap<string, unknown>,
  rejected = 0,
): ProjectMcpConnectionResult {
  const projectServers = new Set(
    [...sources].filter(([, source]) => source.level === "project").map(([name]) => name),
  );
  return {
    projectConfigured: projectServers.size,
    projectFailed: rejected + [...errors.keys()].filter((name) => projectServers.has(name)).length,
  };
}

function projectMcpRuntimeStatus(result: ProjectMcpConnectionResult): {
  status: "ready" | "degraded";
  error: { code: string; message: string } | null;
  mcpStatus: "off" | "ready" | "degraded";
} {
  const degraded = result.projectFailed > 0;
  return {
    status: degraded ? "degraded" : "ready",
    error: degraded
      ? {
          code: "project_mcp_degraded",
          message: "One or more project MCP resources could not be loaded.",
        }
      : null,
    mcpStatus: degraded
      ? "degraded"
      : result.projectConfigured > 0 ? "ready" : "off",
  };
}

async function connectGhostProjectMCP(
  manager: GhostMcpManager,
  input: {
    ghostRoot: string;
    secretResolver: SecretResolver;
    project?: { root: string; mcp: EffectiveProjectMcpRead };
  },
  logger: Logger,
): Promise<{ result: ProjectMcpConnectionResult; configs: Map<string, MCPServerConfig>; sources: Map<string, McpSource> }> {
  const configs = new Map<string, MCPServerConfig>();
  const sources = new Map<string, McpSource>();
  let projectRejected = 0;
  const roots = [
    {
      root: input.ghostRoot,
      project: false,
      effective: await readEffectiveProjectMcp(input.ghostRoot),
    },
    ...(input.project
      ? [{ root: input.project.root, project: true, effective: input.project.mcp }]
      : []),
  ];
  for (const sourceRoot of roots) {
    const { root, project: isActiveProject, effective } = sourceRoot;
    // A later project row claims precedence before admission. Disabled and
    // invalid rows therefore shadow a same-name visible Ghost server without
    // entering the runtime configuration themselves.
    for (const name of effective.claimedNames) {
      configs.delete(name);
      sources.delete(name);
    }
    for (const skipped of effective.skipped) {
      if (isActiveProject) projectRejected += 1;
      logger.error("MCP config failed to load", {
        path: skipped.path,
        code: "mcp_connection_failed",
      });
    }
    for (const server of effective.servers) {
      if (server.errors.length > 0) {
        if (isActiveProject) projectRejected += 1;
        logger.error("MCP server failed to load", {
          path: server.source.relativePath,
          ...(validateServerName(server.name) ? {} : { server: server.name }),
          code: "mcp_connection_failed",
        });
        continue;
      }
      const config = server.config as MCPServerConfig;
      if (config.enabled === false) continue;
      const resolved = resolveMcpServerSecrets(config, input.secretResolver);
      configs.set(server.name, normalizeMcpStdioCwd(expandMcpServerConfig(resolved), root));
      sources.set(server.name, {
        path: server.source.absolutePath,
        level: isActiveProject ? "project" : "user",
      });
    }
  }

  if (configs.size === 0) {
    return { result: summarizeProjectMcpConnection(sources, new Map(), projectRejected), configs, sources };
  }
  try {
    const connected = await manager.connectServers(Object.fromEntries(configs));
    for (const [name, error] of connected.errors) {
      logger.error("ghost project MCP server failed to load", {
        path: sources.get(name)?.path ?? `mcp:${name}`,
        server: name,
        code: error,
      });
    }
    return { result: summarizeProjectMcpConnection(sources, connected.errors, projectRejected), configs, sources };
  } catch {
    logger.error("project MCP failed to load", {
      path: input.project ? join(input.project.root, ".omp") : input.ghostRoot,
      code: "mcp_connection_failed",
    });
    const configured = summarizeProjectMcpConnection(sources, new Map(), projectRejected);
    return {
      result: {
        projectConfigured: configured.projectConfigured,
        projectFailed: configured.projectFailed + configured.projectConfigured,
      },
      configs,
      sources,
    };
  }
}

export class SessionHost {
  private readonly registry: GhostRegistry;
  private readonly ownerHome: string;
  private readonly scheduleUnitDir: string;
  private readonly scheduleRuntimeUnitDir: string;
  private readonly scheduleCommandRunner: CommandRunner | undefined;
  private readonly machineSkills: string[];
  private readonly projectBindings: ProjectBindingStore;
  private readonly browserSessionClose: (homeDir: string) => Promise<void>;
  private readonly sessionStartupProbe: NonNullable<SessionHostOptions["sessionStartupProbe"]>;
  private readonly toolCwdWriter: typeof writeToolCwds;
  private readonly pinWriter: typeof writePins;
  private readonly readWriter: typeof writeReads;
  private readonly conversationFileProbe: NonNullable<SessionHostOptions["conversationFileProbe"]>;
  private readonly transactionProbe: NonNullable<SessionHostOptions["transactionProbe"]>;
  private readonly transactionMarkerLstat: NonNullable<SessionHostOptions["transactionMarkerLstat"]>;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly extensionOptions: GhostExtensionOptions;
  private readonly compactionConfig: CompactionConfig;
  private readonly autoBackgroundMs: number;
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
  private readonly claudeCode: ClaudeCodeRuntime;
  private readonly hooks: GhostHookRunner;
  private maintenance: SessionConversationMaintenance | undefined;
  private readonly liveVoice: LiveVoiceManager;
  private readonly collaboration: CollaborationManager;
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
  private readonly projectTransitions = new Set<string>();
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
    const scheduleRuntimeUnitDir = options.scheduleRuntimeUnitDir
      ?? join(this.ownerHome, ".runtime", "systemd", "user");
    if (!isAbsolute(scheduleRuntimeUnitDir)) {
      throw new TypeError("scheduleRuntimeUnitDir must be absolute");
    }
    this.scheduleRuntimeUnitDir = resolve(scheduleRuntimeUnitDir);
    this.scheduleCommandRunner = options.scheduleCommandRunner;
    this.machineSkills = options.machineSkillPaths
      ? [...options.machineSkillPaths]
      : machineSkillPaths(this.ownerHome);
    this.projectBindings = options.projectBindings
      ?? new ProjectBindingStore({ ownerHome: this.ownerHome });
    this.browserSessionClose = options.browserSessionClose ?? closeBrowserSession;
    this.sessionStartupProbe = options.sessionStartupProbe ?? (() => {});
    this.toolCwdWriter = options.toolCwdWriter ?? writeToolCwds;
    this.pinWriter = options.pinWriter ?? writePins;
    this.readWriter = options.readWriter ?? writeReads;
    this.conversationFileProbe = options.conversationFileProbe ?? (() => {});
    this.transactionProbe = options.transactionProbe ?? (() => {});
    this.transactionMarkerLstat = options.transactionMarkerLstat ?? lstat;
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.extensionOptions = options.extensionOptions ?? {};
    this.compactionConfig = options.compaction ?? DEFAULT_COMPACTION_CONFIG;
    this.autoBackgroundMs = options.jobs?.autoBackgroundMs ?? DEFAULT_AUTO_BACKGROUND_MS;
    this.titleEnabled = options.title?.enabled ?? true;
    this.titleTimeoutMs = options.title?.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
    if (!Number.isFinite(this.titleTimeoutMs) || this.titleTimeoutMs <= 0) {
      throw new RangeError("title.timeoutMs must be a finite positive number");
    }
    this.titleTimeoutScheduler = options.title?.scheduleTimeout ?? scheduleTitleTimeout;
    this.askTimeoutSeconds = options.askTimeoutSeconds ?? 0;
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
    this.maintenance = options.maintenance;
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
    this.claudeCode = new ClaudeCodeRuntime({
      ownerHome: this.ownerHome,
      machineSkillPaths: this.machineSkills,
      logger: this.logger,
      extensionOptions: this.extensionOptions,
      hooks: this.hooks,
      ...(options.claudeCode ?? {}),
      scheduleUnitDir: this.scheduleUnitDir,
    });
    this.liveVoice = options.liveVoice ?? new LiveVoiceManager();
    this.liveVoice.setOnInactive(async (key) => {
      try {
        await this.settleLiveVoiceSession(key);
      } catch (error) {
        const [ghost, conversation] = sessionKeyParts(key);
        this.logger.child({ ghost, conversation }).warn("deferred session update after live voice failed", {
          session: key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.collaboration = options.collaboration ?? new CollaborationManager();
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

  setConversationMaintenance(maintenance: SessionConversationMaintenance): void {
    if (this.maintenance && this.maintenance !== maintenance) {
      throw new Error("Conversation maintenance is already attached.");
    }
    this.maintenance = maintenance;
  }

  async withMaintenanceRuntime<T>(
    ghostName: string,
    use: (runtime: GhostPiRuntime) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    const paths = ghostPaths(this.registry.get(ghostName).dir);
    // Maintenance owns a short-lived runtime. Borrowing one from the Pi cache
    // would let an unrelated eviction or project/runtime switch close it while
    // the idle generation is still using the model catalogue.
    const runtime = await createGhostPiRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.home),
      allowModelNetwork: !this.offline,
    });
    try {
      return await use(runtime);
    } finally {
      runtime.close();
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
      || hosted.jobs.hasRunning()
      || hosted.session.isCompacting
      || hosted.title !== undefined
      || hosted.settlingDeferred !== undefined
      || (hosted.collaborationTransitions ?? 0) > 0
      || this.collaboration.status(hosted.sessionKey).active
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
        this.retireHostedSession(hosted.sessionKey, "idle retention expired");
      }
    }
    while (this.sessions.size > this.retentionMaxSessions) {
      const candidate = oldestFirst()
        .find((hosted) => !this.sessionProtectedFromRetention(hosted));
      if (!candidate) break;
      this.retireHostedSession(candidate.sessionKey, "session cache limit reached");
    }
  }

  /** Remove cache admission synchronously; a failed teardown gates replacement opens. */
  private retireHostedSession(key: string, reason: string): void {
    void this.closeHostedSession(key, reason).catch((error) => {
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
    runtime: ConversationRuntime,
    conversationId: string,
    reason?: "project",
  ): Promise<void> {
    const listeners = this.conversationListeners.get(ghostName);
    if (!listeners || listeners.size === 0) return;
    const identity = conversationIdentity(runtime, conversationId);
    const event: ConversationUpdatedEvent = {
      type: "conversation-updated",
      ...identity,
      updatedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
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
    this.assertNoProjectTransition(ghostName, conversationId);
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
        await this.closeHostedSession(key, "retrying incomplete session cleanup");
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
    if (await transactionMarkerEntryExists(
      forkTransactionPath(paths.sessionDir, conversationId),
    )) {
      throw new GhostError("session_busy", "This conversation is still being published.", 409);
    }
    if (await transactionMarkerEntryExists(
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

    const promise = this.createSession(ghostName, conversationId, key, homeLeaseHeld)
      .then(async (hosted) => {
        if (this.disposed) {
          this.cleanupRetries.set(key, hosted);
          await this.closeHostedSession(key, "daemon stopped during session startup").catch(() => {});
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
    runtime: ConversationRuntime = "pi",
  ): Promise<GhostAvailableSlashCommand[]> {
    assertPiConversation(runtime, "Slash commands");
    this.assertPiRuntime(ghostName, "Slash commands");
    const hosted = await this.idleHostedSession(
      ghostName,
      sessionId,
      "Wait for this conversation to finish before refreshing its commands.",
      true,
    );
    try {
      return buildGhostAvailableSlashCommands(hosted.commands);
    } finally {
      await this.releaseSessionClaim(hosted, ghostName);
    }
  }

  /** Plan mode, the approved plan (with its text), and the todo list of one conversation. */
  async planState(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): Promise<PlanStateView> {
    assertPiConversation(runtime, "Plan mode");
    return this.homeOperations.withLease(ghostName, () =>
      this.planStateLeased(ghostName, sessionId)
    );
  }

  private async planStateLeased(
    ghostName: string,
    sessionId: string | null | undefined,
  ): Promise<PlanStateView> {
    const ghost = this.registry.get(ghostName);
    const book = await this.planBookLeased(ghost, sessionId, false);
    return book ? planStateView(book) : { planning: false, plan: null, todo: [] };
  }

  /** `start` enters plan mode, `stop` leaves it (keeping an approved plan), `clear` also drops the plan. */
  async setPlanMode(
    ghostName: string,
    sessionId: string | null | undefined,
    action: "start" | "stop" | "clear",
    runtime: ConversationRuntime = "pi",
  ): Promise<PlanStateView> {
    assertPiConversation(runtime, "Plan mode");
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    return this.homeOperations.withLease(ghostName, () =>
      this.setPlanModeLeased(ghostName, conversationId, action)
    );
  }

  private async setPlanModeLeased(
    ghostName: string,
    conversationId: string,
    action: "start" | "stop" | "clear",
  ): Promise<PlanStateView> {
    const ghost = this.registry.get(ghostName);
    const book = (await this.planBookLeased(ghost, conversationId, true)) as PlanBook;
    if (action === "start" && this.sessions.get(this.keyOf(ghostName, conversationId))?.jobs.hasRunning()) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation's background jobs to finish or cancel them before starting plan mode.",
        409,
      );
    }
    const current = book.getState();
    book.setState({
      planning: action === "start",
      ...(action !== "clear" && current.plan ? { plan: current.plan } : {}),
    });
    await this.announceConversationUpdated(ghostName, "pi", conversationId);
    return planStateView(book);
  }

  /**
   * The conversation's plan book: the open session's own, or one over the
   * transcript file when the conversation is not open. Nothing opens a full
   * session for it. Writing needs the session idle so the entry lands in
   * order; a conversation without a transcript is created for a write and
   * reported empty for a read.
   */
  private async planBookLeased(
    ghost: Ghost,
    sessionId: string | null | undefined,
    write: boolean,
  ): Promise<PlanBook | null> {
    const ghostName = ghost.name;
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    const key = this.keyOf(ghostName, conversationId);
    const opening = this.opening.get(key);
    if (opening) await opening.catch(() => {});
    const hosted = this.sessions.get(key);
    if (hosted) {
      if (write && this.sessionOwned(hosted)) {
        throw new GhostError("session_busy", "Wait for this conversation's turn to finish before changing plan mode.", 409);
      }
      return hosted.plan;
    }
    const paths = ghostPaths(ghost.dir);
    const sessionFile = join(paths.sessionDir, sessionFileNameFor(conversationId));
    await this.conversationFileProbe(write ? "plan-write" : "plan-read", sessionFile);
    if (!existsSync(sessionFile)) {
      if (!write) return null;
      mkdirSync(paths.sessionDir, { recursive: true });
      writeFileSync(sessionFile, "", { flag: "wx", mode: 0o600 });
    } else {
      await requireSessionFileConversationId(sessionFile, conversationId);
    }
    const project = await this.projectStateLeased(ghostName, "pi", conversationId);
    const manager = SessionManager.open(sessionFile, paths.sessionDir, project.cwd);
    if (!existsSync(sessionFile) || manager.getEntries().length <= 1) bindConversationId(manager, conversationId);
    return new PlanBook(manager);
  }

  private assertPiRuntime(ghostName: string, feature: string): Ghost {
    const ghost = this.registry.get(ghostName);
    try {
      const configured = resolveChatModelRef(readGhostModels(ghostPaths(ghost.dir).home));
      if (configured?.provider === CLAUDE_CODE_PROVIDER_ID) {
        throw new GhostError(
          "not_supported",
          `${feature} is unavailable while this ghost uses the Claude Code runtime.`,
          409,
        );
      }
    } catch (error) {
      if (error instanceof GhostError) throw error;
      // Match runTurn: malformed routing falls through to the catalogue default.
    }
    return ghost;
  }

  liveVoiceStatus(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): LiveVoiceStatus {
    assertPiConversation(runtime, "Live voice");
    this.assertPiRuntime(ghostName, "Live voice");
    return this.liveVoice.status(this.keyOf(ghostName, sessionId));
  }

  async liveVoiceAction(
    ghostName: string,
    sessionId: string | null | undefined,
    action: "start" | "mute" | "unmute" | "stop",
    runtime: ConversationRuntime = "pi",
  ): Promise<LiveVoiceStatus> {
    assertPiConversation(runtime, "Live voice");
    this.assertPiRuntime(ghostName, "Live voice");
    const key = this.keyOf(ghostName, sessionId);
    if (action === "stop") {
      const hosted = this.sessions.get(key);
      if (hosted) hosted.liveVoiceTransitions = (hosted.liveVoiceTransitions ?? 0) + 1;
      try {
        const stopping = this.liveVoice.stop(key);
        await hosted?.liveVoiceStart?.catch(() => {});
        await stopping;
        return await this.liveVoice.stop(key);
      } finally {
        if (hosted) {
          hosted.liveVoiceTransitions = Math.max(0, (hosted.liveVoiceTransitions ?? 1) - 1);
          await this.settleLiveVoiceSession(key);
        }
      }
    }
    if (action === "mute" || action === "unmute") {
      return this.liveVoice.setMuted(key, action === "mute");
    }

    await this.cancelRecap(key);
    const current = this.liveVoice.status(key);
    const currentHosted = this.sessions.get(key);
    if (current.active && (currentHosted?.liveVoiceTransitions ?? 0) === 0) return current;
    const hosted = (await this.open(ghostName, sessionId)) as HostedSession;
    if (this.sessionOwned(hosted)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before starting live voice.",
        409,
      );
    }
    await hosted.mcp?.reload;
    const afterReload = this.liveVoice.status(key);
    if (afterReload.active) return afterReload;
    if (this.sessionOwned(hosted)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before starting live voice.",
        409,
      );
    }

    hosted.liveVoiceTransitions = (hosted.liveVoiceTransitions ?? 0) + 1;
    const start = this.liveVoice.start(
      key,
      hosted.session,
      (message, options) => this.runLiveVoicePrompt(hosted, message, options),
    );
    hosted.liveVoiceStart = start;
    try {
      return await start;
    } finally {
      if (hosted.liveVoiceStart === start) hosted.liveVoiceStart = undefined;
      hosted.liveVoiceTransitions = Math.max(0, (hosted.liveVoiceTransitions ?? 1) - 1);
      if (!this.liveVoice.status(key).active) await this.settleLiveVoiceSession(key);
    }
  }

  collaborationStatus(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): CollaborationStatus {
    assertPiConversation(runtime, "Live collaboration");
    this.assertPiRuntime(ghostName, "Live collaboration");
    return this.collaboration.status(this.keyOf(ghostName, sessionId));
  }

  async collaborationAction(
    ghostName: string,
    sessionId: string | null | undefined,
    input: {
      action: "start" | "stop";
      relayUrl?: string;
      writable?: boolean;
      confirmed?: boolean;
    },
    runtime: ConversationRuntime = "pi",
  ): Promise<CollaborationStatus> {
    assertPiConversation(runtime, "Live collaboration");
    this.assertPiRuntime(ghostName, "Live collaboration");
    const key = this.keyOf(ghostName, sessionId);
    if (input.action === "stop") {
      const hosted = this.sessions.get(key);
      if (hosted) hosted.collaborationTransitions = (hosted.collaborationTransitions ?? 0) + 1;
      try {
        return await this.collaboration.stop(key);
      } finally {
        if (hosted) {
          hosted.collaborationTransitions = Math.max(
            0,
            (hosted.collaborationTransitions ?? 1) - 1,
          );
          this.touchSession(hosted);
          await this.settleDeferredSession(hosted);
        }
      }
    }
    const hosted = await this.idleHostedSession(
      ghostName,
      sessionId,
      "Wait for this conversation to finish before starting collaboration.",
      true,
    );
    hosted.collaborationTransitions = (hosted.collaborationTransitions ?? 0) + 1;
    try {
      const relayUrl = input.relayUrl ?? hosted.settings.getString("collab.relayUrl") ?? "";
      const webUrl = hosted.settings.getString("collab.webUrl");
      return await this.collaboration.start({
        sessionKey: key,
        session: hosted.session,
        promptGuest: (text) => this.runCollaborationPrompt(hosted, text),
        ...(webUrl ? { webUrl } : {}),
        relayUrl,
        writable: input.writable === true,
        confirmed: input.confirmed === true,
      });
    } finally {
      hosted.collaborationTransitions = Math.max(
        0,
        (hosted.collaborationTransitions ?? 1) - 1,
      );
      await this.releaseSessionClaim(hosted, ghostName);
    }
  }

  private async projectState(
    ghostName: string,
    runtime: ConversationRuntime,
    conversationId: string,
  ): Promise<ProjectBindingState> {
    return this.homeOperations.withLease(ghostName, () =>
      this.projectStateLeased(ghostName, runtime, conversationId)
    );
  }

  private async projectStateLeased(
    ghostName: string,
    runtime: ConversationRuntime,
    conversationId: string,
  ): Promise<ProjectBindingState> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    await this.recoverForkTransactions(paths.sessionDir, ghostName);
    if (runtime === "pi" && await transactionMarkerEntryExists(
      forkTransactionPath(paths.sessionDir, conversationId),
    )) {
      throw new GhostError("session_busy", "This conversation is still being published.", 409);
    }
    if (await transactionMarkerEntryExists(
      draftAbandonTransactionPath(paths.sessionDir, runtime, conversationId),
    )) {
      throw new GhostError(
        "session_busy",
        "This unpublished draft is still being abandoned.",
        409,
      );
    }
    if (await transactionMarkerEntryExists(
      deleteTransactionPath(paths.sessionDir, runtime, conversationId),
    )) {
      throw new GhostError("session_deleting", "This conversation has an unfinished deletion.", 409);
    }
    const identity = conversationIdentity(runtime, conversationId);
    let legacyCwd: string | undefined;
    let canRebind = true;
    if (runtime !== "pi") {
      const defaults = await this.claudeCode.projectDefaults(ghost, conversationId);
      legacyCwd = defaults.cwd;
      canRebind = defaults.canRebind;
    }
    return this.projectBindings.read(paths.sessionDir, identity.id, runtime, conversationId, {
      ...(runtime === "pi"
        ? {
            legacyCwd: () => legacyPiSessionCwd(
              join(paths.sessionDir, sessionFileNameFor(conversationId)),
            ),
          }
        : legacyCwd ? { legacyCwd } : {}),
      canRebind,
    });
  }

  async getProject(
    ghostName: string,
    conversationId: string,
    runtime: ConversationRuntime,
  ): Promise<ProjectBindingState> {
    requireRawConversationId(conversationId);
    return this.homeOperations.withLease(ghostName, () =>
      this.projectStateLeased(ghostName, runtime, conversationId)
    );
  }

  async previewProject(
    ghostName: string,
    conversationId: string,
    runtime: ConversationRuntime,
    path: string,
  ): Promise<ProjectPreview> {
    requireRawConversationId(conversationId);
    const release = this.reserveProjectTransition(ghostName, runtime, conversationId);
    try {
      // Apply the same tombstone/recovery checks as bind/reload before minting
      // a receipt, including for a qualified id not yet present in session lists.
      await this.projectState(ghostName, runtime, conversationId);
      await this.clearDraftAbandonReceipt(
        ghostPaths(this.registry.get(ghostName).dir).sessionDir,
        runtime,
        conversationId,
      );
      return await this.projectBindings.preview(runtime, conversationId, path, ghostName);
    } finally {
      release();
    }
  }

  private assertProjectTransitionIdle(
    ghostName: string,
    runtime: ConversationRuntime,
    conversationId: string,
  ): void {
    const transitionKey = deletionKeyOf(ghostName, runtime, conversationId);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's filesystem move to finish.", 409);
    }
    if (this.mcpReloadGhosts.has(ghostName)) {
      throw new GhostError("session_busy", "Wait for this ghost's MCP change to finish.", 409);
    }
    if (this.deleting.has(transitionKey)) {
      throw new GhostError("session_busy", "Wait for this conversation's deletion to finish.", 409);
    }
    if (this.projectTransitions.has(transitionKey)) {
      throw new GhostError("session_busy", "Another project change is already in progress.", 409);
    }
    // Admission is runtime-neutral until routing has been resolved. Likewise a
    // cached Pi session may be tearing down immediately before Claude starts.
    // Neither window may race a project receipt or mutation for either runtime.
    const key = this.keyOf(ghostName, conversationId);
    if (this.turnAdmissions.has(key)) {
      throw new GhostError("session_busy", "Wait for this conversation's admitted turn to finish.", 409);
    }
    if ((this.lifecycleAdmissions.get(key) ?? 0) > 0) {
      throw new GhostError("session_busy", "Wait for this conversation to finish opening or closing.", 409);
    }
    if (this.opening.has(key) || this.closing.has(key)) {
      throw new GhostError("session_busy", "Wait for this conversation to finish opening or closing.", 409);
    }
    if (runtime === "claude-code") {
      if (this.claudeCode.isBusy(ghostName, conversationId)) {
        throw new GhostError("session_busy", "Wait for this conversation to finish before changing its project.", 409);
      }
      return;
    }
    const hosted = this.sessions.get(key);
    if (hosted && (this.sessionOwned(hosted)
      || (hosted.mcpTransitions ?? 0) > 0
      || hosted.pendingMcpReload === true
      || hosted.mcp?.reload !== undefined)) {
      throw new GhostError("session_busy", "Wait for this conversation to finish before changing its project.", 409);
    }
  }

  private assertNoProjectTransition(ghostName: string, conversationId: string): void {
    if (["pi", "claude-code"].some((runtime) =>
      this.projectTransitions.has(deletionKeyOf(
        ghostName,
        runtime as ConversationRuntime,
        conversationId,
      )))) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation's project change to finish.",
        409,
      );
    }
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

  private reserveProjectTransition(
    ghostName: string,
    runtime: ConversationRuntime,
    conversationId: string,
  ): () => void {
    this.assertProjectTransitionIdle(ghostName, runtime, conversationId);
    const key = deletionKeyOf(ghostName, runtime, conversationId);
    this.projectTransitions.add(key);
    return () => this.projectTransitions.delete(key);
  }

  async bindProject(
    ghostName: string,
    conversationId: string,
    runtime: ConversationRuntime,
    input: {
      root: string | null;
      cwd?: string;
      trustToken?: string;
      expectedGeneration: number;
    },
  ): Promise<ProjectBindingState> {
    requireRawConversationId(conversationId);
    const release = this.reserveProjectTransition(ghostName, runtime, conversationId);
    try {
      const current = await this.projectState(ghostName, runtime, conversationId);
      await this.clearDraftAbandonReceipt(
        ghostPaths(this.registry.get(ghostName).dir).sessionDir,
        runtime,
        conversationId,
      );
      if (current.generation !== input.expectedGeneration) {
        throw new GhostError("stale_generation", "The project binding changed; refresh it and try again.", 409);
      }
      if (!current.canRebind) {
        throw new GhostError(
          "project_rebind_requires_new_conversation",
          "Claude Code fixes its project before the first owner turn; start a new conversation to change it.",
          409,
        );
      }
      const ghost = this.registry.get(ghostName);
      const sessionDir = ghostPaths(ghost.dir).sessionDir;
      await this.projectBindings.write({
        sessionDir,
        runtime,
        conversationId,
        current,
        root: input.root,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.trustToken === undefined ? {} : { trustToken: input.trustToken }),
        reason: input.root === null ? "unbound" : "bound",
        scope: ghostName,
      });
      if (runtime === "pi") {
        await this.cleanupCommittedProjectPiSession(ghostName, conversationId);
      }
      const next = await this.projectState(ghostName, runtime, conversationId);
      await this.announceConversationUpdated(ghostName, runtime, conversationId, "project");
      return next;
    } finally {
      release();
    }
  }

  async reloadProject(
    ghostName: string,
    conversationId: string,
    runtime: ConversationRuntime,
    expectedGeneration: number,
  ): Promise<ProjectBindingState> {
    requireRawConversationId(conversationId);
    const release = this.reserveProjectTransition(ghostName, runtime, conversationId);
    try {
    const current = await this.projectState(ghostName, runtime, conversationId);
    if (current.generation !== expectedGeneration) {
      throw new GhostError("stale_generation", "The project binding changed; refresh it and try again.", 409);
    }
    if (!current.canRebind) {
      throw new GhostError(
        "project_rebind_requires_new_conversation",
        "Claude Code fixes its project before the first owner turn; start a new conversation to refresh it.",
        409,
      );
    }
    if (!current.root) {
      throw new GhostError("invalid_request", "An unbound conversation has no project to reload.", 400);
    }
    const sessionDir = ghostPaths(this.registry.get(ghostName).dir).sessionDir;
    await this.projectBindings.write({
      sessionDir,
      runtime,
      conversationId,
      current,
      root: current.root,
      cwd: current.cwd,
      reason: "reloaded",
      scope: ghostName,
    });
    if (runtime === "pi") {
      await this.cleanupCommittedProjectPiSession(ghostName, conversationId);
    }
    const next = await this.projectState(ghostName, runtime, conversationId);
    await this.announceConversationUpdated(ghostName, runtime, conversationId, "project");
    return next;
    } finally {
      release();
    }
  }

  async abandonProjectDraft(
    ghostName: string,
    conversationId: string,
    runtime: ConversationRuntime,
  ): Promise<{
    ok: true;
    id: string;
    conversationId: string;
    runtime: ConversationRuntime;
    abandoned: boolean;
  }> {
    requireRawConversationId(conversationId);
    const release = this.reserveProjectTransition(ghostName, runtime, conversationId);
    try {
      const ghost = this.registry.get(ghostName);
      const sessionDir = ghostPaths(ghost.dir).sessionDir;
      mkdirSync(sessionDir, { recursive: true });
      await this.recoverForkTransactions(sessionDir, ghostName);
      const key = this.keyOf(ghostName, conversationId);
      const transcript = join(sessionDir, sessionFileNameFor(conversationId));
      const claudeSidecar = claudeSessionMetadataPath(sessionDir, conversationId);
      if ((runtime === "pi" && this.sessions.has(key))
        || await transactionMarkerEntryExists(runtime === "pi" ? transcript : claudeSidecar)) {
        throw new GhostError(
          "project_draft_published",
          "A published conversation cannot be abandoned as a pre-turn draft.",
          409,
        );
      }
      if (runtime === "pi" && await transactionMarkerEntryExists(
        forkTransactionPath(sessionDir, conversationId),
      )) {
        throw new GhostError("session_busy", "This conversation is still being published.", 409);
      }
      if (await transactionMarkerEntryExists(
        deleteTransactionPath(sessionDir, runtime, conversationId),
      )) {
        throw new GhostError("session_busy", "This conversation is still being deleted.", 409);
      }

      const marker = draftAbandonTransactionPath(sessionDir, runtime, conversationId);
      const receipt = draftAbandonReceiptPath(sessionDir, runtime, conversationId);
      const markerExists = await transactionMarkerEntryExists(marker);
      if (!markerExists && await transactionMarkerEntryExists(receipt)) {
        this.projectBindings.revoke(ghostName, runtime, conversationId);
        return { ok: true, ...conversationIdentity(runtime, conversationId), abandoned: false };
      }

      let record: DraftAbandonTransactionRecord;
      if (markerExists) {
        record = await this.readDraftAbandonTransaction(
          sessionDir,
          runtime,
          conversationId,
          marker,
        );
      } else {
        const candidates = [
          projectBindingPath(sessionDir, runtime, conversationId),
          ...(runtime === "pi" ? await piProjectSnapshotPaths(sessionDir, conversationId) : []),
          ...(runtime === "pi" ? [toolCwdsPath(sessionDir, conversationId)] : []),
        ];
        const artifacts: string[] = [];
        for (const path of candidates) {
          if (await this.transactionEntryExists(path)) artifacts.push(path);
        }
        const hasPreview = this.projectBindings.hasPreview(
          ghostName,
          runtime,
          conversationId,
        );
        if (artifacts.length === 0 && !hasPreview) {
          throw new GhostError(
            "not_found",
            "This unpublished project draft does not exist.",
            404,
          );
        }
        record = {
          version: 1,
          kind: "project-draft-abandon",
          runtime,
          conversationId,
          artifacts,
        };
        await writeTransaction(marker, record);
      }
      this.projectBindings.revoke(ghostName, runtime, conversationId);
      await this.finishDraftAbandon(sessionDir, marker, receipt, record);
      await this.announceConversationUpdated(ghostName, runtime, conversationId, "project");
      return { ok: true, ...conversationIdentity(runtime, conversationId), abandoned: true };
    } finally {
      release();
    }
  }

  private async createSession(
    ghostName: string,
    sessionKey: string,
    key: string,
    homeLeaseHeld = false,
  ): Promise<HostedSession> {
    const ghost = this.registry.get(ghostName);
    const logger = this.logger.child({ ghost: ghostName, conversation: sessionKey });
    const paths = ghostPaths(ghost.dir);
    let project = await (homeLeaseHeld
      ? this.projectStateLeased(ghostName, "pi", sessionKey)
      : this.projectState(ghostName, "pi", sessionKey));
    const projectIdentity = project.root
      ? await this.projectBindings.assertTrusted(project.root)
      : null;
    const runtimeCwd = project.cwd;
    mkdirSync(paths.agentDir, { recursive: true });
    mkdirSync(paths.sessionDir, { recursive: true });

    const settings = loadGhostSettings(paths.home);
    const [sessionCharacter, machineSkills, ghostSnapshot] = await Promise.all([
      openGhostHome(paths.home).readCharacter(),
      loadMachineSkills(this.ownerHome, { paths: this.machineSkills }),
      loadProjectDeclarativeSnapshot(paths.home, { level: "user" }),
    ]);
    const projectSnapshot = project.root && projectIdentity
      ? await readPiProjectSnapshot({
          sessionDir: paths.sessionDir,
          conversationId: sessionKey,
          generation: project.generation,
          root: project.root,
          identity: projectIdentity,
        })
      : null;
    const rootSnapshots = [
      ...(machineSkills ? [machineSkills] : []),
      ghostSnapshot,
      ...(projectSnapshot ? [projectSnapshot] : []),
    ];
    const effectiveDeclarative = mergeProjectDeclarativeSnapshots(rootSnapshots);
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
      renderSharedObsidianPolicy(this.ownerHome),
      renderScheduledWorkPolicy(ghostName, this.scheduleUnitDir),
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
      piExtensionFromGhost(ghostExtension, { dynamicSections: () => planSections(planBookRef.book) }),
      ghostCompactionExtension,
    ];
    const planBookRef: { book: PlanBook } = { book: undefined as unknown as PlanBook };

    const modelRuntime = await createGhostPiRuntime({
      authPath: ghostAuthPath(paths.agentDir),
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
    const mcpResult = await connectGhostProjectMCP(
      manager,
      {
        ghostRoot: paths.home,
        secretResolver: modelRuntime.secretResolver,
        ...(project.root && projectSnapshot
          ? { project: { root: project.root, mcp: projectSnapshot.mcp } }
          : {}),
      },
      logger,
    );
    mcp = { manager, configs: mcpResult.configs, sources: mcpResult.sources };
    await this.sessionStartupProbe("mcp", modelRuntime);
    if (project.root) {
      await this.projectBindings.updateRuntimeStatus(
        paths.sessionDir,
        "pi",
        sessionKey,
        project,
        projectMcpRuntimeStatus(mcpResult.result),
      );
      project = await (homeLeaseHeld
        ? this.projectStateLeased(ghostName, "pi", sessionKey)
        : this.projectState(ghostName, "pi", sessionKey));
    }

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
    // The binding sidecar is the crash-safe authority for the cwd; the header
    // may carry an older one from before a rebind.
    sessionManager = SessionManager.open(sessionFile, paths.sessionDir, runtimeCwd);
    await this.sessionStartupProbe("session-manager", modelRuntime);
    if (!sessionFileExists) bindConversationId(sessionManager, sessionKey);

    const ask = new AskBroker();
    const jobs = new GhostJobManager({
      operations: createLocalBashOperations(),
      onSettled: (job) => this.deliverJobResult(key, job),
    });
    const hookExtensions = await loadGhostHookExtensions(paths.home);
    extensionFactories.push(...hookExtensions.factories);
    for (const error of hookExtensions.errors) {
      logger.error("extension failed to load", {
        path: error.path,
        error: error.error,
      });
    }
    const liveMcp = mcp;
    extensionFactories.push(mcpToolsExtension(liveMcp));
    const plansDir = join(paths.home, "plans", sessionFileNameFor(sessionKey).replace(/\.jsonl$/, ""));
    const plan = new PlanBook(sessionManager);
    planBookRef.book = plan;
    extensionFactories.push(createPlanModeGuard(plan));
    const chatRef = resolveChatModelRef(readGhostModels(paths.home));
    const chatModel = resolveChatModel(chatRef, modelRuntime.getAvailableSnapshot());
    if (chatRef && (chatModel?.provider !== chatRef.provider || chatModel.id !== chatRef.modelId)) {
      logger.warn("configured chat model is not available", {
        provider: chatRef.provider,
        modelId: chatRef.modelId,
      });
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: nativeCompactionSettings(this.compactionConfig, chatModel?.contextWindow),
      defaultTools: [...PI_NATIVE_TOOL_NAMES],
      enableSkillCommands: false,
    }, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd: runtimeCwd,
      agentDir: paths.agentDir,
      settingsManager,
      extensionFactories,
      // Executable discovery is empty. Trusted visible Ghost hooks were
      // already descriptor-pinned and imported as inline factories above;
      // project hooks/extensions and Ghost custom-code tools stay disabled.
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
        createBashTool({ cwd: runtimeCwd, manager: jobs, autoBackgroundMs: this.autoBackgroundMs }) as ToolDefinition,
        createJobsTool(jobs) as ToolDefinition,
        createTodoTool(plan) as ToolDefinition,
        createProposePlanTool({
          book: plan,
          broker: ask,
          plansDir,
          timeoutMs: () => this.askTimeoutSeconds * 1000,
        }) as ToolDefinition,
        createInspectImageTool({
          runtime: modelRuntime,
          cwd: runtimeCwd,
          visionModel: () => readGhostModels(paths.home)?.roles?.vision_model,
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
    const toolCwds = await readToolCwds(paths.sessionDir, sessionKey);
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
      ghost,
      sessionKey: key,
      session,
      sessionFile: session.sessionFile,
      model,
      modelRuntime,
      project,
      projectSnapshot,
      toolCwds,
      toolCwdVersion: 0,
      toolCwdPersistedVersion: 0,
      busy: false,
      lastUsedAt: this.retentionNow(),
      pendingOwnerPasses: [],
      nextOwnerTurnId: persistedPiOwnerTurnCount(sessionManager.getBranch()),
      ask,
      jobs,
      plan,
      pendingJobResults: [],
      settings,
      skills: effectiveDeclarative.skills,
      rules: effectiveDeclarative.rules,
      commands: fileCommands,
      ...(mcp ? { mcp } : {}),
    };
    // A tool catalog change on a live server re-registers the MCP extension.
    liveMcp.manager.setOnToolsChanged(() => this.refreshHostedMcpTools(hosted));
    // CollabHost receives the raw AgentSession, so a writable guest can start
    // a turn without passing through runTurn() and setting hosted.busy. The
    // terminal public agent_end is emitted only after prompt bookkeeping has
    // unwound; that is the safe boundary for deferred model/MCP ownership.
    hosted.unsubscribeOwnership = this.watchExternalTurns(hosted);
    return hosted;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        async () => createdSession?.dispose(),
        async () => mcp?.manager.disconnectAll(),
        async () => modelRuntime.close(),
      ].map(async (action) => action()));
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], "Session startup and cleanup both failed.");
      }
      throw error;
    }
  }

  /**
   * A settled job reports back into its conversation as an agent-attributed
   * follow-up. pi queues it behind a live turn and otherwise starts a turn of
   * its own, which `watchExternalTurns` settles; only a session an owner holds
   * without streaming waits, until `releaseSessionClaim` calls back here.
   */
  private deliverJobResult(key: string, job: GhostJob): void {
    const hosted = this.sessions.get(key);
    if (!hosted || hosted.sessionDisposed) return;
    if (hosted.busy && !hosted.session.isStreaming) {
      hosted.pendingJobResults.push(job);
      return;
    }
    hosted.session.sendCustomMessage({
      customType: JOB_RESULT_MESSAGE_TYPE,
      content: formatJobResult(job),
      display: true,
      details: { attribution: "agent", jobId: job.id, status: job.status, exitCode: job.exitCode ?? null },
    }, { triggerTurn: true, deliverAs: "followUp" }).catch((error) => {
      hosted.logger.warn("background job result could not be delivered", {
        session: key,
        job: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** The background jobs of one open conversation; a closed one has none. */
  listJobs(ghostName: string, sessionId?: string | null, runtime: ConversationRuntime = "pi"): GhostJobSnapshot[] {
    assertPiConversation(runtime, "Background jobs");
    this.registry.get(ghostName);
    const hosted = this.sessions.get(this.keyOf(ghostName, sessionId));
    const now = Date.now();
    return hosted ? hosted.jobs.list().map((job) => jobSnapshot(job, now)) : [];
  }

  cancelJob(
    ghostName: string,
    sessionId: string | null | undefined,
    jobId: string,
    runtime: ConversationRuntime = "pi",
  ): { outcome: CancelJobOutcome; job: GhostJobSnapshot | null } {
    assertPiConversation(runtime, "Background jobs");
    this.registry.get(ghostName);
    const hosted = this.sessions.get(this.keyOf(ghostName, sessionId));
    if (!hosted) return { outcome: "not_found", job: null };
    const outcome = hosted.jobs.cancel(jobId);
    const job = hosted.jobs.get(jobId);
    return { outcome, job: job ? jobSnapshot(job) : null };
  }

  /**
   * Settle turns that bypass `runTurn` (a writable collaboration guest or live
   * voice drive the raw AgentSession). HTTP/ask owners publish their terminal
   * frame after the same durability barrier; while one owns the session this
   * watcher stays out so two settlement loops never race one attempt.
   */
  private watchExternalTurns(hosted: HostedSession): () => void {
    const [ghostName, conversationId] = sessionKeyParts(hosted.sessionKey);
    return hosted.session.subscribe((event) => {
      this.touchSession(hosted);
      if (event.type === "agent_start") {
        hosted.runSignal = hosted.session.agent.signal;
        // Raw collaboration, voice, and job turns bypass HTTP admission; they
        // still win over a presentation-only recap.
        hosted.recap?.controller.abort();
      }
      if (event.type === "tool_execution_start") {
        this.recordToolCwd(hosted, event.toolCallId, hosted.session.sessionManager.getCwd());
      }
      if (event.type !== "agent_settled" || hosted.busy) return;
      void (async () => {
        await this.flushToolCwds(hosted);
        await this.settlePiOwnerPasses(hosted);
        await this.announceConversationUpdated(ghostName, "pi", conversationId);
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
    runtime: ConversationRuntime = "pi",
  ): PendingAsk | null {
    assertPiConversation(runtime, "Ask");
    this.registry.get(ghostName);
    return this.sessions.get(this.keyOf(ghostName, sessionId))?.ask.pending ?? null;
  }

  answerAsk(
    ghostName: string,
    sessionId: string | null | undefined,
    askId: string,
    answer: unknown,
    runtime: ConversationRuntime = "pi",
  ): void {
    assertPiConversation(runtime, "Ask");
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
    runtime: ConversationRuntime = "pi",
  ): QueuedMessages {
    assertPiConversation(runtime, "Message queues");
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
    runtime: ConversationRuntime = "pi",
  ): Promise<QueuedMessages> {
    assertPiConversation(runtime, "Message queues");
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
      await pass.finish();
      throw error;
    }
    return this.queuedMessages(ghostName, sessionId, runtime);
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
   * A busy session is not yanked mid-turn or mid-voice — the active owner
   * keeps the model it started on. It is flagged instead and rebound once that
   * owner releases the AgentSession.
   *
   * Claude Code needs no eager rebinding: runTurn reads `roles.chat_model`
   * fresh, compares it with the warm query's startup identity, and retires a
   * mismatched query before the next prompt. A stale pi session for the same
   * conversation is dropped by `closePi` on that next turn.
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
    this.claudeCode.invalidateAuthProbe();
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
            this.retireHostedSession(hosted.sessionKey, "cancelled auth refresh");
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
   * Re-read the ghost and bound-project MCP files for every open pi conversation.
   * Turns and live voice coalesce changes into one deferred reload at their
   * settle boundary; idle sessions reconnect immediately.
   */
  async reloadMcp(ghostName: string): Promise<void> {
    await this.withMcpReload(ghostName, async () => {});
  }

  async withMcpReload<T>(ghostName: string, mutation: () => Promise<T>): Promise<T> {
    this.registry.get(ghostName);
    if (this.ghostMoveReserved(ghostName)
      || this.mcpReloadGhosts.has(ghostName)
      || this.ghostHasTurnAdmission(ghostName)
      || [...this.projectTransitions].some((key) => deletionKeyGhost(key) === ghostName)
      || [...this.deleting].some((key) => deletionKeyGhost(key) === ghostName)) {
      throw new GhostError(
        "session_busy",
        "Wait for active turns or project changes to finish before reloading MCP.",
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
      || [...this.projectTransitions].some((key) => deletionKeyGhost(key) === ghostName)
      || [...this.deleting].some((key) => deletionKeyGhost(key) === ghostName)) {
      throw new GhostError(
        "session_busy",
        "Wait for active turns or project changes to finish before reconnecting MCP.",
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
      if (hosted.project.root) {
        await this.projectBindings.assertTrusted(hosted.project.root);
        if (!hosted.projectSnapshot) {
          throw new GhostError(
            "project_snapshot_missing",
            "This session has no immutable project snapshot; reopen the conversation.",
            409,
          );
        }
      }
      const connected = await connectGhostProjectMCP(
        candidate,
        {
          ghostRoot: hosted.ghost.dir,
          secretResolver: hosted.modelRuntime.secretResolver,
          ...(hosted.project.root && hosted.projectSnapshot
            ? {
                project: {
                  root: hosted.project.root,
                  mcp: hosted.projectSnapshot.mcp,
                },
              }
            : {}),
        },
        hosted.logger,
      );
      await this.replaceHostedMcpManager(hosted, candidate, connected.configs, connected.sources);
      await this.updateHostedProjectMcpStatus(hosted, connected.result);
    });
    const tracked = reload.finally(() => {
      if (mcp.reload === tracked) mcp.reload = undefined;
      hosted.mcpTransitions = Math.max(0, (hosted.mcpTransitions ?? 1) - 1);
      this.touchSession(hosted);
    });
    mcp.reload = tracked;
    return tracked;
  }

  private liveVoiceOwnsSession(hosted: HostedSession): boolean {
    return (hosted.liveVoiceTransitions ?? 0) > 0
      || this.liveVoice.status(hosted.sessionKey).active;
  }

  private sessionOwned(hosted: HostedSession, includeRecap = true): boolean {
    return hosted.busy
      || (includeRecap && hosted.recap !== undefined)
      || (hosted.rawCollaborationPrompts ?? 0) > 0
      || hosted.pendingOwnerPasses.length > 0
      || hosted.ownerPassSettlement !== undefined
      || hosted.session.isStreaming
      || hosted.session.isBashRunning
      || this.liveVoiceOwnsSession(hosted);
  }

  private maintenanceFinisher(
    identity: MaintenanceIdentity,
    admission: MaintenanceOwnerAdmission | undefined,
    release: () => void = () => admission?.release(),
  ): (turn?: SettledMaintenanceTurn) => Promise<void> {
    let finished = false;
    return async (turn) => {
      if (finished) return;
      finished = true;
      try {
        await admission?.finish(turn);
      } catch {
        if (turn) {
          throw new GhostError(
            "session_settlement_failed",
            MODEL_TURN_PERSISTENCE_ERROR,
            500,
          );
        }
        this.logger
          .child({ ghost: identity.ghostName, conversation: identity.conversationId })
          .warn("conversation maintenance cleanup was not recorded", {
            runtime: identity.runtime,
          });
      } finally {
        release();
      }
    };
  }

  private async preparePiOwnerPass(
    hosted: HostedSession,
    input: {
      kind: PiOwnerPassKind;
      ownerPrompt: string;
      signal?: AbortSignal;
      delivery?: "steer" | "followUp";
      finish?: (turn?: SettledMaintenanceTurn) => Promise<void>;
      callerOwnsFinishOnFailure?: boolean;
    },
  ): Promise<PendingPiOwnerPass> {
    const [ghostName, conversationId] = sessionKeyParts(hosted.sessionKey);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's move to finish.", 409);
    }
    const identity: MaintenanceIdentity = { ghostName, runtime: "pi", conversationId };
    let finish = input.finish;
    if (!finish) {
      const admission = this.maintenance?.admitOwnerAction(identity);
      finish = this.maintenanceFinisher(identity, admission);
      try {
        await admission?.ready;
      } catch (error) {
        await finish();
        throw error;
      }
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
      finish,
    };
    try {
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
    } catch (error) {
      if (!input.callerOwnsFinishOnFailure) await finish();
      throw error;
    }
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
  ): Promise<Extract<SessionEntry, { type: "message" }>> {
    if (!this.hooks.hasHandlers("session_stop") || pass.signal.aborted) return assistantEntry;
    const [ghostName, conversationId] = sessionKeyParts(hosted.sessionKey);
    const ghost = this.registry.get(ghostName);
    let stopHookActive = false;
    let latestAssistantEntry = assistantEntry;
    while (!pass.signal.aborted) {
      const assistant = latestAssistantEntry.message;
      if (assistant.role !== "assistant") return latestAssistantEntry;
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
      if (!additionalContext) return latestAssistantEntry;
      stopHookActive = true;
      await hosted.session.sendCustomMessage({
        customType: "session-stop-continuation",
        content: additionalContext,
        display: false,
      }, { triggerTurn: true });
      const nextAssistant = hosted.session.sessionManager.getBranch().findLast((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
      );
      if (nextAssistant?.type === "message") latestAssistantEntry = nextAssistant;
    }
    return latestAssistantEntry;
  }

  private async finishPiPersistedPass(
    hosted: HostedSession,
    pass: PendingPiOwnerPass,
    assistantEntry: Extract<SessionEntry, { type: "message" }>,
    outcome?: SettledMaintenanceTurn["outcome"],
  ): Promise<void> {
    const assistant = assistantEntry.message;
    if (assistant.role !== "assistant") {
      await pass.finish();
      return;
    }
    const createdAt = hosted.session.sessionManager.getHeader()?.timestamp;
    if (!createdAt) {
      await pass.finish();
      return;
    }
    await pass.finish({
      source: { runtime: "pi", createdAt },
      sourceRevision: { kind: "pi-leaf", value: assistantEntry.id },
      cwd: hosted.session.sessionManager.getCwd(),
      ownerPrompt: pass.ownerPrompt,
      assistantText: entryText(assistant.content),
      outcome: outcome ?? (assistant.stopReason === "error" ? "failed" : "completed"),
    });
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
          if (boundary === "superseded") {
            await pass.finish();
            continue;
          }
          let assistantEntry = boundary.assistantEntry;
          const assistant = assistantEntry.message;
          // An abort that lands while a tool runs surfaces on the follow-up
          // model call as a provider error; the run's own signal is the fact.
          const aborted = assistant.role === "assistant"
            && (assistant.stopReason === "aborted"
              || (assistant.stopReason === "error" && hosted.runSignal?.aborted === true));
          if (assistant.role !== "assistant" || aborted || pass.signal.aborted) {
            await pass.finish();
            continue;
          }
          try {
            assistantEntry = await this.emitPiSessionStop(hosted, pass, assistantEntry);
          } catch (error) {
            const latestBoundary = this.persistedPiPassBoundary(hosted, pass, new Set());
            const latestAssistant = latestBoundary && latestBoundary !== "superseded"
              ? latestBoundary.assistantEntry
              : assistantEntry;
            await this.finishPiPersistedPass(hosted, pass, latestAssistant, "failed");
            throw error;
          }
          await this.finishPiPersistedPass(hosted, pass, assistantEntry);
        }
      } finally {
        hosted.pendingOwnerPasses = hosted.pendingOwnerPasses.filter(
          (pass) => !completed.has(pass),
        );
      }
      if (!hosted.session.isStreaming && hosted.session.pendingMessageCount === 0) {
        const abandoned = hosted.pendingOwnerPasses.splice(0);
        for (const pass of abandoned) await pass.finish();
      }
    })().finally(() => {
      if (hosted.ownerPassSettlement === settling) hosted.ownerPassSettlement = undefined;
    });
    hosted.ownerPassSettlement = settling;
    return settling;
  }

  private async abandonPiOwnerPasses(hosted: HostedSession): Promise<void> {
    await hosted.ownerPassSettlement?.catch(() => {});
    const abandoned = hosted.pendingOwnerPasses.splice(0);
    for (const pass of abandoned) await pass.finish();
  }

  private deferPiSettlement(
    hosted: HostedSession,
    finish?: (turn?: SettledMaintenanceTurn) => Promise<void>,
  ): PiSettlementBarrier {
    const completed = Promise.withResolvers<PiSettlementResult>();
    let armed = true;
    const unsubscribe = hosted.session.subscribe((event) => {
      if (!armed || event.type !== "agent_settled") return;
      armed = false;
      unsubscribe();
      void (async () => {
        let result: PiSettlementResult;
        try {
          result = await this.settlePiNow(hosted, finish);
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

  private async settlePiNow(
    hosted: HostedSession,
    finish?: (turn?: SettledMaintenanceTurn) => Promise<void>,
  ): Promise<PiSettlementResult> {
    let toolCwdError: unknown;
    let settlementError: unknown;
    try {
      await this.flushToolCwds(hosted);
    } catch (error) {
      toolCwdError = error;
    }
    try {
      await this.settlePiOwnerPasses(hosted);
    } catch (error) {
      settlementError = error;
      hosted.logger.warn("Pi owner pass settlement failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.abandonPiOwnerPasses(hosted);
    }
    await finish?.();
    return {
      ...(toolCwdError === undefined ? {} : { toolCwdError }),
      ...(settlementError === undefined ? {} : { settlementError }),
    };
  }

  private piOwnerActivity(hosted: HostedSession): MaintenanceOwnerActivity | null {
    const createdAt = hosted.session.sessionManager.getHeader()?.timestamp;
    if (!createdAt) return null;
    return {
      source: { runtime: "pi", createdAt },
      cwd: hosted.project.cwd,
    };
  }

  private async recordPiOwnerActivity(
    ghostName: string,
    conversationId: string,
    hosted: HostedSession,
    activity: MaintenanceOwnerActivity | null = this.piOwnerActivity(hosted),
  ): Promise<void> {
    if (!this.maintenance) return;
    if (!activity) {
      hosted.logger.warn("conversation maintenance owner activity was not recorded", {
        runtime: "pi",
      });
      return;
    }
    try {
      await this.maintenance.recordOwnerActivity(
        { ghostName, runtime: "pi", conversationId },
        activity,
      );
    } catch {
      hosted.logger.warn("conversation maintenance owner activity was not recorded", {
        runtime: "pi",
      });
    }
  }

  private async runCollaborationPrompt(hosted: HostedSession, text: string): Promise<void> {
    while (hosted.mcpPublication) await hosted.mcpPublication;
    const ownerPrompt = text.trim();
    if (!ownerPrompt) {
      throw new GhostError("invalid_prompt", "A writable collaboration prompt cannot be empty.", 400);
    }
    const pass = await this.preparePiOwnerPass(hosted, {
      kind: "collaboration",
      ownerPrompt,
      ...(hosted.session.isStreaming ? { delivery: "steer" as const } : {}),
    });
    const settlementBarrier = this.deferPiSettlement(hosted);
    hosted.rawCollaborationPrompts = (hosted.rawCollaborationPrompts ?? 0) + 1;
    if (hosted.rawCollaborationPrompts === 1) {
      const idle = Promise.withResolvers<void>();
      hosted.rawCollaborationIdle = idle.promise;
      hosted.releaseRawCollaborationIdle = idle.resolve;
    }
    try {
      await hosted.session.sendCustomMessage({
        customType: "collaboration-prompt",
        content: ownerPrompt,
        display: true,
        details: { attribution: "user" },
      }, { triggerTurn: true, ...(hosted.session.isStreaming ? { deliverAs: "steer" as const } : {}) });
      const settlement = await settlementBarrier.settled;
      if (settlement.toolCwdError !== undefined || settlement.settlementError !== undefined) {
        throw new GhostError(
          "session_settlement_failed",
          "The collaboration turn could not be durably settled.",
          500,
        );
      }
    } catch (error) {
      if (settlementBarrier.cancel()) {
        hosted.pendingOwnerPasses = hosted.pendingOwnerPasses.filter(
          (candidate) => candidate !== pass,
        );
        await pass.finish();
      } else {
        await settlementBarrier.settled;
      }
      throw error;
    } finally {
      hosted.rawCollaborationPrompts = Math.max(
        0,
        (hosted.rawCollaborationPrompts ?? 1) - 1,
      );
      if (hosted.rawCollaborationPrompts === 0) {
        hosted.releaseRawCollaborationIdle?.();
        hosted.rawCollaborationIdle = undefined;
        hosted.releaseRawCollaborationIdle = undefined;
        this.touchSession(hosted);
        await this.settleDeferredSession(hosted);
      }
    }
  }

  private async runLiveVoicePrompt(
    hosted: HostedSession,
    message: Parameters<AgentSession["sendCustomMessage"]>[0] | string,
    options?: Parameters<AgentSession["sendCustomMessage"]>[1],
  ): Promise<void> {
    const ownerPrompt = (typeof message === "string" ? message : entryText(message.content)).trim();
    if (!ownerPrompt) return;
    const pass = await this.preparePiOwnerPass(hosted, {
      kind: "voice",
      ownerPrompt,
      ...(hosted.session.isStreaming ? { delivery: "steer" as const } : {}),
    });
    const settlementBarrier = this.deferPiSettlement(hosted);
    try {
      await hosted.session.sendCustomMessage(
        typeof message === "string"
          ? {
              customType: LIVE_DELEGATION_MESSAGE_TYPE,
              content: message,
              display: true,
              details: { attribution: "user" },
            }
          : { ...message, details: { ...(message.details as object ?? {}), attribution: "user" } },
        { triggerTurn: true, ...options },
      );
      const settlement = await settlementBarrier.settled;
      if (settlement.toolCwdError !== undefined || settlement.settlementError !== undefined) {
        throw new GhostError(
          "session_settlement_failed",
          "The live voice turn could not be durably settled.",
          500,
        );
      }
    } catch (error) {
      if (settlementBarrier.cancel()) {
        hosted.pendingOwnerPasses = hosted.pendingOwnerPasses.filter(
          (candidate) => candidate !== pass,
        );
        await pass.finish();
      } else {
        await settlementBarrier.settled;
      }
      throw error;
    }
  }

  private async publishMcpCandidate<T>(
    hosted: HostedSession,
    publish: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      if ((hosted.rawCollaborationPrompts ?? 0) > 0) {
        const idle = hosted.rawCollaborationIdle;
        if (idle) await idle;
        continue;
      }
      if (hosted.mcpPublication) {
        await hosted.mcpPublication;
        continue;
      }
      break;
    }
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
      hosted.logger.warn("ghost project MCP tool refresh failed", {
        code: "mcp_tool_load_failed",
      });
    });
    return run;
  }

  private async updateHostedProjectMcpStatus(
    hosted: HostedSession,
    result: ProjectMcpConnectionResult,
  ): Promise<void> {
    if (!hosted.project.root) return;
    const conversationId = sessionKeyParts(hosted.sessionKey)[1];
    const changed = await this.projectBindings.updateRuntimeStatus(
      ghostPaths(hosted.ghost.dir).sessionDir,
      "pi",
      conversationId,
      hosted.project,
      projectMcpRuntimeStatus(result),
    );
    if (!changed) return;
    hosted.project = await this.projectState(hosted.ghost.name, "pi", conversationId);
    await this.announceConversationUpdated(
      hosted.ghost.name,
      "pi",
      conversationId,
      "project",
    );
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
        hosted.logger.warn("previous project MCP manager did not close cleanly", {
          code: "mcp_connection_failed",
        });
      });
    });
  }

  private reconnectHostedMcp(hosted: HostedSession, serverName: string): Promise<void> {
    const mcp = hosted.mcp;
    if (!mcp?.configs.has(serverName)) return Promise.resolve();
    const reconnectsProject = mcp.sources.get(serverName)?.level === "project";
    hosted.mcpTransitions = (hosted.mcpTransitions ?? 0) + 1;
    const reconnect = (mcp.reload ?? Promise.resolve()).then(async () => {
      const candidate = this.createHostedMcpCandidate(hosted);
      const configs = new Map(mcp.configs);
      const sources = new Map(mcp.sources);
      let published = false;
      try {
        const result = await candidate.connectServers(Object.fromEntries(configs));
        const summary = summarizeProjectMcpConnection(
          sources,
          result.errors,
          hosted.projectSnapshot
            ? rejectedProjectMcpCount(hosted.projectSnapshot.mcp)
            : 0,
        );
        await this.replaceHostedMcpManager(hosted, candidate, configs, sources);
        published = true;
        if (reconnectsProject) await this.updateHostedProjectMcpStatus(hosted, summary);
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

  private recordToolCwd(hosted: HostedSession, toolCallId: string, cwd: string): void {
    const absolute = resolve(cwd);
    hosted.toolCwds.delete(toolCallId);
    hosted.toolCwds.set(toolCallId, absolute);
    hosted.toolCwdVersion += 1;
    this.startToolCwdWrite(hosted, toolCallId);
  }

  private startToolCwdWrite(hosted: HostedSession, toolCallId: string): Promise<void> {
    if (hosted.toolCwdWrite) return hosted.toolCwdWrite;
    const sessionDir = ghostPaths(hosted.ghost.dir).sessionDir;
    let write!: Promise<void>;
    write = (async () => {
      try {
        while (hosted.toolCwdPersistedVersion < hosted.toolCwdVersion) {
          const targetVersion = hosted.toolCwdVersion;
          const snapshot = new Map(hosted.toolCwds);
          const persisted = await this.toolCwdWriter(
            sessionDir,
            sessionKeyParts(hosted.sessionKey)[1],
            snapshot,
          );
          hosted.toolCwdPersistedVersion = targetVersion;
          if (hosted.toolCwdVersion === targetVersion) {
            hosted.toolCwds = new Map(persisted);
          }
        }
      } finally {
        if (hosted.toolCwdWrite === write) hosted.toolCwdWrite = undefined;
      }
    })();
    hosted.toolCwdWrite = write;
    void write.catch((error) => {
      hosted.logger.warn("could not persist a tool working directory", {
        toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return write;
  }

  private async flushToolCwds(hosted: HostedSession): Promise<void> {
    let failures = 0;
    while (hosted.toolCwdPersistedVersion < hosted.toolCwdVersion) {
      try {
        await (hosted.toolCwdWrite ?? this.startToolCwdWrite(hosted, "flush"));
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= 3) throw error;
      }
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
      for (const job of hosted.pendingJobResults.splice(0)) this.deliverJobResult(hosted.sessionKey, job);
    }
  }

  /** Cancel presentation-only recap work and drain deferred session changes. */
  private async cancelRecap(key: string): Promise<void> {
    const hosted = this.sessions.get(key);
    const recap = hosted?.recap;
    if (!hosted || !recap) return;
    recap.controller.abort();
    await recap.task.catch(() => {});
    await this.settleDeferredSession(hosted);
  }

  private async settleLiveVoiceSession(key: string): Promise<void> {
    if (this.disposed) return;
    const hosted = this.sessions.get(key);
    if (hosted) await this.settleDeferredSession(hosted);
  }

  /**
   * Drain model/MCP changes after an owner that bypassed SessionHost settles.
   * One promise per hosted session prevents voice and agent_end boundaries from
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
    settleBeforeRelease?: (hosted: HostedSession) => Promise<void>,
  ): Promise<void> {
    const conversationId = options.sessionId ?? DEFAULT_SESSION_KEY;
    if (this.claudeCode.isBusy(ghostName, conversationId)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }

    const hosted = await this.idleHostedSession(
      ghostName,
      options.sessionId,
      "This ghost is already working in this conversation.",
      true,
    );
    const id = `bash-${randomUUID()}`;
    const executionCwd = resolve(hosted.session.sessionManager.getCwd());
    let prevalidatedCd: string | null = null;
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
      if (hosted.project.root && isPersistentShellCdCommand(command.command)) {
        const target = persistentCdTarget(command.command, executionCwd, this.ownerHome);
        if (!target) {
          throw new GhostError(
            "cwd_outside_project",
            "This cd form cannot be authorized inside a bound project; choose an explicit path.",
            409,
          );
        }
        prevalidatedCd = await this.projectBindings.resolveOperationalCwd(hosted.project, target);
      }
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
        const target = prevalidatedCd
          ?? persistentCdTarget(command.command, executionCwd, this.ownerHome);
        const nextCwd = target ? resolve(target) : null;
        if (nextCwd && nextCwd !== resolve(hosted.session.sessionManager.getCwd())) {
          const sessionDir = ghostPaths(hosted.ghost.dir).sessionDir;
          await this.projectBindings.writeOperationalCwd(
            sessionDir,
            "pi",
            conversationId,
            hosted.project,
            nextCwd,
          );
          hosted.project = await this.projectState(ghostName, "pi", conversationId);
          await this.announceConversationUpdated(ghostName, "pi", conversationId, "project");
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
        await settleBeforeRelease?.(hosted);
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
        jobs: hosted.jobs,
        plan: hosted.plan,
        cwd: hosted.session.sessionManager.getCwd(),
        projectRoot: hosted.project.root,
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
   * Resolve the selected chat runtime once, before any command dispatch or
   * runtime state is opened. Malformed routing retains the default fallback.
   */
  private selectedTurnRuntime(ghostName: string): ConfiguredTurnRuntime {
    const ghost = this.registry.get(ghostName);
    let configured: ReturnType<typeof resolveChatModelRef>;
    try {
      configured = resolveChatModelRef(readGhostModels(ghostPaths(ghost.dir).home));
    } catch (error) {
      this.logger.error("models.json is unusable", {
        ghost: ghostName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { runtime: "pi" };
    }
    if (configured?.provider === CLAUDE_CODE_PROVIDER_ID) {
      if (configured.modelId !== CLAUDE_CODE_DEFAULT_MODEL_ID) {
        throw new GhostError(
          "unknown_model",
          `Claude Code has no runtime entry ${JSON.stringify(configured.modelId)}.`,
          409,
        );
      }
      return { runtime: "claude-code", modelId: configured.modelId };
    }
    return { runtime: "pi" };
  }

  /**
   * A raw resume id may exist in both runtimes, but a trusted project binding
   * must never cross that qualification boundary implicitly. Reading these
   * sidecars creates nothing and validates any binding before admission.
   */
  private async assertProjectRuntimeMatches(
    ghostName: string,
    conversationId: string,
    selectedRuntime: ConversationRuntime,
  ): Promise<void> {
    const sessionDir = ghostPaths(this.registry.get(ghostName).dir).sessionDir;
    const selectedIdentity = conversationIdentity(selectedRuntime, conversationId);
    const selected = await this.projectBindings.read(
      sessionDir,
      selectedIdentity.id,
      selectedRuntime,
      conversationId,
    );
    if (selected.root !== null) return;

    const oppositeRuntime: ConversationRuntime = selectedRuntime === "pi"
      ? "claude-code"
      : "pi";
    const oppositeIdentity = conversationIdentity(oppositeRuntime, conversationId);
    const opposite = await this.projectBindings.read(
      sessionDir,
      oppositeIdentity.id,
      oppositeRuntime,
      conversationId,
    );
    if (opposite.root === null) return;
    throw new GhostError(
      "project_runtime_mismatch",
      `This conversation is project-bound for ${oppositeRuntime}; unbind it or start a new conversation before using ${selectedRuntime}.`,
      409,
    );
  }

  private async admitClaudeProject(
    ghostName: string,
    conversationId: string,
  ): Promise<ClaudeProjectSnapshot> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const project = await this.projectState(ghostName, "claude-code", conversationId);
    const projectIdentity = project.root
      ? await this.projectBindings.assertTrusted(project.root)
      : undefined;
    const reference = {
      root: project.root,
      cwd: project.cwd,
      ...(projectIdentity ? { identity: projectIdentity } : {}),
    };
    const admittedSnapshot = await this.claudeCode.admitProjectSnapshot(
      ghost,
      conversationId,
      reference,
    );
    return {
      ...reference,
      ...(admittedSnapshot ? { admittedSnapshot } : {}),
      ...(project.root
        ? {
            reportStatus: async (status: {
              status: "ready" | "degraded";
              error: { code: string; message: string } | null;
              mcpStatus: "off" | "ready" | "degraded";
            }) => {
              const changed = await this.projectBindings.updateRuntimeStatus(
                paths.sessionDir,
                "claude-code",
                conversationId,
                project,
                status,
              );
              if (changed) {
                await this.announceConversationUpdated(
                  ghostName,
                  "claude-code",
                  conversationId,
                  "project",
                );
              }
            },
          }
        : {}),
    };
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
    this.assertNoProjectTransition(ghostName, conversationId);
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
    let maintenanceAdmission: MaintenanceOwnerAdmission | undefined;
    let maintenanceReleased = false;
    const releaseMaintenance = () => {
      if (maintenanceReleased) return;
      maintenanceReleased = true;
      maintenanceAdmission?.release();
    };
    const release = () => {
      if (released) return;
      released = true;
      releaseMaintenance();
      this.turnAdmissions.delete(admissionKey);
    };
    try {
      // Reserve first so another owner cannot slip in while recap cancellation
      // drains; owner work then wins this presentation-only boundary.
      await this.cancelRecap(admissionKey);
      const configured = this.selectedTurnRuntime(ghostName);
      await this.assertProjectRuntimeMatches(ghostName, conversationId, configured.runtime);
      const bashCommand = parseUserBashCommand(options.prompt);
      if (bashCommand && configured.runtime === "claude-code") {
        throw new GhostError(
          "not_supported",
          "Direct ! and !! commands are unavailable while this ghost uses Claude Code.",
          409,
        );
      }
      if (bashCommand && !bashCommand.command) {
        throw new GhostError("invalid_request", "Write a command after ! or !!.", 400);
      }
      const selected: SelectedTurnRuntime = configured.runtime === "claude-code"
        ? {
            ...configured,
            project: await this.admitClaudeProject(ghostName, conversationId),
          }
        : configured;
      maintenanceAdmission = this.maintenance?.admitOwnerAction({
        ghostName,
        runtime: selected.runtime,
        conversationId,
      });
      await maintenanceAdmission?.ready;
      return {
        run: async (streamOptions: AdmittedTurnOptions) => {
          if (started || released) {
            throw new GhostError("session_busy", "This turn admission is no longer available.", 409);
          }
          started = true;
          const finishMaintenance = this.maintenanceFinisher(
            { ghostName, runtime: selected.runtime, conversationId },
            maintenanceAdmission,
            releaseMaintenance,
          );
          try {
            await this.runAdmittedTurn(ghostName, {
              sessionId: conversationId,
              prompt: options.prompt,
              ...streamOptions,
            }, selected, finishMaintenance);
          } finally {
            await finishMaintenance();
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
    selected: SelectedTurnRuntime,
    finishMaintenance: (turn?: SettledMaintenanceTurn) => Promise<void>,
  ): Promise<void> {
    const conversationId = requireRawConversationId(options.sessionId ?? DEFAULT_SESSION_KEY);
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const key = this.keyOf(ghostName, conversationId);
    const liveHosted = this.sessions.get(key);
    if (this.liveVoice.status(key).active || (liveHosted?.liveVoiceTransitions ?? 0) > 0) {
      throw new GhostError(
        "session_busy",
        "Stop live voice before sending a separate turn in this conversation.",
        409,
      );
    }
    const bashCommand = parseUserBashCommand(options.prompt);
    if (bashCommand) {
      if (this.projectTransitions.has(deletionKeyOf(ghostName, "pi", conversationId))) {
        throw new GhostError("session_busy", "Wait for this conversation's project change to finish.", 409);
      }
      await this.runUserBash(ghostName, bashCommand, options, async (hosted) => {
        await this.recordPiOwnerActivity(ghostName, conversationId, hosted);
        await finishMaintenance();
      });
      // pi binds a session's cwd when it opens; a `!cd` takes effect by
      // reopening the conversation at its new operational cwd.
      const moved = this.sessions.get(key);
      if (moved && resolve(moved.project.cwd) !== resolve(moved.session.sessionManager.getCwd())) {
        await this.closePi(ghostName, conversationId);
      }
      await this.announceConversationUpdated(
        ghostName,
        "pi",
        options.sessionId ?? DEFAULT_SESSION_KEY,
      );
      return;
    }
    if (selected.runtime === "claude-code") {
      if (this.projectTransitions.has(deletionKeyOf(ghostName, "claude-code", conversationId))) {
        throw new GhostError("session_busy", "Wait for this conversation's project change to finish.", 409);
      }
      // A model switch must not leave a stale pi AgentSession owning this
      // conversation. Claude owns a separate warm query whose startup identity
      // is checked inside runTurn before it accepts the next prompt.
      const piSession = this.sessions.get(key);
      if (piSession && this.sessionOwned(piSession)) {
        throw new GhostError(
          "session_busy",
          "This ghost is already answering in this conversation.",
          409,
        );
      }
      await this.closePi(ghostName, options.sessionId);
      if (this.deleting.has(deletionKeyOf(ghostName, "claude-code", conversationId))) {
        throw new GhostError(
          "session_busy",
          "Wait for this conversation to finish deleting before opening it.",
          409,
        );
      }
      await this.claudeCode.runTurn(
        ghost,
        conversationId,
        selected.modelId,
        options,
        selected.project,
        finishMaintenance,
      );
      await this.announceConversationUpdated(ghostName, "claude-code", conversationId, "project");
      return;
    }

    if (this.liveVoice.status(key).active) {
      throw new GhostError(
        "session_busy",
        "Stop live voice before sending a separate chat turn in this conversation.",
        409,
      );
    }
    if (this.projectTransitions.has(deletionKeyOf(ghostName, "pi", conversationId))) {
      throw new GhostError("session_busy", "Wait for this conversation's project change to finish.", 409);
    }
    if (this.claudeCode.isBusy(ghostName, conversationId)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }

    const hosted = await this.idleHostedSession(
      ghostName,
      options.sessionId,
      "This ghost is already answering in this conversation.",
      true,
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
        await this.recordPiOwnerActivity(ghostName, conversationId, hosted);
        await finishMaintenance();
        if (pendingTerminal) options.emit(pendingTerminal);
      } finally {
        await finishMaintenance();
        await this.releaseSessionClaim(hosted, ghostName);
      }
      await this.announceConversationUpdated(ghostName, "pi", conversationId);
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
    const emitAfterToolCwdDurability = (event: PiMessagesEvent) => {
      if (event.type === "done" || event.type === "error") pendingTerminal = event;
      else options.emit(event);
    };
    const adapter = createPiMessagesAdapter(emitAfterToolCwdDurability, {
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
        finish: finishMaintenance,
      });
      settlementBarrier = this.deferPiSettlement(hosted, finishMaintenance);
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
          ? await this.settlePiNow(hosted, finishMaintenance)
          : await settlementBarrier.settled
        : await this.settlePiNow(hosted, finishMaintenance);
      if (settlement.toolCwdError !== undefined) {
        pendingTerminal = {
          type: "error",
          reason: "error",
          usage: adapter.totalUsage(),
          errorMessage: `Could not durably save tool working directories: ${
            settlement.toolCwdError instanceof Error
              ? settlement.toolCwdError.message
              : String(settlement.toolCwdError)
          }`,
        };
      } else if (settlement.settlementError !== undefined) {
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
      await finishMaintenance();
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
      await this.announceConversationUpdated(ghostName, "pi", conversationId);
    }
  }

  /** Generate one transient recap without adding either message to the transcript. */
  async recap(
    ghostName: string,
    conversationId: string | null | undefined,
    runtime: ConversationRuntime = "pi",
    signal?: AbortSignal,
  ): Promise<string | null> {
    assertPiConversation(runtime, "Conversation recap");
    const ghost = this.assertPiRuntime(ghostName, "Conversation recap");
    const id = requireRawConversationId(conversationId ?? DEFAULT_SESSION_KEY);
    const key = this.keyOf(ghostName, id);
    const paths = ghostPaths(ghost.dir);
    const sessionFile = join(paths.sessionDir, sessionFileNameFor(id));

    // `open` creates a transcript. A recap is only a view over existing
    // history, so an unknown id stays unknown instead of creating an empty row.
    if (!existsSync(sessionFile) && !this.sessions.has(key) && !this.opening.has(key)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(id)}.`,
        404,
      );
    }
    if (this.turnAdmissions.has(key)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before generating a recap.",
        409,
      );
    }
    if (signal?.aborted) return null;

    const hosted = await this.idleHostedSession(
      ghostName,
      id,
      "Wait for this conversation to finish before generating a recap.",
    );
    this.assertPiRuntime(ghostName, "Conversation recap");
    if (this.turnAdmissions.has(key)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before generating a recap.",
        409,
      );
    }

    const branchMessages = hosted.session.sessionManager.buildSessionContext().messages;
    if (branchMessages.length === 0 || signal?.aborted) return null;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);

    let tracked!: Promise<string | null>;
    const generation = Promise.resolve().then(async () => {
      const model = hosted.session.model;
      if (!model) throw new Error("This conversation has no chat model bound for a recap.");
      const response = await hosted.modelRuntime.complete(model, {
        systemPrompt: hosted.session.systemPrompt,
        messages: [
          ...convertToLlm(branchMessages),
          {
            role: "user",
            content: buildRecapPrompt(hosted.session.sessionName),
            timestamp: Date.now(),
          },
        ],
      }, { signal: controller.signal });
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `Recap generation ${response.stopReason}.`);
      }
      const recap = normalizeRecap(assistantText(response));
      if (!recap) throw new Error("The chat model returned no usable recap text.");
      return recap;
    });
    tracked = generation.catch((error: unknown) => {
      if (!controller.signal.aborted) {
        hosted.logger.warn("conversation recap generation failed", {
          session: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      if (hosted.recap?.task === tracked) hosted.recap = undefined;
      this.touchSession(hosted);
    });
    hosted.recap = { controller, task: tracked };
    const recap = await tracked;
    await this.settleDeferredSession(hosted);
    return recap;
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
      session: hosted.session,
      runtime: hosted.modelRuntime,
      ghostName,
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
        await this.announceConversationUpdated(ghostName, "pi", conversationId);
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
      this.extensionOptions.documents,
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
      memoryLines: digest.memoryLines,
      documents: digest.documents,
      localTime: localTimeString(),
      daysSinceLastConversation,
      onboarding,
    };
  }

  private async defaultGreeting(input: {
    ghost: Ghost;
    context: GreetingContextInput;
  }): Promise<string | null> {
    const configDir = ghostPaths(input.ghost.dir).home;
    let ref: GhostModelRoleBinding | null = null;
    try {
      ref = resolveSmolModelRef(readGhostModels(configDir));
    } catch {
      // A broken models.json is not fatal to greeting: fall back to cheapest usable.
      ref = null;
    }
    return this.withGreetingRuntime(input.ghost, (runtime) =>
      generateGreeting({ runtime, context: input.context, ref }));
  }

  /**
   * A runtime to `complete()` on, outside any session.
   *
   * A live conversation already has one bound to this ghost's credentials, so
   * reuse it rather than opening a second keyring/metadata handle for one throwaway
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
      authPath: ghostAuthPath(paths.agentDir),
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
   * each group — pi transcripts plus Claude Code resume sidecars, in one
   * shape.
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
    const pinned = pinState.version === 1
      ? expandLegacyPins(pinState.pinned, rows)
      : new Set(pinState.pinned);
    const reads = readState.version === 1
      ? expandLegacyReads(readState.reads, rows)
      : readState.reads;
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
    runtime: ConversationRuntime = "pi",
  ): Promise<void> {
    return this.homeOperations.withLease(ghostName, () =>
      this.setPinnedLeased(ghostName, sessionId, pinned, runtime)
    );
  }

  private async setPinnedLeased(
    ghostName: string,
    sessionId: string | null | undefined,
    pinned: boolean,
    runtime: ConversationRuntime,
  ): Promise<void> {
    const ghost = this.registry.get(ghostName);
    const conversationId = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(runtime, conversationId);
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
    const stored = state.version === 1
      ? expandLegacyPins(state.pinned, rows)
      : new Set(state.pinned);
    stored.delete(identity.id);
    const kept = [...stored].filter((pin) => existing.has(pin));
    await this.pinWriter(paths.sessionDir, pinned ? [...kept, identity.id] : kept);
    await this.announceConversationUpdated(ghostName, runtime, conversationId);
  }

  /**
   * Record that the owner opened one stored conversation. Rewriting the whole
   * validated map also prunes ids whose conversations disappeared elsewhere.
   */
  async markRead(
    ghostName: string,
    sessionId: string | null | undefined,
    openedAt = new Date(),
    runtime: ConversationRuntime = "pi",
  ): Promise<string> {
    return this.homeOperations.withLease(ghostName, () =>
      this.markReadLeased(ghostName, sessionId, openedAt, runtime)
    );
  }

  private async markReadLeased(
    ghostName: string,
    sessionId: string | null | undefined,
    openedAt: Date,
    runtime: ConversationRuntime,
  ): Promise<string> {
    const ghost = this.registry.get(ghostName);
    const conversationId = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(runtime, conversationId);
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
    const reads = state.version === 1
      ? expandLegacyReads(state.reads, rows)
      : state.reads;
    const kept = Object.fromEntries(
      Object.entries(reads).filter(([id]) => existing.has(id)),
    );
    const readAt = openedAt.toISOString();
    await this.readWriter(paths.sessionDir, { ...kept, [identity.id]: readAt });
    await this.announceConversationUpdated(ghostName, runtime, conversationId);
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
    runtime: ConversationRuntime = "pi",
  ): Promise<string> {
    assertPiConversation(runtime, "Conversation renaming");
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
      // Claude Code owns its own conversation's name; Ghost only mirrors the
      // runtime label into the listing and has nothing to write to.
      if (existsSync(claudeSessionMetadataPath(paths.sessionDir, id))) {
        throw new GhostError(
          "not_supported",
          "A Claude Code conversation cannot be renamed from Ghost.",
          409,
        );
      }
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
    const project = hosted?.project ?? await this.projectStateLeased(ghostName, "pi", id);
    const manager = hosted?.session.sessionManager ?? SessionManager.open(
      sessionFile,
      paths.sessionDir,
      project.cwd,
    );
    try {
      const stored = this.applySessionName(hosted?.session, manager, title);
      (hosted?.logger ?? this.logger.child({ ghost: ghostName, conversation: id })).info("renamed ghost conversation", {
        session: id,
        title: stored,
      });
      await this.announceConversationUpdated(ghostName, "pi", id);
      return stored;
    } finally {
      // A manager opened for this write alone is dropped here; the live
      // session keeps its own, and the next turn re-opens an idle conversation.
    }
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

  private async transactionEntryExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
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
        || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
        throw invalidMarker();
      }
      if (value.version === 1) return emptyDeleteTransaction(runtime, conversationId);
      if (!Array.isArray(value.artifacts)) {
        throw invalidMarker();
      }
      const artifacts: TrashedConversationArtifact[] = [];
      const parseArtifact = (row: unknown): TrashedConversationArtifact | null => {
        if (!row || typeof row !== "object") {
          return null;
        }
        const artifact = (row as Record<string, unknown>).artifact;
        const source = (row as Record<string, unknown>).source;
        const trash = (row as Record<string, unknown>).trash;
        const kind = (row as Record<string, unknown>).kind;
        if (typeof artifact !== "string"
          || !DELETE_ARTIFACT_KINDS.has(artifact as TrashedConversationArtifact["artifact"])
          || typeof source !== "string" || !isAbsolute(source)
          || typeof trash !== "string" || !isAbsolute(trash)
          || (kind !== "freedesktop" && kind !== "fallback")) {
          return null;
        }
        return {
          artifact: artifact as TrashedConversationArtifact["artifact"],
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
      const current = value.version === 3;
      const trashRoot = current ? value.trashRoot : null;
      const pending = current && value.pending !== null
        ? parseArtifact(value.pending)
        : null;
      if ((current && value.pending !== null && !pending)
        || (current && trashRoot !== null
          && (typeof trashRoot !== "string" || !exactDeleteTrashRoot(ghostDir, trashRoot)))
        || (current && pending && typeof trashRoot !== "string")
        || (current && pending && (pending.kind !== "fallback"
          || !exactDeleteTrashChild(trashRoot as string, pending, artifacts.length + 1)))) {
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
        if (!exactDeleteStaticSource(ghostDir, runtime, conversationId, artifact)) {
          throw invalidMarker();
        }
      }
      for (const artifact of artifacts) {
        if (await this.transactionEntryExists(artifact.source)
          || !(await this.transactionEntryExists(artifact.trash))) {
          throw invalidMarker();
        }
      }
      if (value.version === 2) {
        return {
          version: 3,
          kind: "delete",
          runtime,
          conversationId,
          artifacts,
          trashRoot: null,
          pending: null,
        };
      }
      return {
        version: 3,
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
        await writeTransaction(marker, record);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Deletion marker removal was not durable and its live marker could not be restored.",
        );
      }
      throw error;
    }
  }

  private async clearDraftAbandonReceipt(
    sessionDir: string,
    runtime: ConversationRuntime,
    conversationId: string,
  ): Promise<void> {
    try {
      await unlink(draftAbandonReceiptPath(sessionDir, runtime, conversationId));
      await fsyncDirectory(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async readDraftAbandonTransaction(
    sessionDir: string,
    runtime: ConversationRuntime,
    conversationId: string,
    marker: string,
  ): Promise<DraftAbandonTransactionRecord> {
    let value: unknown;
    try {
      value = JSON.parse(await readDaemonControlFile(marker, TRANSACTION_MARKER_MAX_BYTES));
    } catch {
      throw new GhostError(
        "project_draft_cleanup_pending",
        "This unpublished draft has an unreadable cleanup transaction.",
        500,
      );
    }
    const row = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const artifacts = row?.artifacts;
    const binding = projectBindingPath(sessionDir, runtime, conversationId);
    const toolCwds = toolCwdsPath(sessionDir, conversationId);
    const snapshotPrefix = `${conversationTransactionStem(conversationId)}.pi.project-snapshot.`;
    const allowed = (path: string): boolean => path === binding
      || (runtime === "pi" && path === toolCwds)
      || (runtime === "pi" && pathIsWithin(sessionDir, path)
        && basename(path).startsWith(snapshotPrefix)
        && /^\d+\.json$/u.test(basename(path).slice(snapshotPrefix.length)));
    if (row?.version !== 1 || row.kind !== "project-draft-abandon"
      || row.runtime !== runtime || row.conversationId !== conversationId
      || !Array.isArray(artifacts)
      || !artifacts.every((path): path is string =>
        typeof path === "string" && isAbsolute(path) && allowed(path))
      || new Set(artifacts).size !== artifacts.length) {
      throw new GhostError(
        "project_draft_cleanup_pending",
        "This unpublished draft has an invalid cleanup transaction.",
        500,
      );
    }
    return {
      version: 1,
      kind: "project-draft-abandon",
      runtime,
      conversationId,
      artifacts,
    };
  }

  private async finishDraftAbandon(
    sessionDir: string,
    marker: string,
    receipt: string,
    record: DraftAbandonTransactionRecord,
  ): Promise<void> {
    for (const path of record.artifacts) {
      await this.transactionProbe("draft-abandon-unlink", path);
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const path of record.artifacts) {
      if (await this.transactionEntryExists(path)) {
        throw new Error(`Draft cleanup left an unpublished sidecar at ${path}.`);
      }
    }
    await this.transactionProbe("draft-abandon-fsync", sessionDir);
    await fsyncDirectory(sessionDir);
    await this.transactionProbe("draft-abandon-complete", receipt);
    await writeTransaction(receipt, {
      version: 1,
      kind: "project-draft-abandoned",
      runtime: record.runtime,
      conversationId: record.conversationId,
    });
    await unlink(marker);
    try {
      await fsyncDirectory(sessionDir);
    } catch (error) {
      try {
        await writeTransaction(marker, record);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Draft cleanup marker removal was not durable and could not be restored.",
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
    await writeTransaction(marker, record);
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
    await writeTransaction(marker, record);
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
        await writeTransaction(marker, record);
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
          tempProjectBinding?: unknown;
          tempProjectSnapshot?: unknown;
          projectSnapshotGeneration?: unknown;
          tempToolCwds?: unknown;
        };
        const legacy = value.version === 1;
        const current = value.version === 2;
        if ((!legacy && !current) || value.kind !== "fork"
          || typeof value.conversationId !== "string" || !isValidConversationId(value.conversationId)
          || typeof value.tempTranscript !== "string" || !isAbsolute(value.tempTranscript)
          || !pathIsWithin(sessionDir, value.tempTranscript)
          || typeof value.tempProjectBinding !== "string" || !isAbsolute(value.tempProjectBinding)
          || !pathIsWithin(sessionDir, value.tempProjectBinding)
          || typeof value.tempToolCwds !== "string" || !isAbsolute(value.tempToolCwds)
          || !pathIsWithin(sessionDir, value.tempToolCwds)
          || (current && value.tempProjectSnapshot !== null
            && (typeof value.tempProjectSnapshot !== "string"
              || !isAbsolute(value.tempProjectSnapshot)
              || !pathIsWithin(sessionDir, value.tempProjectSnapshot)))
          || (current && value.projectSnapshotGeneration !== null
            && (typeof value.projectSnapshotGeneration !== "number"
              || !Number.isSafeInteger(value.projectSnapshotGeneration)
              || value.projectSnapshotGeneration < 0))
          || (current && ((value.tempProjectSnapshot === null)
            !== (value.projectSnapshotGeneration === null)))
          || marker !== forkTransactionPath(sessionDir, value.conversationId)) {
          throw new Error("invalid fork transaction marker");
        }
        const record: ForkTransactionRecord = {
          version: current ? 2 : 1,
          kind: "fork",
          conversationId: value.conversationId,
          tempTranscript: value.tempTranscript,
          tempProjectBinding: value.tempProjectBinding,
          tempProjectSnapshot: current && typeof value.tempProjectSnapshot === "string"
            ? value.tempProjectSnapshot
            : null,
          projectSnapshotGeneration: current
            && typeof value.projectSnapshotGeneration === "number"
            ? value.projectSnapshotGeneration
            : null,
          tempToolCwds: value.tempToolCwds,
        };
        const transcript = join(sessionDir, sessionFileNameFor(record.conversationId));
        const binding = projectBindingPath(sessionDir, "pi", record.conversationId);
        const toolCwds = toolCwdsPath(sessionDir, record.conversationId);
        const projectSnapshot = current && typeof value.projectSnapshotGeneration === "number"
          ? piProjectSnapshotPath(sessionDir, record.conversationId, value.projectSnapshotGeneration)
          : null;
        const pairs = [
          ...(record.tempProjectSnapshot && projectSnapshot
            ? [[record.tempProjectSnapshot, projectSnapshot] as const]
            : []),
          [record.tempProjectBinding, binding],
          [record.tempToolCwds, toolCwds],
          [record.tempTranscript, transcript],
        ] as const;
        if (!exactForkTemporaryPath(sessionDir, record.tempTranscript, transcript, true)
          || !exactForkTemporaryPath(
            sessionDir,
            record.tempProjectBinding,
            binding,
            false,
          )
          || !exactForkTemporaryPath(sessionDir, record.tempToolCwds, toolCwds, false)
          || (record.tempProjectSnapshot !== null
            && projectSnapshot !== null
            && !exactForkTemporaryPath(
              sessionDir,
              record.tempProjectSnapshot,
              projectSnapshot,
              false,
            ))
          || pairs.some(([temporary, final]) => temporary === final)
          || new Set(pairs.flat()).size
            !== pairs.length * 2) {
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
          record.tempTranscript,
          record.tempProjectBinding,
          ...(record.tempProjectSnapshot ? [record.tempProjectSnapshot] : []),
          record.tempToolCwds,
          transcript,
          binding,
          ...(projectSnapshot ? [projectSnapshot] : []),
          toolCwds,
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
    const [sessions, claudeSessions] = await Promise.all([
      SessionManager.listAll(paths.sessionDir),
      this.claudeCode.listSessions(ghost),
    ]);
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
        ...conversationIdentity("pi", conversationId),
        title: info.name ?? null,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
      };
    }));
    const piSessions = scannedPiSessions.filter(
      (row): row is Exclude<(typeof scannedPiSessions)[number], null> => row !== null,
    );
    const rows: StoredSessionRow[] = [
      ...piSessions,
      ...claudeSessions.filter((info) => isValidConversationId(info.conversationId)).map((info) => ({
        ...conversationIdentity("claude-code", info.conversationId),
        title: "Claude Code",
        createdAt: info.created,
        updatedAt: info.modified,
        messageCount: info.messageCount,
      })),
    ];
    const visibleRows = await Promise.all(rows.map(async (row) => {
      if (await transactionMarkerEntryExists(
        deleteTransactionPath(paths.sessionDir, row.runtime, row.conversationId),
      )) return null;
      if (row.runtime === "pi" && await transactionMarkerEntryExists(
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
    runtime: ConversationRuntime = "pi",
  ): Promise<Transcript> {
    assertPiConversation(runtime, "Transcript reading");
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
    const project = hosted?.project ?? await this.projectStateLeased(ghostName, "pi", id);

    const manager = SessionManager.open(path, paths.sessionDir, project.cwd);
    const toolCwds = await readToolCwds(paths.sessionDir, id);
    return this.transcriptFromManager(id, manager, options, toolCwds);
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
      if (entry.type !== "message") continue;
      const message = projectTranscriptMessage(entry, askBranches, failedToolCalls, toolCwds);
      if (message) all.push(message);
    }
    const total = all.length;
    const limit = clampTranscriptLimit(options.limit);
    const offset = Math.min(clampTranscriptOffset(options.offset), total);
    const messages = all.slice(offset, offset + limit);
    return {
      ...conversationIdentity("pi", id),
      title: manager.getSessionName() ?? null,
      messages,
      total,
      truncated: offset > 0 || offset + messages.length < total,
    };
  }

  private async idleHostedSession(
    ghostName: string,
    conversationId: string | null | undefined,
    busyMessage: string,
    claim = false,
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
    if (claim) hosted.busy = true;
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
    runtime: ConversationRuntime = "pi",
  ): Promise<{
    id: string;
    conversationId: string;
    runtime: "pi";
    sessionId: string;
    title: string | null;
    draft: string;
    transcript: Transcript;
  }> {
    assertPiConversation(runtime, "Conversation branching");
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
    const temporaryProjectBinding = `${projectBindingPath(paths.sessionDir, "pi", forkId)}.${randomUUID()}.pending`;
    const temporaryToolCwds = `${toolCwdsPath(paths.sessionDir, forkId)}.${randomUUID()}.pending`;
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
      true,
    );
    const forkProjectSnapshot = source.project.root
      ? piProjectSnapshotPath(paths.sessionDir, forkId, source.project.generation)
      : null;
    const temporaryProjectSnapshot = forkProjectSnapshot
      ? `${forkProjectSnapshot}.${randomUUID()}.pending`
      : null;
    const forkRecord: ForkTransactionRecord = {
      version: 2,
      kind: "fork",
      conversationId: forkId,
      tempTranscript: temporaryForkFile,
      tempProjectBinding: temporaryProjectBinding,
      tempProjectSnapshot: temporaryProjectSnapshot,
      projectSnapshotGeneration: source.project.root ? source.project.generation : null,
      tempToolCwds: temporaryToolCwds,
    };
    const forkArtifacts = [
      temporaryForkFile,
      temporaryProjectBinding,
      ...(temporaryProjectSnapshot ? [temporaryProjectSnapshot] : []),
      temporaryToolCwds,
      forkFile,
      projectBindingPath(paths.sessionDir, "pi", forkId),
      ...(forkProjectSnapshot ? [forkProjectSnapshot] : []),
      toolCwdsPath(paths.sessionDir, forkId),
    ];
    this.activeForks.add(forkMarker);
    try {
      await writeTransaction(forkMarker, forkRecord);
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
      // full `listSessions` would also read every Claude Code sidecar and the
      // pins, and wait on unrelated titles, for one `(n)`.
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
        transcript: this.transcriptFromManager(forkId, forked, {}, source.toolCwds),
      };
      const sidecars = await Promise.allSettled([
        this.projectBindings.clone(
          paths.sessionDir,
          "pi",
          forkId,
          source.project,
          temporaryProjectBinding,
          temporaryProjectSnapshot ?? undefined,
        ),
        writeToolCwds(paths.sessionDir, forkId, source.toolCwds, temporaryToolCwds),
      ]);
      const sidecarFailures = sidecars.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      const singleSidecarFailure = sidecarFailures.length === 1 ? sidecarFailures[0] : undefined;
      if (singleSidecarFailure) throw singleSidecarFailure.reason;
      if (sidecarFailures.length > 1) {
        throw new AggregateError(
          sidecarFailures.map((result) => result.reason),
          "Fork sidecars could not be staged.",
        );
      }
      const transcript = await openFile(temporaryForkFile, "r");
      try {
        await transcript.sync();
      } finally {
        await transcript.close();
      }
      if (temporaryProjectSnapshot && forkProjectSnapshot) {
        await rename(temporaryProjectSnapshot, forkProjectSnapshot);
      }
      await rename(
        temporaryProjectBinding,
        projectBindingPath(paths.sessionDir, "pi", forkId),
      );
      await rename(temporaryToolCwds, toolCwdsPath(paths.sessionDir, forkId));
      // The transcript is the publication barrier: list/open cannot see the
      // fork until both required sidecars already have their final names.
      await rename(temporaryForkFile, forkFile);
      await this.finishForkArtifactState(
        paths.sessionDir,
        forkMarker,
        forkRecord,
        [
          temporaryForkFile,
          temporaryProjectBinding,
          ...(temporaryProjectSnapshot ? [temporaryProjectSnapshot] : []),
          temporaryToolCwds,
        ],
        [
          forkFile,
          projectBindingPath(paths.sessionDir, "pi", forkId),
          ...(forkProjectSnapshot ? [forkProjectSnapshot] : []),
          toolCwdsPath(paths.sessionDir, forkId),
        ],
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
      await this.announceConversationUpdated(ghostName, "pi", forkId);
      return {
        ...conversationIdentity("pi", forkId),
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
      const forkIdentity = conversationIdentity("pi", forkId);
      const sessionFile = join(paths.sessionDir, sessionFileNameFor(forkId));
      try {
        if (existsSync(sessionFile)) {
          await requireSessionFileConversationId(sessionFile, forkId);
        }
        await unlink(sessionFile);
        await Promise.all([
          unlink(projectBindingPath(paths.sessionDir, "pi", forkId)).catch(() => {}),
          unlink(toolCwdsPath(paths.sessionDir, forkId)).catch(() => {}),
          ...(await piProjectSnapshotPaths(paths.sessionDir, forkId))
            .map((path) => unlink(path).catch(() => {})),
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const remainingIds = new Set(rowsBefore
        .filter((row) => row.id !== forkIdentity.id)
        .map((row) => row.id));
      const pinState = await readPinState(paths.sessionDir);
      const pins = pinState.version === 1
        ? expandLegacyPins(pinState.pinned, rowsBefore)
        : new Set(pinState.pinned);
      pins.delete(forkIdentity.id);
      await writePins(paths.sessionDir, [...pins].filter((pin) => remainingIds.has(pin)));
      const readState = await readReadState(paths.sessionDir);
      const reads = readState.version === 1
        ? expandLegacyReads(readState.reads, rowsBefore)
        : { ...readState.reads };
      delete reads[forkIdentity.id];
      await writeReads(paths.sessionDir, Object.fromEntries(
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
    assertPiConversation(options.runtime ?? "pi", "Ask re-answering");
    this.assertPiRuntime(ghostName, "Ask re-answering");
    const conversationId = requireRawConversationId(options.sessionId ?? DEFAULT_SESSION_KEY);
    const admissionKey = this.keyOf(ghostName, conversationId);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's move to finish.", 409);
    }
    if (this.turnAdmissions.has(admissionKey)) {
      throw new GhostError("session_busy", "This conversation already has an owner action.", 409);
    }
    this.turnAdmissions.add(admissionKey);
    const maintenanceIdentity: MaintenanceIdentity = {
      ghostName,
      runtime: "pi",
      conversationId,
    };
    const maintenanceAdmission = this.maintenance?.admitOwnerAction(maintenanceIdentity);
    const finishMaintenance = this.maintenanceFinisher(
      maintenanceIdentity,
      maintenanceAdmission,
    );
    try {
      await maintenanceAdmission?.ready;
    } catch (error) {
      await finishMaintenance();
      this.turnAdmissions.delete(admissionKey);
      throw error;
    }
    let pendingTerminal: Extract<PiMessagesEvent, { type: "done" | "error" }> | undefined;
    const emitAfterToolCwdDurability = (event: PiMessagesEvent) => {
      if (event.type === "done" || event.type === "error") pendingTerminal = event;
      else options.emit(event);
    };
    const adapter = createPiMessagesAdapter(emitAfterToolCwdDurability, {
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
        true,
      );
    } catch (error) {
      await finishMaintenance();
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
    let reanswerPass: PendingPiOwnerPass | undefined;
    let committedActivity: MaintenanceOwnerActivity | null | undefined;
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
      hosted.plan.reload();
      const previous = reopen.resultMessage;
      manager.appendMessage({
        ...previous,
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: Date.now(),
      });
      hosted.session.agent.state.messages = manager.buildSessionContext().messages;
      committedActivity = this.piOwnerActivity(hosted);
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
      reanswerPass = await this.preparePiOwnerPass(hosted, {
        kind: "reanswer",
        ownerPrompt,
        ...(options.signal ? { signal: options.signal } : {}),
        finish: finishMaintenance,
        callerOwnsFinishOnFailure: true,
      });
      manager.appendCustomMessageEntry(
        ASK_REANSWER_OWNER_MESSAGE_TYPE,
        ownerPrompt,
        false,
        { attribution: "user", askResultEntryId: options.entryId },
      );
      settlementBarrier = this.deferPiSettlement(hosted, finishMaintenance);
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
        const persistedBoundary = reanswerPass
          ? this.persistedPiPassBoundary(hosted, reanswerPass, new Set())
          : null;
        if (committedActivity !== undefined
          && (!persistedBoundary || persistedBoundary === "superseded")) {
          await this.recordPiOwnerActivity(
            ghostName,
            conversationId,
            hosted,
            committedActivity,
          );
        }
        const settlement = settlementBarrier
          ? settlementBarrier.cancel()
            ? await this.settlePiNow(hosted, finishMaintenance)
            : await settlementBarrier.settled
          : await this.settlePiNow(hosted, finishMaintenance);
        if (settlement.toolCwdError !== undefined) {
          pendingTerminal = {
            type: "error",
            reason: "error",
            usage: adapter.totalUsage(),
            errorMessage: `Could not durably save tool working directories: ${
              settlement.toolCwdError instanceof Error
                ? settlement.toolCwdError.message
                : String(settlement.toolCwdError)
            }`,
          };
        } else if (settlement.settlementError !== undefined) {
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
        await finishMaintenance();
        if (pendingTerminal) options.emit(pendingTerminal);
        await this.releaseSessionClaim(hosted, ghostName);
        await this.announceConversationUpdated(ghostName, "pi", conversationId);
      } finally {
        unsubscribe?.();
        this.turnAdmissions.delete(admissionKey);
      }
    }
  }

  /** Drop one hosted session (aborting an in-flight turn). */
  async close(ghostName: string, sessionId?: string | null): Promise<void> {
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    this.assertNoProjectTransition(ghostName, conversationId);
    const releaseAdmission = this.reserveLifecycleAdmission(ghostName, conversationId);
    try {
      await this.claudeCode.close(ghostName, conversationId);
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
    const identity = conversationIdentity(runtime, id);
    const piKey = this.keyOf(ghostName, sessionId);
    const deleteKey = deletionKeyOf(ghostName, runtime, id);
    const tombstone = deleteTransactionPath(paths.sessionDir, runtime, id);
    if (this.ghostMoveReserved(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's filesystem move to finish.", 409);
    }
    const hosted = runtime === "pi" ? this.sessions.get(piKey) : undefined;
    const runtimeBusy = runtime === "pi"
      ? this.opening.has(piKey)
        || (hosted
          ? this.sessionOwned(hosted, false) || (hosted.mcpTransitions ?? 0) > 0
          : this.liveVoice.status(piKey).active)
      : this.claudeCode.isBusy(ghostName, id);
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
    if (this.projectTransitions.has(deleteKey)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation's project change to finish before deleting it.",
        409,
      );
    }

    // Claim synchronously before the first awaited filesystem operation. MCP
    // reconnect/reload and project transitions perform the inverse check, so
    // either admission order has one winner rather than a microtask race.
    const maintenanceReservation = this.maintenance?.reserveConversationDelete({
      ghostName,
      runtime,
      conversationId: id,
    });
    let maintenanceDeleteOutcome: MaintenanceConversationDeleteOutcome = "rolled-back";
    this.deleting.add(deleteKey);
    try {
      if (runtime === "pi") await this.cancelRecap(piKey);
      await maintenanceReservation?.drained;
      const draftMarker = draftAbandonTransactionPath(paths.sessionDir, runtime, id);
      const draftState = await transactionMarkerState(
        draftMarker,
        this.transactionMarkerLstat,
      );
      if (draftState !== "absent") {
        throw new GhostError(
          "session_busy",
          "Wait for this unpublished draft to finish being abandoned.",
          409,
        );
      }
      const deleteState = await transactionMarkerState(
        tombstone,
        this.transactionMarkerLstat,
      );
      if (deleteState === "indeterminate") {
        maintenanceDeleteOutcome = "recovery-pending";
        throw new GhostError(
          "delete_recovery_pending",
          "This conversation has an invalid or unreadable deletion transaction.",
          500,
        );
      }
      const resumingDeletion = deleteState === "present";
      if (resumingDeletion) maintenanceDeleteOutcome = "recovery-pending";
      this.projectBindings.revoke(ghostName, runtime, id);
      if (!resumingDeletion) {
        mkdirSync(paths.sessionDir, { recursive: true });
        try {
          await writeTransaction(tombstone, emptyDeleteTransaction(runtime, id));
          maintenanceDeleteOutcome = "recovery-pending";
        } catch (error) {
          const published = await transactionMarkerState(
            tombstone,
            this.transactionMarkerLstat,
          ).catch(() => "indeterminate" as const);
          if (published !== "absent") maintenanceDeleteOutcome = "recovery-pending";
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

      if (runtime === "pi") await this.closePi(ghostName, sessionId);
      else await this.claudeCode.close(ghostName, id);
      const piPath = join(paths.sessionDir, sessionFileNameFor(id));
      const claudePath = claudeSessionMetadataPath(paths.sessionDir, id);
      const claudeResumeMarkers = Object.values(
        claudeSessionResumeMarkerPaths(paths.sessionDir, id),
      );
      const bindingPath = projectBindingPath(paths.sessionDir, runtime, id);
      const cwdPath = toolCwdsPath(paths.sessionDir, id);
      const maintenancePath = maintenanceStatePath(paths.sessionDir, runtime, id);
      const projectSnapshots = runtime === "pi"
        ? await piProjectSnapshotPaths(paths.sessionDir, id)
        : [];
      if (runtime === "pi" && await this.transactionEntryExists(piPath)) {
        await requireSessionFileConversationId(piPath, id);
      }
      const rowsBefore = await this.collectSessions(ghost.name);
      const candidates: Array<{
        artifact: TrashedConversationArtifact["artifact"];
        path: string;
      }> = runtime === "pi"
        ? [
            { artifact: "omp-transcript", path: piPath },
            { artifact: "tool-cwds", path: cwdPath },
            { artifact: "project-binding", path: bindingPath },
            { artifact: "maintenance-state", path: maintenancePath },
            ...projectSnapshots.map((path) => ({
              artifact: "project-snapshot" as const,
              path,
            })),
          ]
        : [
            { artifact: "claude-sidecar", path: claudePath },
            ...claudeResumeMarkers.map((path) => ({
              artifact: "claude-sidecar" as const,
              path,
            })),
            { artifact: "project-binding", path: bindingPath },
            { artifact: "maintenance-state", path: maintenancePath },
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
        await writeTransaction(tombstone, deleteRecord);
        await this.transactionProbe("delete-intent-recorded", candidate.path);
        await this.reconcileDeleteMove(tombstone, deleteRecord);
        const artifact = deleteRecord.artifacts.at(-1);
        if (!artifact) throw new Error("Deletion move completed without a durable receipt.");
        artifacts.push(artifact);
        recorded.add(candidateKey);
      }
      if (artifacts.length === 0 && !resumingDeletion) {
        await this.retireDeleteMarker(paths.sessionDir, tombstone, deleteRecord);
        maintenanceDeleteOutcome = "rolled-back";
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
      const pins = pinState.version === 1
        ? expandLegacyPins(pinState.pinned, rowsBefore)
        : new Set(pinState.pinned);
      pins.delete(identity.id);
      await writePins(paths.sessionDir, [...pins].filter((pin) => remainingIds.has(pin)));
      const readState = await readReadState(paths.sessionDir);
      const reads = readState.version === 1
        ? expandLegacyReads(readState.reads, rowsBefore)
        : { ...readState.reads };
      delete reads[identity.id];
      await writeReads(paths.sessionDir, Object.fromEntries(
        Object.entries(reads).filter(([key]) => remainingIds.has(key)),
      ));
      try {
        await unlink(draftAbandonReceiptPath(paths.sessionDir, runtime, id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      deleteRecord.artifacts = [...artifacts];
      await this.retireDeleteMarker(paths.sessionDir, tombstone, deleteRecord);
      this.maintenance?.completeConversationDelete({
        ghostName,
        runtime,
        conversationId: id,
      });
      maintenanceDeleteOutcome = "completed";
      this.logger.child({ ghost: ghostName, conversation: id }).info("trashed ghost conversation", {
        session: identity.id,
        artifacts: artifacts.map((entry) => entry.artifact),
      });
      await this.announceConversationUpdated(ghostName, runtime, id);
      return { artifacts };
    } finally {
      this.deleting.delete(deleteKey);
      if (maintenanceDeleteOutcome === "rolled-back"
        && await transactionMarkerState(tombstone, this.transactionMarkerLstat) !== "absent") {
        maintenanceDeleteOutcome = "recovery-pending";
      }
      maintenanceReservation?.release(maintenanceDeleteOutcome);
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
    let maintenanceReservation: MaintenanceDrainReservation | undefined;
    try {
      maintenanceReservation = this.maintenance?.reserveGhostMove(ghost.name);
      this.projectBindings.revokeScope(ghost.name);
      await maintenanceReservation?.drained;
      await this.quiesceGhost(ghost, "deleted");
      const trashed = this.registry.trash(ghost.name);
      this.forgetGhost(ghost.name);
      this.maintenance?.completeGhostDelete(ghost.name);
      this.logger.info("trashed ghost", { ghost: ghost.name, trash: trashed.trash });
      return trashed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
      maintenanceReservation?.release();
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
    let maintenanceReservation: MaintenanceDrainReservation | undefined;
    try {
      maintenanceReservation = this.maintenance?.reserveGhostMove(ghost.name);
      this.projectBindings.revokeScope(ghost.name);
      await maintenanceReservation?.drained;
      await this.quiesceGhost(ghost, "renamed");
      const renamed = this.registry.rename(ghost.name, nextName);
      this.forgetGhost(ghost.name);
      await this.maintenance?.completeGhostRename(ghost.name, nextName);
      this.logger.info("renamed ghost", { ghost: ghost.name, name: renamed.name });
      return renamed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
      this.reservedGhosts.delete(nextName);
      maintenanceReservation?.release();
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
    for (const [, entry] of hosted) entry.recap?.controller.abort();
    const background: Promise<unknown>[] = hosted
      .flatMap(([, entry]) => [entry.title, entry.recap?.task])
      .filter((task) => task !== undefined);
    if (background.length > 0) await Promise.allSettled(background);

    for (const [key] of hosted) await this.closePi(ghostName, sessionKeyParts(key)[1]);
    await this.claudeCode.closeGhost(ghostName);
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
    for (const key of this.projectTransitions) {
      if (deletionKeyGhost(key) === ghostName) return true;
    }
    if (this.mcpReloadGhosts.has(ghostName)) return true;
    return this.claudeCode.isGhostBusy(ghostName);
  }

  private ghostHasTurnAdmission(ghostName: string): boolean {
    for (const key of this.turnAdmissions) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    return false;
  }

  private async cleanupCommittedProjectPiSession(
    ghostName: string,
    sessionId: string,
  ): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    if (!this.sessions.has(key) && !this.cleanupRetries.has(key)) return;
    try {
      await this.closeHostedSession(key, "project binding changed");
    } catch {
      try {
        this.logger.child({ ghost: ghostName, conversation: sessionId }).warn("committed project session cleanup is pending retry", {
          code: "project_cleanup_pending",
        });
      } catch {
        // A committed binding stays successful even if an injected logger fails.
      }
    }
  }

  private async closePi(ghostName: string, sessionId?: string | null): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    await this.closeHostedSession(key, "conversation closed");
  }

  private closeHostedSession(
    key: string,
    reason: string,
  ): Promise<void> {
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
      hosted.liveVoiceTransitions = (hosted.liveVoiceTransitions ?? 0) + 1;
      const results = await Promise.allSettled([
        this.stopHostedVoice(key, hosted),
        this.stopHostedCollaboration(key, hosted, reason),
        this.disposePiSession(hosted),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to fully close session ${key}.`);
      }
      if (this.cleanupRetries.get(key) === hosted) this.cleanupRetries.delete(key);
    })().finally(() => {
      if (this.closing.get(key)?.promise === closing) this.closing.delete(key);
    });
    this.closing.set(key, { hosted, promise: closing });
    return closing;
  }

  private async stopHostedVoice(key: string, hosted: HostedSession): Promise<void> {
    if (hosted.voiceStopped) return;
    const stoppingVoice = this.liveVoice.stop(key);
    await hosted.liveVoiceStart?.catch(() => {});
    await stoppingVoice;
    await this.liveVoice.stop(key);
    hosted.voiceStopped = true;
  }

  private async stopHostedCollaboration(
    key: string,
    hosted: HostedSession,
    reason: string,
  ): Promise<void> {
    if (hosted.collaborationStopped) return;
    await this.collaboration.stop(key, reason);
    hosted.collaborationStopped = true;
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

  private async flushHostedToolCwds(hosted: HostedSession): Promise<void> {
    if (hosted.toolCwdsFlushed) return;
    await this.flushToolCwds(hosted);
    hosted.toolCwdsFlushed = true;
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
    await this.collectCleanupFailure(failures, () => hosted.recap?.controller.abort());
    await this.collectCleanupFailure(failures, () => hosted.recap?.task);
    await this.collectCleanupFailure(failures, () => this.flushHostedToolCwds(hosted));
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
    await this.collectCleanupFailure(failures, () => hosted.jobs.dispose());
    await this.collectCleanupFailure(failures, () => this.closeModelRuntime(hosted));
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to fully dispose session ${hosted.sessionKey}.`);
    }
  }

  /** Stop new work and synchronously trip every active owner's cancellation. */
  beginShutdown(): void {
    if (this.shutdownTasks) return;
    this.disposed = true;
    // Invocation is synchronous even though draining is awaited below: timers
    // are retired and running maintenance is aborted before any other shutdown
    // owner gets a chance to capture another home path.
    const maintenanceDrain = this.maintenance?.beginShutdown();
    this.launchCleanupStep(undefined, "retention timer", () => this.retentionTimer.dispose());
    this.shutdownTasks = [
      ...(maintenanceDrain ? [maintenanceDrain] : []),
      Promise.resolve().then(() => this.liveVoice.disposeAll()),
      Promise.resolve().then(() => this.collaboration.disposeAll()),
      Promise.resolve().then(() => this.claudeCode.disposeAll()),
    ];
    for (const hosted of this.sessions.values()) {
      this.launchCleanupStep(hosted, "abort bash", () => this.abortHostedBash(hosted));
      this.launchCleanupStep(hosted, "close ask", () => this.closeHostedAsk(hosted));
      this.launchCleanupStep(hosted, "abort title", () => this.abortHostedTitle(hosted));
      this.launchCleanupStep(hosted, "abort recap", () => hosted.recap?.controller.abort());
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
        sessionKeys.map((key) => this.closeHostedSession(key, "daemon stopped")),
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
      try {
        await this.maintenance?.disposeAll();
      } catch (error) {
        this.reportCleanupFailure(undefined, "conversation maintenance", error);
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
  forceDisposeAll(): void {
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
      this.launchCleanupStep(entry, "force abort recap", () => entry.recap?.controller.abort());
      this.launchCleanupStep(entry, "force detach ownership", () => this.detachHostedOwnership(entry));
      this.launchCleanupStep(entry, "force abort session", () => this.abortHostedSession(entry));
      if (entry.mcp) {
        this.launchCleanupStep(
          entry,
          "force disconnect MCP",
          () => this.disconnectHostedMcp(entry),
        );
      }
      this.launchCleanupStep(entry, "force cancel jobs", () => entry.jobs.dispose());
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
  }
}
