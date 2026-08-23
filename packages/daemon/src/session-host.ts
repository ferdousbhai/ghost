/**
 * Per-ghost chat-runtime lifecycle.
 *
 * Modern Oh My Pi is the default provider-agnostic `AgentSession` harness. An explicit
 * `claude-code` role instead uses the owner-local, Effect-scoped Agent SDK
 * backend in `claude-code.ts`. One daemon process hosts many ghosts
 * concurrently; the OMP path is isolated entirely through SDK options — no env
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
 * 2. **A ghost is not a coding agent.** `noContextFiles`, `noSkills`,
 *    `noPromptTemplates`, and `appendSystemPromptOverride: () => []` together
 *    stop OMP from walking up for `AGENTS.md` / `APPEND_SYSTEM.md` and layering
 *    a coding-agent prompt under the persona. All four are required; the
 *    spike verified that the result is a system prompt containing zero bytes
 *    of OMP's coding-agent prompt.
 *
 * 3. **Project trust is denied by default.** `noExtensions: true` disables
 *    discovery, so a `.ts` file dropped into `~/Ghosts/<name>/.pi/extensions/`
 *    is NOT loaded. A ghost home is user data that may arrive in an imported
 *    archive; treating it as an extension source would be arbitrary code
 *    execution. Only the factories the daemon passes in run.
 *
 * 4. **Only the human-input built-in.** Coding/filesystem built-ins stay on an
 *    explicit denylist. OMP's `ask` is added as a UI bridge, with no tool
 *    approval surface; all other capabilities come from Ghost extensions.
 */
import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
  isVisitorScope,
  readGhostHomeDigest,
  resolveGhostExtensions,
  resolveGhostScope,
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
import { createPiMessagesAdapter, type PiMessagesEvent } from "./pi-messages.js";
import { generateTitle } from "./title.js";
import { createGhostOmpRuntime, type GhostOmpRuntime } from "./omp-runtime.js";
import { AskBroker, AskBrokerError, type PendingAsk } from "./ask-broker.js";

/**
 * OMP's coding/filesystem built-ins. Excluded wholesale so no ghost can shell out or touch
 * the filesystem outside its own extension tools, and so the daemon does not
 * have to know the names of the tools `@ghost/extensions` registers.
 */
export const PI_BUILTIN_TOOL_NAMES: readonly string[] = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
];

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
   * `relayTransport` present, relay sessions point at the creator's real
   * Chromium; `"profile"` (or no transport) uses the per-ghost profile.
   */
  browserMode?: "relay" | "profile";
  /** The daemon's relay hub as a transport, for the relay browser backend. */
  relayTransport?: RelayTransport;
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
}

/** A renderable transcript message: OMP's message shape, reasoning removed. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  content: unknown;
  timestamp?: number;
  entryId: string;
  parentId: string | null;
  /** Sibling user-message branches reachable at this point in the tree. */
  branch?: BranchNavigation;
}

export interface BranchNavigation {
  index: number;
  count: number;
  previousTargetId?: string;
  nextTargetId?: string;
}

export interface AskBranchNavigation extends BranchNavigation {
  /** The active ask toolResult entry; selecting re-answer creates its sibling. */
  resultEntryId: string;
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
  branch: BranchNavigation | undefined,
  askBranches: ReadonlyMap<string, AskBranchNavigation>,
): TranscriptMessage | null {
  const message = entry.message;
  const role = (message as { role?: unknown } | null)?.role;
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
    ...(branch ? { branch } : {}),
  };
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number") projected.timestamp = timestamp;
  return projected;
}

