/**
 * Conversations, as ghostd hosts them: each turn is one headless run of an
 * agent CLI the owner already has (see `harness-table.ts`), started in the
 * conversation's own directory with the ghost's persona and tools, its output
 * streamed to the client and recorded in the conversation log. ghostd keeps
 * no model, agent loop, or credentials; it owns the persona, the log, the
 * owner's hooks, the choice of harness, and the ghost's lifecycle.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildGhostSystemPrompt,
  collectGhostExtension,
  openGhostHome,
  resolveDocumentsDirectory,
  type CollectedGhostExtension,
} from "@ghost/extensions";
import { readAttachment, saveAttachment } from "./attachments.js";
import { ghostSessionStopContinuation } from "./hook-policy.js";
import { closeBrowserSession, errorMessage, FIRST_MEETING_SECTION, isSeededCharacter } from "@ghost/extensions";
import {
  appendLog,
  conversationDir,
  conversationEnvironment,
  handoffContext,
  isValidConversationId,
  logPath,
  logState,
  listedLog,
  newConversationEntry,
  readLog,
  requireConversationId,
  transcriptMessages,
  unseenCommands,
  type AssistantPart,
  type TranscriptMessage,
} from "./conversation-log.js";
import { resolveGhostExtensions, type GhostExtensionOptions } from "./extensions.js";
import { loadGhostSettings, writeGhostSetting } from "./ghost-settings.js";
import { assertValidGhostName, GhostError, ghostPaths, type Ghost, type GhostRegistry } from "./ghosts.js";
import { accountEnv, eligibleIds, omarchyDefaultAgent, orderHarnesses, readHarnessReport, type Harness, type HarnessReport } from "./harnesses.js";
import { runHarness, writeLaunchFiles } from "./harness-process.js";
import {
  harnessRow,
  SUPPORTED_HARNESSES,
  type HarnessEvent,
  type HarnessMcpServer,
  type HarnessRow,
} from "./harness-table.js";
import { GhostHookRunner, type HookObserver } from "./hooks.js";
import { silentLogger, type Logger } from "./log.js";
import {
  BACKGROUND_WORK_POLICY,
  HARNESS_LIMITS_POLICY,
  OMARCHY_COMPUTER_USE_POLICY,
  renderOwnerContextPolicy,
} from "./prompt-policy.js";
import type { MCPServerConfig } from "./mcp-config-policy.js";
import { expandMcpServerConfig } from "./mcp-catalog-policy.js";
import { normalizeMcpStdioCwd, readEnabledMcp } from "./mcp-catalog.js";
import { classifyLimitMessage, type TurnEvent } from "./turn-events.js";
import { readPinState, writePins } from "./pins.js";
import { readReadState, writeReads } from "./reads.js";
import type { RunningSource } from "./running-source.js";
import {
  ghostCliPath,
  SCHEDULED_WORK_POLICY,
  resolveScheduleUnitDirectory,
  sweepGhostSchedules,
} from "./schedules.js";
import type { CommandRunner } from "./tailscale-identity.js";
import { renderSelfMaintenancePolicy } from "./self-maintenance.js";
import { trashPath, type TrashPathResult } from "./trash.js";


/** Same prefix Claude Code and Codex put on Stop-hook continuation prompts. */
export const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:\n";
/** How long one read of Omarchy's harness report is reused. */
const HARNESS_REPORT_TTL_MS = 60_000;
/** The live tail of a tool's output shown on its card. */
const TOOL_SUMMARY_MAX = 800;
/**
 * A conversation name is a label in a sidebar, not a description. The cap is
 * generous for a sentence and short enough to stay a label.
 */
const MAX_CONVERSATION_TITLE_LENGTH = 120;
/** The MCP server name ghost's own tools are served under. */
export const GHOST_MCP_SERVER = "ghost";

export interface SessionHostOptions {
  registry: GhostRegistry;
  ownerHome?: string;
  scheduleUnitDir?: string;
  scheduleCliPath?: string;
  runningSource?: RunningSource;
  scheduleCommandRunner?: CommandRunner;
  logger?: Logger;
  extensionOptions?: GhostExtensionOptions;
  hooks?: GhostHookRunner;
  /**
   * The harnesses a turn may run on, in Omarchy's order; production reads
   * Omarchy's eligibility report. A test supplies its own list and rows.
   */
  eligibleHarnesses?: () => Promise<readonly string[]>;
  /** Omarchy's installed agents with their usage, for the agent picker. */
  harnessReport?: () => Promise<HarnessReport>;
  harnessRows?: (id: string) => HarnessRow | null;
  /** Omarchy's default agent; production asks `omarchy-default-agent`. */
  defaultHarness?: () => Promise<string | null>;
  /** The environment harnesses run with; the daemon's own by default. */
  env?: NodeJS.ProcessEnv;
}

export interface RunTurnOptions {
  sessionId?: string | null;
  prompt: string;
  emit: (event: TurnEvent) => void;
}

export interface AdmittedTurnOptions {
  emit: (event: TurnEvent) => void;
}

export interface TurnAdmission {
  run(options: AdmittedTurnOptions): Promise<void>;
  release(): void;
}

/** A tool as `ghost mcp serve` lists it; `inputSchema` is JSON Schema. */
export interface SessionToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface SessionToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
}

export interface QueuedMessages {
  streaming: boolean;
  followUp: readonly string[];
}


export interface SessionSummary {
  id: string;
  title: string | null;
  /** First owner text; display-only. */
  preview: string | null;
  /** The harness that carried the latest stretch of the conversation. */
  harness: string | null;
  /** What that harness's latest pass ran on, as far as it said; null otherwise. */
  model: string | null;
  provider: string | null;
  effort: string | null;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  unread: boolean;
  /** A turn or owner command is running in it now, whichever client started it. */
  running: boolean;
}

export interface Transcript {
  id: string;
  messages: TranscriptMessage[];
  total: number;
  truncated: boolean;
}

export const DEFAULT_TRANSCRIPT_LIMIT = 1_000;
export const MAX_TRANSCRIPT_LIMIT = 2_000;

export interface ConversationUpdatedEvent {
  type: "conversation-updated";
  id: string;
  updatedAt: string;
}

export type ConversationEventListener = (event: ConversationUpdatedEvent) => void;

