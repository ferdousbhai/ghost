/**
 * Per-ghost chat-runtime lifecycle.
 *
 * Modern Oh My Pi is the default provider-agnostic `AgentSession` harness. An explicit
 * `claude-code` role instead uses the owner-local, Effect-scoped Agent SDK
 * backend in `claude-code.ts`. One daemon process hosts many ghosts
 * concurrently; the OMP path is scoped entirely through SDK options — no env
 * var, no child process — following the spike (`pi-spike/concurrent-ghosts.mjs`):
 *
 *   cwd        = ~/ghosts/<name>            the ghost home; extensions derive
 *                                           their paths from ctx.cwd
 *   agentDir   = ~/ghosts/<name>/.pi        settings, models.json, agent.db
 *   sessionDir = ~/ghosts/<name>/sessions  transcripts
 *
 * Four decisions that are easy to get wrong and are load-bearing here:
 *
 * 1. **Sessions must be redirected explicitly.** `createAgentSession({
 *    agentDir })` does NOT move session storage; only
 *    `SessionManager.create/open(cwd, sessionDir)` does. Without it a ghost's
 *    transcripts land in the global `~/.pi/agent/sessions/`, breaking the
 *    "one directory is the whole ghost" property that backup and future
 *    per-ghost encryption depend on.
 *
 * 2. **Sessions use the native OMP runtime.** Its prompt, filesystem,
 *    Bash, skills, rules, project context, plugins, project MCP, web search,
 *    task/hub, and background-job machinery stay enabled. Ghost appends its
 *    persona and adds the capabilities that are genuinely Ghost-specific.
 *    MCP is deliberately narrower than OMP's default discovery: only the
 *    ghost home's own `.omp/mcp.json` (or `.omp/.mcp.json`) is loaded, never
 *    user/global config belonging to OMP or another coding agent.
 *
 * 3. **Ghost has no approval UI.** Sessions are deliberately local and
 *    unrestricted. OMP's `ask` remains the human-input bridge.
 */
