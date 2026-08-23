/**
 * Per-ghost chat-runtime lifecycle.
 *
 * pi remains the default provider-agnostic `AgentSession` harness. An explicit
 * `claude-code` role instead uses the owner-local, Effect-scoped Agent SDK
 * backend in `claude-code.ts`. One daemon process hosts many ghosts
 * concurrently; the pi path is isolated entirely through SDK options — no env
 * var, no child process — following the spike (`pi-spike/concurrent-ghosts.mjs`):
 *
 *   cwd        = ~/Ghosts/<name>            the ghost home; extensions derive
 *                                           their paths from ctx.cwd
 *   agentDir   = ~/Ghosts/<name>/.pi        settings.json, models.json, auth.json
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
 *    stop pi from walking up for `AGENTS.md` / `APPEND_SYSTEM.md` and layering
 *    a coding-agent prompt under the persona. All four are required; the
 *    spike verified that the result is a system prompt containing zero bytes
 *    of pi's own.
 *
 * 3. **Project trust is denied by default.** `noExtensions: true` disables
 *    discovery, so a `.ts` file dropped into `~/Ghosts/<name>/.pi/extensions/`
 *    is NOT loaded. A ghost home is user data that may arrive in an imported
 *    archive; treating it as an extension source would be arbitrary code
 *    execution. Only the factories the daemon passes in run.
 *
 * 4. **No built-in tools.** `noTools: "all"` plus an `excludeTools` denylist
 *    of every pi built-in means a ghost can never reach bash, the filesystem,
 *    or a browser. Its tools are exactly the ones its extensions register.
 */
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
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
  resolveGhostExtensions,
  type GhostExtensionOptions,
  type RelayTransport,
} from "./extensions.js";
import { GhostError, ghostPaths, type Ghost, type GhostRegistry } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  resolveTitleModelRef,
} from "./models.js";
import { createPiMessagesAdapter, type PiMessagesEvent } from "./pi-messages.js";
import { generateTitle } from "./title.js";

/**
 * pi's built-in tools. Excluded wholesale so no ghost can shell out or touch
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
 * behaviour without a real model. The default reads `roles.title_model` and
 * runs one completion on the cheapest usable model (see title.ts).
 */