function branchNavigation(
  entry: SessionEntry,
  siblings: readonly SessionEntry[],
  deepestTarget: (entryId: string) => string,
): BranchNavigation | undefined {
  if (siblings.length <= 1) return undefined;
  const index = siblings.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return undefined;
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  return {
    index,
    count: siblings.length,
    ...(previous ? { previousTargetId: deepestTarget(previous.id) } : {}),
    ...(next ? { nextTargetId: deepestTarget(next.id) } : {}),
  };
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

    const settings = Settings.isolated({
      "compaction.enabled": false,
      // Modern OMP owns retry classification, cooldowns, and fallback
      // reversion. Ghost only supplies the role assignments and ordered
      // chains from models.json.
      "retry.modelFallback": true,
      "retry.fallbackRevertPolicy": "cooldown-expiry",
      // Ghost supplies its own scoped `look_at_image` extension. Keep OMP's
      // model-sensitive `inspect_image` builtin from widening that allowlist
      // when a text-only chat model is selected.
      "inspect_image.mode": "off",
      // Ghost has no approval surface by design. Its explicit extension-tool
      // allowlist is the capability boundary.
      "tools.approvalMode": "yolo",
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
    // is written. Creator scope only: onboarding is the owner's ritual, and a
    // visitor is not the person the ghost is trying to become.
    const extraSections = [
      ...(this.extensionOptions.extraSections ?? []),
      ...(this.isFirstMeeting(ghost) ? [FIRST_MEETING_SECTION] : []),
    ];
    const extensions = resolveGhostExtensions({
      ghostName,
      browserMode: this.browserMode,
      ...(this.relayTransport ? { relayTransport: this.relayTransport } : {}),
      ...this.extensionOptions,
      ...(extraSections.length > 0 ? { extraSections } : {}),
    });

    const modelRuntime = await createGhostOmpRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.agentDir),
      // Provider catalogs are fetched only when the daemon is not offline.
      allowModelNetwork: !this.offline,
      settings,
    });

    const sessionManager = await SessionManager.open(
      join(paths.sessionDir, sessionFileNameFor(sessionKey)),
      paths.sessionDir,
      undefined,
      { initialCwd: paths.home },
    );

    const ask = new AskBroker();
    const { session, extensionsResult, setToolUIContext } = await createAgentSession({
      cwd: paths.home,
      agentDir: paths.agentDir,
      settings,
      authStorage: modelRuntime.authStorage,
      modelRegistry: modelRuntime.modelRegistry,
      extensions: extensions.factories,
      disableExtensionDiscovery: true,
      additionalExtensionPaths: [],
      preloadedExtensionPaths: [],
      preloadedCustomToolPaths: [],
      contextFiles: [],
      skills: [],
      rules: [],
      promptTemplates: [],
      slashCommands: [],
      systemPrompt: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
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
      // See decision 4. The allowlist comes from @ghost/extensions (it is
      // scope-dependent — a visitor session has no note writer); the denylist
      // is belt-and-braces so a future built-in cannot appear by name.
      toolNames: [...extensions.toolNames, "ask"],
    });
    setToolUIContext(ask.uiContext, true);

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
      scope: extensions.scope.kind,
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
    };
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

  /**
   * Run one turn, streaming pi-messages events to `emit`.
   *
   * Exactly one terminal `done` or `error` is emitted, always — the pinned
   * client treats a stream that ends without one as a failure.
   */
  async runTurn(ghostName: string, options: RunTurnOptions): Promise<void> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
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
      await hosted.session.prompt(options.prompt);

      let stopHookActive = false;
      let continuationCount = 0;
      while (!adapter.isTerminal() && !options.signal?.aborted && this.hooks.hasHandlers("session_stop")) {
        const messages = [...hosted.session.messages];
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        const result = await this.hooks.emitSessionStop({
          type: "session_stop",
          messages,
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
   * as a pi `session_info` entry, which never enters the model's context.
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
   * the creator's own conversation with a ghost that is still the seed.
   *
   * An unreadable character.md answers "no". Being wrong the other way would
   * push a written ghost back through an interview it has already had, which
   * reads as amnesia rather than as a first meeting.
   */
  private isFirstMeeting(ghost: Ghost): boolean {
    if (isVisitorScope(resolveGhostScope(this.extensionOptions.visitorId))) return false;
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
    let digest: GhostHomeDigest = { character: null, memoryLines: [], noteLines: [] };
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
      // listSessions is newest-updated first, so the head is the last time the
      // owner and this ghost actually spoke.
      const newest = (await this.listSessions(ghost.name))[0]?.updatedAt;
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
      noteLines: digest.noteLines,
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
   * The ghost's conversations, newest-updated first — pi transcripts plus
   * Claude Code resume sidecars, in one shape.
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
    mkdirSync(paths.sessionDir, { recursive: true });
    const [sessions, claudeSessions] = await Promise.all([
      SessionManager.list(paths.home, paths.sessionDir),
      this.claudeCode.listSessions(ghost),
    ]);
    const piSessions: SessionSummary[] = sessions.map((info) => ({
      id: conversationIdFromSessionFile(info.path),
      title: info.title?.trim() ? info.title : null,
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
      messageCount: info.messageCount,
    }));
    const claude: SessionSummary[] = claudeSessions.map((info) => ({
      id: info.conversationId,
      title: "Claude Code",
      createdAt: info.created,
      updatedAt: info.modified,
      messageCount: info.messageCount,
    }));
    return [...piSessions, ...claude].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Read one conversation's messages so the shell can rehydrate it (issue #26).
   *
   * Reuses OMP's own session read: the transcript file is opened read-only and
   * its message entries are projected to the same `{ role, content }` shape a
   * pi-messages client renders. Private reasoning (`thinking` blocks) and
   * internal `toolResult` messages are dropped — exactly what the live wire
   * omits — so a resumed conversation shows what the visitor actually saw.
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
    const entries = manager.getEntries();
    const active = manager.getBranch();
    const children = new Map<string | null, SessionEntry[]>();
    const order = new Map<string, number>();
    for (const [index, entry] of entries.entries()) {
      order.set(entry.id, index);
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry);
      children.set(entry.parentId, siblings);
    }
    const deepestTarget = (entryId: string): string => {
      let best = entryId;
      let bestOrder = order.get(entryId) ?? -1;
      const stack = [entryId];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) break;
        if (visited.has(current)) continue;
        visited.add(current);
        const descendants = children.get(current) ?? [];
        if (descendants.length === 0) {
          const candidateOrder = order.get(current) ?? -1;
          if (candidateOrder >= bestOrder) {
            best = current;
            bestOrder = candidateOrder;
          }
        } else {
          for (const child of descendants) stack.push(child.id);
        }
      }
      return best;
    };

    const askBranches = new Map<string, AskBranchNavigation>();
    for (const entry of active) {
      if (entry.type !== "message" || entry.message.role !== "toolResult"
        || entry.message.toolName !== "ask") continue;
      const toolCallId = entry.message.toolCallId;
      const siblings = (children.get(entry.parentId) ?? []).filter(
        (candidate): candidate is Extract<SessionEntry, { type: "message" }> =>
          candidate.type === "message"
          && candidate.message.role === "toolResult"
          && candidate.message.toolName === "ask"
          && candidate.message.toolCallId === toolCallId,
      );
      const navigation = branchNavigation(entry, siblings, deepestTarget)
        ?? { index: 0, count: 1 };
      askBranches.set(toolCallId, {
        ...navigation,
        resultEntryId: entry.id,
      });
    }

    const all: TranscriptMessage[] = [];
    for (const entry of active) {
      if (entry.type !== "message") continue;
      const userSiblings = entry.message.role === "user"
        ? (children.get(entry.parentId) ?? []).filter(
            (candidate): candidate is Extract<SessionEntry, { type: "message" }> =>
              candidate.type === "message" && candidate.message.role === "user",
          )
        : [];
      const message = projectTranscriptMessage(
        entry,
        entry.message.role === "user"
          ? branchNavigation(entry, userSiblings, deepestTarget)
          : undefined,
        askBranches,
      );
      if (message) all.push(message);
    }
    const total = all.length;
    const limit = clampTranscriptLimit(options.limit);
    const offset = Math.min(clampTranscriptOffset(options.offset), total);
    const messages = all.slice(offset, offset + limit);
    return {
      id,
      title: manager.getSessionName() ?? null,
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

  /** Rewind before one user message and return its text as an editable branch draft. */
  async branchConversation(
    ghostName: string,
    conversationId: string | null | undefined,
    entryId: string,
  ): Promise<{ draft: string; transcript: Transcript }> {
    const hosted = await this.idleHostedSession(ghostName, conversationId);
    const entry = hosted.session.sessionManager.getEntry(entryId);
    if (entry?.type !== "message" || entry.message.role !== "user") {
      throw new GhostError("invalid_branch", "Only a persisted user message can start an editable branch.", 400);
    }
    hosted.busy = true;
    try {
      const result = await hosted.session.navigateTree(entryId);
      if (result.cancelled) throw new GhostError("branch_cancelled", "Conversation branching was cancelled.", 409);
      return {
        draft: result.editorText ?? "",
        transcript: this.transcriptFromManager(
          conversationId || DEFAULT_SESSION_KEY,
          hosted.session.sessionManager,
        ),
      };
    } finally {
      hosted.busy = false;
    }
  }

  /** Switch the active leaf to an existing sibling branch. */
  async navigateConversation(
    ghostName: string,
    conversationId: string | null | undefined,
    targetId: string,
  ): Promise<{ transcript: Transcript }> {
    const hosted = await this.idleHostedSession(ghostName, conversationId);
    hosted.busy = true;
    try {
      const result = await hosted.session.navigateTree(targetId);
      if (result.cancelled) throw new GhostError("branch_cancelled", "Branch navigation was cancelled.", 409);
      return {
        transcript: this.transcriptFromManager(
          conversationId || DEFAULT_SESSION_KEY,
          hosted.session.sessionManager,
        ),
      };
    } finally {
      hosted.busy = false;
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
        hasUI: true,
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
      this.logger.info("deleted ghost conversation", { ghost: ghostName, session: id });
    } finally {
      this.deleting.delete(key);
    }
  }

  private async closePi(ghostName: string, sessionId?: string | null): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    const hosted = this.sessions.get(key);
    if (!hosted) return;
    this.sessions.delete(key);
    if (hosted.busy) await hosted.session.abort();
    hosted.ask.close();
    try {
      await hosted.session.dispose();
    } finally {
      hosted.modelRuntime.close();
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
        if (entry.busy) await entry.session.abort();
        entry.ask.close();
        try {
          await entry.session.dispose();
        } finally {
          entry.modelRuntime.close();
        }
      } catch (error) {
        this.logger.warn("session disposal failed", { error: (error as Error).message });
      }
    }
  }
}