/** The agents a ghost can run on, as the picker shows them. */
export interface HarnessChoices {
  /** `effort` is the one its launch asks for, null where the owner's setting stands. */
  harnesses: (Harness & { effort: string | null })[];
  /** The ghost's `settings.yml` `harness`, or null for automatic. */
  ghostDefault: string | null;
  /** Omarchy's default agent, the next preference after the ghost's own. */
  omarchyDefault: string | null;
}

interface LiveTurn {
  readonly followUps: string[];
  /** The turn's own stream, which announces each change to `followUps`. */
  readonly emit: (event: TurnEvent) => void;
}

/** One harness pass: what it said and did, and how it ended. */
interface PassResult {
  readonly content: AssistantPart[];
  readonly error: string | null;
  readonly aborted: boolean;
  /** It produced output, so handing the prompt to another harness would repeat its work. */
  readonly produced: boolean;
  /** The model the harness reported, if it did. */
  readonly model: Extract<HarnessEvent, { type: "model" }> | null;
}

type TerminalError = Extract<TurnEvent, { type: "error" }>;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function tail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > TOOL_SUMMARY_MAX ? `…${trimmed.slice(-TOOL_SUMMARY_MAX)}` : trimmed;
}

/**
 * An owner `!command` (`!!` keeps it out of the ghost's context), or null for
 * a prompt. A message that opens with an attached photo, `![image](…)`, is a
 * prompt.
 */