export type TitleGenerator = (input: {
  session: AgentSession;
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

/** The default: resolve title_model against the session's own runtime, complete once. */
const defaultTitleGenerator: TitleGenerator = async ({ session, agentDir, firstPrompt }) => {
  let ref = null;
  try {
    ref = resolveTitleModelRef(readGhostModels(agentDir));
  } catch {
    // A broken models.json is not fatal to titling: fall back to cheapest usable.
    ref = null;
  }
  return generateTitle({ runtime: session.modelRuntime, firstPrompt, ref });
};

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
    "logger" | "extensionOptions" | "browserMode" | "relayTransport"
  >;
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

export interface GhostSessionHandle {
  ghost: Ghost;
  sessionKey: string;
  session: AgentSession;
  sessionFile: string | undefined;
  /** Which model the session resolved to, for diagnostics. */
  model: { provider: string; id: string } | null;
}

interface HostedSession extends GhostSessionHandle {
  busy: boolean;
  /**
   * The in-flight background compaction, if any. A turn awaits this before
   * prompting, because pi's `session.prompt()` throws while a manual
   * compaction is running. Resolves (never rejects) when compaction settles.
   */
  compaction?: Promise<void>;
  /**
   * The in-flight background title generation, if any. `listSessions` awaits it
   * so a just-generated title shows up in the listing; it never blocks a turn.
   * Resolves (never rejects) when title generation settles.
   */
  title?: Promise<void>;
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

/** A renderable transcript message: pi's own message shape, reasoning removed. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  content: unknown;
  timestamp?: number;
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
function projectTranscriptMessage(message: unknown): TranscriptMessage | null {
  const role = (message as { role?: unknown } | null)?.role;
  if (role !== "user" && role !== "assistant") return null;
  let content = (message as { content?: unknown }).content;
  if (role === "assistant" && Array.isArray(content)) {
    content = content.filter(
      (part) => (part as { type?: unknown } | null)?.type !== "thinking",
    );
  }
  const projected: TranscriptMessage = { role, content };
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number") projected.timestamp = timestamp;
  return projected;
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
  private readonly claudeCode: ClaudeCodeRuntime;
  private readonly sessions = new Map<string, HostedSession>();
  /** In-flight opens, so two concurrent turns never build two sessions. */
  private readonly opening = new Map<string, Promise<HostedSession>>();
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
    this.claudeCode = new ClaudeCodeRuntime({
      logger: this.logger,
      extensionOptions: this.extensionOptions,
      browserMode: this.browserMode,
      ...(this.relayTransport ? { relayTransport: this.relayTransport } : {}),
      ...(options.claudeCode ?? {}),
    });
    // Idempotent: main.ts already scrubbed at boot. Repeated here so that a
    // library consumer (or a test) that skips main.ts still cannot leak an
    // ambient provider key into a ghost.
    const { removed } = scrubProviderEnv(process.env, { offline: this.offline });
    if (removed.length > 0) {
      this.logger.warn("scrubbed inherited provider credentials", { removed });
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

    const settingsManager = SettingsManager.create(paths.home, paths.agentDir);
    // pi's *automatic* compaction is left off (this `enabled: false` is exactly
    // what gates its `_checkCompaction`), because its auto path both blocks the
    // next turn and gives no hook for our own summary prompt. Compaction is
    // instead driven from runTurn via `maybeCompact` — see compaction.ts. The
    // manual `session.compact()` path ignores this flag, so disabling the auto
    // trigger here does not disable compaction itself.
    settingsManager.applyOverrides({ compaction: { enabled: false } });

    const extensions = resolveGhostExtensions({
      ghostName,
      browserMode: this.browserMode,
      ...(this.relayTransport ? { relayTransport: this.relayTransport } : {}),
      ...this.extensionOptions,
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: paths.home,
      agentDir: paths.agentDir,
      settingsManager,
      extensionFactories: extensions.factories,
      // See decision 3 in the module comment: no discovery of extensions
      // sitting inside the ghost home.
      noExtensions: true,
      // See decision 2: a ghost is not a coding agent.
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    for (const error of loaded.errors ?? []) {
      this.logger.error("extension failed to load", {
        ghost: ghostName,
        path: error.path,
        error: String(error.error),
      });
    }

    const modelRuntime = await ModelRuntime.create({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.agentDir),
      // Provider catalogs are fetched only when the daemon is not offline.
      allowModelNetwork: !this.offline,
    });

    const { session } = await createAgentSession({
      cwd: paths.home,
      agentDir: paths.agentDir,
      resourceLoader,
      settingsManager,
      modelRuntime,
      // See decision 1: sessions live under the ghost home. `open` on a path
      // that does not exist yet creates it, so a conversation id maps to a
      // stable transcript across daemon restarts.
      sessionManager: SessionManager.open(
        join(paths.sessionDir, sessionFileNameFor(sessionKey)),
        paths.sessionDir,
        paths.home,
      ),
      // See decision 4. The allowlist comes from @ghost/extensions (it is
      // scope-dependent — a visitor session has no note writer); the denylist
      // is belt-and-braces so a future built-in cannot appear by name.
      noTools: "all",
      tools: extensions.toolNames,
      excludeTools: [...PI_BUILTIN_TOOL_NAMES],
    });

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
      busy: false,
    };
  }

  /**
   * Bind the ghost's chat model.
   *
   * Provider-agnostic by construction: the (provider, modelId) pair comes
   * from the ghost's own `models.json`, and an unresolvable pair is a warning
   * rather than a hard failure — pi's own default selection still applies,
   * and the turn will report a clean error if there is nothing to run on.
   */
  private async selectModel(
    session: AgentSession,
    modelRuntime: ModelRuntime,
    agentDir: string,
    ghostName: string,
  ): Promise<{ provider: string; id: string } | null> {
    let ref: ReturnType<typeof resolveChatModelRef> = null;
    try {
      ref = resolveChatModelRef(readGhostModels(agentDir));
    } catch (error) {
      this.logger.error("models.json is unusable", {
        ghost: ghostName,
        error: (error as Error).message,
      });
    }
    if (ref) {
      const model = modelRuntime.getModel(ref.provider, ref.modelId);
      if (model) {
        // Await the bind: a fire-and-forget setModel can lose the race with
        // the first prompt, which would then run on pi's default model.
        await session.setModel(model);
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
    // pi's `session.prompt()` throws while a manual compaction is in progress,
    // so wait it out first. This is the only place a turn can be delayed by
    // compaction, and only when the user returns before it finished; the
    // awaited promise never rejects (errors were already routed to the log).
    if (hosted.compaction) await hosted.compaction;

    const adapter = createPiMessagesAdapter(options.emit, {
      includeThinking: options.includeThinking,
    });
    const unsubscribe = hosted.session.subscribe((event: AgentSessionEvent) => {
      adapter.handle(event);
    });

    const onAbort = () => {
      void hosted.session.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await hosted.session.prompt(options.prompt);
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
      // Kick compaction AFTER unsubscribing and releasing the turn: it must run
      // on an idle session (pi's compact() aborts any active run), and its
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
   * single completion on the title_model (see title.ts); the result is stored
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
      ghostName,
      agentDir,
      firstPrompt,
    })
      .then((raw) => {
        const title = raw.trim();
        // A concurrent turn may have titled it first; do not overwrite.
        if (!title || hosted.session.sessionName) return;
        hosted.session.sessionManager.appendSessionInfo(title);
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
      title: info.name && info.name.trim() ? info.name : null,
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
   * Reuses pi's own session read: the transcript file is opened read-only and
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

    const manager = SessionManager.open(path, paths.sessionDir, paths.home);
    const all: TranscriptMessage[] = [];
    for (const entry of manager.getEntries()) {
      if (entry.type !== "message") continue;
      const message = projectTranscriptMessage(entry.message);
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

  /** Drop one hosted session (aborting an in-flight turn). */
  async close(ghostName: string, sessionId?: string | null): Promise<void> {
    await this.claudeCode.close(ghostName, sessionId || DEFAULT_SESSION_KEY);
    await this.closePi(ghostName, sessionId);
  }

  private async closePi(ghostName: string, sessionId?: string | null): Promise<void> {
    const key = this.keyOf(ghostName, sessionId);
    const hosted = this.sessions.get(key);
    if (!hosted) return;
    this.sessions.delete(key);
    if (hosted.busy) await hosted.session.abort();
    hosted.session.dispose();
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
        entry.session.dispose();
      } catch (error) {
        this.logger.warn("session disposal failed", { error: (error as Error).message });
      }
    }
  }
}