import { existsSync, mkdirSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
  visitEntriesFromFile,
  visitEntriesFromFileStream,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
  buildSkillPromptMessage,
  parseSkillInvocation,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
  bashExecutionToText,
  type BashExecutionMessage,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import {
  isPersistentShellCdCommand,
  type BashResult,
} from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import {
  AskTool,
  type AskToolDetails,
  type QuestionResult,
} from "@oh-my-pi/pi-coding-agent/tools/ask";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeRuntime,
  claudeSessionMetadataPath,
  type ClaudeCodeRuntimeOptions,
} from "./claude-code.js";
import {
  DEFAULT_COMPACTION_CONFIG,
  GHOST_COMPACTION_PROMPT,
  nativeCompactionSettings,
  type CompactionConfig,
} from "./compaction.js";
import { scrubProviderEnv } from "./env-scrub.js";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
} from "./hooks.js";
import {
  ompToolCapabilities,
  readGhostHomeDigest,
  resolveGhostExtensions,
  type GhostExtensionOptions,
  type GhostHomeDigest,
  type RelayTransport,
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
  ghostOmpModelRouting,
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  resolveOmpChatModel,
  resolveSmolModelRef,
  type GhostModelRoleBinding,
} from "./models.js";
import {
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
import { hostedConversationSourcePaths } from "./hosted-conversation-import.js";
import { trashPath, type TrashPathResult } from "./trash.js";
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
import { createGhostOmpRuntime, type GhostOmpRuntime } from "./omp-runtime.js";
import { ensureGhostArtifactRoot } from "./artifact-root.js";
import { AskBroker, AskBrokerError, type PendingAsk } from "./ask-broker.js";
import {
  buildGhostAvailableSlashCommands,
  classifyGhostBuiltin,
  executeGhostBuiltin,
  type GhostAvailableSlashCommand,
} from "./slash-commands.js";
import {
  LiveVoiceManager,
  type LiveVoiceStatus,
} from "./live-voice.js";
import {
  CollaborationManager,
  type CollaborationStatus,
} from "./collaboration.js";
import { readEffectiveProjectMcp } from "./mcp-catalog.js";

/**
 * The core OMP capabilities Ghost deliberately inherits.
 * OMP may add or gate tools by configuration and model capability, so this is
 * a documented minimum rather than an exhaustive registry.
 */
export const OMP_NATIVE_TOOL_NAMES: readonly string[] = [
  "bash",
  "edit",
  "glob",
  "grep",
  "hub",
  "read",
  "task",
  "web_search",
  "write",
];

export interface UserBashCommand {
  command: string;
  /** `!!command` runs locally but excludes its result from model context. */
  excludeFromContext: boolean;
}

/** Parse OMP's direct local-command sigils without intercepting ordinary text. */
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

/**
 * Preserve OMP's explicit `/skill:name args` command surface. Native `read`
 * lets the model discover skills; this path is the user's force-invocation.
 */
async function promptOmpSession(session: AgentSession, prompt: string): Promise<void> {
  if (session.skillsSettings?.enableSkillCommands) {
    const invocation = parseSkillInvocation(prompt);
    const skill = invocation
      ? session.skills.find((candidate) => candidate.name === invocation.name)
      : undefined;
    if (invocation && skill) {
      const built = await buildSkillPromptMessage(skill, invocation.args, "user");
      await session.promptCustomMessage({
        customType: SKILL_PROMPT_MESSAGE_TYPE,
        content: built.message,
        display: true,
        details: built.details,
        attribution: "user",
      }, {
        streamingBehavior: "steer",
        queueChipText: prompt,
      });
      return;
    }
  }
  await session.prompt(prompt);
}

/**
 * Generate a title for a new conversation from its first user message. Throws
 * on failure; the caller swallows it. Injectable so a test can drive title
 * behaviour without a real model. The default reads `roles.smol_model` and
 * runs one completion on the cheapest usable model (see title.ts).
 */
export type TitleGenerator = (input: {
  session: AgentSession;
  runtime: GhostOmpRuntime;
  ghostName: string;
  agentDir: string;
  firstPrompt: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface TitleConfig {
  /** Master switch. Defaults to enabled. */
  enabled?: boolean;
  /** Provider deadline. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Test seam: replace the default title generator. */
  generate?: TitleGenerator;
}

export const DEFAULT_TITLE_TIMEOUT_MS = 15_000;

/** The default: resolve smol_model against the session's own runtime, complete once. */
const defaultTitleGenerator: TitleGenerator = async ({ runtime, agentDir, firstPrompt, signal }) => {
  let ref = null;
  try {
    ref = resolveSmolModelRef(readGhostModels(agentDir));
  } catch {
    // A broken models.json is not fatal to titling: fall back to cheapest usable.
    ref = null;
  }
  return generateTitle({ runtime, firstPrompt, ref, signal });
};

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
  /** Master switch. Defaults to enabled; off answers `greeting: null`. */
  enabled?: boolean;
  /** Cache lifetime. Defaults to `GREETING_CACHE_TTL_MS`. */
  ttlMs?: number;
  /** Test seam: replace the default generator. */
  generate?: GreetingGenerator;
}

export interface SessionRetentionTimer {
  unref?(): void;
  dispose(): void;
}

export interface SessionRetentionConfig {
  /** Dispose an otherwise-idle cached session after this long. `0` disables TTL expiry. */
  idleTtlMs?: number;
  /** Soft maximum: protected sessions may exceed it until they become idle. */
  maxSessions?: number;
  /** How often protected sessions are reconsidered after becoming idle. */
  sweepIntervalMs?: number;
  /** Monotonic test seam. Production uses `Date.now`. */
  now?: () => number;
  /** Timer test seam. The returned timer is always unref'd. */
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

export interface SessionHostOptions {
  registry: GhostRegistry;
  logger?: Logger;
  /** Sets `PI_OFFLINE` and forbids catalog refresh. See config.offline. */
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
   * Which browser `ghost_browser` drives. Default `"relay"`. With a
   * `relayTransport` present, relay sessions point at the owner's real
   * Chromium; `"profile"` (or no transport) uses the per-ghost profile.
   */
  browserMode?: "relay" | "profile";
  /** The daemon's relay hub as a transport, for the relay browser backend. */
  relayTransport?: RelayTransport;
  /**
   * Seconds a question waits before it settles itself. Daemon-wide; see
   * DaemonConfig.askTimeoutSeconds for why it is not a property of the ghost.
   * `0` (the default here) waits forever. Sessions carry it as OMP's own
   * `ask.timeout`, so OMP resolves plan mode and an explicit disable with it.
   */
  askTimeoutSeconds?: number;
  /**
   * OMP-native compaction policy. Defaults to enabled at 80% of the active
   * model's context window, with asynchronous speculation enabled.
   */
  compaction?: CompactionConfig;
  /**
   * Owner-local Claude Code harness. It is dormant unless
   * `roles.chat_model.provider` is `claude-code`; options are chiefly the
   * executable override and test seams.
   */
  claudeCode?: Omit<
    ClaudeCodeRuntimeOptions,
    "logger" | "extensionOptions" | "browserMode" | "relayTransport" | "hooks"
  >;
  /** Injectable owner for OMP's conversation-scoped realtime voice surface. */
  liveVoice?: LiveVoiceManager;
  /** Injectable owner for OMP's encrypted collaboration relay hosts. */
  collaboration?: CollaborationManager;
  /** Awaited Ghost-owned lifecycle hooks, shared by every model harness. */
  hooks?: GhostHookRunner;
  /** Internal daemon cache bounds and deterministic lifecycle test seams. */
  retention?: SessionRetentionConfig;
}

export interface RunTurnOptions {
  /** Conversation id (pi-messages `options.sessionId`). */
  sessionId?: string | null;
  prompt: string;
  emit: (event: PiMessagesEvent) => void;
  signal?: AbortSignal;
  /** Forward `thinking_*` blocks. Off by default; reasoning is private. */
  includeThinking?: boolean;
}

export interface RunAskReanswerOptions {
  sessionId?: string | null;
  /** Runtime qualified by the public action id. Re-answer is Pi-only. */
  runtime?: ConversationRuntime;
  /** Persisted `ask` toolResult entry selected from the branch tree. */
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
  /** Which model the session resolved to, for diagnostics. */
  model: { provider: string; id: string } | null;
}

export interface QueuedMessages {
  streaming: boolean;
  count: number;
  steering: readonly string[];
  followUp: readonly string[];
}

export interface TrashedConversationArtifact extends TrashPathResult {
  artifact: "hosted-source" | "omp-transcript" | "claude-sidecar";
  source: string;
}

export interface TrashedConversation {
  artifacts: TrashedConversationArtifact[];
}

export type QueueMode = "steer" | "followUp";

interface HostedMCP {
  manager: MCPManager;
  /** Serialized dynamic MCP tool refreshes; never rejects. */
  refresh?: Promise<void>;
  /** Serialized config reconnects, so concurrent mutations never interleave. */
  reload?: Promise<void>;
}

interface HostedSession extends GhostSessionHandle {
  busy: boolean;
  /** Last owner-visible use, for TTL and LRU retention. */
  lastUsedAt: number;
  /** Persistent owner listener for turns started outside SessionHost (collab). */
  unsubscribeOwnership?: () => void;
  /** Coalesces terminal-event and live-voice deferred-update drains. */
  settlingDeferred?: Promise<void>;
  /** Nested reservations while live voice is starting or stopping. */
  liveVoiceTransitions?: number;
  /** Lets stop wait for an admitted startup before stopping its controller. */
  liveVoiceStart?: Promise<LiveVoiceStatus>;
  /** HTTP-backed implementation of OMP's built-in `ask` UI contract. */
  ask: AskBroker;
  /**
   * The runtime this session's model was bound from, kept so a later model
   * switch can re-resolve against the same catalogue the session was built
   * with (see `rebindModel`).
   */
  modelRuntime: GhostOmpRuntime;
  /**
   * Set when a model switch arrived during a turn or live voice. The model is
   * rebound after that exclusive owner releases the AgentSession.
   */
  pendingRebind?: boolean;
  /** Credentials changed in agent.db; reload the borrowed OMP runtime once idle. */
  pendingAuthRefresh?: boolean;
  /** Config changed during a turn or live voice; reconnect once idle. */
  pendingMcpReload?: boolean;
  /** Project MCP reconnect/tool refresh work currently touching this session. */
  mcpTransitions?: number;
  /**
   * The in-flight background title generation, if any. `listSessions` awaits it
   * so a just-generated title shows up in the listing; it never blocks a turn.
   * Resolves (never rejects) when title generation settles.
   */
  title?: Promise<void>;
  /** Cancels the provider call and bounded wrapper on timeout or shutdown. */
  titleAbort?: AbortController;
  /** Nested reservations while collaboration starts or stops. */
  collaborationTransitions?: number;
  /** Close the borrowed runtime exactly once across graceful/forced teardown. */
  modelRuntimeClosed?: boolean;
  /** At-most-once guards shared by graceful and forced cleanup paths. */
  disposeBegun?: boolean;
  bashAbortStarted?: boolean;
  abortTask?: Promise<void>;
  askClosed?: boolean;
  ownershipDetached?: boolean;
  forceDisposeStarted?: boolean;
  /** Monotonic external turn id used by the Ghost session_stop contract. */
  turnId: number;
  /** MCP lifecycle populated strictly from this ghost home's `.omp/`. */
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

/** The (ghost, conversation) halves back out of a `sessionKeyOf` key. */
function sessionKeyParts(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

/** Destructive reservations include runtime: equal raw ids remain independent. */
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

/** One row in the conversation listing. Titles are null until generated. */
export interface SessionSummary {
  /** Runtime-qualified public row/action identity. */
  id: string;
  /** Raw runtime resume id; pi-messages keeps sending this as `options.sessionId`. */
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

/** A renderable transcript message: OMP's message shape, reasoning removed. */
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
  /** The active ask toolResult entry; selecting re-answer creates its sibling. */
  resultEntryId: string;
  settled: AskSettlement;
}

/**
 * How an ask closed survives only in the tool result OMP wrote. A cancel or an
 * abort throws out of the tool, leaving an error entry with empty details; an
 * answer carries the selections, either as `results` for a multi-question ask
 * or flattened onto details for a single one. Without reading that back, a
 * restored transcript cannot tell an answer from a question nobody ever saw.
 */
function askSettlement(details: AskToolDetails | null | undefined): AskSettlement {
  if (!details) return "cancelled";
  if (details.chatRedirect === true) return "chat";
  const timedOut = (result: QuestionResult) => result.timedOut === true;
  if (details.results && details.results.length > 0) {
    return details.results.some(timedOut) ? "timedOut" : "submitted";
  }
  if (details.selectedOptions || typeof details.customInput === "string") {
    return details.timedOut === true ? "timedOut" : "submitted";
  }
  return "cancelled";
}

/** A conversation's history for rehydration in the shell. */
export interface Transcript {
  id: string;
  conversationId: string;
  runtime: "pi";
  title: string | null;
  messages: TranscriptMessage[];
  /** Total renderable messages before the page cap. */
  total: number;
  /** True when this page omits messages (paged, or over the cap). */
  truncated: boolean;
}

/** Default and hard cap on messages returned from one transcript read. */
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
      if (!askBranch && !failed) return part;
      return {
        ...(part as object),
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

/**
 * pi 0.84 stored a display name as an append-only `session_info` entry. OMP 18
 * replaced that record with a fixed title slot, but does not migrate the old
 * entry itself. Keep this reader until every pre-OMP transcript has had a
 * writable open and can be promoted through `SessionManager.setSessionName`.
 */
function legacySessionTitle(entries: readonly unknown[]): string | null {
  let title: string | null = null;
  for (const entry of entries) {
    const record = entry as { type?: unknown; name?: unknown } | null;
    if (record?.type !== "session_info") continue;
    if (typeof record.name !== "string") {
      title = null;
      continue;
    }
    const normalized = Array.from(record.name, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? " "
        : character;
    }).join("").replace(/ +/g, " ").trim();
    title = normalized || null;
  }
  return title;
}

async function readLegacySessionTitle(sessionFile: string): Promise<string | null> {
  // OMP 18 reserves a physical title slot before the first session entry. Its
  // presence proves this cannot contain Ghost's older `session_info` title,
  // so stop after the first logical entry instead of scanning a growing chat
  // every time an untitled conversation changes.
  const nativeTitleSlot = await visitEntriesFromFileStream(sessionFile, () => false);
  if (nativeTitleSlot) return null;

  const entries: unknown[] = [];
  await visitEntriesFromFile(sessionFile, (entry) => {
    if ((entry as { type?: unknown }).type === "session_info") entries.push(entry);
  });
  return legacySessionTitle(entries);
}

/** A title already ending in a copy counter, as `<base> (<n>)`. */
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

/** Upgrade one loaded pi 0.84 title to OMP 18's durable native title slot. */
export async function migrateLegacySessionTitle(
  manager: SessionManager,
): Promise<string | null> {
  if (manager.getSessionName()) return null;
  const title = legacySessionTitle(manager.getEntries());
  if (!title) return null;
  const changed = await manager.setSessionName(
    title,
    "auto",
    "ghost-legacy-session-info",
  );
  return changed ? title : null;
}

/**
 * Connect only the native project MCP files contained by one ghost home.
 *
 * OMP's ordinary discovery intentionally merges user-level OMP configuration
 * with Codex, Claude, Copilot, and other coding-agent sources. A sovereign
 * ghost must not even scan those sources. Reading the two native project files
 * directly, then injecting the resulting manager into the SDK, preserves the
 * ghost's own MCP without consulting anything outside its home.
 */
async function connectGhostProjectMCP(
  manager: MCPManager,
  ghostHome: string,
  logger: Logger,
): Promise<void> {
  const configs: Record<string, MCPServerConfig> = {};
  const sources: Record<string, SourceMeta> = {};
  const effective = await readEffectiveProjectMcp(ghostHome);
  for (const skipped of effective.skipped) {
    logger.error("ghost project MCP config failed to load", {
      path: skipped.path,
      error: skipped.reason,
    });
  }
  for (const server of effective.servers) {
    if (server.errors.length > 0) {
      logger.error("ghost project MCP server failed to load", {
        path: server.source.relativePath,
        server: server.name,
        error: server.errors.join("; "),
      });
      continue;
    }
    const config = server.config as MCPServerConfig;
    if (config.enabled === false) continue;
    configs[server.name] = expandEnvVarsDeep(config);
    sources[server.name] = {
      provider: "native",
      providerName: "OMP",
      path: server.source.absolutePath,
      level: "project",
    };
  }

  if (Object.keys(configs).length === 0) return;
  try {
    const result = await manager.connectServers(configs, sources);
    for (const [name, error] of result.errors) {
      logger.error("ghost project MCP server failed to load", {
        path: sources[name]?.path ?? `mcp:${name}`,
        server: name,
        error,
      });
    }
  } catch (error) {
    logger.error("ghost project MCP failed to load", {
      path: join(ghostHome, ".omp"),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Hide the two CustomTool fields that OMP 18.0.3's reflective adapter proxies
 * before assigning its own readonly copies under Bun. Ordinary property reads
 * still see the original values, so `strict: false`, load-mode selection,
 * rendering, execution, and MCP provenance are preserved. Remove this bridge
 * when the upstream RegisteredToolAdapter/CustomToolAdapter Bun bug is fixed.
 */
function mcpToolsForBunAdapter(manager: MCPManager): ReturnType<MCPManager["getTools"]> {
  return manager.getTools().map((tool) => new Proxy(tool, {
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => key !== "strict" && key !== "loadMode");
    },
  }));
}

export class SessionHost {
  private readonly registry: GhostRegistry;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly extensionOptions: GhostExtensionOptions;
  private readonly browserMode: "relay" | "profile";
  private readonly relayTransport: RelayTransport | undefined;
  private readonly compactionConfig: CompactionConfig;
  private readonly titleEnabled: boolean;
  private readonly titleTimeoutMs: number;
  /** Seconds an unanswered ask waits; 0 waits forever. Projected onto `ask.timeout`. */
  private readonly askTimeoutSeconds: number;
  private readonly generateTitle: TitleGenerator;
  private readonly greetingEnabled: boolean;
  private readonly greetings: GreetingCache;
  private readonly generateGreetingFor: GreetingGenerator;
  private readonly claudeCode: ClaudeCodeRuntime;
  private readonly hooks: GhostHookRunner;
  private readonly liveVoice: LiveVoiceManager;
  private readonly collaboration: CollaborationManager;
  private readonly sessions = new Map<string, HostedSession>();
  /** Passive listing invalidation listeners; they never own or open a session. */
  private readonly conversationListeners = new Map<string, Set<ConversationEventListener>>();
  /** In-flight opens, so two concurrent turns never build two sessions. */
  private readonly opening = new Map<string, Promise<HostedSession>>();
  /** In-flight closes, so a reopen cannot race a still-disposing session. */
  private readonly closing = new Map<
    string,
    { hosted: HostedSession; promise: Promise<void> }
  >();
  /** Runtime-qualified conversation identities reserved by destructive delete. */
  private readonly deleting = new Set<string>();
  /** Ghost names reserved by an in-flight whole-ghost move: a delete or a rename. */
  private readonly reservedGhosts = new Set<string>();
  /** Read-through cache for legacy titles that have not had a writable open yet. */
  private readonly legacyTitles = new Map<
    string,
    { modifiedMs: number; size: number; title: string | null }
  >();
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
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.extensionOptions = options.extensionOptions ?? {};
    this.browserMode = options.browserMode ?? "relay";
    this.relayTransport = options.relayTransport;
    this.compactionConfig = options.compaction ?? DEFAULT_COMPACTION_CONFIG;
    this.titleEnabled = options.title?.enabled ?? true;
    this.titleTimeoutMs = options.title?.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
    if (!Number.isFinite(this.titleTimeoutMs) || this.titleTimeoutMs <= 0) {
      throw new RangeError("title.timeoutMs must be a finite positive number");
    }
    this.askTimeoutSeconds = options.askTimeoutSeconds ?? 0;
    this.generateTitle = options.title?.generate ?? defaultTitleGenerator;
    this.greetingEnabled = options.greeting?.enabled ?? true;
    this.greetings = new GreetingCache(
      options.greeting?.ttlMs === undefined ? {} : { ttlMs: options.greeting.ttlMs },
    );
    this.generateGreetingFor = options.greeting?.generate
      ?? ((input) => this.defaultGreeting(input));
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
    this.claudeCode = new ClaudeCodeRuntime({
      logger: this.logger,
      extensionOptions: this.extensionOptions,
      browserMode: this.browserMode,
      ...(this.relayTransport ? { relayTransport: this.relayTransport } : {}),
      hooks: this.hooks,
      ...(options.claudeCode ?? {}),
    });
    this.liveVoice = options.liveVoice ?? new LiveVoiceManager();
    this.liveVoice.setOnInactive(async (key) => {
      try {
        await this.settleLiveVoiceSession(key);
      } catch (error) {
        this.logger.warn("deferred session update after live voice failed", {
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

  private keyOf(ghostName: string, sessionId: string | null | undefined): string {
    return sessionKeyOf(ghostName, sessionId);
  }

  /** Test/diagnostic projection of the bounded in-memory Pi session cache. */
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
      || hosted.session.compactionSpeculation === "running"
      || hosted.session.isEvalRunning
      || hosted.title !== undefined
      || hosted.settlingDeferred !== undefined
      || (hosted.collaborationTransitions ?? 0) > 0
      || this.collaboration.status(hosted.sessionKey).active
      || hosted.pendingRebind === true
      || hosted.pendingAuthRefresh === true
      || hosted.pendingMcpReload === true
      || (hosted.mcpTransitions ?? 0) > 0
      || this.opening.has(hosted.sessionKey)
      || this.reservedGhosts.has(hosted.ghost.name)
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

  /** Remove cache admission synchronously; teardown continues without blocking a new open. */
  private retireHostedSession(key: string, reason: string): void {
    void this.closeHostedSession(key, reason).catch((error) => {
      this.logger.warn("retained session disposal failed", {
        session: key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Subscribe to small conversation-list invalidations for one ghost. */
  subscribeConversationEvents(
    ghostName: string,
    listener: ConversationEventListener,
  ): () => void {
    this.registry.get(ghostName);
    const listeners = this.conversationListeners.get(ghostName) ?? new Set();
    listeners.add(listener);
    this.conversationListeners.set(ghostName, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.conversationListeners.delete(ghostName);
    };
  }

  /** Publish after storage settles; a deletion uses its mutation time. */
  private async announceConversationUpdated(
    ghostName: string,
    runtime: ConversationRuntime,
    conversationId: string,
  ): Promise<void> {
    const listeners = this.conversationListeners.get(ghostName);
    if (!listeners || listeners.size === 0) return;
    const identity = conversationIdentity(runtime, conversationId);
    let updatedAt = new Date().toISOString();
    try {
      const ghost = this.registry.get(ghostName);
      const row = (await this.collectSessions(ghost)).find((session) => session.id === identity.id);
      if (row) updatedAt = row.updatedAt;
    } catch {
      // Whole-home deletion can remove the ghost before the final invalidation.
    }
    const event: ConversationUpdatedEvent = {
      type: "conversation-updated",
      ...identity,
      updatedAt,
    };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("conversation event listener failed", {
          ghost: ghostName,
          conversation: identity.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Open (or reuse) the pi session for one ghost + conversation. */
  async open(
    ghostName: string,
    sessionId?: string | null,
  ): Promise<GhostSessionHandle> {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    if (this.reservedGhosts.has(ghostName)) {
      throw new GhostError(
        "ghost_busy",
        "Wait for this ghost to finish moving before opening a conversation.",
        409,
      );
    }
    const conversationId = requireRawConversationId(sessionId ?? DEFAULT_SESSION_KEY);
    const key = this.keyOf(ghostName, conversationId);
    const closing = this.closing.get(key);
    if (closing) {
      await closing.promise;
      if (this.disposed) {
        throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
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
          await this.disposePiSession(hosted);
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
    return promise;
  }

  /** OMP's live, session-scoped slash-command catalog, annotated by Ghost's policy. */
  async availableCommands(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): Promise<GhostAvailableSlashCommand[]> {
    assertPiConversation(runtime, "OMP slash commands");
    this.assertOmpRuntime(ghostName, "OMP slash commands");
    const hosted = await this.idleHostedSession(
      ghostName,
      sessionId,
      "Wait for this conversation to finish before refreshing its commands.",
      true,
    );
    try {
      return buildGhostAvailableSlashCommands(hosted.session);
    } finally {
      await this.releaseSessionClaim(hosted, ghostName);
    }
  }

  /** Reject OMP-only surfaces without constructing a shadow pi session. */
  private assertOmpRuntime(ghostName: string, feature: string): Ghost {
    const ghost = this.registry.get(ghostName);
    try {
      const configured = resolveChatModelRef(readGhostModels(ghostPaths(ghost.dir).agentDir));
      if (configured?.provider === CLAUDE_CODE_PROVIDER_ID) {
        throw new GhostError(
          "not_supported",
          `${feature} is unavailable while this ghost uses the Claude Code runtime.`,
          409,
        );
      }
    } catch (error) {
      if (error instanceof GhostError) throw error;
      // Match runTurn: malformed routing falls through to OMP's own selection.
    }
    return ghost;
  }

  /** Current realtime voice state; this read never opens a conversation. */
  liveVoiceStatus(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): LiveVoiceStatus {
    assertPiConversation(runtime, "Live voice");
    this.assertOmpRuntime(ghostName, "Live voice");
    return this.liveVoice.status(this.keyOf(ghostName, sessionId));
  }

  async liveVoiceAction(
    ghostName: string,
    sessionId: string | null | undefined,
    action: "start" | "mute" | "unmute" | "stop",
    runtime: ConversationRuntime = "pi",
  ): Promise<LiveVoiceStatus> {
    assertPiConversation(runtime, "Live voice");
    this.assertOmpRuntime(ghostName, "Live voice");
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
    const start = this.liveVoice.start(key, hosted.session);
    hosted.liveVoiceStart = start;
    try {
      return await start;
    } finally {
      if (hosted.liveVoiceStart === start) hosted.liveVoiceStart = undefined;
      hosted.liveVoiceTransitions = Math.max(0, (hosted.liveVoiceTransitions ?? 1) - 1);
      if (!this.liveVoice.status(key).active) await this.settleLiveVoiceSession(key);
    }
  }

  /** Current encrypted collaboration state; this read never opens a conversation. */
  collaborationStatus(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): CollaborationStatus {
    assertPiConversation(runtime, "Live collaboration");
    this.assertOmpRuntime(ghostName, "Live collaboration");
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
    this.assertOmpRuntime(ghostName, "Live collaboration");
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
      const configuredRelay = hosted.session.settings.get("collab.relayUrl");
      const relayUrl = input.relayUrl
        ?? (typeof configuredRelay === "string" ? configuredRelay : "");
      return await this.collaboration.start({
        sessionKey: key,
        session: hosted.session,
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

  private async createSession(
    ghostName: string,
    sessionKey: string,
    key: string,
  ): Promise<HostedSession> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    mkdirSync(paths.agentDir, { recursive: true });
    mkdirSync(paths.sessionDir, { recursive: true });
    // Before settings are read: this is what makes the home's own `skills/`,
    // `agents/`, `commands/`, `rules/`, `prompts/`, `tools/`, and `hooks/`
    // discoverable.
    ensureGhostArtifactRoot(paths.home);

    const settingsOverrides: Partial<Record<SettingPath, unknown>> = {
      ...nativeCompactionSettings(this.compactionConfig),
      // `ghost_browser`, `ghost_desktop`, and `ghost_screen` own those surfaces,
      // so OMP's overlapping browser/computer built-ins stay off. Image
      // inspection is the opposite call: it is OMP-native now — `inspect_image`
      // runs in its default `auto` mode, registering only when the active chat
      // model cannot see, and resolving the `vision` role Ghost projects from
      // `models.json`'s `vision_model`. OMP's `images.describeForTextModels`
      // attachment fallback is deliberately left at its default (on) for the
      // same reason. Everything else remains governed by the user's native OMP
      // setup.
      "browser.enabled": false,
      "computer.enabled": false,
      // Ghost memory is plain files in the ghost home. OMP's memory lanes
      // (retain/recall/reflect on the mnemopi/hindsight backends, autolearn's
      // managed skills) would grow a second store outside it, and settings
      // load read-only from the ghost home, so one stray key there would
      // mount them silently. Force the whole system off. `memories.enabled`
      // is the legacy flag OMP migrates into `memory.backend`; pin it too.
      "memory.backend": "off",
      "memories.enabled": false,
      "autolearn.enabled": false,
      // OMP's harness prompt opens by casting the model as a coding assistant
      // and spends ~900 characters on how that assistant should talk. A ghost
      // speaks from character.md instead, so the personality block is off and
      // the persona extension drops what remains of the role section.
      "personality": "none",
      // Device docs on demand rather than inline. The four built-in devices
      // (ast_edit, debug, lsp, inspect_image) carry ~180 lines of prose and
      // TypeScript schemas that a conversation almost never reaches for. The
      // catalog still names every device; the model reads `xd://<name>` when
      // it wants one, at the cost of one extra read before first use.
      "tools.xdevDocs": "catalog",
      // A ghost inherits the owner's vendor-neutral global instructions from
      // ~/.agents/AGENTS.md, and not ~/.claude/CLAUDE.md, which is written to
      // steer a coding agent and usually opens by telling the model who it is.
      // That fights character.md, which is the one thing a ghost is.
      //
      // One entry does both jobs. OMP dedupes user-level context files under a
      // single key, so the highest-priority provider wins outright: Claude Code
      // (80) shadows the agent-dirs provider (70) whenever ~/.claude/CLAUDE.md
      // exists. Disabling it both removes the identity text and lets
      // ~/.agents/AGENTS.md through. Project-level CLAUDE.md is untouched, so a
      // ghost working inside a repo still reads what that repo tells an agent.
      "disabledExtensions": ["context-file:user:CLAUDE.md"],
      // Ghost has no approval surface. Sessions are explicitly local and unrestricted.
      "tools.approvalMode": "yolo",
      // How long an unanswered question waits is the owner's setting, and it
      // belongs here rather than in the broker: OMP's ask tool resolves the
      // deadline once, subtracting plan mode and an explicit `0`, and hands the
      // broker the answer. Setting it as an override also puts the daemon-wide
      // value above a ghost home's own `.omp` settings, which is the direction
      // it was always meant to run — the person at the keyboard decides how
      // long a dialog waits, not the persona asking.
      "ask.timeout": this.askTimeoutSeconds,
      // OMP's toast is branded "Oh My Pi" and targets an OMP terminal window.
      // Ghost's shell owns this surface: it names the ghost, includes the
      // actual question, and opens the HUD when clicked.
      "ask.notify": "off",
    };
    const settings = await Settings.loadReadOnly({
      cwd: paths.home,
      agentDir: paths.agentDir,
      overrides: settingsOverrides,
    });
    try {
      const routing = ghostOmpModelRouting(readGhostModels(paths.agentDir));
      settings.override("modelRoles", routing.modelRoles);
      settings.override("retry.fallbackChains", routing.fallbackChains);
    } catch (error) {
      this.logger.error("models.json routing is unusable", {
        ghost: ghostName,
        error: (error as Error).message,
      });
    }
    // A ghost whose character.md is still the seed has been summoned but never
    // met, so its conversations carry the first-meeting section until that file
    // is written.
    const extraSections = [
      ...(this.extensionOptions.extraSections ?? []),
      ...(this.isFirstMeeting(ghost) ? [FIRST_MEETING_SECTION] : []),
    ];
    const extensions = resolveGhostExtensions(
      {
        ghostName,
        browserMode: this.browserMode,
        ...(this.relayTransport ? { relayTransport: this.relayTransport } : {}),
        ...this.extensionOptions,
        ...(extraSections.length > 0 ? { extraSections } : {}),
      },
      paths.home,
      ompToolCapabilities,
    );
    extensions.factories.push((api) => {
      api.on("session.compacting", () => ({ prompt: GHOST_COMPACTION_PROMPT }));
    });

    const modelRuntime = await createGhostOmpRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.agentDir),
      // Provider catalogs are fetched only when the daemon is not offline.
      allowModelNetwork: !this.offline,
      settings,
    });

    // Supplying an MCPManager is OMP's SDK lever for skipping its ambient MCP
    // discovery. Populate it ourselves from the ghost home only.
    const mcp: HostedMCP = { manager: new MCPManager(paths.home, null) };
    mcp.manager.setAuthStorage(modelRuntime.authStorage);
    if (settings.get("mcp.notifications")) mcp.manager.setNotificationsEnabled(true);
    await connectGhostProjectMCP(mcp.manager, paths.home, this.logger);

    const sessionFile = join(paths.sessionDir, sessionFileNameFor(sessionKey));
    const sessionFileExists = existsSync(sessionFile);
    if (sessionFileExists) await requireSessionFileConversationId(sessionFile, sessionKey);
    const sessionManager = await SessionManager.open(
      sessionFile,
      paths.sessionDir,
      undefined,
      { initialCwd: paths.home },
    );
    if (!sessionFileExists) bindConversationId(sessionManager, sessionKey);
    await this.promoteLegacySessionTitle(sessionManager, ghostName, sessionKey);

    const ask = new AskBroker(this.logger);
    let created: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      created = await createAgentSession({
        cwd: paths.home,
        agentDir: paths.agentDir,
        settings,
        authStorage: modelRuntime.authStorage,
        modelRegistry: modelRuntime.modelRegistry,
        extensions: extensions.factories,
        hasUI: false,
        // `ask` is a human-input bridge, not a tool-approval surface. OMP keeps
        // those concerns separate: interactivePrompts exposes AskTool while the
        // yolo approval mode above still auto-accepts the explicit capability set.
        interactivePrompts: true,
        autoApprove: true,
        agentRegistry: new AgentRegistry(),
        // See decision 1: sessions live under the ghost home. `open` on a path
        // that does not exist yet creates it; the bound raw id keeps that
        // transcript stable across daemon restarts.
        sessionManager,
        mcpManager: mcp.manager,
      });
    } catch (error) {
      await mcp.manager.disconnectAll().catch(() => {});
      if (MCPManager.instance() === mcp.manager) MCPManager.setInstance(undefined);
      modelRuntime.close();
      throw error;
    }
    const { session, extensionsResult, setToolUIContext } = created;
    setToolUIContext(ask.uiContext, true);

    // Injected managers are borrowed in OMP's ownership model, so Ghost must
    // bridge initial and notification-driven tool catalogs into this session.
    // Install this even when no server exists yet: adding the first server to
    // a live conversation must mount its tools without reopening the session.
    const refreshMCPTools = (): Promise<void> => {
      const run = (mcp.refresh ?? Promise.resolve()).then(async () => {
        if (!session.isDisposed) {
          await session.refreshMCPTools(mcpToolsForBunAdapter(mcp.manager));
        }
      });
      mcp.refresh = run.catch((error) => {
        this.logger.warn("ghost project MCP tool refresh failed", {
          ghost: ghostName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return run;
    };
    mcp.manager.setOnToolsChanged(() => refreshMCPTools());
    await refreshMCPTools().catch(() => {});

    for (const error of extensionsResult.errors ?? []) {
      this.logger.error("extension failed to load", {
        ghost: ghostName,
        path: error.path,
        error: String(error.error),
      });
    }

    const toolNames = session.getActiveToolNames();
    const initialModel = session.model;
    const model = initialModel
      ? { provider: initialModel.provider, id: initialModel.id }
      : null;

    this.logger.info("ghost session opened", {
      ghost: ghostName,
      session: sessionKey,
      tools: toolNames.length,
      model: model ? `${model.provider}/${model.id}` : null,
    });

    const hosted: HostedSession = {
      ghost,
      sessionKey: key,
      session,
      sessionFile: session.sessionFile,
      model,
      modelRuntime,
      busy: false,
      lastUsedAt: this.retentionNow(),
      ask,
      turnId: 0,
      ...(mcp ? { mcp } : {}),
    };
    // CollabHost receives the raw AgentSession, so a writable guest can start
    // a turn without passing through runTurn() and setting hosted.busy. The
    // terminal public agent_end is emitted only after prompt bookkeeping has
    // unwound; that is the safe boundary for deferred model/MCP ownership.
    hosted.unsubscribeOwnership = session.subscribe((event) => {
      this.touchSession(hosted);
      if (event.type !== "agent_end" || event.isTerminal === false) return;
      if (!hosted.busy) {
        const [, conversationId] = sessionKeyParts(key);
        void this.announceConversationUpdated(ghostName, "pi", conversationId);
      }
      void this.settleDeferredSession(hosted).catch((error) => {
        this.logger.warn("deferred session update after external turn failed", {
          session: key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    return hosted;
  }

  /** Promote a pi 0.84 display name into OMP 18's native title slot on resume. */
  private async promoteLegacySessionTitle(
    manager: SessionManager,
    ghostName: string,
    conversationId: string,
  ): Promise<void> {
    try {
      const title = await migrateLegacySessionTitle(manager);
      if (title) {
        this.logger.info("migrated legacy conversation title", {
          ghost: ghostName,
          session: conversationId,
          title,
        });
      }
    } catch (error) {
      // Title recovery must never make an otherwise healthy conversation
      // impossible to resume. Listing still has the read-only fallback below.
      this.logger.warn("legacy conversation title migration failed", {
        ghost: ghostName,
        session: conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The currently blocked OMP `ask`, if this live conversation has one. */
  pendingAsk(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): PendingAsk | null {
    assertPiConversation(runtime, "Ask");
    this.registry.get(ghostName);
    return this.sessions.get(this.keyOf(ghostName, sessionId))?.ask.pending ?? null;
  }

  /** Resolve the current ask. AskBroker validates ids/options and is first-response-wins. */
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
    const queued = hosted.session.getQueuedMessages();
    return {
      streaming: hosted.session.isStreaming,
      count: hosted.session.queuedMessageCount,
      steering: [...queued.steering],
      followUp: [...queued.followUp],
    };
  }

  /** Queue text using OMP's native steering/follow-up semantics. */
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
    if (mode === "followUp") await hosted.session.followUp(text);
    else await hosted.session.steer(text);
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
   * A busy session is not yanked mid-turn or mid-voice — OMP's active owner
   * keeps the model it started on. It is flagged instead and rebound once that
   * owner releases the AgentSession.
   *
   * Claude Code sessions need no rebinding: they are scoped per turn and read
   * `roles.chat_model` fresh each time (see runTurn), so the next turn already
   * picks up the switch — and a stale pi session for the same conversation is
   * dropped by `closePi` on that next turn.
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
    await this.awaitUnlessAborted(hosted.modelRuntime.authStorage.reload(), signal);
    await this.awaitUnlessAborted(
      hosted.modelRuntime.modelRegistry.hydrateCredentialScopedModelCaches(),
      signal,
    );
    await this.awaitUnlessAborted(hosted.modelRuntime.modelRegistry.refresh("offline"), signal);
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

  /** Aggregate one configured server's state without opening a conversation. */
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
   * Re-read the two project-owned MCP files for every open OMP conversation.
   * Turns and live voice coalesce changes into one deferred reload at their
   * settle boundary; idle sessions reconnect immediately.
   */
  async reloadMcp(ghostName: string): Promise<void> {
    this.registry.get(ghostName);
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
  }

  /** Manual retry for already-loaded managers; never opens a session. */
  async reconnectMcp(
    ghostName: string,
    serverName: string,
  ): Promise<"connected" | "connecting" | "disconnected" | "mixed" | "not_loaded" | "deferred"> {
    this.registry.get(ghostName);
    const managers = [...this.sessions.values()]
      .filter((hosted) => hosted.ghost.name === ghostName && hosted.mcp);
    if (managers.length === 0) return "not_loaded";
    const deferred = managers.filter((hosted) => this.sessionOwned(hosted));
    for (const hosted of deferred) hosted.pendingMcpReload = true;
    await Promise.all(managers.filter((hosted) => !this.sessionOwned(hosted)).map(async (hosted) => {
      const mcp = hosted.mcp;
      if (!mcp) return null;
      hosted.mcpTransitions = (hosted.mcpTransitions ?? 0) + 1;
      try {
        const connected = await mcp.manager.reconnectServer(serverName, { manual: true });
        await mcp.refresh;
        return connected;
      } finally {
        hosted.mcpTransitions = Math.max(0, (hosted.mcpTransitions ?? 1) - 1);
        this.touchSession(hosted);
      }
    }));
    if (deferred.length > 0) return "deferred";
    return this.mcpConnectionStatus(ghostName, serverName);
  }

  /** Reconnect one hosted manager from disk and replace its mounted tool set. */
  private reloadHostedMcp(hosted: HostedSession): Promise<void> {
    const mcp = hosted.mcp;
    if (!mcp) return Promise.resolve();
    hosted.mcpTransitions = (hosted.mcpTransitions ?? 0) + 1;
    const reload = (mcp.reload ?? Promise.resolve()).then(async () => {
      await mcp.manager.disconnectAll();
      await connectGhostProjectMCP(mcp.manager, hosted.ghost.dir, this.logger);
      const refresh = (mcp.refresh ?? Promise.resolve()).then(async () => {
        if (!hosted.session.isDisposed) {
          await hosted.session.refreshMCPTools(mcpToolsForBunAdapter(mcp.manager));
        }
      });
      mcp.refresh = refresh.catch((error) => {
        this.logger.warn("ghost project MCP tool refresh failed", {
          ghost: hosted.ghost.name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await mcp.refresh;
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

  /** Every way OMP can have an exclusive owner, including raw CollabHost turns. */
  private sessionOwned(hosted: HostedSession): boolean {
    return hosted.busy
      || hosted.session.isStreaming
      || hosted.session.isBashRunning
      || this.liveVoiceOwnsSession(hosted);
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

  /** Apply deferred owner changes after voice releases its AgentSession. */
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
    const agentDir = ghostPaths(hosted.ghost.dir).agentDir;
    try {
      hosted.model = await this.selectModel(
        hosted.session,
        hosted.modelRuntime,
        agentDir,
        ghostName,
      );
    } catch (error) {
      this.logger.warn("model rebind failed", {
        ghost: ghostName,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Rebind the ghost's chat model after an owner changes its routing.
   *
   * Provider-agnostic by construction: the (provider, modelId) pair comes
   * from the ghost's own `models.json`, and an unresolvable pair is a warning
   * rather than a hard failure — OMP's own default selection still applies,
   * and the turn will report a clean error if there is nothing to run on.
   */
  private async selectModel(
    session: AgentSession,
    modelRuntime: GhostOmpRuntime,
    agentDir: string,
    ghostName: string,
  ): Promise<{ provider: string; id: string } | null> {
    let ref: ReturnType<typeof resolveChatModelRef> = null;
    try {
      const file = readGhostModels(agentDir);
      const routing = ghostOmpModelRouting(file);
      session.settings.override("modelRoles", routing.modelRoles);
      session.settings.override("retry.fallbackChains", routing.fallbackChains);
      ref = resolveChatModelRef(file);
    } catch (error) {
      this.logger.error("models.json is unusable", {
        ghost: ghostName,
        error: (error as Error).message,
      });
      const current = session.model;
      return current ? { provider: current.provider, id: current.id } : null;
    }
    const model = resolveOmpChatModel(ref, modelRuntime.modelRegistry.getAvailable());
    if (ref && (model?.provider !== ref.provider || model.id !== ref.modelId)) {
      this.logger.warn("configured chat model is not available", {
        ghost: ghostName,
        provider: ref.provider,
        modelId: ref.modelId,
      });
    }
    if (model) {
      // Await the live rebind so the next prompt cannot race onto the prior model.
      await session.setModel(model, "default");
      return { provider: model.provider, id: model.id };
    }
    const current = session.model;
    return current ? { provider: current.provider, id: current.id } : null;
  }

  /** Run OMP's direct `!`/`!!` command surface without asking a model. */
  private async runUserBash(
    ghostName: string,
    command: UserBashCommand,
    options: RunTurnOptions,
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
    let streamedTail = "";
    let lastUpdate = 0;
    let toolFinished = false;
    options.emit({ type: "start" });
    options.emit({
      type: "tool_execution_start",
      id,
      toolName: "bash",
      arguments: {
        command: command.command,
        excludeFromContext: command.excludeFromContext,
      },
      intent: "Run a local command",
    });

    const onAbort = () => hosted.session.abortBash();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
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
        {
          excludeFromContext: command.excludeFromContext,
          useUserShell: true,
        },
      );

      if (
        isPersistentShellCdCommand(command.command)
        && !result.cancelled
        && result.exitCode === 0
        && result.workingDir
        && isAbsolute(result.workingDir)
      ) {
        const nextCwd = resolve(result.workingDir);
        if (nextCwd !== resolve(hosted.session.sessionManager.getCwd())) {
          try {
            if ((await stat(nextCwd)).isDirectory()) {
              const sessionDir = ghostPaths(hosted.ghost.dir).sessionDir;
              await hosted.session.sessionManager.moveTo(nextCwd, sessionDir);
            }
          } catch (error) {
            this.logger.warn("bash changed directory but the session cwd could not follow", {
              ghost: ghostName,
              cwd: nextCwd,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const isError = result.cancelled || result.timedOut === true
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
        options.emit({
          type: "error",
          reason: "aborted",
          usage: zeroUsage(),
          errorMessage: "Command aborted.",
        });
      } else {
        options.emit({ type: "done", reason: "stop", usage: zeroUsage() });
      }
    } catch (error) {
      this.logger.error("direct bash command failed", {
        ghost: ghostName,
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
      options.emit({
        type: "error",
        reason: options.signal?.aborted ? "aborted" : "error",
        usage: zeroUsage(),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await this.releaseSessionClaim(hosted, ghostName);
    }
  }

  /** Consume one known OMP builtin without creating a model message or turn. */
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
      await executeGhostBuiltin(options.prompt, {
        session: hosted.session,
        sessionManager: hosted.session.sessionManager,
        settings: hosted.session.settings,
        cwd: hosted.session.sessionManager.getCwd(),
        output: (output) => {
          options.emit({ type: "command_output", command: dispatch.command, output });
        },
        refreshCommands: () => {},
        reloadPlugins: async () => {
          throw new Error("Plugin reload is outside Ghost's read-only builtin command set.");
        },
      });
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
   * Run one turn, streaming pi-messages events to `emit`.
   *
   * Exactly one terminal `done` or `error` is emitted, always — the pinned
   * client treats a stream that ends without one as a failure.
   */
  async runTurn(ghostName: string, options: RunTurnOptions): Promise<void> {
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
      if (!bashCommand.command) {
        throw new GhostError("invalid_request", "Write a command after ! or !!.", 400);
      }
      await this.runUserBash(ghostName, bashCommand, options);
      await this.announceConversationUpdated(
        ghostName,
        "pi",
        options.sessionId ?? DEFAULT_SESSION_KEY,
      );
      return;
    }
    let configured: ReturnType<typeof resolveChatModelRef> = null;
    try {
      configured = resolveChatModelRef(readGhostModels(paths.agentDir));
    } catch (error) {
      this.logger.error("models.json is unusable", {
        ghost: ghostName,
        error: (error as Error).message,
      });
    }
    if (configured?.provider === CLAUDE_CODE_PROVIDER_ID) {
      // A model switch must not leave a stale pi AgentSession owning this
      // conversation. Claude itself is scoped per turn and keeps only its
      // opaque resume id between turns.
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
      await this.claudeCode.runTurn(ghost, conversationId, configured.modelId, options);
      await this.announceConversationUpdated(ghostName, "claude-code", conversationId);
      return;
    }

    if (this.liveVoice.status(key).active) {
      throw new GhostError(
        "session_busy",
        "Stop live voice before sending a separate chat turn in this conversation.",
        409,
      );
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

    // Known OMP builtins are commands even when Ghost cannot safely run them.
    // Consume them before hooks, title generation, and especially
    // before AgentSession.prompt(), where unknown slash text becomes a model
    // message.
    const builtin = classifyGhostBuiltin(options.prompt);
    if (builtin.kind !== "not_builtin") {
      try {
        await this.runBuiltinCommand(hosted, builtin, options);
      } finally {
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

    const adapter = createPiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
      // The shell rendered the POST's prompt before opening the stream. OMP
      // emits it again as the run's first user message; only later dequeued
      // steering/follow-ups belong on the live wire.
      skipOwnerMessages: 1,
      // Ghost owns the settle boundary so session_stop can continue this same
      // HTTP turn before its one terminal frame is emitted.
      deferAgentEnd: true,
    });
    const unsubscribe = hosted.session.subscribe((event: AgentSessionEvent) => {
      adapter.handle(event);
    });

    const onAbort = () => {
      void hosted.session.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      hosted.turnId += 1;
      if (this.hooks.hasHandlers("before_prompt")) {
        const result = await this.hooks.emitBeforePrompt({
          type: "before_prompt",
          prompt: options.prompt,
          turn_id: hosted.turnId,
          session_id: hosted.session.sessionId,
          ...(hosted.session.sessionFile ? { session_file: hosted.session.sessionFile } : {}),
          signal: options.signal ?? new AbortController().signal,
          ghost_name: ghostName,
          cwd: paths.home,
          runtime: "omp",
        });
        if (result?.additionalContext && !options.signal?.aborted) {
          await hosted.session.sendCustomMessage({
            customType: "before-prompt-hook-context",
            content: result.additionalContext,
            display: false,
          }, { triggerTurn: false });
        }
      }
      await promptOmpSession(hosted.session, options.prompt);

      let stopHookActive = false;
      let continuationCount = 0;
      while (!adapter.isTerminal() && !options.signal?.aborted && this.hooks.hasHandlers("session_stop")) {
        const messages = [...hosted.session.messages];
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        const result = await this.hooks.emitSessionStop({
          type: "session_stop",
          // Stop hooks review this pass, not the screenshot/tool-heavy session
          // history. This also matches the Claude Code runtime's payload.
          messages: lastAssistant ? [lastAssistant] : [],
          turn_id: hosted.turnId,
          ...(lastAssistant ? { last_assistant_message: lastAssistant } : {}),
          session_id: hosted.session.sessionId,
          ...(hosted.session.sessionFile ? { session_file: hosted.session.sessionFile } : {}),
          stop_hook_active: stopHookActive,
          signal: options.signal ?? new AbortController().signal,
          ghost_name: ghostName,
          cwd: paths.home,
          runtime: "omp",
        });
        const additionalContext = ghostSessionStopContinuation(result);
        if (!additionalContext) break;
        if (continuationCount >= GHOST_SESSION_STOP_CONTINUATION_CAP) {
          this.logger.warn("session_stop continuation cap reached", {
            ghost: ghostName,
            session: hosted.session.sessionId,
            cap: GHOST_SESSION_STOP_CONTINUATION_CAP,
          });
          break;
        }
        continuationCount += 1;
        stopHookActive = true;
        await hosted.session.sendCustomMessage({
          customType: "session-stop-continuation",
          content: additionalContext,
          display: false,
        }, { triggerTurn: true });
      }

      if (!adapter.isTerminal()) {
        if (options.signal?.aborted) adapter.finishError(new Error("Turn aborted."), true);
        else adapter.finishDone();
      }
    } catch (error) {
      this.logger.error("turn failed", {
        ghost: ghostName,
        error: (error as Error).message,
      });
      if (!adapter.isTerminal()) {
        adapter.finishError(error, options.signal?.aborted === true);
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      // A model switch that arrived mid-turn was deferred rather than applied to
      // the running prompt; apply it now the turn has settled, before the next
      // turn starts.
      await this.releaseSessionClaim(hosted, ghostName);
      // Name the conversation from its first message, fire-and-forget. Runs
      // after the reply is fully delivered and never blocks the next turn.
      if (shouldTitle) {
        this.startBackgroundTitle(hosted, ghostName, paths.agentDir, options.prompt);
      }
      await this.announceConversationUpdated(ghostName, "pi", conversationId);
    }
  }

  /**
   * Fire-and-forget conversation titling. Non-blocking by construction: the
   * promise is stored on the session so `listSessions` can await it before
   * reading titles, but this method never awaits and never throws — a failure
   * is logged and the conversation simply stays untitled. Generation is a
   * single completion on the smol_model (see title.ts); the result is stored
   * through OMP's native title slot, which never enters the model's context.
   */
  private startBackgroundTitle(
    hosted: HostedSession,
    ghostName: string,
    agentDir: string,
    firstPrompt: string,
  ): void {
    const controller = new AbortController();
    hosted.titleAbort?.abort();
    hosted.titleAbort = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
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
      agentDir,
      firstPrompt,
      signal: controller.signal,
    }));
    const promise = Promise.race([generation, aborted])
      .then(async (raw) => {
        const title = raw.trim();
        // A concurrent turn may have titled it first; do not overwrite.
        if (!title || hosted.session.sessionName) return;
        await hosted.session.sessionManager.setSessionName(title, "auto", "ghost-title");
        this.logger.info("named ghost conversation", {
          ghost: ghostName,
          session: hosted.session.sessionId,
          title,
        });
        const [, conversationId] = sessionKeyParts(hosted.sessionKey);
        await this.announceConversationUpdated(ghostName, "pi", conversationId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted && !timedOut) return;
        this.logger.warn("conversation title generation failed", {
          ghost: ghostName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const tracked: Promise<void> = promise.finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      if (hosted.titleAbort === controller) hosted.titleAbort = undefined;
      if (hosted.title === tracked) hosted.title = undefined;
      void this.sweepRetainedSessions();
    });
    hosted.title = tracked;
  }

  /**
   * Whether a session for this ghost should carry the first-meeting section:
   * the owner's conversation with a ghost that is still the seed.
   *
   * An unreadable character.md answers "no". Being wrong the other way would
   * push a written ghost back through an interview it has already had, which
   * reads as amnesia rather than as a first meeting.
   */
  private isFirstMeeting(ghost: Ghost): boolean {
    try {
      return isSeededCharacter(ghost.name, readCharacterFile(ghost.dir));
    } catch (error) {
      this.logger.warn("could not read character.md", {
        ghost: ghost.name,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * The line the shell opens an empty chat with, and whether this ghost has
   * been met yet.
   *
   * A generation failure is never an HTTP failure: `greeting: null` is the
   * contract, and the shell keeps its own static line. An unknown ghost is
   * still a 404 — that is a client bug, not a model that was busy.
   *
   * The onboarding flag is computed from character.md on every request, not
   * from the cached entry, so it is correct even when generation fails.
   */
  async greeting(ghostName: string): Promise<GreetingResult> {
    const ghost = this.registry.get(ghostName);
    const character = readCharacterFile(ghost.dir);
    const onboarding = isSeededCharacter(ghost.name, character);
    if (!this.greetingEnabled) return { greeting: null, onboarding };

    // The character file IS the cache key's second half: writing it is exactly
    // the event that must produce a different greeting immediately.
    const fingerprint = createHash("sha256").update(character ?? "").digest("hex");
    return this.greetings.get(ghost.name, fingerprint, async () => {
      try {
        const context = await this.greetingContext(ghost, onboarding);
        return { greeting: await this.generateGreetingFor({ ghost, context }), onboarding };
      } catch (error) {
        this.logger.warn("greeting generation failed", {
          ghost: ghost.name,
          error: error instanceof Error ? error.message : String(error),
        });
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
  ): Promise<GreetingContextInput> {
    const paths = ghostPaths(ghost.dir);
    let digest: GhostHomeDigest = { character: null, memoryLines: [], docLines: [] };
    try {
      digest = await readGhostHomeDigest(paths.home);
    } catch (error) {
      this.logger.warn("could not read the ghost home for a greeting", {
        ghost: ghost.name,
        error: (error as Error).message,
      });
    }

    let daysSinceLastConversation: number | null = null;
    try {
      // The most recent conversation is the last time the owner and this ghost
      // actually spoke. Taken as a max rather than off the head of the
      // listing, which is ordered pinned-first.
      const newest = (await this.collectSessions(ghost))
        .reduce<string | null>(
          (latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest),
          null,
        );
      if (newest) daysSinceLastConversation = wholeDaysSince(newest);
    } catch (error) {
      this.logger.warn("could not read conversations for a greeting", {
        ghost: ghost.name,
        error: (error as Error).message,
      });
    }

    return {
      ghostName: ghost.name,
      character: digest.character,
      memoryLines: digest.memoryLines,
      docLines: digest.docLines,
      localTime: localTimeString(),
      daysSinceLastConversation,
      onboarding,
    };
  }

  /** The default generator: `roles.smol_model`, one completion, clean or null. */
  private async defaultGreeting(input: {
    ghost: Ghost;
    context: GreetingContextInput;
  }): Promise<string | null> {
    const agentDir = ghostPaths(input.ghost.dir).agentDir;
    let ref: GhostModelRoleBinding | null = null;
    try {
      ref = resolveSmolModelRef(readGhostModels(agentDir));
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
   * reuse it rather than opening a second `agent.db` handle for one throwaway
   * call; with nothing open, build one exactly as `createSession` does and close
   * it again. (Reusing a live one can race a concurrent `closePi`, which closes
   * that runtime — the completion then fails and the greeting is null, which is
   * the same answer every other failure gives.)
   */
  private async withGreetingRuntime<T>(
    ghost: Ghost,
    use: (runtime: GhostOmpRuntime) => Promise<T>,
  ): Promise<T> {
    for (const hosted of this.sessions.values()) {
      if (hosted.ghost.name === ghost.name) return use(hosted.modelRuntime);
    }
    const paths = ghostPaths(ghost.dir);
    const runtime = await createGhostOmpRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.agentDir),
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
    const inflightTitles = [...this.sessions.values()]
      .filter((hosted) => hosted.ghost.name === ghostName && hosted.title)
      .map((hosted) => hosted.title as Promise<void>);
    if (inflightTitles.length > 0) await Promise.allSettled(inflightTitles);

    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const [rows, pinState, readState] = await Promise.all([
      this.collectSessions(ghost),
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
    const ghost = this.registry.get(ghostName);
    const conversationId = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(runtime, conversationId);
    const paths = ghostPaths(ghost.dir);
    const rows = await this.collectSessions(ghost);
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
    await writePins(paths.sessionDir, pinned ? [...kept, identity.id] : kept);
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
    const ghost = this.registry.get(ghostName);
    const conversationId = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(runtime, conversationId);
    const paths = ghostPaths(ghost.dir);
    const rows = await this.collectSessions(ghost);
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
    await writeReads(paths.sessionDir, { ...kept, [identity.id]: readAt });
    await this.announceConversationUpdated(ghostName, runtime, conversationId);
    return readAt;
  }

  /**
   * Name one conversation through OMP's native title slot with source
   * `"user"`. OMP refuses an automatic title over a name a person chose, so
   * the background titler cannot undo the rename.
   *
   * Naming is allowed mid-turn. The title slot is not part of the conversation
   * tree — writing it appends one audit entry and rewrites 256 fixed bytes —
   * so a rename cannot disturb a running prompt.
   */
  async renameConversation(
    ghostName: string,
    conversationId: string | null | undefined,
    title: string,
    runtime: ConversationRuntime = "pi",
  ): Promise<string> {
    assertPiConversation(runtime, "Conversation renaming");
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const id = conversationId ?? DEFAULT_SESSION_KEY;
    const key = this.keyOf(ghostName, conversationId);
    const sessionFile = join(paths.sessionDir, sessionFileNameFor(id));
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
    const manager = hosted?.session.sessionManager ?? await SessionManager.open(
      sessionFile,
      paths.sessionDir,
      undefined,
      { initialCwd: paths.home },
    );
    try {
      const stored = await this.applySessionName(manager, title);
      this.legacyTitles.delete(sessionFile);
      this.logger.info("renamed ghost conversation", {
        ghost: ghostName,
        session: id,
        title: stored,
      });
      await this.announceConversationUpdated(ghostName, "pi", id);
      return stored;
    } finally {
      // Release a manager opened for this write alone; the live session keeps
      // its own, and the next turn re-opens an idle conversation for itself.
      if (!hosted) await manager.close();
    }
  }

  /**
   * Write one name through OMP and answer with what it kept — OMP collapses
   * control characters and runs of spaces, so the stored name is the honest
   * one to hand back. A name with nothing printable in it stores as nothing,
   * which is a bad request rather than a silent no-op.
   */
  private async applySessionName(
    manager: SessionManager,
    title: string,
  ): Promise<string> {
    const applied = await manager.setSessionName(title, "user", "ghost-rename");
    const stored = manager.getSessionName();
    if (!applied || !stored) {
      throw new GhostError(
        "invalid_request",
        "A conversation title needs at least one printable character.",
        400,
      );
    }
    return stored;
  }

  /** Every stored conversation for one ghost, before pin state is applied. */
  private async collectSessions(
    ghost: Ghost,
  ): Promise<StoredSessionRow[]> {
    const paths = ghostPaths(ghost.dir);
    mkdirSync(paths.sessionDir, { recursive: true });
    const [sessions, claudeSessions] = await Promise.all([
      SessionManager.list(paths.home, paths.sessionDir),
      this.claudeCode.listSessions(ghost),
    ]);
    const scannedOmpSessions = await Promise.all(sessions.map(async (info) => {
      const nativeTitle = info.title?.trim() ? info.title : null;
      let title = nativeTitle;
      if (!title) {
        const modifiedMs = info.modified.getTime();
        const cached = this.legacyTitles.get(info.path);
        if (cached?.modifiedMs === modifiedMs && cached.size === info.size) {
          title = cached.title;
        } else {
          try {
            title = await readLegacySessionTitle(info.path);
          } catch {
            // A concurrent delete or malformed transcript should not make the
            // entire conversation list fail.
            title = null;
          }
          this.legacyTitles.set(info.path, { modifiedMs, size: info.size, title });
        }
      }
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
        title,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
      };
    }));
    const ompSessions = scannedOmpSessions.filter(
      (row): row is Exclude<(typeof scannedOmpSessions)[number], null> => row !== null,
    );
    return [
      ...ompSessions,
      ...claudeSessions.filter((info) => isValidConversationId(info.conversationId)).map((info) => ({
        ...conversationIdentity("claude-code", info.conversationId),
        title: "Claude Code",
        createdAt: info.created,
        updatedAt: info.modified,
        messageCount: info.messageCount,
      })),
    ];
  }

  /**
   * Read one conversation's messages so the shell can rehydrate it (issue #26).
   *
   * Reuses OMP's own session read: the transcript file is opened read-only and
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
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const id = conversationId ?? DEFAULT_SESSION_KEY;
    const path = join(paths.sessionDir, sessionFileNameFor(id));
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

    const manager = await SessionManager.open(
      path,
      paths.sessionDir,
      undefined,
      { initialCwd: paths.home },
    );
    return this.transcriptFromManager(id, manager, options);
  }

  private transcriptFromManager(
    id: string,
    manager: SessionManager,
    options: { limit?: number; offset?: number } = {},
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
      const message = projectTranscriptMessage(entry, askBranches, failedToolCalls);
      if (message) all.push(message);
    }
    const total = all.length;
    const limit = clampTranscriptLimit(options.limit);
    const offset = Math.min(clampTranscriptOffset(options.offset), total);
    const messages = all.slice(offset, offset + limit);
    return {
      ...conversationIdentity("pi", id),
      title: manager.getSessionName() ?? legacySessionTitle(manager.getEntries()),
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
  ): Promise<HostedSession> {
    const hosted = (await this.open(ghostName, conversationId)) as HostedSession;
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
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const sourceId = conversationId ?? DEFAULT_SESSION_KEY;
    const sourceFile = join(paths.sessionDir, sessionFileNameFor(sourceId));
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
    const source = await this.idleHostedSession(
      ghostName,
      conversationId,
      "Wait for this conversation to finish before changing branches.",
      true,
    );
    try {
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
      // Session persistence is lazy and buffered, so the file being copied has
      // to be complete on disk first.
      await sourceManager.ensureOnDisk();
      await sourceManager.flush();
      const sourceFile = sourceManager.getSessionFile();
      if (!sourceFile) {
        throw new GhostError("invalid_branch", "This conversation has no transcript to branch from.", 400);
      }
      // Names to avoid colliding with, straight from OMP's own listing. The
      // full `listSessions` would also read every Claude Code sidecar and the
      // pins, and wait on unrelated titles, for one `(n)`.
      const title = forkConversationTitle(
        sourceManager.getSessionName() ?? null,
        (await SessionManager.list(paths.home, paths.sessionDir)).map((info) => info.title ?? null),
      );
      const forked = await SessionManager.forkFrom(
        sourceFile,
        paths.home,
        paths.sessionDir,
        undefined,
        // Pin the copy's path to the same bounded mapping every other
        // conversation uses, so `open` and `listSessions` find it unaided.
        { sessionFile: join(paths.sessionDir, sessionFileNameFor(forkId)) },
      );
      try {
        // forkFrom inherits the source's title *and* its provenance, and OMP
        // refuses an "auto" write over a name the user chose. The copy name is
        // derived from that name, so it inherits its standing with it.
        if (title) await forked.setSessionName(title, forked.titleSource ?? "auto", "ghost-fork");
        await forked.ensureOnDisk();
      } finally {
        // Release the copy's writer before the host opens it as a session.
        await forked.close();
      }
    } finally {
      await this.releaseSessionClaim(source, ghostName);
    }

    // From here the copy exists on disk and would show up in the sidebar, so
    // every failure has to take it back out again: a branch the user was told
    // was refused must not leave a titled duplicate behind.
    try {
      const hosted = await this.idleHostedSession(
        ghostName,
        forkId,
        "Wait for this conversation to finish before changing branches.",
        true,
      );
      try {
        const result = await hosted.session.navigateTree(entryId);
        if (result.cancelled) throw new GhostError("branch_cancelled", "Conversation branching was cancelled.", 409);
        const fork = {
          ...conversationIdentity("pi", forkId),
          sessionId: forkId,
          title: hosted.session.sessionManager.getSessionName() ?? null,
          draft: result.editorText ?? "",
          transcript: this.transcriptFromManager(forkId, hosted.session.sessionManager),
        };
        await this.announceConversationUpdated(ghostName, "pi", forkId);
        return fork;
      } finally {
        await this.releaseSessionClaim(hosted, ghostName);
      }
    } catch (error) {
      await this.discardFork(ghostName, forkId);
      throw error;
    }
  }

  /** Undo a fork that never reached the user without creating a Trash entry. */
  private async discardFork(ghostName: string, forkId: string): Promise<void> {
    try {
      const ghost = this.registry.get(ghostName);
      const paths = ghostPaths(ghost.dir);
      await this.closePi(ghostName, forkId);
      const rowsBefore = await this.collectSessions(ghost);
      const forkIdentity = conversationIdentity("pi", forkId);
      const sessionFile = join(paths.sessionDir, sessionFileNameFor(forkId));
      try {
        if (existsSync(sessionFile)) {
          await requireSessionFileConversationId(sessionFile, forkId);
        }
        await unlink(sessionFile);
        this.legacyTitles.delete(sessionFile);
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
      this.logger.warn("could not discard an abandoned branch copy", {
        ghost: ghostName,
        conversation: forkId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Re-open a historical OMP `ask`, commit the new answer as a sibling
   * toolResult, rebuild the active branch, then resume the model on that branch.
   */
  async runAskReanswer(
    ghostName: string,
    options: RunAskReanswerOptions,
  ): Promise<void> {
    assertPiConversation(options.runtime ?? "pi", "Ask re-answering");
    const adapter = createPiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
      deferAgentEnd: true,
    });
    const hosted = await this.idleHostedSession(
      ghostName,
      options.sessionId,
      "Wait for this conversation to finish before changing this answer.",
      true,
    );
    let unsubscribe: (() => void) | undefined;
    const onAbort = () => {
      hosted.ask.close();
      void hosted.session.abort();
    };
    const syntheticId = `ask-reanswer-${options.entryId}`;
    try {
      unsubscribe = hosted.session.subscribe((event: AgentSessionEvent) => adapter.handle(event));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const probe = await hosted.session.navigateTree(options.entryId, { allowAskReopen: true });
      if (!probe.reopenAsk) {
        throw new GhostError(
          "ask_not_reanswerable",
          "That branch point is not a recoverable OMP ask result.",
          400,
        );
      }
      adapter.handle({
        type: "tool_execution_start",
        toolCallId: syntheticId,
        toolName: "ask",
        args: { questions: probe.reopenAsk.questions },
        intent: "Re-answer an earlier question",
      } as AgentSessionEvent);

      const toolSession: ToolSession = {
        cwd: ghostPaths(hosted.ghost.dir).home,
        // The HTTP broker can reach the owner, but this daemon is not an OMP
        // terminal UI. Keeping those concepts separate also keeps OMP from
        // advertising itself as the desktop application for this interaction.
        hasUI: false,
        canPromptUser: true,
        settings: hosted.session.settings,
        getSessionFile: () => hosted.session.sessionFile ?? null,
        getSessionSpawns: () => null,
        getPlanModeState: () => hosted.session.getPlanModeState(),
      };
      const askTool = new AskTool(toolSession);
      const result = await askTool.execute(
        syntheticId,
        { questions: probe.reopenAsk.questions },
        options.signal,
        undefined,
        hosted.session.buildAskReanswerContext(hosted.ask.uiContext),
      );
      if (result.details?.chatRedirect) {
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
        isError: result.isError === true,
      } as AgentSessionEvent);

      const committed = await hosted.session.navigateTree(options.entryId, {
        allowAskReopen: true,
        reanswerAskResult: result,
      });
      if (!committed.askReanswerCommitted) {
        throw new GhostError("ask_reanswer_failed", "OMP did not commit the revised answer.", 409);
      }
      options.emit({
        type: "branch_changed",
        transcript: this.transcriptFromManager(
          options.sessionId ?? DEFAULT_SESSION_KEY,
          hosted.session.sessionManager,
        ),
      });

      hosted.session.resumeAfterAskReanswer();
      await hosted.session.waitForIdle();
      if (!adapter.isTerminal()) {
        if (options.signal?.aborted) adapter.finishError(new Error("Turn aborted."), true);
        else adapter.finishDone();
      }
    } catch (error) {
      if (!adapter.isTerminal()) {
        adapter.finishError(
          error instanceof ToolAbortError ? new Error("Ask re-answer cancelled.") : error,
          options.signal?.aborted === true,
        );
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      await this.releaseSessionClaim(hosted, ghostName);
      await this.announceConversationUpdated(
        ghostName,
        "pi",
        options.sessionId ?? DEFAULT_SESSION_KEY,
      );
    }
  }

  /** Drop one hosted session (aborting an in-flight turn). */
  async close(ghostName: string, sessionId?: string | null): Promise<void> {
    await this.claudeCode.close(ghostName, sessionId ?? DEFAULT_SESSION_KEY);
    await this.closePi(ghostName, sessionId);
  }

  /** Move every Ghost-owned artifact for one idle conversation to recoverable trash. */
  async deleteSession(
    ghostName: string,
    sessionId?: string | null,
    runtime: ConversationRuntime = "pi",
  ): Promise<TrashedConversation> {
    const ghost = this.registry.get(ghostName);
    const id = sessionId ?? DEFAULT_SESSION_KEY;
    const identity = conversationIdentity(runtime, id);
    const piKey = this.keyOf(ghostName, sessionId);
    const deleteKey = deletionKeyOf(ghostName, runtime, id);
    const hosted = runtime === "pi" ? this.sessions.get(piKey) : undefined;
    const busy = runtime === "pi"
      ? this.opening.has(piKey)
        || (hosted ? this.sessionOwned(hosted) : this.liveVoice.status(piKey).active)
      : this.claudeCode.isBusy(ghostName, id);
    if (this.deleting.has(deleteKey) || busy) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before deleting it.",
        409,
      );
    }

    this.deleting.add(deleteKey);
    try {
      // Title generation can still append to an otherwise-idle transcript.
      // Let it settle before disposal so deletion cannot race a late write.
      const background = [hosted?.title]
        .filter((task): task is Promise<void> => task !== undefined);
      if (background.length > 0) await Promise.allSettled(background);

      if (runtime === "pi") await this.closePi(ghostName, sessionId);
      else await this.claudeCode.close(ghostName, id);
      const paths = ghostPaths(ghost.dir);
      const piPath = join(paths.sessionDir, sessionFileNameFor(id));
      const claudePath = claudeSessionMetadataPath(paths.sessionDir, id);
      if (runtime === "pi" && existsSync(piPath)) {
        await requireSessionFileConversationId(piPath, id);
      }
      const rowsBefore = await this.collectSessions(ghost);
      const candidates: Array<{
        artifact: TrashedConversationArtifact["artifact"];
        path: string;
      }> = runtime === "pi"
        ? [
            ...(await hostedConversationSourcePaths(ghost.dir, id))
              .map((path) => ({ artifact: "hosted-source" as const, path })),
            { artifact: "omp-transcript", path: piPath },
          ]
        : [{ artifact: "claude-sidecar", path: claudePath }];
      const artifacts: TrashedConversationArtifact[] = [];
      for (const candidate of candidates) {
        try {
          const trashed = trashPath(candidate.path, {
            fallbackRoot: join(ghost.dir, ".trash"),
          });
          artifacts.push({ artifact: candidate.artifact, source: candidate.path, ...trashed });
          if (candidate.path === piPath) this.legacyTitles.delete(piPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (artifacts.length === 0) {
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
      this.logger.info("trashed ghost conversation", {
        ghost: ghostName,
        session: identity.id,
        artifacts: artifacts.map((entry) => entry.artifact),
      });
      await this.announceConversationUpdated(ghostName, runtime, id);
      return { artifacts };
    } finally {
      this.deleting.delete(deleteKey);
    }
  }

  /**
   * Trash one whole ghost: close its conversations, then move its home aside.
   *
   * The move is the registry's (`trash`) — into the system trash, where a
   * trash tool or file manager can restore it — and it is a move rather than a
   * removal: the ghost home holds the only copy of a persona, its memory, and
   * its docs. Nothing here follows up with a recursive delete.
   */
  async deleteGhost(ghostName: string): Promise<{ trash: string }> {
    const ghost = this.registry.get(ghostName);
    this.reserveGhosts([ghost.name], "deleting it");
    try {
      await this.quiesceGhost(ghost.name);
      const trashed = this.registry.trash(ghost.name);
      this.forgetGhost(ghost.name, ghost.dir);
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
   * nothing else — persona, memory, docs, conversations, pins, and credentials
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
    try {
      await this.quiesceGhost(ghost.name);
      const renamed = this.registry.rename(ghost.name, nextName);
      this.forgetGhost(ghost.name, ghost.dir);
      this.logger.info("renamed ghost", { ghost: ghost.name, name: renamed.name });
      return renamed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
      this.reservedGhosts.delete(nextName);
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
  private async quiesceGhost(ghostName: string): Promise<void> {
    const alreadyClosing = [...this.closing.entries()]
      .filter(([key]) => sessionKeyParts(key)[0] === ghostName)
      .map(([, closing]) => closing.promise);
    if (alreadyClosing.length > 0) await Promise.all(alreadyClosing);
    const hosted = [...this.sessions].filter(([key]) => sessionKeyParts(key)[0] === ghostName);
    // Title generation can still append to an otherwise-idle transcript. Let
    // it settle before the home moves out from under it.
    const background = hosted
      .flatMap(([, entry]) => [entry.title])
      .filter((task): task is Promise<void> => task !== undefined);
    if (background.length > 0) await Promise.allSettled(background);

    for (const [key] of hosted) await this.closePi(ghostName, sessionKeyParts(key)[1]);
    await this.claudeCode.closeGhost(ghostName);
  }

  /**
   * Drop everything the daemon still holds under a name or a home that has
   * moved. A ghost re-summoned (or renamed) into this name must not inherit
   * the previous one's opening line, and a title cached against a path in the
   * old home would answer for whatever ends up at that path next.
   */
  private forgetGhost(ghostName: string, home: string): void {
    this.greetings.clear(ghostName);
    const prefix = `${resolve(home)}${sep}`;
    for (const path of [...this.legacyTitles.keys()]) {
      if (path.startsWith(prefix)) this.legacyTitles.delete(path);
    }
  }

  /** True while any conversation of this ghost is busy, opening, closing, or mid-delete. */
  private ghostBusy(ghostName: string): boolean {
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
    for (const key of this.deleting) {
      if (deletionKeyGhost(key) === ghostName) return true;
    }
    return this.claudeCode.isGhostBusy(ghostName);
  }

  private async closePi(ghostName: string, sessionId?: string | null): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    await this.closeHostedSession(key, "conversation closed");
  }

  /** The sole path that removes and disposes a cached Pi session. */
  private closeHostedSession(key: string, reason: string): Promise<void> {
    const alreadyClosing = this.closing.get(key);
    if (alreadyClosing) return alreadyClosing.promise;
    const hosted = this.sessions.get(key);
    if (!hosted) return Promise.resolve();

    // Remove admission before the first await. Every potentially fallible
    // teardown action lives inside the settled cleanup below.
    this.sessions.delete(key);
    const closing = (async () => {
      hosted.liveVoiceTransitions = (hosted.liveVoiceTransitions ?? 0) + 1;
      const results = await Promise.allSettled([
        (async () => {
          const stoppingVoice = this.liveVoice.stop(key);
          await hosted.liveVoiceStart?.catch(() => {});
          await stoppingVoice;
          await this.liveVoice.stop(key);
        })(),
        Promise.resolve().then(() => this.collaboration.stop(key, reason)),
        this.disposePiSession(hosted),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to fully close session ${key}.`);
      }
    })().finally(() => {
      if (this.closing.get(key)?.promise === closing) this.closing.delete(key);
    });
    this.closing.set(key, { hosted, promise: closing });
    return closing;
  }

  private closeModelRuntime(hosted: HostedSession): void {
    if (hosted.modelRuntimeClosed) return;
    hosted.modelRuntimeClosed = true;
    hosted.modelRuntime.close();
  }

  private beginHostedDispose(hosted: HostedSession): void {
    if (hosted.disposeBegun) return;
    hosted.disposeBegun = true;
    hosted.session.beginDispose();
  }

  private abortHostedBash(hosted: HostedSession): void {
    if (hosted.bashAbortStarted) return;
    hosted.bashAbortStarted = true;
    hosted.session.abortBash();
  }

  private abortHostedSession(hosted: HostedSession): Promise<void> {
    if (hosted.abortTask) return hosted.abortTask;
    let abort: Promise<void>;
    try {
      abort = Promise.resolve(hosted.session.abort());
    } catch (error) {
      abort = Promise.reject(error);
    }
    hosted.abortTask = abort;
    return abort;
  }

  private closeHostedAsk(hosted: HostedSession): void {
    if (hosted.askClosed) return;
    hosted.askClosed = true;
    hosted.ask.close();
  }

  private detachHostedOwnership(hosted: HostedSession): void {
    if (hosted.ownershipDetached) return;
    hosted.ownershipDetached = true;
    const unsubscribe = hosted.unsubscribeOwnership;
    hosted.unsubscribeOwnership = undefined;
    unsubscribe?.();
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
      this.logger.warn("session cleanup failed", {
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

  /** Dispose one OMP session and the project-only MCP manager Ghost injected. */
  private async disposePiSession(hosted: HostedSession): Promise<void> {
    const failures: unknown[] = [];
    await this.collectCleanupFailure(failures, () => this.beginHostedDispose(hosted));
    await this.collectCleanupFailure(failures, () => this.detachHostedOwnership(hosted));
    await this.collectCleanupFailure(failures, () => this.abortHostedBash(hosted));
    await this.collectCleanupFailure(failures, () => this.abortHostedSession(hosted));
    await this.collectCleanupFailure(failures, () => this.closeHostedAsk(hosted));
    await this.collectCleanupFailure(failures, () => hosted.titleAbort?.abort());
    if (hosted.mcp) {
      await this.collectCleanupFailure(failures, () => hosted.mcp?.reload);
      await this.collectCleanupFailure(failures, () => hosted.mcp?.manager.disconnectAll());
      await this.collectCleanupFailure(failures, () => hosted.mcp?.refresh);
      await this.collectCleanupFailure(failures, () => {
        if (MCPManager.instance() === hosted.mcp?.manager) MCPManager.setInstance(undefined);
      });
    }
    await this.collectCleanupFailure(failures, () => hosted.session.dispose());
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
    this.shutdownTasks = [
      Promise.resolve().then(() => this.liveVoice.disposeAll()),
      Promise.resolve().then(() => this.collaboration.disposeAll()),
      Promise.resolve().then(() => this.claudeCode.disposeAll()),
    ];
    for (const hosted of this.sessions.values()) {
      this.launchCleanupStep(hosted, "begin dispose", () => this.beginHostedDispose(hosted));
      this.launchCleanupStep(hosted, "abort bash", () => this.abortHostedBash(hosted));
      this.launchCleanupStep(hosted, "close ask", () => this.closeHostedAsk(hosted));
      this.launchCleanupStep(hosted, "abort title", () => hosted.titleAbort?.abort());
      this.launchCleanupStep(hosted, "abort session", () => this.abortHostedSession(hosted));
    }
  }

  /** Tear down every hosted session. Idempotent; bounded by main's shutdown stage. */
  disposeAll(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.beginShutdown();
    const dispose = (async () => {
      await Promise.allSettled([...this.opening.values()]);
      await Promise.allSettled(
        [...this.sessions.keys()].map((key) => this.closeHostedSession(key, "daemon stopped")),
      );
      await Promise.allSettled([...this.closing.values()].map(({ promise }) => promise));
      await Promise.allSettled(this.shutdownTasks ?? []);
      this.sessions.clear();
    })();
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
    ])];
    this.sessions.clear();
    for (const entry of hosted) {
      this.launchCleanupStep(entry, "force begin dispose", () => this.beginHostedDispose(entry));
      this.launchCleanupStep(entry, "force abort bash", () => this.abortHostedBash(entry));
      this.launchCleanupStep(entry, "force close ask", () => this.closeHostedAsk(entry));
      this.launchCleanupStep(entry, "force abort title", () => entry.titleAbort?.abort());
      this.launchCleanupStep(entry, "force detach ownership", () => this.detachHostedOwnership(entry));
      this.launchCleanupStep(entry, "force abort session", () => this.abortHostedSession(entry));
      if (entry.mcp) {
        this.launchCleanupStep(
          entry,
          "force disconnect MCP",
          () => entry.mcp?.manager.disconnectAll(),
        );
        this.launchCleanupStep(entry, "force clear MCP singleton", () => {
          if (MCPManager.instance() === entry.mcp?.manager) MCPManager.setInstance(undefined);
        });
      }
      this.launchCleanupStep(entry, "force close model runtime", () => this.closeModelRuntime(entry));
      if (!entry.forceDisposeStarted) {
        entry.forceDisposeStarted = true;
        this.launchCleanupStep(entry, "force dispose session", () => entry.session.dispose({
          drainTimeoutMs: 0,
          mnemopiConsolidateTimeoutMs: 0,
        }));
      }
    }
  }
}
