/**
 * Per-ghost chat-runtime lifecycle.
 *
 * Modern Oh My Pi is the default provider-agnostic `AgentSession` harness. An explicit
 * `claude-code` role instead uses the owner-local, Effect-scoped Agent SDK
 * backend in `claude-code.ts`. One daemon process hosts many ghosts
 * concurrently; the OMP path is scoped entirely through SDK options — no env
 * var, no child process — following the spike (`pi-spike/concurrent-ghosts.mjs`):
 *
 *   cwd        = ~/Ghosts/<name>            the ghost home; extensions derive
 *                                           their paths from ctx.cwd
 *   agentDir   = ~/Ghosts/<name>/.pi        settings, models.json, agent.db
 *   sessionDir = ~/Ghosts/<name>/.sessions  transcripts
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
import { visitEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
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
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeRuntime,
  type ClaudeCodeRuntimeOptions,
} from "./claude-code.js";
import {
  DEFAULT_COMPACTION_CONFIG,
  maybeCompact,
  type CompactionConfig,
} from "./compaction.js";
import { scrubProviderEnv } from "./env-scrub.js";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
} from "./hooks.js";
import {
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
  resolveSmolModelRef,
  type GhostModelRoleBinding,
} from "./models.js";
import {
  createPiMessagesAdapter,
  type PiMessagesEvent,
  zeroUsage,
} from "./pi-messages.js";
import { readPins, writePins } from "./pins.js";
import { generateTitle } from "./title.js";
import { createGhostOmpRuntime, type GhostOmpRuntime } from "./omp-runtime.js";
import { AskBroker, AskBrokerError, type PendingAsk } from "./ask-broker.js";

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
}) => Promise<string>;

export interface TitleConfig {
  /** Master switch. Defaults to enabled. */
  enabled?: boolean;
  /** Test seam: replace the default title generator. */
  generate?: TitleGenerator;
}