function ownerCommand(prompt: string): { command: string; excluded: boolean } | null {
  const match = /^(?!!\[)(!!?)\s*([\s\S]*)$/u.exec(prompt.trim());
  return match ? { command: match[2] as string, excluded: match[1] === "!!" } : null;
}

function keyOf(ghostName: string, id: string): string {
  return JSON.stringify([ghostName, id]);
}

function ghostOfKey(key: string): string {
  return (JSON.parse(key) as [string, string])[0];
}

export class SessionHost {
  private readonly registry: GhostRegistry;
  private readonly ownerHome: string;
  private readonly scheduleUnitDir: string;
  private readonly scheduleCliPath: string;
  private readonly runningSource: RunningSource | null;
  private readonly scheduleCommandRunner: CommandRunner | undefined;
  private readonly logger: Logger;
  private readonly extensionOptions: GhostExtensionOptions;
  private readonly hooks: GhostHookRunner;
  private readonly eligibleHarnesses: () => Promise<readonly string[]>;
  private readonly harnessReport: () => Promise<HarnessReport>;
  private readonly defaultHarness: () => Promise<string | null>;
  private readonly rowOf: (id: string) => HarnessRow | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly live = new Map<string, LiveTurn>();
  /** Each admitted turn's stop: the turn outlives its client, so only `stopTurn` or shutdown ends it early. */
  private readonly admissions = new Map<string, AbortController>();
  private readonly deleting = new Set<string>();
  private readonly reservedGhosts = new Set<string>();
  /** File work in flight per ghost, which a delete or rename waits out. */
  private readonly leases = new Map<string, { count: number; drained?: () => void }>();
  private readonly listeners = new Map<string, Set<{ listener: ConversationEventListener; close: () => void }>>();
  private readonly tools = new Map<string, Promise<CollectedGhostExtension>>();
  private reportCache?: { at: number; report: Promise<HarnessReport> };
  private shuttingDown = false;

  constructor(options: SessionHostOptions) {
    this.registry = options.registry;
    this.ownerHome = resolve(options.ownerHome ?? homedir());
    this.scheduleUnitDir = resolve(options.scheduleUnitDir ?? resolveScheduleUnitDirectory(this.ownerHome, {}));
    this.scheduleCliPath = options.scheduleCliPath ?? ghostCliPath();
    this.runningSource = options.runningSource ?? null;
    this.scheduleCommandRunner = options.scheduleCommandRunner;
    this.logger = options.logger ?? silentLogger;
    this.extensionOptions = options.extensionOptions ?? {};
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
    this.env = options.env ?? process.env;
    this.eligibleHarnesses = options.eligibleHarnesses ?? (() => this.omarchyEligible());
    this.harnessReport = options.harnessReport ?? (() => readHarnessReport(this.env, this.ownerHome));
    this.defaultHarness = options.defaultHarness ?? (() => omarchyDefaultAgent(this.env));
    this.rowOf = options.harnessRows ?? harnessRow;
  }

  // ── Conversation events ────────────────────────────────────────────────

  subscribeConversationEvents(
    ghostName: string,
    listener: ConversationEventListener,
    close: () => void = () => {},
  ): () => void {
    this.registry.get(ghostName);
    const set = this.listeners.get(ghostName) ?? new Set();
    const subscription = { listener, close };
    set.add(subscription);
    this.listeners.set(ghostName, set);
    return () => {
      set.delete(subscription);
      if (set.size === 0 && this.listeners.get(ghostName) === set) this.listeners.delete(ghostName);
    };
  }

  private announce(ghostName: string, id: string): void {
    const event: ConversationUpdatedEvent = { type: "conversation-updated", id, updatedAt: new Date().toISOString() };
    for (const { listener } of [...(this.listeners.get(ghostName) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("conversation event listener failed", { ghost: ghostName, error: errorMessage(error) });
      }
    }
  }

  private closeConversationEventStreams(ghostName: string): void {
    const set = this.listeners.get(ghostName);
    this.listeners.delete(ghostName);
    for (const { close } of [...(set ?? [])]) {
      try {
        close();
      } catch {
        // The stream is going away either way.
      }
    }
  }

  // ── Persona and harness configuration ─────────────────────────────────

  /**
   * The ghost's whole system prompt: its character and the stable policy
   * sections. Rendered before every turn, so a character the ghost (or the
   * owner) rewrote is who it is on the next one.
   */
  async renderPersona(ghost: Ghost): Promise<string> {
    const character = await openGhostHome(ghost.dir).readCharacter();
    return buildGhostSystemPrompt({
      ghostName: ghost.name,
      character,
      homeDir: ghost.dir,
      extraSections: [
        OMARCHY_COMPUTER_USE_POLICY,
        HARNESS_LIMITS_POLICY,
        BACKGROUND_WORK_POLICY,
        renderOwnerContextPolicy(resolveDocumentsDirectory(this.env, this.ownerHome)),
        SCHEDULED_WORK_POLICY,
        renderSelfMaintenancePolicy({ ghostName: ghost.name, running: this.runningSource }),
        ...(isSeededCharacter(ghost.name, character?.body ?? null) ? [FIRST_MEETING_SECTION] : []),
      ],
    });
  }

  /** The MCP servers a turn loads: ghost's own tools, then the ghost's enabled `mcp.json` rows. */
  private async mcpServers(ghost: Ghost, id: string): Promise<HarnessMcpServer[]> {
    const servers: HarnessMcpServer[] = [{
      name: GHOST_MCP_SERVER,
      config: { command: this.scheduleCliPath, args: ["mcp", "serve", "-g", ghost.name, "-s", id] },
    }];
    try {
      for (const server of readEnabledMcp(ghost.dir)) {
        if (server.name === GHOST_MCP_SERVER) continue;
        const config = normalizeMcpStdioCwd(expandMcpServerConfig(server.config as MCPServerConfig, process.env), ghost.dir);
        servers.push({ name: server.name, config });
      }
    } catch (error) {
      this.logger.warn("ghost mcp.json unreadable; turn runs with Ghost's tools only", { ghost: ghost.name, error: errorMessage(error) });
    }
    return servers;
  }

  /**
   * Lay out the conversation directory a harness runs in: the persona as
   * `AGENTS.md` (and the `CLAUDE.md`/`GEMINI.md` names other harnesses read),
   * and the ghost's skills where harnesses look for project skills.
   */
  private async prepareDirectory(ghost: Ghost, dir: string, persona: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "AGENTS.md"), persona, { mode: 0o600 });
    for (const alias of ["CLAUDE.md", "GEMINI.md"]) await this.ensureLink(join(dir, alias), "AGENTS.md");
    const skills = join(ghost.dir, "skills");
    if (existsSync(skills)) {
      for (const root of [".claude", ".agents"]) {
        await mkdir(join(dir, root), { recursive: true });
        await this.ensureLink(join(dir, root, "skills"), skills);
      }
    }
  }

  /** Point the link at `target`, so a renamed home relinks on its next turn; anything not a link is left alone. */
  private async ensureLink(path: string, target: string): Promise<void> {
    try {
      if ((await readlink(path)) === target) return;
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    await symlink(target, path);
  }

  /** The harness report, shared by turns and the picker for a minute; it takes most of a second. */
  private cachedReport(): Promise<HarnessReport> {
    const now = Date.now();
    if (this.reportCache && now - this.reportCache.at < HARNESS_REPORT_TTL_MS) return this.reportCache.report;
    const entry = { at: now, report: this.harnessReport() };
    this.reportCache = entry;
    entry.report.catch(() => {
      if (this.reportCache === entry) this.reportCache = undefined;
    });
    return entry.report;
  }

  /** Installed harnesses Omarchy's usage records say have room, in Omarchy's order. */
  private omarchyEligible(): Promise<readonly string[]> {
    return this.cachedReport()
      .then(eligibleIds)
      .catch((error: unknown) => {
        this.logger.warn("harness report unavailable; trying every supported harness", { error: errorMessage(error) });
        return SUPPORTED_HARNESSES;
      });
  }

  /**
   * The harnesses to try for a turn, best first: the one already carrying
   * the conversation, the ghost's `harness` setting, Omarchy's default agent,
   * then every other eligible one Ghost has a row for.
   */
  private async harnessCandidates(ghost: Ghost, current: string | null): Promise<string[]> {
    const [eligible, omarchyDefault] = await Promise.all([this.eligibleHarnesses(), this.defaultHarness()]);
    return orderHarnesses(eligible.filter((id) => this.rowOf(id) !== null), [current, loadGhostSettings(ghost.dir).getString("harness") ?? null, omarchyDefault]);
  }

  // ── Agent choice ──────────────────────────────────────────────────────

  private requireRow(id: string): void {
    if (!this.rowOf(id)) {
      throw new GhostError("unknown_harness", `Ghost cannot run on ${JSON.stringify(id)}; it has no row for that agent.`, 400);
    }
  }

  /** Installed agents Ghost can run on, with Omarchy's usage, and both defaults. */
  async listHarnesses(ghostName: string): Promise<HarnessChoices> {
    const ghost = this.registry.get(ghostName);
    const [report, omarchyDefault] = await Promise.all([this.cachedReport(), this.defaultHarness()]);
    return {
      harnesses: report.harnesses.flatMap((harness) => {
        const row = this.rowOf(harness.id);
        return row ? [{ ...harness, effort: row.effort ?? null }] : [];
      }),
      ghostDefault: loadGhostSettings(ghost.dir).getString("harness") ?? null,
      omarchyDefault,
    };
  }

  /** The ghost's preferred agent, ahead of Omarchy's default; null is automatic. */
  async setGhostHarness(ghostName: string, id: string | null): Promise<HarnessChoices> {
    if (id !== null) this.requireRow(id);
    await this.withGhost(ghostName, async () => {
      await writeGhostSetting(this.registry.get(ghostName).dir, "harness", id);
    });
    return this.listHarnesses(ghostName);
  }

  /**
   * Run this conversation's next turn on `id`. The agent takes over the way
   * a fallback does: it is handed the conversation so far, then kept.
   */
  async chooseHarness(ghostName: string, sessionId: string, id: string): Promise<{ id: string; harness: string }> {
    this.requireRow(id);
    // A turn only runs on an agent with room, so a choice it would pass over
    // is refused here rather than silently ignored.
    const listed = (await this.cachedReport()).harnesses.find((harness) => harness.id === id);
    if (!listed) throw new GhostError("harness_not_installed", `${id} is not installed.`, 409);
    if (!listed.eligible) throw new GhostError("harness_no_room", `${id} has no room: ${listed.reason ?? "its usage is spent"}.`, 409);
    const ghost = this.registry.get(ghostName);
    const conversation = requireConversationId(sessionId);
    await this.withGhost(ghost.name, async () => {
      const { sessionDir } = ghostPaths(ghost.dir);
      const entries = await readLog(sessionDir, conversation);
      if (entries !== null && logState(entries).harness === id) return;
      await appendLog(sessionDir, conversation, [
        ...(entries === null ? [newConversationEntry(conversation, new Date())] : []),
        { type: "harness", at: new Date().toISOString(), harness: id, session: null, dir: conversationDir(sessionDir, conversation) },
      ]);
    });
    this.announce(ghost.name, conversation);
    return { id: conversation, harness: id };
  }

  // ── Turns ─────────────────────────────────────────────────────────────

  async admitTurn(ghostName: string, options: Pick<RunTurnOptions, "sessionId" | "prompt">): Promise<TurnAdmission> {
    const ghost = this.registry.get(ghostName);
    const id = requireConversationId(options.sessionId ?? "default");
    const key = keyOf(ghost.name, id);
    if (this.shuttingDown) throw new GhostError("shutting_down", "ghostd is shutting down.", 503);
    if (this.reservedGhosts.has(ghost.name)) {
      throw new GhostError("ghost_busy", "Wait for this ghost to finish moving before starting a turn.", 409);
    }
    if (this.admissions.has(key) || this.deleting.has(key)) {
      throw new GhostError("session_busy", "This ghost is already answering in this conversation.", 409);
    }
    const command = ownerCommand(options.prompt);
    if (command?.command === "") throw new GhostError("invalid_request", "Write a command after ! or !!.", 400);
    const controller = new AbortController();
    this.admissions.set(key, controller);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.admissions.delete(key);
    };
    return {
      run: async (stream) => {
        try {
          await this.withGhost(ghost.name, () => this.runAdmitted(ghost, id, options.prompt, command, stream, controller.signal));
        } finally {
          release();
          this.announce(ghost.name, id);
        }
      },
      release,
    };
  }

  /** One whole turn, as the server runs it; a failure outside its passes throws instead of emitting. */
  async runTurn(ghostName: string, options: RunTurnOptions): Promise<void> {
    await (await this.admitTurn(ghostName, options)).run(options);
  }

  private async runAdmitted(
    ghost: Ghost,
    id: string,
    prompt: string,
    command: ReturnType<typeof ownerCommand>,
    stream: AdmittedTurnOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const { sessionDir } = ghostPaths(ghost.dir);
    if (!existsSync(logPath(sessionDir, id))) await appendLog(sessionDir, id, [newConversationEntry(id, new Date())]);
    stream.emit({ type: "start" });
    if (command) {
      this.announce(ghost.name, id);
      await this.runOwnerCommand(ghost, id, command.command, command.excluded, stream, signal);
      return;
    }
    const key = keyOf(ghost.name, id);
    const turn: LiveTurn = { followUps: [], emit: stream.emit };
    this.live.set(key, turn);
    const blocks = { next: 0 };
    const onHook: HookObserver = (name, running) => stream.emit({ type: running ? "hook_start" : "hook_end", name });
    let terminal: TurnEvent = { type: "done" };
    try {
      type Pass = { text: string; origin?: "follow_up" | "hook" };
      let next: Pass | undefined = { text: prompt };
      let turnId = randomUUID();
      let ownerPrompt = prompt;
      while (next && !signal.aborted) {
        const { text, origin }: Pass = next;
        if (origin === "follow_up") {
          turnId = randomUUID();
          ownerPrompt = text;
        }
        await appendLog(sessionDir, id, [{ type: "user", at: new Date().toISOString(), text, ...(origin ? { origin } : {}) }]);
        // Other clients learn the turn is running with its prompt already readable.
        this.announce(ghost.name, id);
        let passPrompt = origin === "hook" ? `${STOP_HOOK_FEEDBACK_PREFIX}${text}` : text;
        if (origin !== "hook") {
          const context = await this.beforePrompt(ghost, id, text, turnId, signal, onHook);
          if (context) passPrompt = `${passPrompt}\n\n<hook-context>\n${context}\n</hook-context>`;
        }
        const failure = await this.runPasses(ghost, id, passPrompt, stream, blocks, signal);
        if (failure) {
          terminal = failure;
          break;
        }
        // The owner's own queued message is the next instruction: a stop hook
        // is not asked while one waits, and loses to one sent while it ran.
        const continuation: string | null = turn.followUps.length > 0
          ? null
          : await this.sessionStop(ghost, id, ownerPrompt, turnId, origin === "hook", signal, onHook);
        if (continuation && turn.followUps.length === 0) {
          stream.emit({ type: "session_stop_continued", reason: continuation });
          next = { text: continuation, origin: "hook" };
          continue;
        }
        const followUp = turn.followUps.shift();
        if (followUp !== undefined) {
          stream.emit({ type: "queue", followUp: [...turn.followUps] });
          stream.emit({ type: "owner_message", text: followUp });
        }
        next = followUp === undefined ? undefined : { text: followUp, origin: "follow_up" };
      }
      if (signal.aborted && terminal.type === "done") {
        terminal = { type: "error", reason: "aborted", errorMessage: "Turn aborted." };
      }
    } catch (error) {
      this.logger.error("turn failed", { ghost: ghost.name, conversation: id, error: errorMessage(error) });
      terminal = { type: "error", reason: signal.aborted ? "aborted" : "error", errorMessage: errorMessage(error) };
    } finally {
      this.live.delete(key);
      stream.emit(terminal);
    }
  }

  /**
   * Run one prompt on the best harness that will take it. A harness that
   * fails before producing anything (not signed in, out of quota, missing)
   * hands the prompt to the next eligible one, which is given the earlier
   * conversation as context. Returns the terminal error, or null on success.
   */
  private async runPasses(
    ghost: Ghost,
    id: string,
    prompt: string,
    stream: AdmittedTurnOptions,
    blocks: { next: number },
    signal: AbortSignal,
  ): Promise<TerminalError | null> {
    const { sessionDir } = ghostPaths(ghost.dir);
    let entries = (await readLog(sessionDir, id)) ?? [];
    const candidates = await this.harnessCandidates(ghost, logState(entries).harness);
    if (candidates.length === 0) {
      return {
        type: "error",
        reason: "error",
        errorMessage: "No agent CLI is installed with room to run. `ghost harnesses` shows why.",
      };
    }
    let lastError = "The turn failed.";
    for (const harness of candidates) {
      const row = this.rowOf(harness) as HarnessRow;
      const bound = logState(entries);
      const dir = conversationDir(sessionDir, id);
      // A harness new to the conversation, or to its directory since a home
      // rename, has not seen it; one continuing it has not seen the owner's
      // `!` commands since its last turn.
      const moved = bound.harnessDir !== null && bound.harnessDir !== dir;
      if (bound.harness !== harness || moved || bound.harnessDir === null) {
        await appendLog(sessionDir, id, [{ type: "harness", at: new Date().toISOString(), harness, session: null, dir }]);
      }
      const fresh = bound.harness !== harness || moved || !bound.harnessStarted;
      const earlier = entries.slice(0, entries.findLastIndex((entry) => entry.type === "user"));
      const carried = fresh ? handoffContext(earlier) : null;
      const commands = fresh ? null : unseenCommands(entries);
      const passPrompt = [
        ...(carried ? [`<conversation-so-far>\n${carried}\n</conversation-so-far>`] : []),
        ...(commands ? [`<owner-commands>\n${commands}\n</owner-commands>`] : []),
        prompt,
      ].join("\n\n");
      stream.emit({ type: "harness", harness });
      const result = await this.runPass(ghost, id, row, {
        prompt: passPrompt,
        resume: !fresh,
        sessionId: fresh ? null : bound.harnessSession,
      }, stream, blocks, signal);
      if (result.error === null || result.aborted || result.produced) {
        await appendLog(sessionDir, id, [{
          type: "assistant",
          at: new Date().toISOString(),
          harness,
          content: result.content,
          ...(result.error ? { error: result.error } : {}),
          ...(result.model ? { model: result.model.model } : {}),
          ...(result.model?.provider ? { provider: result.model.provider } : {}),
          ...(result.model?.effort ?? row.effort ? { effort: result.model?.effort ?? row.effort } : {}),
        }]);
        return result.error === null ? null : this.failure(stream, harness, result.error, result.aborted);
      }
      lastError = result.error;
      this.logger.warn("harness failed before answering; trying the next", { ghost: ghost.name, conversation: id, harness, error: result.error });
      entries = (await readLog(sessionDir, id)) ?? [];
    }
    const last = candidates.at(-1) as string;
    await appendLog(sessionDir, id, [{ type: "assistant", at: new Date().toISOString(), harness: last, content: [], error: lastError }]);
    return this.failure(stream, last, lastError, false);
  }

  private failure(stream: AdmittedTurnOptions, harness: string, message: string, aborted: boolean): TerminalError {
    const kind = aborted ? null : classifyLimitMessage(message);
    if (kind) stream.emit({ type: "limit_reached", harness, kind });
    return { type: "error", reason: aborted ? "aborted" : "error", errorMessage: message };
  }

  private async runPass(
    ghost: Ghost,
    id: string,
    row: HarnessRow,
    turn: { prompt: string; resume: boolean; sessionId: string | null },
    stream: AdmittedTurnOptions,
    blocks: { next: number },
    signal: AbortSignal,
  ): Promise<PassResult> {
    const { sessionDir } = ghostPaths(ghost.dir);
    const dir = conversationDir(sessionDir, id);
    const account = accountEnv(row.id, this.env);
    const [persona, mcp] = await Promise.all([this.renderPersona(ghost), this.mcpServers(ghost, id)]);
    await this.prepareDirectory(ghost, dir, persona);
    const launch = row.launch({ ...turn, persona, mcp });
    await writeLaunchFiles(dir, launch.files);

    const content: AssistantPart[] = [];
    const tools = new Map<string, { name: string; part: number }>();
    // The text block streaming now and its logged part, the last one while it is open,
    // so a block key a harness reuses after a tool call logs a new part, as the stream shows.
    let open: { key: string; index: number; part: number; text: string } | null = null;
    let error: string | null = null;
    let produced = false;
    let thoughtBlock: string | null = null;
    let model: Extract<HarnessEvent, { type: "model" }> | null = null;
    let session = turn.sessionId;
    const writes: Promise<void>[] = [];
    const closeBlock = () => {
      if (!open) return;
      stream.emit({ type: "text_end", contentIndex: open.index, content: open.text });
      open = null;
    };
    const onEvent = (event: HarnessEvent): void => {
      switch (event.type) {
        case "thinking":
          // Reasoning streams for the activity line; it is not an answer and is not logged.
          if (event.delta === "") return;
          stream.emit({ type: "thinking", delta: thoughtBlock !== null && thoughtBlock !== event.block ? `\n${event.delta}` : event.delta });
          thoughtBlock = event.block;
          return;
        case "text": {
          if (event.delta === "") return;
          produced = true;
          const key = event.block;
          if (open?.key !== key) {
            closeBlock();
            open = { key, index: blocks.next++, part: content.length, text: "" };
            content.push({ type: "text", text: "" });
            stream.emit({ type: "text_start", contentIndex: open.index });
          }
          open.text += event.delta;
          content[open.part] = { type: "text", text: open.text };
          stream.emit({ type: "text_delta", contentIndex: open.index, delta: event.delta });
          return;
        }
        case "tool_start":
          if (tools.has(event.id)) return;
          produced = true;
          closeBlock();
          tools.set(event.id, { name: event.name, part: content.length });
          content.push({ type: "toolCall", id: event.id, name: event.name, arguments: event.args });
          stream.emit({ type: "tool_execution_start", id: event.id, toolName: event.name, arguments: event.args, cwd: dir });
          return;
        case "tool_end": {
          const tool = tools.get(event.id);
          if (!tool) return;
          if (event.isError) content[tool.part] = { ...(content[tool.part] as Extract<AssistantPart, { type: "toolCall" }>), failed: true };
          const summary = event.output === undefined ? undefined : tail(event.output);
          stream.emit({ type: "tool_execution_end", id: event.id, toolName: tool.name, isError: event.isError, ...(summary ? { summary } : {}) });
          return;
        }
        case "model":
          model = event;
          return;
        case "session":
          session = event.id;
          writes.push(appendLog(sessionDir, id, [{ type: "harness", at: new Date().toISOString(), harness: row.id, session: event.id, dir }]));
          return;
        case "error":
          error = event.message;
          return;
      }
    };

    const env = { ...this.env, ...conversationEnvironment(ghost.name, id), ...(await account) };
    const exit = await runHarness({
      launch,
      cwd: dir,
      env,
      parse: row.parser(),
      onEvent,
      signal,
    });
    closeBlock();
    // The session record lands before the pass's assistant entry.
    await Promise.all(writes);
    if (model === null && session !== null && row.ranOn) model = await row.ranOn(session, env).catch(() => null);
    if (signal.aborted) return { content, error: "Turn aborted.", aborted: true, produced, model };
    if (exit.spawnError) return { content, error: `${row.id} could not start: ${exit.spawnError}`, aborted: false, produced, model };
    if (error === null && exit.code !== 0) {
      const stderr = exit.stderr.trim().split("\n").slice(-6).join("\n");
      error = stderr || `${row.id} exited with ${exit.code === null ? `signal ${exit.signal}` : `status ${exit.code}`}.`;
    }
    return { content, error, aborted: false, produced, model };
  }

  private async beforePrompt(
    ghost: Ghost,
    id: string,
    prompt: string,
    turnId: string,
    signal: AbortSignal,
    onHook: HookObserver,
  ): Promise<string | null> {
    if (!this.hooks.hasHandlers("before_prompt")) return null;
    const { sessionDir } = ghostPaths(ghost.dir);
    const harness = logState((await readLog(sessionDir, id)) ?? []).harness;
    const result = await this.hooks.emitBeforePrompt({
      type: "before_prompt",
      prompt,
      turn_id: turnId,
      session_id: id,
      session_file: logPath(sessionDir, id),
      signal,
      ghost_name: ghost.name,
      ghost_home: ghost.dir,
      cwd: conversationDir(sessionDir, id),
      conversation_id: id,
      ...(harness ? { harness } : {}),
    }, onHook);
    return result?.additionalContext || null;
  }

  private async sessionStop(
    ghost: Ghost,
    id: string,
    ownerPrompt: string,
    turnId: string,
    active: boolean,
    signal: AbortSignal,
    onHook: HookObserver,
  ): Promise<string | null> {
    if (!this.hooks.hasHandlers("session_stop") || signal.aborted) return null;
    const { sessionDir } = ghostPaths(ghost.dir);
    const last = ((await readLog(sessionDir, id)) ?? []).findLast((entry) => entry.type === "assistant");
    if (last?.type !== "assistant") return null;
    const { harness } = last;
    const message = { role: "assistant", content: last.content };
    const result = await this.hooks.emitSessionStop({
      type: "session_stop",
      messages: [message],
      turn_id: turnId,
      last_assistant_message: message,
      session_id: id,
      session_file: logPath(sessionDir, id),
      transcript_path: logPath(sessionDir, id),
      stop_hook_active: active,
      owner_prompt: ownerPrompt,
      signal,
      ghost_name: ghost.name,
      ghost_home: ghost.dir,
      cwd: conversationDir(sessionDir, id),
      conversation_id: id,
      harness,
    }, onHook);
    return ghostSessionStopContinuation(result) ?? null;
  }

  /**
   * The owner's `!command` (or `!!command`, kept from the ghost), run in the
   * owner home with the conversation's identity and recorded in the log; its
   * output reaches the ghost with its next prompt.
   */
  private async runOwnerCommand(ghost: Ghost, id: string, command: string, excluded: boolean, stream: AdmittedTurnOptions, signal: AbortSignal): Promise<void> {
    const toolId = `bash-${Date.now().toString(36)}`;
    stream.emit({ type: "tool_execution_start", id: toolId, toolName: "bash", arguments: { command }, cwd: this.ownerHome });
    // The log keeps the last 100 KB; a chatty command is trimmed in batches,
    // and the card's summary is sent at most every 100 ms, not per line.
    let output = "";
    let update: ReturnType<typeof setTimeout> | undefined;
    const sendUpdate = () => {
      update = undefined;
      stream.emit({ type: "tool_execution_update", id: toolId, summary: tail(output.slice(-4 * TOOL_SUMMARY_MAX)) });
    };
    const exit = await runHarness({
      launch: { argv: ["bash", "-c", command] },
      cwd: this.ownerHome,
      env: { ...this.env, ...conversationEnvironment(ghost.name, id) },
      parse: (line) => [{ type: "text", block: "out", delta: `${line}\n` }],
      onEvent: (event) => {
        if (event.type !== "text") return;
        output += event.delta;
        if (output.length > 200_000) output = output.slice(-100_000);
        update ??= setTimeout(sendUpdate, 100);
      },
      signal,
    });
    clearTimeout(update);
    output = output.slice(-100_000);
    if (exit.stderr) output = `${output}${exit.stderr}`;
    if (exit.spawnError) output = `${output}${exit.spawnError}`;
    stream.emit({ type: "tool_execution_end", id: toolId, toolName: "bash", isError: exit.code !== 0, summary: tail(output) ?? `Exit ${exit.code ?? exit.signal}` });
    await appendLog(ghostPaths(ghost.dir).sessionDir, id, [{ type: "command", at: new Date().toISOString(), command, output, exitCode: exit.code, excluded }]);
    stream.emit(signal.aborted
      ? { type: "error", reason: "aborted", errorMessage: "Command aborted." }
      : { type: "done" });
  }

  queuedMessages(ghostName: string, sessionId?: string | null): QueuedMessages {
    this.registry.get(ghostName);
    const turn = this.live.get(keyOf(ghostName, requireConversationId(sessionId ?? "default")));
    return { streaming: turn !== undefined, followUp: [...(turn?.followUps ?? [])] };
  }

  /** Abort the conversation's running turn or owner command; its stream ends `aborted`. */
  stopTurn(ghostName: string, sessionId?: string | null): void {
    this.registry.get(ghostName);
    const controller = this.admissions.get(keyOf(ghostName, requireConversationId(sessionId ?? "default")));
    if (!controller) {
      throw new GhostError("session_not_streaming", "This conversation is not currently streaming.", 409);
    }
    controller.abort();
  }

  /** Queue text for after the current pass; a harness takes no input mid-run. */
  async queueMessage(ghostName: string, sessionId: string | null | undefined, text: string): Promise<QueuedMessages> {
    this.registry.get(ghostName);
    const key = keyOf(ghostName, requireConversationId(sessionId ?? "default"));
    const turn = this.live.get(key);
    if (!turn) {
      // A running `!command` has no passes to queue after.
      if (this.admissions.has(key)) throw new GhostError("session_busy", "An owner command is running in this conversation; send this when it ends.", 409);
      throw new GhostError("session_not_streaming", "This conversation is not currently streaming; send a normal message instead.", 409);
    }
    turn.followUps.push(text);
    turn.emit({ type: "queue", followUp: [...turn.followUps] });
    return this.queuedMessages(ghostName, sessionId);
  }

  // ── Ghost tools for `ghost mcp serve` ──────────────────────────────────

  private ghostTools(ghost: Ghost): Promise<CollectedGhostExtension> {
    let tools = this.tools.get(ghost.dir);
    if (!tools) {
      tools = collectGhostExtension(resolveGhostExtensions(this.extensionOptions, ghost.dir));
      tools.catch(() => this.tools.delete(ghost.dir));
      this.tools.set(ghost.dir, tools);
    }
    return tools;
  }

  async sessionTools(ghostName: string): Promise<SessionToolDescriptor[]> {
    const tools = await this.ghostTools(this.registry.get(ghostName));
    return [...tools.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
  }

  async callSessionTool(
    ghostName: string,
    sessionId: string | null | undefined,
    name: string,
    args: unknown,
    signal?: AbortSignal,
    caller?: string,
  ): Promise<SessionToolResult> {
    const ghost = this.registry.get(ghostName);
    const tool = (await this.ghostTools(ghost)).tools.get(name);
    if (!tool) throw new GhostError("tool_not_found", `This ghost has no tool named ${JSON.stringify(name)}.`, 404);
    const id = sessionId ? requireConversationId(sessionId) : null;
    try {
      const result = await tool.execute((args ?? {}) as never, signal, {
        caller: caller ?? (id ? `conversation ${id}` : "a delegated run"),
      });
      return { content: result.content as SessionToolResult["content"], isError: false };
    } catch (error) {
      return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    }
  }

  // ── Listing and metadata ──────────────────────────────────────────────

  private async conversationIds(sessionDir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(sessionDir);
    } catch {
      return [];
    }
    return names.filter((name) => isValidConversationId(name) && existsSync(logPath(sessionDir, name)));
  }

  listSessions(ghostName: string): Promise<SessionSummary[]> {
    return this.withGhost(ghostName, () => this.listSessionsLeased(ghostName));
  }

  private async listSessionsLeased(ghostName: string): Promise<SessionSummary[]> {
    const ghost = this.registry.get(ghostName);
    const { sessionDir } = ghostPaths(ghost.dir);
    const [ids, pins, reads] = await Promise.all([
      this.conversationIds(sessionDir),
      readPinState(sessionDir),
      readReadState(sessionDir),
    ]);
    const listed = await Promise.all(ids.map(async (id) => ({ id, log: await listedLog(sessionDir, id) })));
    const rows: SessionSummary[] = [];
    for (const { id, log } of listed) {
      if (!log) continue;
      const { state, updatedAt } = log;
      // An owner command logs when it ends, so a running one is listed before anything is.
      const running = this.admissions.has(keyOf(ghost.name, id));
      if (state.messageCount === 0 && state.title === null && !running) continue;
      const readAt = reads.reads[id];
      rows.push({
        id,
        title: state.title,
        preview: state.preview,
        harness: state.harness,
        model: state.model,
        provider: state.provider,
        effort: state.effort,
        updatedAt,
        messageCount: state.messageCount,
        pinned: pins.pinned.includes(id),
        unread: readAt === undefined || updatedAt > readAt,
        running,
      });
    }
    return rows.sort((a, b) => (a.pinned === b.pinned ? b.updatedAt.localeCompare(a.updatedAt) : (a.pinned ? -1 : 1)));
  }

  private async requireConversation(ghost: Ghost, sessionId: string | null | undefined): Promise<string> {
    const id = requireConversationId(sessionId ?? "default");
    if (!existsSync(logPath(ghostPaths(ghost.dir).sessionDir, id))) {
      throw new GhostError("not_found", `This ghost has no conversation ${JSON.stringify(id)}.`, 404);
    }
    return id;
  }

  async setPinned(ghostName: string, sessionId: string | null | undefined, pinned: boolean): Promise<void> {
    const ghost = this.registry.get(ghostName);
    const id = await this.requireConversation(ghost, sessionId);
    const { sessionDir } = ghostPaths(ghost.dir);
    const existing = new Set(await this.conversationIds(sessionDir));
    const kept = (await readPinState(sessionDir)).pinned.filter((pin) => pin !== id && existing.has(pin));
    await writePins(sessionDir, pinned ? [...kept, id] : kept);
    this.announce(ghost.name, id);
  }

  async markRead(ghostName: string, sessionId: string | null | undefined, openedAt = new Date()): Promise<string> {
    const ghost = this.registry.get(ghostName);
    const id = await this.requireConversation(ghost, sessionId);
    const { sessionDir } = ghostPaths(ghost.dir);
    const existing = new Set(await this.conversationIds(sessionDir));
    const kept = Object.fromEntries(Object.entries((await readReadState(sessionDir)).reads).filter(([read]) => existing.has(read)));
    const readAt = openedAt.toISOString();
    await writeReads(sessionDir, { ...kept, [id]: readAt });
    this.announce(ghost.name, id);
    return readAt;
  }

  async renameConversation(ghostName: string, sessionId: string | null | undefined, title: string): Promise<string> {
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new GhostError("invalid_request", "\"title\" must not be empty.", 400);
    if (trimmed.length > MAX_CONVERSATION_TITLE_LENGTH) {
      throw new GhostError("invalid_request", `"title" must be at most ${MAX_CONVERSATION_TITLE_LENGTH} characters.`, 400);
    }
    if (!/\P{C}/u.test(trimmed)) {
      throw new GhostError("invalid_request", "A conversation title needs at least one printable character.", 400);
    }
    const ghost = this.registry.get(ghostName);
    const id = await this.requireConversation(ghost, sessionId);
    await appendLog(ghostPaths(ghost.dir).sessionDir, id, [{ type: "title", at: new Date().toISOString(), title: trimmed }]);
    this.announce(ghost.name, id);
    return trimmed;
  }

  /** Store an image in the conversation directory, which need not hold a turn yet. */
  saveAttachment(ghostName: string, sessionId: string, bytes: Uint8Array): Promise<string> {
    return this.withGhost(ghostName, () => saveAttachment(this.attachmentDir(ghostName, sessionId), bytes));
  }

  readAttachment(ghostName: string, sessionId: string, name: string): Promise<{ bytes: Buffer; type: string }> {
    return this.withGhost(ghostName, () => readAttachment(this.attachmentDir(ghostName, sessionId), name));
  }

  private attachmentDir(ghostName: string, sessionId: string): string {
    return conversationDir(ghostPaths(this.registry.get(ghostName).dir).sessionDir, requireConversationId(sessionId));
  }

  readTranscript(
    ghostName: string,
    sessionId: string | null | undefined,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Transcript> {
    return this.withGhost(ghostName, () => this.readTranscriptLeased(ghostName, sessionId, options));
  }

  private async readTranscriptLeased(
    ghostName: string,
    sessionId: string | null | undefined,
    options: { limit?: number; offset?: number },
  ): Promise<Transcript> {
    const ghost = this.registry.get(ghostName);
    const id = requireConversationId(sessionId ?? "default");
    const entries = (await readLog(ghostPaths(ghost.dir).sessionDir, id)) ?? [];
    const all = transcriptMessages(entries);
    const limit = Math.max(1, clamp(options.limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT));
    const offset = Math.min(clamp(options.offset, 0, Number.MAX_SAFE_INTEGER), all.length);
    const messages = all.slice(offset, offset + limit);
    return {
      id,
      messages,
      total: all.length,
      truncated: offset > 0 || offset + messages.length < all.length,
    };
  }

  /** Move the conversation's directory, log and all, to recoverable Trash. */
  async deleteSession(ghostName: string, sessionId: string | null | undefined): Promise<TrashPathResult> {
    const ghost = this.registry.get(ghostName);
    const id = await this.requireConversation(ghost, sessionId);
    const key = keyOf(ghost.name, id);
    if (this.admissions.has(key) || this.deleting.has(key)) {
      throw new GhostError("session_busy", "Wait for this conversation to finish before deleting it.", 409);
    }
    this.deleting.add(key);
    try {
      const { sessionDir } = ghostPaths(ghost.dir);
      const trashed = trashPath(conversationDir(sessionDir, id), { env: this.env, home: this.ownerHome });
      const pins = (await readPinState(sessionDir)).pinned;
      if (pins.includes(id)) await writePins(sessionDir, pins.filter((pin) => pin !== id));
      this.logger.info("trashed conversation", { ghost: ghost.name, conversation: id, trash: trashed.trash });
      this.announce(ghost.name, id);
      return trashed;
    } finally {
      this.deleting.delete(key);
    }
  }

  // ── Ghost lifecycle ───────────────────────────────────────────────────

  private ghostBusy(ghostName: string): boolean {
    return [...this.admissions.keys(), ...this.deleting].some((key) => ghostOfKey(key) === ghostName);
  }

  createGhost(name: string): Ghost {
    assertValidGhostName(name);
    if (this.reservedGhosts.has(name)) {
      throw new GhostError("ghost_busy", "Wait for the previous ghost home to finish moving before reusing this name.", 409);
    }
    return this.registry.create(name);
  }

  /**
   * Run file work under a ghost's home. A move in progress refuses it, and a
   * move waits for whatever was already running.
   */
  async withGhost<T>(ghostName: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.reservedGhosts.has(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's home move to finish before changing its files.", 409);
    }
    const lease = this.leases.get(ghostName) ?? { count: 0 };
    lease.count += 1;
    this.leases.set(ghostName, lease);
    try {
      return await operation();
    } finally {
      lease.count -= 1;
      if (lease.count === 0) {
        this.leases.delete(ghostName);
        lease.drained?.();
      }
    }
  }

  /** Claim names for a move, refusing a running conversation and waiting out file work. */
  private async reserve(names: readonly string[], operation: string): Promise<void> {
    for (const name of names) {
      if (this.reservedGhosts.has(name) || this.ghostBusy(name)) {
        throw new GhostError("ghost_busy", `Wait for this ghost's conversations to finish before ${operation}.`, 409);
      }
    }
    for (const name of names) this.reservedGhosts.add(name);
    await Promise.all(names.map((name) => {
      const lease = this.leases.get(name);
      return lease ? new Promise<void>((resolve) => { lease.drained = resolve; }) : undefined;
    }));
  }

  /** Release what the daemon holds under a home that is about to move. */
  private async quiesce(ghost: Ghost, outcome: "deleted" | "renamed"): Promise<void> {
    try {
      await closeBrowserSession(ghost.dir);
    } catch {
      throw new GhostError("browser_cleanup_pending", "The ghost's browser session did not close. Restore the browser relay and retry.", 503);
    }
    try {
      await sweepGhostSchedules(ghost.name, {
        unitDir: this.scheduleUnitDir,
        ...(this.scheduleCommandRunner ? { run: this.scheduleCommandRunner } : {}),
        logger: this.logger,
      });
    } catch (error) {
      this.logger.error(`could not clean up a ghost's schedules before it was ${outcome}`, { ghost: ghost.name, error: errorMessage(error) });
      throw new GhostError(
        "schedule_cleanup_failed",
        `Could not stop and remove this ghost's schedules. The ghost was not ${outcome}; retry after checking its systemd user timers.`,
        503,
      );
    }
    this.tools.delete(ghost.dir);
  }

  async deleteGhost(ghostName: string): Promise<{ trash: string }> {
    const ghost = this.registry.get(ghostName);
    await this.reserve([ghost.name], "deleting it");
    try {
      await this.quiesce(ghost, "deleted");
      const trashed = this.registry.trash(ghost.name);
      this.closeConversationEventStreams(ghost.name);
      this.logger.info("trashed ghost", { ghost: ghost.name, trash: trashed.trash });
      return trashed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
    }
  }

  async renameGhost(ghostName: string, nextName: string): Promise<Ghost> {
    assertValidGhostName(nextName);
    const ghost = this.registry.get(ghostName);
    if (nextName === ghost.name) return ghost;
    if (existsSync(join(this.registry.root, nextName))) {
      throw new GhostError("already_exists", `A ghost named ${JSON.stringify(nextName)} already exists.`, 409);
    }
    await this.reserve([ghost.name, nextName], "renaming it");
    try {
      await this.quiesce(ghost, "renamed");
      const renamed = this.registry.rename(ghost.name, nextName);
      this.closeConversationEventStreams(ghost.name);
      this.logger.info("renamed ghost", { ghost: ghost.name, name: renamed.name });
      return renamed;
    } finally {
      this.reservedGhosts.delete(ghost.name);
      this.reservedGhosts.delete(nextName);
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.admissions.values()) controller.abort();
  }

  async disposeAll(): Promise<void> {
    this.beginShutdown();
    for (const ghostName of [...this.listeners.keys()]) this.closeConversationEventStreams(ghostName);
  }
}