/** The default: resolve smol_model against the session's own runtime, complete once. */
const defaultTitleGenerator: TitleGenerator = async ({ runtime, agentDir, firstPrompt }) => {
  let ref = null;
  try {
    ref = resolveSmolModelRef(readGhostModels(agentDir));
  } catch {
    // A broken models.json is not fatal to titling: fall back to cheapest usable.
    ref = null;
  }
  return generateTitle({ runtime, firstPrompt, ref });
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
   * Seconds a question waits before answering itself with its recommended
   * option. Daemon-wide; see DaemonConfig.askTimeoutSeconds for why it is not
   * a property of the ghost. `0` (the default here) waits forever.
   */
  askTimeoutSeconds?: number;
  /**
   * Background compaction policy. Defaults to enabled at
   * `min(0.8 × contextWindow, 100_000)` tokens. See compaction.ts.
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
  /** Awaited Ghost-owned lifecycle hooks, shared by every model harness. */
  hooks?: GhostHookRunner;
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

export type QueueMode = "steer" | "followUp";

interface HostedMCP {
  manager: MCPManager;
  /** Serialized dynamic MCP tool refreshes; never rejects. */
  refresh?: Promise<void>;
}

interface HostedSession extends GhostSessionHandle {
  busy: boolean;
  /** HTTP-backed implementation of OMP's built-in `ask` UI contract. */
  ask: AskBroker;
  /**
   * The runtime this session's model was bound from, kept so a later model
   * switch can re-resolve against the same catalogue the session was built
   * with (see `rebindModel`).
   */
  modelRuntime: GhostOmpRuntime;
  /**
   * Set when a model switch arrived while this session was mid-turn: the model
   * is not yanked out from under a running prompt, it is rebound in runTurn's
   * `finally` once the turn settles.
   */
  pendingRebind?: boolean;
  /**
   * The in-flight background compaction, if any. A turn awaits this before
   * prompting, because OMP's `session.prompt()` throws while a manual
   * compaction is running. Resolves (never rejects) when compaction settles.
   */
  compaction?: Promise<void>;
  /**
   * The in-flight background title generation, if any. `listSessions` awaits it
   * so a just-generated title shows up in the listing; it never blocks a turn.
   * Resolves (never rejects) when title generation settles.
   */
  title?: Promise<void>;
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
 * otherwise be read as belonging to a different ghost. An empty/missing
 * sessionId collapses to DEFAULT_SESSION_KEY, matching how the on-disk
 * transcript is named in createSession.
 */
export function sessionKeyOf(
  ghostName: string,
  sessionId: string | null | undefined,
): string {
  return JSON.stringify([ghostName, sessionId || DEFAULT_SESSION_KEY]);
}

/** The (ghost, conversation) halves back out of a `sessionKeyOf` key. */
function sessionKeyParts(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

/**
 * Map a conversation id onto a session filename. Ids come from a client and
 * may contain anything; a hash suffix keeps two ids that sanitize alike from
 * colliding onto one transcript.
 */
export function sessionFileNameFor(sessionKey: string): string {
  const safe = sessionKey.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  const needsHash = safe !== sessionKey;
  if (!needsHash && safe.length > 0) return `${safe}.jsonl`;
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
  return `${safe || "session"}-${digest}.jsonl`;
}

/**
 * Recover the conversation id from a transcript file path — the inverse of
 * `sessionFileNameFor` for any filename-safe id (which is what a client should
 * send). The listing returns this so the shell can resume the conversation via
 * the same id it passes as `options.sessionId`.
 */
export function conversationIdFromSessionFile(sessionFile: string): string {
  const base = sessionFile.slice(sessionFile.lastIndexOf(sep) + 1);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/** One row in the conversation listing. Titles are null until generated. */
export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
}

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
function askSettlement(details: unknown): AskSettlement {
  if (details === null || typeof details !== "object") return "cancelled";
  const record = details as {
    chatRedirect?: unknown;
    results?: unknown;
    selectedOptions?: unknown;
    customInput?: unknown;
    timedOut?: unknown;
  };
  if (record.chatRedirect === true) return "chat";
  const timedOut = (item: unknown) =>
    (item as { timedOut?: unknown } | null)?.timedOut === true;
  if (Array.isArray(record.results) && record.results.length > 0) {
    return record.results.some(timedOut) ? "timedOut" : "submitted";
  }
  if (Array.isArray(record.selectedOptions) || typeof record.customInput === "string") {
    return record.timedOut === true ? "timedOut" : "submitted";
  }
  return "cancelled";
}

/** A conversation's history for rehydration in the shell. */
export interface Transcript {
  id: string;
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
 */
function projectTranscriptMessage(
  entry: Extract<SessionEntry, { type: "message" }>,
  askBranches: ReadonlyMap<string, AskBranchNavigation>,
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
      return askBranch ? { ...(part as object), ghostAsk: askBranch } : part;
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
  const configPaths = [
    join(ghostHome, ".omp", "mcp.json"),
    join(ghostHome, ".omp", ".mcp.json"),
  ];

  // Match OMP's native provider precedence: mcp.json wins over the legacy
  // .mcp.json when both declare the same server name.
  for (const configPath of configPaths) {
    try {
      const document = await readMCPConfigFile(configPath);
      const servers = document.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
      for (const [name, rawConfig] of Object.entries(servers)) {
        if (Object.hasOwn(configs, name) || rawConfig.enabled === false) continue;
        configs[name] = expandEnvVarsDeep(rawConfig);
        sources[name] = {
          provider: "native",
          providerName: "OMP",
          path: configPath,
          level: "project",
        };
      }
    } catch (error) {
      logger.error("ghost project MCP config failed to load", {
        path: configPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
  /** Seconds an unanswered ask waits before it answers itself; 0 waits forever. */
  private readonly askTimeoutSeconds: number;
  private readonly generateTitle: TitleGenerator;
  private readonly greetingEnabled: boolean;
  private readonly greetings: GreetingCache;
  private readonly generateGreetingFor: GreetingGenerator;
  private readonly claudeCode: ClaudeCodeRuntime;
  private readonly hooks: GhostHookRunner;
  private readonly sessions = new Map<string, HostedSession>();
  /** In-flight opens, so two concurrent turns never build two sessions. */
  private readonly opening = new Map<string, Promise<HostedSession>>();
  /** Conversation ids reserved by a destructive delete operation. */
  private readonly deleting = new Set<string>();
  /** Ghost names reserved by an in-flight `deleteGhost`. */
  private readonly deletingGhosts = new Set<string>();
  /** Read-through cache for legacy titles that have not had a writable open yet. */
  private readonly legacyTitles = new Map<
    string,
    { modifiedMs: number; size: number; title: string | null }
  >();
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

  /** Open (or reuse) the pi session for one ghost + conversation. */
  async open(
    ghostName: string,
    sessionId?: string | null,
  ): Promise<GhostSessionHandle> {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    const key = this.keyOf(ghostName, sessionId);
    if (this.deleting.has(key)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish deleting before opening it.",
        409,
      );
    }
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.opening.get(key);
    if (pending) return pending;

    const promise = this.createSession(ghostName, sessionId || DEFAULT_SESSION_KEY, key)
      .then((hosted) => {
        this.sessions.set(key, hosted);
        return hosted;
      })
      .finally(() => {
        this.opening.delete(key);
      });
    this.opening.set(key, promise);
    return promise;
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

    const settingsOverrides: Partial<Record<SettingPath, unknown>> = {
      "compaction.enabled": false,
      // Modern OMP owns retry classification, cooldowns, and fallback
      // reversion. Ghost only supplies the role assignments and ordered
      // chains from models.json.
      "retry.modelFallback": true,
      "retry.fallbackRevertPolicy": "cooldown-expiry",
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
      // Ghost has no approval surface. Sessions are explicitly local and unrestricted.
      "tools.approvalMode": "yolo",
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
    // OMP's *automatic* compaction is left off (this `enabled: false` is exactly
    // what gates its `_checkCompaction`), because its auto path both blocks the
    // next turn and gives no hook for our own summary prompt. Compaction is
    // instead driven from runTurn via `maybeCompact` — see compaction.ts. The
    // manual `session.compact()` path ignores this flag, so disabling the auto
    // trigger here does not disable compaction itself.
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
    );

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

    const sessionManager = await SessionManager.open(
      join(paths.sessionDir, sessionFileNameFor(sessionKey)),
      paths.sessionDir,
      undefined,
      { initialCwd: paths.home },
    );
    await this.promoteLegacySessionTitle(sessionManager, ghostName, sessionKey);

    const ask = new AskBroker(this.askTimeoutSeconds);
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
        // that does not exist yet creates it, so a conversation id maps to a
        // stable transcript across daemon restarts.
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

    if (mcp && mcp.manager.getAllServerNames().length > 0) {
      // Injected managers are borrowed in OMP's ownership model, so Ghost must
      // bridge initial and notification-driven tool catalogs into this session.
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
    }

    for (const error of extensionsResult.errors ?? []) {
      this.logger.error("extension failed to load", {
        ghost: ghostName,
        path: error.path,
        error: String(error.error),
      });
    }

    const toolNames = session.getActiveToolNames();
    const model = await this.selectModel(session, modelRuntime, paths.agentDir, ghostName);

    this.logger.info("ghost session opened", {
      ghost: ghostName,
      session: sessionKey,
      tools: toolNames.length,
      model: model ? `${model.provider}/${model.id}` : null,
    });

    return {
      ghost,
      sessionKey: key,
      session,
      sessionFile: session.sessionFile,
      model,
      modelRuntime,
      busy: false,
      ask,
      turnId: 0,
      ...(mcp ? { mcp } : {}),
    };
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
  pendingAsk(ghostName: string, sessionId?: string | null): PendingAsk | null {
    this.registry.get(ghostName);
    return this.sessions.get(this.keyOf(ghostName, sessionId))?.ask.pending ?? null;
  }

  /** Resolve the current ask. AskBroker validates ids/options and is first-response-wins. */
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

  queuedMessages(ghostName: string, sessionId?: string | null): QueuedMessages {
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
  ): Promise<QueuedMessages> {
    this.registry.get(ghostName);
    const hosted = this.sessions.get(this.keyOf(ghostName, sessionId));
    if (!hosted?.busy || !hosted.session.isStreaming) {
      throw new GhostError(
        "session_not_streaming",
        "This conversation is not currently streaming; send a normal message instead.",
        409,
      );
    }
    if (mode === "followUp") await hosted.session.followUp(text);
    else await hosted.session.steer(text);
    return this.queuedMessages(ghostName, sessionId);
  }

  /**
   * Re-bind the chat model on every live session for one ghost.
   *
   * A cached `AgentSession` binds its model exactly once, at construction
   * (createSession → selectModel). The model switcher writes a new
   * `roles.chat_model` to models.json but holds no reference to a running
   * session, so without this a switch never reaches a conversation that is
   * already open: `GET /model` would report the new model while every further
   * turn kept answering on the old one (there is no idle eviction).
   * `ModelCatalog.setChatModel` calls this right after the write.
   *
   * A busy session is not yanked mid-turn — OMP's active run keeps the model it
   * started on. It is flagged instead and rebound in runTurn's `finally`, once
   * the current turn settles and before the next one begins.
   *
   * Claude Code sessions need no rebinding: they are scoped per turn and read
   * `roles.chat_model` fresh each time (see runTurn), so the next turn already
   * picks up the switch — and a stale pi session for the same conversation is
   * dropped by `closePi` on that next turn.
   */
  async rebindModel(ghostName: string): Promise<void> {
    for (const hosted of this.sessions.values()) {
      if (hosted.ghost.name !== ghostName) continue;
      if (hosted.busy) {
        hosted.pendingRebind = true;
        continue;
      }
      await this.rebindSessionModel(hosted, ghostName);
    }
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
   * Bind the ghost's chat model.
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
    }
    if (ref) {
      const model = modelRuntime.modelRegistry.find(ref.provider, ref.modelId);
      if (model) {
        // Await the bind: a fire-and-forget setModel can lose the race with
        // the first prompt, which would then run on OMP's default model.
        await session.setModel(model, "default");
        return { provider: model.provider, id: model.id };
      }
      this.logger.warn("configured chat model is not available", {
        ghost: ghostName,
        provider: ref.provider,
        modelId: ref.modelId,
      });
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
    const conversationId = options.sessionId || DEFAULT_SESSION_KEY;
    if (this.claudeCode.isBusy(ghostName, conversationId)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }

    const hosted = (await this.open(ghostName, options.sessionId)) as HostedSession;
    if (hosted.busy || hosted.session.isBashRunning) {
      throw new GhostError(
        "session_busy",
        "This ghost is already working in this conversation.",
        409,
      );
    }
    hosted.busy = true;
    if (hosted.compaction) await hosted.compaction;

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
      hosted.busy = false;
      if (hosted.pendingRebind) {
        hosted.pendingRebind = false;
        await this.rebindSessionModel(hosted, ghostName);
      }
      this.startBackgroundCompaction(hosted, ghostName);
    }
  }

  /**
   * Run one turn, streaming pi-messages events to `emit`.
   *
   * Exactly one terminal `done` or `error` is emitted, always — the pinned
   * client treats a stream that ends without one as a failure.
   */
  async runTurn(ghostName: string, options: RunTurnOptions): Promise<void> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const bashCommand = parseUserBashCommand(options.prompt);
    if (bashCommand) {
      if (!bashCommand.command) {
        throw new GhostError("invalid_request", "Write a command after ! or !!.", 400);
      }
      await this.runUserBash(ghostName, bashCommand, options);
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
      const conversationId = options.sessionId || DEFAULT_SESSION_KEY;
      // A model switch must not leave a stale pi AgentSession owning this
      // conversation. Claude itself is scoped per turn and keeps only its
      // opaque resume id between turns.
      const piSession = this.sessions.get(this.keyOf(ghostName, options.sessionId));
      if (piSession?.busy) {
        throw new GhostError(
          "session_busy",
          "This ghost is already answering in this conversation.",
          409,
        );
      }
      await this.closePi(ghostName, options.sessionId);
      if (this.deleting.has(this.keyOf(ghostName, options.sessionId))) {
        throw new GhostError(
          "session_busy",
          "Wait for this conversation to finish deleting before opening it.",
          409,
        );
      }
      await this.claudeCode.runTurn(ghost, conversationId, configured.modelId, options);
      return;
    }

    const conversationId = options.sessionId || DEFAULT_SESSION_KEY;
    if (this.claudeCode.isBusy(ghostName, conversationId)) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }

    const hosted = (await this.open(ghostName, options.sessionId)) as HostedSession;
    if (hosted.busy) {
      throw new GhostError(
        "session_busy",
        "This ghost is already answering in this conversation.",
        409,
      );
    }
    hosted.busy = true;

    // Decide, BEFORE prompting, whether this turn should name the conversation:
    // titling is on, the conversation has no title yet, and this is its first
    // turn (no assistant message so far — a resumed transcript already has one).
    // `options.prompt` is then the first user message the title is built from.
    const shouldTitle = this.titleEnabled
      && !hosted.session.sessionName
      && !hosted.session.messages.some((message) => message.role === "assistant");

    // A background compaction from the previous turn may still be running.
    // OMP's `session.prompt()` throws while a manual compaction is in progress,
    // so wait it out first. This is the only place a turn can be delayed by
    // compaction, and only when the user returns before it finished; the
    // awaited promise never rejects (errors were already routed to the log).
    if (hosted.compaction) await hosted.compaction;

    const adapter = createPiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
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
      hosted.busy = false;
      // A model switch that arrived mid-turn was deferred rather than applied to
      // the running prompt; apply it now the turn has settled — before the next
      // turn, and before compaction so any summary runs on the new model.
      if (hosted.pendingRebind) {
        hosted.pendingRebind = false;
        await this.rebindSessionModel(hosted, ghostName);
      }
      // Kick compaction AFTER unsubscribing and releasing the turn: it must run
      // on an idle session (OMP's compact() aborts any active run), and its
      // compaction_start/end events must not leak into this turn's stream.
      this.startBackgroundCompaction(hosted, ghostName);
      // Name the conversation from its first message, fire-and-forget. Runs
      // after the reply is fully delivered and never blocks the next turn.
      if (shouldTitle) {
        this.startBackgroundTitle(hosted, ghostName, paths.agentDir, options.prompt);
      }
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
    const promise = this.generateTitle({
      session: hosted.session,
      runtime: hosted.modelRuntime,
      ghostName,
      agentDir,
      firstPrompt,
    })
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
      })
      .catch((error: unknown) => {
        this.logger.warn("conversation title generation failed", {
          ghost: ghostName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const tracked: Promise<void> = promise.finally(() => {
      if (hosted.title === tracked) hosted.title = undefined;
    });
    hosted.title = tracked;
  }

  /**
   * Fire-and-forget background compaction if the context is over threshold.
   * Non-blocking by construction: the promise is stored on the session so the
   * next turn can await it (see runTurn), but this method never awaits and
   * never throws — a failure is logged and the conversation continues on the
   * un-compacted context.
   */
  private startBackgroundCompaction(hosted: HostedSession, ghostName: string): void {
    const promise = maybeCompact(hosted.session, this.compactionConfig, {
      onStart: (info) => {
        this.logger.info("compacting ghost context", { ghost: ghostName, ...info });
      },
      onError: (error) => {
        this.logger.error("compaction failed", { ghost: ghostName, error: error.message });
      },
    });
    if (!promise) return;
    const tracked: Promise<void> = promise.finally(() => {
      // Clear only if no newer compaction has replaced this one.
      if (hosted.compaction === tracked) hosted.compaction = undefined;
    });
    hosted.compaction = tracked;
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
   * `id` is the conversation id the shell uses to resume (the pi-messages
   * `options.sessionId`), recovered from the transcript filename; `title` is
   * null until the background titler names it. Any in-flight title write for
   * this ghost is awaited first, so a title generated by the turn that just
   * finished is already visible here.
   */
  async listSessions(ghostName: string): Promise<SessionSummary[]> {
    const inflightTitles = [...this.sessions.values()]
      .filter((hosted) => hosted.ghost.name === ghostName && hosted.title)
      .map((hosted) => hosted.title as Promise<void>);
    if (inflightTitles.length > 0) await Promise.allSettled(inflightTitles);

    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const [rows, pins] = await Promise.all([
      this.collectSessions(ghost),
      readPins(paths.sessionDir),
    ]);
    // A pin whose conversation is gone is simply not seen here; the next write
    // prunes it.
    const pinned = new Set(pins);
    return rows
      .map((row) => ({ ...row, pinned: pinned.has(row.id) }))
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
    const ghost = this.registry.get(ghostName);
    const id = sessionId || DEFAULT_SESSION_KEY;
    const paths = ghostPaths(ghost.dir);
    const existing = new Set((await this.collectSessions(ghost)).map((row) => row.id));
    if (!existing.has(id)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(id)}.`,
        404,
      );
    }
    const kept = (await readPins(paths.sessionDir))
      .filter((pin) => pin !== id && existing.has(pin));
    await writePins(paths.sessionDir, pinned ? [...kept, id] : kept);
  }

  /** Every stored conversation for one ghost, before pin state is applied. */
  private async collectSessions(ghost: Ghost): Promise<Omit<SessionSummary, "pinned">[]> {
    const paths = ghostPaths(ghost.dir);
    mkdirSync(paths.sessionDir, { recursive: true });
    const [sessions, claudeSessions] = await Promise.all([
      SessionManager.list(paths.home, paths.sessionDir),
      this.claudeCode.listSessions(ghost),
    ]);
    const ompSessions = await Promise.all(sessions.map(async (info) => {
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
      return {
        id: conversationIdFromSessionFile(info.path),
        title,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
      };
    }));
    return [
      ...ompSessions,
      ...claudeSessions.map((info) => ({
        id: info.conversationId,
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
  ): Promise<Transcript> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const id = conversationId || DEFAULT_SESSION_KEY;
    const path = join(paths.sessionDir, sessionFileNameFor(id));
    if (!existsSync(path)) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(id)}.`,
        404,
      );
    }
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
    for (const entry of active) {
      if (entry.type !== "message" || entry.message.role !== "toolResult"
        || entry.message.toolName !== "ask") continue;
      askBranches.set(entry.message.toolCallId, {
        resultEntryId: entry.id,
        settled: askSettlement(entry.message.details),
      });
    }

    const all: TranscriptMessage[] = [];
    for (const entry of active) {
      if (entry.type !== "message") continue;
      const message = projectTranscriptMessage(entry, askBranches);
      if (message) all.push(message);
    }
    const total = all.length;
    const limit = clampTranscriptLimit(options.limit);
    const offset = Math.min(clampTranscriptOffset(options.offset), total);
    const messages = all.slice(offset, offset + limit);
    return {
      id,
      title: manager.getSessionName() ?? legacySessionTitle(manager.getEntries()),
      messages,
      total,
      truncated: offset > 0 || offset + messages.length < total,
    };
  }

  private async idleHostedSession(
    ghostName: string,
    conversationId: string | null | undefined,
  ): Promise<HostedSession> {
    const hosted = (await this.open(ghostName, conversationId)) as HostedSession;
    if (hosted.busy || hosted.session.isStreaming) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before changing branches.",
        409,
      );
    }
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
    sessionId: string;
    title: string | null;
    draft: string;
    transcript: Transcript;
  }> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const sourceId = conversationId || DEFAULT_SESSION_KEY;
    // `open` would happily create the conversation being branched from; an id
    // that names neither a live session nor a stored transcript is a 404, not a
    // brand-new empty conversation.
    if (!this.sessions.has(this.keyOf(ghostName, conversationId))
      && !existsSync(join(paths.sessionDir, sessionFileNameFor(sourceId)))) {
      throw new GhostError(
        "not_found",
        `This ghost has no conversation ${JSON.stringify(sourceId)}.`,
        404,
      );
    }
    const source = await this.idleHostedSession(ghostName, conversationId);
    const sourceManager = source.session.sessionManager;
    const entry = sourceManager.getEntry(entryId);
    if (entry?.type !== "message" || entry.message.role !== "user") {
      throw new GhostError("invalid_branch", "Only a persisted user message can start an editable branch.", 400);
    }
    const forkId = `branch-${randomUUID()}`;
    // Hold the source for the copy only. It is never written to: the flag just
    // keeps a turn from appending to the transcript being copied.
    source.busy = true;
    try {
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
        // Pin the copy's path so its conversation id is the same round-trip
        // `sessionFileNameFor`/`conversationIdFromSessionFile` pair every other
        // conversation uses, and `open`/`listSessions` find it unaided.
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
      source.busy = false;
    }

    // From here the copy exists on disk and would show up in the sidebar, so
    // every failure has to take it back out again: a branch the user was told
    // was refused must not leave a titled duplicate behind.
    try {
      const hosted = await this.idleHostedSession(ghostName, forkId);
      hosted.busy = true;
      try {
        const result = await hosted.session.navigateTree(entryId);
        if (result.cancelled) throw new GhostError("branch_cancelled", "Conversation branching was cancelled.", 409);
        return {
          sessionId: forkId,
          title: hosted.session.sessionManager.getSessionName() ?? null,
          draft: result.editorText ?? "",
          transcript: this.transcriptFromManager(forkId, hosted.session.sessionManager),
        };
      } finally {
        hosted.busy = false;
      }
    } catch (error) {
      await this.discardFork(ghostName, forkId);
      throw error;
    }
  }

  /**
   * Undo a fork that never reached the user, through the same removal an
   * ordinary conversation delete uses so the two cannot drift. Best-effort by
   * construction: the error that brought us here is the one worth reporting.
   */
  private async discardFork(ghostName: string, forkId: string): Promise<void> {
    try {
      await this.deleteSession(ghostName, forkId);
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
    const hosted = await this.idleHostedSession(ghostName, options.sessionId);
    hosted.busy = true;
    const adapter = createPiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
      deferAgentEnd: true,
    });
    const unsubscribe = hosted.session.subscribe((event: AgentSessionEvent) => adapter.handle(event));
    const onAbort = () => {
      hosted.ask.close();
      void hosted.session.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const syntheticId = `ask-reanswer-${options.entryId}`;
    try {
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
          options.sessionId || DEFAULT_SESSION_KEY,
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
      unsubscribe();
      hosted.busy = false;
    }
  }

  /** Drop one hosted session (aborting an in-flight turn). */
  async close(ghostName: string, sessionId?: string | null): Promise<void> {
    await this.claudeCode.close(ghostName, sessionId || DEFAULT_SESSION_KEY);
    await this.closePi(ghostName, sessionId);
  }

  /** Permanently delete one idle conversation, regardless of its runtime. */
  async deleteSession(ghostName: string, sessionId?: string | null): Promise<void> {
    const ghost = this.registry.get(ghostName);
    const id = sessionId || DEFAULT_SESSION_KEY;
    const key = this.keyOf(ghostName, sessionId);
    const hosted = this.sessions.get(key);
    if (this.deleting.has(key) || this.opening.has(key) || hosted?.busy
      || this.claudeCode.isBusy(ghostName, id)) {
      throw new GhostError(
        "session_busy",
        "Wait for this conversation to finish before deleting it.",
        409,
      );
    }

    this.deleting.add(key);
    try {
      // Title generation and compaction can still append to an otherwise-idle
      // transcript. Let them settle before disposal so deletion cannot race a
      // late write that recreates the file.
      const background = [hosted?.title, hosted?.compaction]
        .filter((task): task is Promise<void> => task !== undefined);
      if (background.length > 0) await Promise.allSettled(background);

      await this.closePi(ghostName, sessionId);
      const paths = ghostPaths(ghost.dir);
      const piPath = join(paths.sessionDir, sessionFileNameFor(id));
      let deleted = await this.claudeCode.deleteSession(ghost, id);
      try {
        await unlink(piPath);
        this.legacyTitles.delete(piPath);
        deleted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!deleted) {
        throw new GhostError(
          "not_found",
          `This ghost has no conversation ${JSON.stringify(id)}.`,
          404,
        );
      }
      const pins = await readPins(paths.sessionDir);
      if (pins.includes(id)) {
        await writePins(paths.sessionDir, pins.filter((pin) => pin !== id));
      }
      this.logger.info("deleted ghost conversation", { ghost: ghostName, session: id });
    } finally {
      this.deleting.delete(key);
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
    if (this.deletingGhosts.has(ghost.name) || this.ghostBusy(ghost.name)) {
      throw new GhostError(
        "ghost_busy",
        "Wait for this ghost's conversations to finish before deleting it.",
        409,
      );
    }

    this.deletingGhosts.add(ghost.name);
    try {
      const hosted = [...this.sessions].filter(([key]) =>
        sessionKeyParts(key)[0] === ghost.name);
      // Title generation and compaction can still append to an otherwise-idle
      // transcript. Let them settle before the home moves out from under them.
      const background = hosted
        .flatMap(([, entry]) => [entry.title, entry.compaction])
        .filter((task): task is Promise<void> => task !== undefined);
      if (background.length > 0) await Promise.allSettled(background);

      for (const [key] of hosted) await this.closePi(ghost.name, sessionKeyParts(key)[1]);
      await this.claudeCode.closeGhost(ghost.name);

      const trashed = this.registry.trash(ghost.name);
      // A ghost re-summoned under this name must not inherit the old one's
      // opening line.
      this.greetings.clear(ghost.name);
      this.logger.info("trashed ghost", { ghost: ghost.name, trash: trashed.trash });
      return trashed;
    } finally {
      this.deletingGhosts.delete(ghost.name);
    }
  }

  /** True while any conversation of this ghost is busy, opening, or mid-delete. */
  private ghostBusy(ghostName: string): boolean {
    for (const [key, hosted] of this.sessions) {
      if (hosted.busy && sessionKeyParts(key)[0] === ghostName) return true;
    }
    for (const key of [...this.opening.keys(), ...this.deleting]) {
      if (sessionKeyParts(key)[0] === ghostName) return true;
    }
    return this.claudeCode.isGhostBusy(ghostName);
  }

  private async closePi(ghostName: string, sessionId?: string | null): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    const hosted = this.sessions.get(key);
    if (!hosted) return;
    this.sessions.delete(key);
    await this.disposePiSession(hosted);
  }

  /** Dispose one OMP session and the project-only MCP manager Ghost injected. */
  private async disposePiSession(hosted: HostedSession): Promise<void> {
    if (hosted.busy) {
      hosted.session.abortBash();
      await hosted.session.abort();
    }
    hosted.ask.close();
    try {
      if (hosted.mcp) {
        try {
          await hosted.mcp.manager.disconnectAll();
        } finally {
          await hosted.mcp.refresh;
          if (MCPManager.instance() === hosted.mcp.manager) MCPManager.setInstance(undefined);
        }
      }
    } finally {
      try {
        await hosted.session.dispose();
      } finally {
        hosted.modelRuntime.close();
      }
    }
  }

  /** Tear down every hosted session. Idempotent. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    await this.claudeCode.disposeAll();
    const hosted = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of hosted) {
      try {
        await this.disposePiSession(entry);
      } catch (error) {
        this.logger.warn("session disposal failed", { error: (error as Error).message });
      }
    }
  }
}
