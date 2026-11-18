/**
 * Conversations, as ghostd hosts them: each turn is one headless run of an
 * agent CLI the owner already has (see `harness-table.ts`), started in the
 * conversation's own directory with the ghost's persona and tools, its output
 * streamed to the client and recorded in the conversation log. ghostd keeps
 * no model, agent loop, or credentials; it owns the persona, the log, the
 * owner's hooks, the choice of harness, and the ghost's lifecycle.
 */
import { type DesktopContext, renderDesktopContext } from "./desktop-context.js";
import { eventConversationId, eventPrompt, eventPromptLead, type ExternalEvent } from "./external-events.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildGhostSystemPrompt, characterSection, FIRST_MEETING_SECTION, isSeededCharacter } from "./persona.js";
import { readCharacter } from "./home.js";
import { findSourceRoot } from "./running-source.js";
import { resolveDocumentsDirectory } from "./xdg-user-dirs.js";
import { errorMessage, GhostError } from "./errors.js";
import { readAttachment, saveAttachment } from "./attachments.js";
import { ghostSessionStopContinuation, type GhostHookEventBase } from "./hook-policy.js";
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
  readTranscriptPage,
  unseenCommands,
  isEventPrompt,
  type AssistantPart,
  type LogEntry,
  type TranscriptMessage,
} from "./conversation-log.js";
import { readHarnessSetting, writeGhostSetting } from "./ghost-settings.js";
import { assertValidGhostName, ghostPaths, type Ghost, type GhostRegistry } from "./ghosts.js";
import { accountEnv, eligibleIds, omarchyDefaultAgent, orderHarnesses, readHarnessReport, type Harness, type HarnessReport } from "./harnesses.js";
import { runHarness, writeLaunchFiles, type HarnessExit } from "./harness-process.js";
import {
  harnessRow,
  SUPPORTED_HARNESSES,
  type HarnessEvent,
  type HarnessMcpServer,
  type HarnessRow,
  type TurnRow,
} from "./harness-table.js";
import { GhostHookRunner, type HookObserver } from "./hooks.js";
import { silentLogger, type Logger } from "./log.js";
import {
  OMARCHY_COMPUTER_USE_POLICY,
  GHOST_POLICY,
  renderOwnerContextPolicy,
} from "./prompt-policy.js";
import { expandMcpServerConfig, type MCPServerConfig } from "./mcp-config-policy.js";
import { normalizeMcpStdioCwd, readEnabledMcp } from "./mcp-catalog.js";
import { classifyLimitMessage, isUnreachableMessage, statedReturn, type TurnEvent } from "./turn-events.js";
import { type OwnerQuestion, pinsPath, questionsPath, readPins, readQuestions, readReads, readsPath, writePins, writeQuestions, writeReads } from "./sidecars.js";
import { serializeByKey } from "./promise-chain.js";
import {
  listGhostRoutines,
  readRoutineLogs,
  controlGhostRoutine,
  resolveScheduleUnitDirectory,
  sweepGhostSchedules,
} from "./schedules.js";
import { readRoutineConfig, saveRoutineConfig, removeRoutine, listRoutineRecoveries, restoreRoutine, discardRoutineRecoveries, type RoutineConfig } from "./routine-config.js";
import type { CommandRunner } from "./command-runner.js";
import { trashPath } from "./trash.js";
import { LOCAL_HARNESS, type LocalModel } from "./local-model.js";
import { completeLocally, runLocalTurn, type DelegateResult } from "./local-turn.js";
import { TOOL_RESULT_CHARS } from "./local-tools.js";


/** Same prefix Claude Code and Codex put on Stop-hook continuation prompts. */
const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:\n";

/** How long one read of Omarchy's harness report is reused. */
const HARNESS_REPORT_TTL_MS = 60_000;

/** Where earlier packages installed the skills Ghost shipped. */
const PACKAGED_SKILLS = "/usr/lib/ghost/skills";
/** The live tail of a tool's output shown on its card. */
const TOOL_SUMMARY_MAX = 800;
/**
 * A conversation name is a label in a sidebar, not a description. The cap is
 * generous for a sentence and short enough to stay a label.
 */
const MAX_CONVERSATION_TITLE_LENGTH = 120;
/**
 * How long a harness that failed before answering is tried last when its
 * refusal does not say when access returns: a limit (quota, rate, credit) for
 * an hour, anything else for a quarter. A retry an hour later costs one failed
 * start; trying it first every turn costs one per turn.
 */
const REST_AFTER_LIMIT_MS = 60 * 60_000;
const REST_AFTER_FAILURE_MS = 15 * 60_000;
/**
 * The waits before each rerun of an event turn that could not reach its
 * model: soon for a network still coming up at boot, then up to hourly for a
 * machine offline longer, about three hours in all.
 */
const EVENT_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 60, 60].map((minutes) => minutes * 60_000);
/** How long after its acceptance a daemon start still reruns an unfinished event: past this, its news is stale. */
const EVENT_RESUME_WINDOW_MS = 24 * 60 * 60_000;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_QUESTION_OPTIONS = 6;
const MAX_QUESTION_OPTION_LENGTH = 120;

export interface SessionHostOptions {
  registry: GhostRegistry;
  ownerHome?: string;
  scheduleUnitDir?: string;
  scheduleCommandRunner?: CommandRunner;
  scheduleVerifyRunner?: CommandRunner;
  scheduleJournalRunner?: CommandRunner;
  logger?: Logger;
  hooks?: GhostHookRunner;
  /** The app's link to a conversation for `turn_end`'s `url`, or null. */
  conversationUrl?: (ghost: string, id: string) => Promise<string | null>;
  /**
   * The harnesses a turn may run on, in Omarchy's order; production reads
   * Omarchy's eligibility report. A test supplies its own list and rows.
   */
  eligibleHarnesses?: () => Promise<readonly string[]>;
  /** Omarchy's installed agents with their usage, for the agent picker. */
  harnessReport?: () => Promise<HarnessReport>;
  harnessRows?: (id: string) => HarnessRow | null;
  /** The model ghostd runs itself, when the owner configured one (CONTRACTS.md "Local model"). */
  localModel?: LocalModel | null;
  /** Omarchy's default agent; production asks `omarchy-default-agent`. */
  defaultHarness?: () => Promise<string | null>;
  /** The environment harnesses run with; the daemon's own by default. */
  env?: NodeJS.ProcessEnv;
  /** The waits before rerunning an event turn that could not reach its model; a test supplies short ones. */
  eventRetryDelays?: readonly number[];
}

interface RunTurnOptions {
  sessionId?: string | null;
  prompt: string;
  /** The window a summon came from: hidden context for the first pass only. */
  desktop?: DesktopContext | null;
  emit: (event: TurnEvent) => void;
}

interface AdmittedTurnOptions {
  emit: (event: TurnEvent) => void;
}

/** An admitted turn: the conversation is held until `run` settles. */
interface TurnAdmission {
  /** The conversation the turn runs in, "default" when the request named none. */
  readonly sessionId: string;
  run(options: AdmittedTurnOptions): Promise<void>;
}

interface QueuedMessages {
  streaming: boolean;
  followUp: readonly string[];
}


export interface SessionSummary {
  id: string;
  title: string | null;
  /** First owner text; display-only. */
  preview: string | null;
  /** The external event source that opened it (an `event-` conversation); null for any other. */
  source: string | null;
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
  /** What the ghost asked and is waiting on; the owner's next message answers it. */
  question: OwnerQuestion | null;
}

export interface Transcript {
  id: string;
  messages: TranscriptMessage[];
  total: number;
  truncated: boolean;
}

const DEFAULT_TRANSCRIPT_LIMIT = 1_000;
const MAX_TRANSCRIPT_LIMIT = 2_000;

interface ConversationUpdatedEvent {
  type: "conversation-updated";
  id: string;
  updatedAt: string;
}

type ConversationEventListener = (event: ConversationUpdatedEvent) => void;

/** A harness that failed before answering, tried last until `until`. */
interface HarnessRest {
  until: string;
  /** The failure that sent it to the back, as the harness reported it. */
  reason: string;
}

/** The agents a ghost can run on, as the picker shows them. */
export interface HarnessChoices {
  /**
   * `effort` is the one its launch asks for, null where the owner's setting
   * stands; `resting` is set while a recent failure keeps it at the back.
   */
  harnesses: (Harness & { effort: string | null; resting: HarnessRest | null })[];
  /** The ghost's `settings.yml` `harness`, or null for automatic. */
  ghostDefault: string | null;
  /**
   * What a new conversation would start on now: the first harness
   * `harnessCandidates` would try (the local model when it is the default),
   * or null when none can run.
   */
  automatic: string | null;
}

interface LiveTurn {
  /** The owner's queued messages, in order, which the HUD shows and hands back on a stop. */
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

function endedUnreachable(last: LogEntry | undefined): boolean {
  return last?.type === "assistant" && !!last.error && isUnreachableMessage(last.error);
}

/** Whether the daemon's last run left this event's prompt, which `entries` start at, unanswered: no reply (a crash), its model unreachable, or cut off by a stop. */
function leftUnfinished(entries: readonly LogEntry[], last: LogEntry | undefined): boolean {
  if (last?.type === "user" || endedUnreachable(last)) return true;
  // Once only, so a turn whose own work restarts the daemon cannot loop.
  return last?.type === "assistant" && last.interrupted === true
    && entries.filter((entry) => entry.type === "assistant" && entry.interrupted).length === 1;
}

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

/** The fields every hook event carries (docs/hooks.md). */
function hookEventBase(ghost: Ghost, id: string, sessionDir: string, signal: AbortSignal): GhostHookEventBase {
  return {
    session_id: id, session_file: logPath(sessionDir, id), signal, ghost_name: ghost.name,
    ghost_home: ghost.dir, cwd: conversationDir(sessionDir, id), conversation_id: id,
  };
}

/**
 * The policy sections every persona carries after its character, in prompt
 * order; prompt-budget.test.ts measures exactly this list.
 */
export function stablePolicySections(options: {
  documents: string;
  firstMeeting: boolean;
}): string[] {
  return [
    OMARCHY_COMPUTER_USE_POLICY,
    GHOST_POLICY,
    renderOwnerContextPolicy(options.documents),
    ...(options.firstMeeting ? [FIRST_MEETING_SECTION] : []),
  ];
}

/** A question as asked: trimmed, bounded, options deduplicated in order. */
function validQuestion(text: string, options: readonly string[]): OwnerQuestion {
  const trimmed = text.trim();
  if (trimmed === "") throw new GhostError("invalid_request", "A question needs text.", 400);
  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new GhostError("invalid_request", `A question must be at most ${MAX_QUESTION_LENGTH} characters.`, 400);
  }
  const kept = [...new Set(options.map((option) => option.trim()).filter((option) => option !== ""))];
  if (kept.length > MAX_QUESTION_OPTIONS) {
    throw new GhostError("invalid_request", `A question takes at most ${MAX_QUESTION_OPTIONS} options.`, 400);
  }
  if (kept.some((option) => option.length > MAX_QUESTION_OPTION_LENGTH)) {
    throw new GhostError("invalid_request", `Each option must be at most ${MAX_QUESTION_OPTION_LENGTH} characters.`, 400);
  }
  return { text: trimmed, options: kept, askedAt: new Date().toISOString() };
}

export class SessionHost {
  private readonly registry: GhostRegistry;
  private readonly ownerHome: string;
  private readonly scheduleUnitDir: string;
  private readonly scheduleCommandRunner: CommandRunner | undefined;
  private readonly scheduleVerifyRunner: CommandRunner | undefined;
  private readonly scheduleJournalRunner: CommandRunner | undefined;
  private readonly eventAdmissions = new Map<string, Promise<unknown>>();
  private readonly routineChanges = new Map<string, Promise<unknown>>();
  private readonly logger: Logger;
  private readonly hooks: GhostHookRunner;
  private readonly conversationUrl: ((ghost: string, id: string) => Promise<string | null>) | undefined;
  private readonly eligibleHarnesses: () => Promise<readonly string[]>;
  private readonly harnessReport: () => Promise<HarnessReport>;
  private readonly defaultHarness: () => Promise<string | null>;
  private readonly rowOf: (id: string) => TurnRow | null;
  private readonly localModel: LocalModel | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly live = new Map<string, LiveTurn>();
  /** Each admitted turn's stop: the turn outlives its client, so only `stopTurn` or shutdown ends it early. */
  private readonly admissions = new Map<string, AbortController>();
  /** A session being switched or trashed cannot admit a turn or another mutation. */
  private readonly reservedSessions = new Set<string>();
  private readonly reservedGhosts = new Set<string>();
  /** File work in flight per ghost, which a delete or rename waits out. */
  private readonly leases = new Map<string, { count: number; drained?: () => void }>();
  private readonly metadataWrites = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<{ listener: ConversationEventListener; close: () => void }>>();
  private reportCache?: { at: number; report: Promise<HarnessReport> };
  private shuttingDown = false;
  private readonly eventRetryDelays: readonly number[];
  private readonly eventRetries = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: SessionHostOptions) {
    this.registry = options.registry;
    this.ownerHome = resolve(options.ownerHome ?? homedir());
    this.scheduleUnitDir = resolve(options.scheduleUnitDir ?? resolveScheduleUnitDirectory(this.ownerHome, {}));
    this.scheduleCommandRunner = options.scheduleCommandRunner;
    this.scheduleVerifyRunner = options.scheduleVerifyRunner;
    this.scheduleJournalRunner = options.scheduleJournalRunner;
    this.logger = options.logger ?? silentLogger;
    this.conversationUrl = options.conversationUrl;
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
    this.env = options.env ?? process.env;
    this.eligibleHarnesses = options.eligibleHarnesses ?? (() => this.omarchyEligible());
    this.harnessReport = options.harnessReport ?? (() => readHarnessReport(this.env, this.ownerHome));
    this.defaultHarness = options.defaultHarness ?? (() => omarchyDefaultAgent(this.env));
    this.localModel = options.localModel ?? null;
    const rows = options.harnessRows ?? harnessRow;
    const local = this.localModel;
    const localRow: TurnRow | null = local ? { id: LOCAL_HARNESS, run: (input) => runLocalTurn(local, input) } : null;
    this.rowOf = (id) => id === LOCAL_HARNESS ? localRow : rows(id);
    this.eventRetryDelays = options.eventRetryDelays ?? EVENT_RETRY_DELAYS_MS;
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

  /** The owner's Documents folder, which the prompt names. */
  private documentsDir(): string {
    return resolveDocumentsDirectory(this.env, this.ownerHome);
  }

  /**
   * The ghost's whole system prompt (`persona`: its character and the stable
   * policy sections) and the character alone, which is what a local pass gets.
   * Rendered before every turn, so a character the ghost (or the owner)
   * rewrote is who it is on the next one.
   */
  async renderPersona(ghost: Ghost): Promise<{ persona: string; character: string }> {
    const character = await readCharacter(ghost.dir);
    return {
      persona: buildGhostSystemPrompt({
        ghostName: ghost.name,
        character,
        homeDir: ghost.dir,
        extraSections: stablePolicySections({
          documents: this.documentsDir(),
          firstMeeting: isSeededCharacter(ghost.name, character?.body ?? null),
        }),
      }),
      character: characterSection({ ghostName: ghost.name, character }),
    };
  }

  /** The MCP servers a turn loads: the ghost's enabled `mcp.json` rows. */
  private async mcpServers(ghost: Ghost): Promise<HarnessMcpServer[]> {
    const servers: HarnessMcpServer[] = [];
    // An unreadable file or row is skipped, not thrown; GET …/mcp shows why.
    for (const server of readEnabledMcp(ghost.dir)) {
      const config = normalizeMcpStdioCwd(expandMcpServerConfig(server.config as MCPServerConfig, this.env), ghost.dir);
      servers.push({ name: server.name, config });
    }
    return servers;
  }

  /**
   * Lay out the conversation directory a harness runs in: the persona as
   * `AGENTS.md` (and the `CLAUDE.md`/`GEMINI.md` names other harnesses read),
   * and no skills: the `ghost` CLI is a ghost's documentation, and the owner's
   * own skills are where every harness already looks.
   */
  private async prepareDirectory(ghostDir: string, dir: string, persona: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "AGENTS.md"), persona, { mode: 0o600 });
    for (const alias of ["CLAUDE.md", "GEMINI.md"]) await this.ensureLink(join(dir, alias), "AGENTS.md");
    // Ghost links no skills: harnesses find the owner's own. Earlier versions
    // linked their shipped and per-ghost skills here; take those links away,
    // and leave any other link alone.
    const madeByGhost = (link: string, target: string, within: boolean): boolean => {
      const resolved = resolve(dirname(link), target);
      const root = within ? dirname(resolved) : resolved;
      return root === PACKAGED_SKILLS || root === join(ghostDir, "skills") || (basename(root) === "skills" && findSourceRoot(dirname(root)) === dirname(root));
    };
    for (const root of [".claude", ".agents"]) {
      const linked = join(dir, root, "skills");
      const whole = await readlink(linked).catch(() => null);
      if (whole !== null) {
        if (madeByGhost(linked, whole, false)) await rm(linked);
        continue;
      }
      const entries = await readdir(linked, { withFileTypes: true }).catch(() => null);
      if (entries === null) continue;
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) continue;
        const link = join(linked, entry.name);
        if (madeByGhost(link, await readlink(link), true)) await rm(link);
      }
      if ((await readdir(linked)).length === 0) await rm(linked, { recursive: true });
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

  /** Installed harnesses, in Omarchy's order. */
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
    // The local model is the default when configured, and never a fallback:
    // a conversation on it runs only there, so the owner's content stays local.
    const setting = readHarnessSetting(ghost.dir);
    if (current === LOCAL_HARNESS || (current === null && (setting === LOCAL_HARNESS || (setting === null && this.localModel)))) {
      return this.localModel ? [LOCAL_HARNESS] : [];
    }
    return this.cloudHarnesses([current, setting]);
  }

  /**
   * The cloud harnesses Ghost has a row for, best first: `preferred`, then
   * Omarchy's default agent, then every other eligible one. Turns and the
   * local model's `delegate` share this order.
   */
  private async cloudHarnesses(preferred: readonly (string | null)[]): Promise<string[]> {
    const [eligible, omarchyDefault] = await Promise.all([this.eligibleHarnesses(), this.defaultHarness()]);
    const ordered = orderHarnesses(eligible.filter((id) => id !== LOCAL_HARNESS && this.rowOf(id) !== null), [...preferred, omarchyDefault]);
    // A harness that just failed before answering goes to the back, not out:
    // if everything ahead of it fails too, it is still tried.
    return [...ordered.filter((id) => !this.restingFor(id)), ...ordered.filter((id) => this.restingFor(id))];
  }

  /** Machine-wide, since a harness's sign-in and credit are the owner's, not one ghost's. */
  private readonly resting = new Map<string, { until: number; reason: string }>();

  private restingFor(id: string): HarnessRest | null {
    const rest = this.resting.get(id);
    if (!rest) return null;
    if (rest.until <= Date.now()) {
      this.resting.delete(id);
      return null;
    }
    return { until: new Date(rest.until).toISOString(), reason: rest.reason };
  }

  /** Until the refusal says access returns, else for the default span. */
  private rest(id: string, reason: string): void {
    const now = Date.now();
    const until = statedReturn(reason, now)
      ?? now + (classifyLimitMessage(reason) ? REST_AFTER_LIMIT_MS : REST_AFTER_FAILURE_MS);
    this.resting.set(id, { until, reason: reason.slice(0, 300) });
  }

  // ── Agent choice ──────────────────────────────────────────────────────

  private requireRow(id: string): void {
    if (!this.rowOf(id)) {
      throw new GhostError("unknown_harness", `Ghost cannot run on ${JSON.stringify(id)}; it has no row for that agent.`, 400);
    }
  }

  /** Installed agents Ghost can run on, with Omarchy's usage, the ghost's preference, and what runs automatically. */
  async listHarnesses(ghostName: string): Promise<HarnessChoices> {
    const ghost = this.registry.get(ghostName);
    const [report, [automatic]] = await Promise.all([this.cachedReport(), this.harnessCandidates(ghost, null)]);
    return {
      harnesses: [
        ...report.harnesses.flatMap((harness) => {
          const row = this.rowOf(harness.id);
          return row ? [{ ...harness, effort: ("run" in row ? undefined : row.effort) ?? null, resting: this.restingFor(harness.id) }] : [];
        }),
        ...(this.localModel ? [{ id: LOCAL_HARNESS, usage: null, effort: null, resting: null }] : []),
      ],
      ghostDefault: readHarnessSetting(ghost.dir),
      automatic: automatic ?? null,
    };
  }

  /** The ghost's preferred agent, ahead of Omarchy's default; null is automatic. */
  async setGhostHarness(ghostName: string, id: string | null): Promise<HarnessChoices> {
    if (id !== null) this.requireRow(id);
    // The owner naming it is the retry.
    if (id !== null) this.resting.delete(id);
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
    this.resting.delete(id);
    const listed = id === LOCAL_HARNESS || (await this.cachedReport()).harnesses.some((harness) => harness.id === id);
    if (!listed) throw new GhostError("harness_not_installed", `${id} is not installed.`, 409);
    const ghost = this.registry.get(ghostName);
    const conversation = requireConversationId(sessionId);
    const key = keyOf(ghost.name, conversation);
    if (this.admissions.has(key) || this.reservedSessions.has(key)) {
      throw new GhostError("session_busy", "Wait for this conversation to finish before switching agents.", 409);
    }
    this.reservedSessions.add(key);
    try {
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
    } finally {
      this.reservedSessions.delete(key);
    }
  }

  /** At daemon start, rerun the event turns the last run left unfinished (CONTRACTS.md "External events"). */
  async resumeEventTurns(): Promise<void> {
    for (const { name } of this.registry.list()) {
      const { sessionDir } = ghostPaths(this.registry.get(name).dir);
      for (const id of await this.conversationIds(sessionDir)) {
        if (!id.startsWith("event-")) continue;
        try {
          const admission = await this.retryEvent(name, id, 0, true);
          if (!admission) continue;
          this.logger.info("rerunning an unfinished event turn", { ghost: name, conversation: id });
          void admission.run({ emit: () => {} }).catch((error: unknown) => this.logger.warn("event rerun failed", { ghost: name, conversation: id, error: errorMessage(error) }));
        } catch (error) {
          this.logger.warn("event rerun not started", { ghost: name, conversation: id, error: errorMessage(error) });
        }
      }
    }
  }

  // ── Turns ─────────────────────────────────────────────────────────────

  async admitTurn(
    ghostName: string,
    options: Pick<RunTurnOptions, "sessionId" | "prompt" | "desktop"> & { promptRecorded?: boolean },
  ): Promise<TurnAdmission> {
    const ghost = this.registry.get(ghostName);
    const id = requireConversationId(options.sessionId ?? "default");
    const key = keyOf(ghost.name, id);
    if (this.shuttingDown) throw new GhostError("shutting_down", "ghostd is shutting down.", 503);
    if (this.reservedGhosts.has(ghost.name)) {
      throw new GhostError("ghost_busy", "Wait for this ghost to finish moving before starting a turn.", 409);
    }
    if (this.admissions.has(key) || this.reservedSessions.has(key)) {
      throw new GhostError("session_busy", "This ghost is already answering in this conversation.", 409);
    }
    const command = ownerCommand(options.prompt);
    if (command?.command === "") throw new GhostError("invalid_request", "Write a command after ! or !!.", 400);
    const controller = new AbortController();
    let turnId: string = randomUUID();
    this.admissions.set(key, controller);
    return {
      sessionId: id,
      run: async (stream) => {
        let settled: Extract<TurnEvent, { type: "done" | "error" }> | undefined;
        try {
          await this.withGhost(ghost.name, async () => {
            let terminal: Extract<TurnEvent, { type: "done" | "error" }> | undefined;
            const emit = (event: TurnEvent) => {
              if (event.type === "done" || event.type === "error") terminal = event;
              else stream.emit(event);
            };
            try { turnId = await this.runAdmitted(ghost, id, options.prompt, command, { emit }, controller.signal, options.promptRecorded, turnId, options.desktop ?? null); }
            catch (error) {
              terminal = { type: "error", reason: controller.signal.aborted ? "aborted" : "error", errorMessage: errorMessage(error) };
            }
            terminal ??= { type: "error", reason: "error", errorMessage: "The turn ended without a terminal event." };
            stream.emit(terminal);
            settled = terminal;
          });
        } finally {
          this.admissions.delete(key);
          this.announce(ghost.name, id);
          // Delivery observes a settled turn; a slow notifier never holds the conversation busy.
          const ended = settled;
          if (ended) void this.turnEnd(ghost, id, ended, controller.signal, turnId);
        }
      },
    };
  }

  async admitEvent(ghostName: string, event: ExternalEvent): Promise<{ sessionId: string; admission: TurnAdmission | null }> {
    const alone = eventConversationId(event), prompt = eventPrompt(event), lead = eventPromptLead(event);
    const thread = event.thread === undefined ? alone : eventConversationId({ source: event.source, id: event.thread });
    return this.withGhost(ghostName, () => serializeByKey(this.eventAdmissions, keyOf(ghostName, alone), async () => {
      const ghost = this.registry.get(ghostName), { sessionDir } = ghostPaths(ghost.dir);
      const logs = new Map<string, readonly LogEntry[] | null>();
      for (const id of [thread, alone]) {
        if (logs.has(id)) continue;
        const log = await readLog(sessionDir, id);
        logs.set(id, log);
        const earlier = log?.find((entry) => entry.type === "user" && entry.origin === undefined && entry.text.startsWith(lead));
        if (earlier?.type !== "user") continue;
        if (earlier.text !== prompt) throw new GhostError("event_conflict", "This source/id already has different instructions or data.", 409);
        return { sessionId: id, admission: null };
      }
      // A busy thread holds up nothing: the event takes its own conversation.
      const threadKey = keyOf(ghostName, thread);
      const sessionId = this.admissions.has(threadKey) || this.reservedSessions.has(threadKey) ? alone : thread;
      const entries = logs.get(sessionId) ?? null;
      const admission = await this.admitTurn(ghostName, { sessionId, prompt, promptRecorded: true });
      try {
        await appendLog(sessionDir, sessionId, [
          ...(entries === null ? [newConversationEntry(sessionId, new Date())] : []),
          { type: "user", at: new Date().toISOString(), text: prompt },
        ]);
      } catch (error) { this.admissions.delete(keyOf(ghostName, sessionId)); throw error; }
      this.announce(ghostName, sessionId);
      return { sessionId, admission: this.retriedWhenUnreachable(ghostName, sessionId, admission, 0) };
    }));
  }

  /**
   * An event turn that ends unable to reach its model runs again after the
   * next delay, unattended as the first one was (CONTRACTS.md "External events").
   */
  private retriedWhenUnreachable(ghostName: string, sessionId: string, admission: TurnAdmission, attempt: number): TurnAdmission {
    return {
      sessionId,
      run: async (options) => {
        let failure: string | null = null;
        await admission.run({
          emit: (event) => {
            if (event.type === "error" && event.reason === "error") failure = event.errorMessage ?? "";
            options.emit(event);
          },
        });
        const delay = this.eventRetryDelays[attempt];
        if (failure === null || !isUnreachableMessage(failure) || delay === undefined || this.shuttingDown) return;
        this.logger.warn("event turn could not reach its model; retrying", { ghost: ghostName, conversation: sessionId, retry: attempt + 1, delayMs: delay });
        const timer = setTimeout(() => {
          this.eventRetries.delete(timer);
          void this.retryEvent(ghostName, sessionId, attempt + 1)
            .then((next) => next?.run({ emit: () => {} }))
            .catch((error: unknown) => this.logger.warn("event retry not started", { ghost: ghostName, conversation: sessionId, error: errorMessage(error) }));
        }, delay);
        timer.unref();
        this.eventRetries.add(timer);
      },
    };
  }

  /**
   * The event's turn again, while the conversation still ends at the reply
   * that could not reach its model, or when `resuming`, as the last run left
   * it unfinished; null once anything else happened there.
   */
  private async retryEvent(ghostName: string, sessionId: string, attempt: number, resuming = false): Promise<TurnAdmission | null> {
    return this.withGhost(ghostName, () => serializeByKey(this.eventAdmissions, keyOf(ghostName, sessionId), async () => {
      const key = keyOf(ghostName, sessionId);
      const entries = (await readLog(ghostPaths(this.registry.get(ghostName).dir).sessionDir, sessionId)) ?? [];
      const last = entries.findLast((entry) => entry.type === "user" || entry.type === "assistant" || entry.type === "command");
      const prompt = entries.findLast((entry) => entry.type === "user");
      // The owner's message after it answers for itself.
      if (prompt?.type !== "user" || prompt.origin !== undefined || !isEventPrompt(prompt.text)) return null;
      const due = resuming
        ? leftUnfinished(entries.slice(entries.indexOf(prompt)), last) && Date.now() - Date.parse(prompt.at) <= EVENT_RESUME_WINDOW_MS
        : endedUnreachable(last);
      if (!due) return null;
      if (this.admissions.has(key) || this.reservedSessions.has(key)) return null;
      const admission = await this.admitTurn(ghostName, { sessionId, prompt: prompt.text, promptRecorded: true });
      return this.retriedWhenUnreachable(ghostName, sessionId, admission, attempt);
    }));
  }

  /** admitTurn then run, in one call, for tests. */
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
    promptRecorded = false,
    initialTurnId: string,
    desktop: DesktopContext | null = null,
  ): Promise<string> {
    const { sessionDir } = ghostPaths(ghost.dir);
    if (!existsSync(logPath(sessionDir, id))) await appendLog(sessionDir, id, [newConversationEntry(id, new Date())]);
    stream.emit({ type: "start" });
    if (command) {
      this.announce(ghost.name, id);
      await this.runOwnerCommand(ghost, id, command.command, command.excluded, stream, signal);
      return initialTurnId;
    }
    const key = keyOf(ghost.name, id);
    const turn: LiveTurn = { followUps: [], emit: stream.emit };
    this.live.set(key, turn);
    const blocks = { next: 0 };
    const onHook: HookObserver = (name, event, running) => stream.emit({ type: running ? "hook_start" : "hook_end", name, event: event as "session_stop" });
    let terminal: TurnEvent = { type: "done" };
    // The id of the owner request the final pass answered, which `turn_end` reports.
    let turnId = initialTurnId;
    try {
      type Pass = { text: string; origin?: "follow_up" | "hook" };
      let next: Pass | undefined = { text: prompt };
      const first = next;
      let ownerPrompt = prompt;
      while (next && !signal.aborted) {
        const { text, origin }: Pass = next;
        if (origin === "follow_up") {
          turnId = randomUUID();
          ownerPrompt = text;
        }
        if (!promptRecorded || origin !== undefined) {
          await appendLog(sessionDir, id, [{ type: "user", at: new Date().toISOString(), text, ...(origin ? { origin } : {}) }]);
        }
        // The owner's message answers what the ghost was waiting on.
        if (origin !== "hook") await this.dropQuestion(ghost, id);
        // Other clients learn the turn is running with its prompt already readable.
        this.announce(ghost.name, id);
        let passPrompt = origin === "hook" ? `${STOP_HOOK_FEEDBACK_PREFIX}${text}` : text;
        if (desktop && next === first && origin === undefined) passPrompt = `${passPrompt}\n\n${renderDesktopContext(desktop)}`;
        const failure = await this.runPasses(ghost, id, passPrompt, stream, blocks, signal);
        // A failed pass ends the turn only when nothing is queued behind it:
        // the owner's follow-ups were accepted and still run.
        terminal = failure ?? { type: "done" };
        if (failure && (signal.aborted || turn.followUps.length === 0)) break;
        // The owner's own queued message is the next instruction: a stop hook
        // is not asked while one waits, and loses to one sent while it ran.
        // Nor while the ghost's own question waits (`ghost ask`): the turn is
        // waiting on the owner, and a hook's "keep going" is not their answer.
        const continuation: string | null = failure || turn.followUps.length > 0 || await this.hasQuestion(ghost, id)
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
    return turnId;
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
        errorMessage: logState(entries).harness === LOCAL_HARNESS || readHarnessSetting(ghost.dir) === LOCAL_HARNESS
          ? "This conversation runs on the local model, and none is configured: set `local.model` in ~/.config/ghost/config.json."
          : "No supported agent CLI is installed. See `ghost harnesses`.",
      };
    }
    let lastError = "The turn failed.";
    for (const harness of candidates) {
      const row = this.rowOf(harness) as TurnRow;
      const bound = logState(entries);
      const dir = conversationDir(sessionDir, id);
      // A harness new to the conversation, or to its directory since a home
      // rename, has not seen it; one continuing it has not seen the owner's
      // `!` commands since its last turn.
      const moved = bound.harnessDir !== null && bound.harnessDir !== dir;
      if (bound.harness !== harness || moved || bound.harnessDir === null) {
        await appendLog(sessionDir, id, [{ type: "harness", at: new Date().toISOString(), harness, session: null, dir }]);
      }
      // The local model keeps no session of its own: every pass is handed the conversation.
      const fresh = "run" in row || bound.harness !== harness || moved || !bound.harnessStarted;
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
        message: entries.findLast((entry) => entry.type === "user")?.text,
        resume: !fresh,
        sessionId: fresh ? null : bound.harnessSession,
      }, stream, blocks, signal);
      if (result.error === null) this.resting.delete(harness);
      if (result.error === null || result.aborted || result.produced) {
        const effort = result.model?.effort ?? ("run" in row ? undefined : row.effort);
        await appendLog(sessionDir, id, [{
          type: "assistant",
          at: new Date().toISOString(),
          harness,
          content: result.content,
          ...(result.error ? { error: result.error } : {}),
          ...(result.aborted && this.shuttingDown ? { interrupted: true as const } : {}),
          ...(result.model ? { model: result.model.model } : {}),
          ...(result.model?.provider ? { provider: result.model.provider } : {}),
          ...(effort ? { effort } : {}),
        }]);
        return result.error === null ? null : this.failure(stream, harness, result.error, result.aborted);
      }
      lastError = result.error;
      this.rest(harness, result.error);
      this.logger.warn("harness failed before answering; trying the next", { ghost: ghost.name, conversation: id, harness, error: result.error });
      entries = (await readLog(sessionDir, id)) ?? [];
    }
    const last = candidates.at(-1) as string;
    await appendLog(sessionDir, id, [{ type: "assistant", at: new Date().toISOString(), harness: last, content: [], error: lastError }]);
    return this.failure(stream, last, lastError, false);
  }

  /**
   * The local model's `delegate`: one headless run of the first cloud harness
   * that answers, in the conversation's directory, with the ghost's persona
   * and MCP servers. Its reply returns to the local model, not the owner.
   */
  private async delegateTask(
    ghost: Ghost, dir: string, env: NodeJS.ProcessEnv, persona: string, task: string, signal: AbortSignal,
  ): Promise<DelegateResult> {
    const [ordered, mcp] = await Promise.all([this.cloudHarnesses([readHarnessSetting(ghost.dir)]), this.mcpServers(ghost)]);
    const prompt = `Your local self, which keeps the owner's content on this computer, hands you this task. Do it, then reply with the result.\n\n${task}`;
    let lastError = "No cloud agent is installed to delegate to.";
    for (const harness of ordered) {
      const pass = await this.cloudPass(harness, { prompt, persona, mcp, dir, env, signal });
      if (!pass) return { harness, text: "Stopped.", isError: true };
      const text = pass.text.slice(0, TOOL_RESULT_CHARS);
      if (text && pass.error === null) return { harness, text, isError: false };
      if (text) return { harness, text: `${text}\n(${harness} then failed: ${pass.error})`, isError: true };
      lastError = `${harness}: ${pass.error ?? "no answer"}`;
    }
    return { harness: null, text: `No cloud agent could take the task. ${lastError}`, isError: true };
  }

  /**
   * One headless run of a cloud harness outside a turn (a delegated task, a
   * hook completion): its trimmed text and the error that ended it, or null
   * when `signal` stopped it. Answering ends the harness's rest, as a turn's
   * pass does; failing before any text starts one.
   */
  private async cloudPass(harness: string, run: {
    prompt: string; persona: string; mcp: readonly HarnessMcpServer[]; dir: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
  }): Promise<{ text: string; error: string | null } | null> {
    const row = this.rowOf(harness) as HarnessRow;
    const launch = row.launch({ prompt: run.prompt, resume: false, sessionId: null, persona: run.persona, mcp: run.mcp });
    await writeLaunchFiles(run.dir, launch.files);
    let text = "";
    let error: string | null = null;
    const exit = await runHarness({
      launch, cwd: run.dir, env: { ...run.env, ...(await accountEnv(harness, this.env)) }, signal: run.signal, parse: row.parser(),
      onEvent: (event) => {
        if (event.type === "text") text += event.delta;
        else if (event.type === "error") error = event.message;
        else if (event.type === "retry") error = null;
      },
    });
    if (run.signal.aborted) return null;
    error ??= exit.spawnError
      ?? (exit.code === 0 ? null : exit.stderr.trim().split("\n").slice(-4).join("\n") || `${harness} exited with ${exit.code}.`);
    text = text.trim();
    if (text && error === null) this.resting.delete(harness);
    else if (!text && error !== null) this.rest(harness, error);
    return { text, error };
  }

  /**
   * One completion for a trusted command hook (`ghostd hook-complete`), on the
   * harness a new conversation would start on, in a scratch directory with no
   * persona, conversation, or Ghost tools; on the local model, this daemon's
   * own copy, never then a cloud one. It takes no ghost lease, admission, or
   * conversation lock: the turn awaiting the `session_stop` hook that asks
   * holds its own, and waiting for it would deadlock.
   */
  async complete(ghostName: string, prompt: string, signal: AbortSignal): Promise<string> {
    if (!prompt.trim()) throw new GhostError("invalid_request", "prompt must be a non-empty string.", 400);
    const ghost = this.registry.get(ghostName);
    const candidates = await this.harnessCandidates(ghost, null);
    if (candidates[0] === LOCAL_HARNESS && this.localModel) {
      const text = (await completeLocally(this.localModel, prompt, signal)).trim();
      if (!text) throw new GhostError("completion_failed", "The local model returned no text for the prompt.", 502);
      return text;
    }
    if (candidates.length === 0 && readHarnessSetting(ghost.dir) === LOCAL_HARNESS) {
      throw new GhostError("harness_not_installed", "This ghost runs on the local model, and none is configured.", 409);
    }
    const failures: string[] = [];
    for (const harness of candidates) {
      const dir = await mkdtemp(join(tmpdir(), "ghost-hook-"));
      try {
        // `GHOST` names the ghost, as in a turn, so a harness stop hook that
        // stands down inside Ghost runs does not review this completion.
        const pass = await this.cloudPass(harness, { prompt, persona: "", mcp: [], dir, env: { ...this.env, GHOST: ghost.name }, signal });
        if (!pass) throw new Error("The completion was cancelled.");
        if (pass.text && pass.error === null) return pass.text;
        failures.push(`${harness}: ${pass.error ?? "no answer"}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    throw new GhostError("completion_failed", failures.length > 0
      ? `No harness completed the prompt (${failures.join("; ")}).`
      : "No harness is eligible to complete the prompt.", 502);
  }

  private failure(stream: AdmittedTurnOptions, harness: string, message: string, aborted: boolean): TerminalError {
    const kind = aborted ? null : classifyLimitMessage(message);
    if (kind) stream.emit({ type: "limit_reached", harness, kind });
    return { type: "error", reason: aborted ? "aborted" : "error", errorMessage: message };
  }

  private async runPass(
    ghost: Ghost,
    id: string,
    row: TurnRow,
    turn: { prompt: string; message?: string; resume: boolean; sessionId: string | null },
    stream: AdmittedTurnOptions,
    blocks: { next: number },
    signal: AbortSignal,
  ): Promise<PassResult> {
    const { sessionDir } = ghostPaths(ghost.dir);
    const dir = conversationDir(sessionDir, id);
    const account = accountEnv(row.id, this.env);
    const [{ persona, character }, mcp] = await Promise.all([this.renderPersona(ghost), "run" in row ? [] : this.mcpServers(ghost)]);
    await this.prepareDirectory(ghost.dir, dir, persona);
    const launch = "run" in row ? null : row.launch({ ...turn, persona, mcp });
    await writeLaunchFiles(dir, launch?.files);

    const at = new Date().toISOString();
    const content: AssistantPart[] = [];
    const tools = new Map<string, { name: string; part: number }>();
    // The text block streaming now and its logged part, the last one while it is open,
    // so a block key a harness reuses after a tool call logs a new part, as the stream shows.
    let open: { key: string; index: number; part: number; text: string } | null = null;
    let error: string | null = null;
    let produced = false;
    let thoughtBlock: string | null = null;
    let model: Extract<HarnessEvent, { type: "model" }> | null = null;
    /** The harness session this pass reported, if it reported one. */
    let reported: string | null = null;
    const writes: Promise<void>[] = [];
    const closeBlock = () => {
      if (!open) return;
      content[open.part] = { type: "text", text: open.text };
      stream.emit({ type: "text_end", contentIndex: open.index, content: open.text });
      open = null;
    };
    const logCompaction = (event: Extract<HarnessEvent, { type: "compacted" }>): void => {
      writes.push(appendLog(sessionDir, id, [{ type: "compacted", at: event.at ?? new Date().toISOString(), harness: row.id, trigger: event.trigger, ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}) }]));
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
          reported = event.id;
          writes.push(appendLog(sessionDir, id, [{ type: "harness", at: new Date().toISOString(), harness: row.id, session: event.id, dir }]));
          return;
        case "error":
          error = event.message;
          return;
        case "retry":
          error = null;
          return;
        case "compacted":
          logCompaction(event);
          stream.emit({ type: "compacted", trigger: event.trigger, ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}) });
          return;
      }
    };

    const env = { ...this.env, ...conversationEnvironment(ghost.name, id), ...(await account) };
    const exit: HarnessExit = "run" in row
      ? await row.run({
        prompt: turn.prompt, message: turn.message ?? turn.prompt, character, cwd: dir, home: this.ownerHome, env, signal, onEvent,
        delegate: (task) => this.delegateTask(ghost, dir, env, persona, task, signal),
      }).then(() => ({ code: 0, signal: null, stderr: "" }), (failure: unknown) => {
        if (!signal.aborted) error = errorMessage(failure);
        return { code: 1, signal: null, stderr: "" };
      })
      : await runHarness({
        launch: launch as NonNullable<typeof launch>,
        cwd: dir,
        env,
        parse: row.parser(),
        onEvent,
        signal,
      });
    closeBlock();
    // The session record lands before the pass's assistant entry.
    await Promise.all(writes);
    if (reported !== null && "inspectSession" in row && row.inspectSession && !exit.spawnError && !signal.aborted) {
      for (const fact of await row.inspectSession(reported, env, at).catch(() => [])) {
        // Found after the reply streamed: logged ahead of it, shown when the client reloads the transcript.
        if (fact.type === "compacted") logCompaction(fact);
        else if (model === null) onEvent(fact);
      }
      await Promise.all(writes);
    }
    if (signal.aborted) return { content, error: "Turn aborted.", aborted: true, produced, model };
    if (exit.spawnError) return { content, error: `${row.id} could not start: ${exit.spawnError}`, aborted: false, produced, model };
    if (error === null && exit.code !== 0) {
      const stderr = exit.stderr.trim().split("\n").slice(-6).join("\n");
      error = stderr || `${row.id} exited with ${exit.code === null ? `signal ${exit.signal}` : `status ${exit.code}`}.`;
    }
    return { content, error, aborted: false, produced, model };
  }

  private async turnEnd(
    ghost: Ghost, id: string, terminal: Extract<TurnEvent, { type: "done" | "error" }>, signal: AbortSignal, turnId: string,
  ): Promise<void> {
    if (!this.hooks.hasHandlers("turn_end") || signal.aborted || (terminal.type === "error" && terminal.reason === "aborted")) return;
    try {
      // The lease covers reading the home, not the handlers, so a slow notifier never holds up a rename or delete.
      const event = await this.withGhost(ghost.name, async () => {
        const { sessionDir } = ghostPaths(ghost.dir), entries = (await readLog(sessionDir, id)) ?? [];
        const last = entries.findLast(entry => entry.type === "assistant" || entry.type === "command");
        const text = terminal.type === "error" ? terminal.errorMessage
          : last?.type === "assistant" ? last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
          : last?.type === "command" ? last.output : "";
        return { title: (logState(entries).title ?? ghost.name).slice(0, 160), text, sessionDir };
      });
      const url = await this.conversationUrl?.(ghost.name, id).catch(() => null) ?? null;
      await this.hooks.emitTurnEnd({
        type: "turn_end", turn_id: turnId, outcome: terminal.type, title: event.title,
        excerpt: (event.text ?? "").replace(/\s+/gu, " ").trim().slice(0, 280), url,
        ...hookEventBase(ghost, id, event.sessionDir, signal),
      });
    } catch { this.logger.warn("turn_end delivery failed open", { ghost: ghost.name, conversation: id }); }
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
      ...hookEventBase(ghost, id, sessionDir, signal),
      transcript_path: logPath(sessionDir, id),
      stop_hook_active: active,
      owner_prompt: ownerPrompt,
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
    // Raw chunks avoid retaining a whole newline-free line before the tail limit.
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
      onStdout: (chunk) => {
        output += chunk;
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

  queuedMessages(ghostName: string, sessionId: string): QueuedMessages {
    this.registry.get(ghostName);
    const turn = this.live.get(keyOf(ghostName, requireConversationId(sessionId)));
    return { streaming: turn !== undefined, followUp: turn ? [...turn.followUps] : [] };
  }

  /** Abort the conversation's running turn or owner command; its stream ends `aborted`. */
  stopTurn(ghostName: string, sessionId: string): void {
    this.registry.get(ghostName);
    const controller = this.admissions.get(keyOf(ghostName, requireConversationId(sessionId)));
    if (!controller) {
      throw new GhostError("session_not_streaming", "This conversation is not currently streaming.", 409);
    }
    controller.abort();
  }

  /** Queue text for after the current pass; a harness takes no input mid-run. */
  async queueMessage(ghostName: string, sessionId: string, text: string): Promise<QueuedMessages> {
    this.registry.get(ghostName);
    const key = keyOf(ghostName, requireConversationId(sessionId));
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
    const [ids, pins, reads, questions] = await Promise.all([
      this.conversationIds(sessionDir),
      readPins(sessionDir),
      readReads(sessionDir),
      readQuestions(sessionDir),
    ]);
    const listed = await Promise.all(ids.map(async (id) => ({ id, log: await listedLog(sessionDir, id) })));
    const rows: SessionSummary[] = [];
    for (const { id, log } of listed) {
      if (!log) continue;
      const { state, updatedAt } = log;
      // An owner command logs when it ends, so a running one is listed before anything is.
      const running = this.admissions.has(keyOf(ghost.name, id));
      if (state.messageCount === 0 && state.title === null && !running) continue;
      const readAt = reads[id];
      rows.push({
        id,
        title: state.title,
        preview: state.preview,
        source: state.source,
        harness: state.harness,
        model: state.model,
        provider: state.provider,
        effort: state.effort,
        updatedAt,
        messageCount: state.messageCount,
        pinned: pins.includes(id),
        unread: readAt === undefined || updatedAt > readAt,
        running,
        question: questions[id] ?? null,
      });
    }
    return rows.sort((a, b) => (a.pinned === b.pinned ? b.updatedAt.localeCompare(a.updatedAt) : (a.pinned ? -1 : 1)));
  }

  private async requireConversation(ghost: Ghost, sessionId: string): Promise<string> {
    const id = requireConversationId(sessionId);
    if (!existsSync(logPath(ghostPaths(ghost.dir).sessionDir, id))) {
      throw new GhostError("not_found", `This ghost has no conversation ${JSON.stringify(id)}.`, 404);
    }
    return id;
  }

  async setPinned(ghostName: string, sessionId: string, pinned: boolean): Promise<void> {
    await this.withGhost(ghostName, async () => {
      const ghost = this.registry.get(ghostName);
      const id = await this.requireConversation(ghost, sessionId);
      const { sessionDir } = ghostPaths(ghost.dir);
      await serializeByKey(this.metadataWrites, pinsPath(sessionDir), async () => {
        const existing = new Set(await this.conversationIds(sessionDir));
        const kept = (await readPins(sessionDir)).filter((pin) => pin !== id && existing.has(pin));
        await writePins(sessionDir, pinned ? [...kept, id] : kept);
      });
      this.announce(ghost.name, id);
    });
  }

  /**
   * Record what the ghost asks the owner in a conversation, replacing an
   * earlier open question there. It stays until the owner's next message to
   * that conversation (`dropQuestion`) or until dismissed.
   */
  async setQuestion(ghostName: string, sessionId: string, text: string, options: readonly string[]): Promise<OwnerQuestion> {
    const question = validQuestion(text, options);
    await this.withGhost(ghostName, async () => {
      const ghost = this.registry.get(ghostName);
      const id = await this.requireConversation(ghost, sessionId);
      await this.updateQuestions(ghost, (questions) => ({ ...questions, [id]: question }));
      this.announce(ghost.name, id);
    });
    return question;
  }

  /** Withdraw a conversation's open question without answering it. */
  async dismissQuestion(ghostName: string, sessionId: string): Promise<void> {
    await this.withGhost(ghostName, async () => {
      const ghost = this.registry.get(ghostName);
      const id = await this.requireConversation(ghost, sessionId);
      if (await this.dropQuestion(ghost, id)) this.announce(ghost.name, id);
    });
  }

  /** The ghost has asked the owner something in this conversation that is still open. */
  private async hasQuestion(ghost: Ghost, id: string): Promise<boolean> {
    return id in await readQuestions(ghostPaths(ghost.dir).sessionDir);
  }

  /** Owner text reached the conversation: whatever was asked there is answered. */
  private async dropQuestion(ghost: Ghost, id: string): Promise<boolean> {
    let dropped = false;
    await this.updateQuestions(ghost, (questions) => {
      if (!(id in questions)) return null;
      dropped = true;
      return Object.fromEntries(Object.entries(questions).filter(([asked]) => asked !== id));
    });
    return dropped;
  }

  /**
   * Apply `change` to the open questions of conversations that still exist.
   * The file is rewritten only when that changes something (a null `change`
   * result, with nothing stale to prune), so most turns touch no file.
   */
  private async updateQuestions(
    ghost: Ghost,
    change: (questions: Record<string, OwnerQuestion>) => Record<string, OwnerQuestion> | null,
  ): Promise<void> {
    const { sessionDir } = ghostPaths(ghost.dir);
    await serializeByKey(this.metadataWrites, questionsPath(sessionDir), async () => {
      const existing = new Set(await this.conversationIds(sessionDir));
      const stored = Object.entries(await readQuestions(sessionDir));
      const kept = Object.fromEntries(stored.filter(([id]) => existing.has(id)));
      const next = change(kept);
      if (next !== null) await writeQuestions(sessionDir, next);
      else if (Object.keys(kept).length < stored.length) await writeQuestions(sessionDir, kept);
    });
  }

  async markRead(ghostName: string, sessionId: string, openedAt = new Date()): Promise<string> {
    return this.withGhost(ghostName, async () => {
      const ghost = this.registry.get(ghostName);
      const id = await this.requireConversation(ghost, sessionId);
      const { sessionDir } = ghostPaths(ghost.dir);
      let readAt = openedAt.toISOString();
      await serializeByKey(this.metadataWrites, readsPath(sessionDir), async () => {
        const existing = new Set(await this.conversationIds(sessionDir));
        const kept = Object.fromEntries(Object.entries(await readReads(sessionDir)).filter(([read]) => existing.has(read)));
        readAt = kept[id] && kept[id] > readAt ? kept[id] : readAt;
        await writeReads(sessionDir, { ...kept, [id]: readAt });
      });
      this.announce(ghost.name, id);
      return readAt;
    });
  }

  async renameConversation(ghostName: string, sessionId: string, title: string): Promise<string> {
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new GhostError("invalid_request", "\"title\" must not be empty.", 400);
    if (trimmed.length > MAX_CONVERSATION_TITLE_LENGTH) {
      throw new GhostError("invalid_request", `"title" must be at most ${MAX_CONVERSATION_TITLE_LENGTH} characters.`, 400);
    }
    if (!/\P{C}/u.test(trimmed)) {
      throw new GhostError("invalid_request", "A conversation title needs at least one printable character.", 400);
    }
    return this.withGhost(ghostName, async () => {
      const ghost = this.registry.get(ghostName);
      const id = await this.requireConversation(ghost, sessionId);
      await appendLog(ghostPaths(ghost.dir).sessionDir, id, [{ type: "title", at: new Date().toISOString(), title: trimmed }]);
      this.announce(ghost.name, id);
      return trimmed;
    });
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
    sessionId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Transcript> {
    return this.withGhost(ghostName, () => this.readTranscriptLeased(ghostName, sessionId, options));
  }

  private async readTranscriptLeased(
    ghostName: string,
    sessionId: string,
    options: { limit?: number; offset?: number },
  ): Promise<Transcript> {
    const ghost = this.registry.get(ghostName);
    const id = requireConversationId(sessionId);
    const limit = Math.max(1, clamp(options.limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT));
    const requestedOffset = clamp(options.offset, 0, Number.MAX_SAFE_INTEGER);
    const { messages, total } = await readTranscriptPage(ghostPaths(ghost.dir).sessionDir, id, requestedOffset, limit);
    const offset = Math.min(requestedOffset, total);
    return {
      id,
      messages,
      total,
      truncated: offset > 0 || offset + messages.length < total,
    };
  }

  private routineOperation<T>(ghost: string, action: (options: { unitDir: string; run?: CommandRunner; verify?: CommandRunner }) => Promise<T>): Promise<T> {
    return this.withGhost(ghost, () => serializeByKey(this.routineChanges, ghost, async () => {
      this.registry.get(ghost);
      return action({ unitDir: this.scheduleUnitDir, run: this.scheduleCommandRunner, verify: this.scheduleVerifyRunner });
    }));
  }

  routineLogs(ghost: string, slug: string) { return this.routineOperation(ghost, (options) => readRoutineLogs(ghost, slug, options, this.scheduleJournalRunner)); }
  routines(ghost: string) {
    return this.routineOperation(ghost, async options => ({
      routines: await listGhostRoutines(ghost, options), recoveries: await listRoutineRecoveries(ghost, options),
    }));
  }
  controlRoutine(ghost: string, slug: string, action: string) {
    return this.routineOperation(ghost, (options) => controlGhostRoutine(ghost, slug, action, options));
  }
  routineConfig(ghost: string, slug: string) { return this.routineOperation(ghost, (options) => readRoutineConfig(ghost, slug, options)); }
  saveRoutine(ghost: string, slug: string, config: RoutineConfig) {
    return this.routineOperation(ghost, (options) => saveRoutineConfig(ghost, slug, config, options));
  }
  removeRoutine(ghost: string, slug: string, expected: string) {
    return this.routineOperation(ghost, (options) => removeRoutine(ghost, slug, expected, options));
  }
  restoreRoutine(ghost: string, id: string) { return this.routineOperation(ghost, (options) => restoreRoutine(ghost, id, options)); }

  /** Move the conversation's directory, log and all, to recoverable Trash. */
  async deleteSession(ghostName: string, sessionId: string): Promise<void> {
    return this.withGhost(ghostName, async () => {
      const ghost = this.registry.get(ghostName);
      const id = await this.requireConversation(ghost, sessionId);
      const key = keyOf(ghost.name, id);
      if (this.admissions.has(key) || this.reservedSessions.has(key)) {
        throw new GhostError("session_busy", "Wait for this conversation to finish before deleting it.", 409);
      }
      this.reservedSessions.add(key);
      try {
        const { sessionDir } = ghostPaths(ghost.dir);
        await trashPath(conversationDir(sessionDir, id), this.trashEnv());
        await serializeByKey(this.metadataWrites, pinsPath(sessionDir), async () => {
          const pins = await readPins(sessionDir);
          if (pins.includes(id)) await writePins(sessionDir, pins.filter((pin) => pin !== id));
        });
        await this.dropQuestion(ghost, id);
        this.logger.info("trashed conversation", { ghost: ghost.name, conversation: id });
        this.announce(ghost.name, id);
      } finally {
        this.reservedSessions.delete(key);
      }
    });
  }

  // ── Ghost lifecycle ───────────────────────────────────────────────────

  private ghostBusy(ghostName: string): boolean {
    return [...this.admissions.keys(), ...this.reservedSessions].some((key) => ghostOfKey(key) === ghostName);
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
      await sweepGhostSchedules(ghost.name, { unitDir: this.scheduleUnitDir, run: this.scheduleCommandRunner, logger: this.logger });
      await discardRoutineRecoveries(ghost.name, { unitDir: this.scheduleUnitDir });
    } catch (error) {
      this.logger.error(`could not clean up a ghost's schedules before it was ${outcome}`, { ghost: ghost.name, error: errorMessage(error) });
      throw new GhostError(
        "schedule_cleanup_failed",
        `Could not stop and remove this ghost's schedules. The ghost was not ${outcome}; retry after checking its systemd user timers.`,
        503,
      );
    }
  }

  /** The environment `gio trash` resolves the owner's Trash from. */
  private trashEnv(): NodeJS.ProcessEnv {
    return { ...this.env, HOME: this.ownerHome };
  }

  async deleteGhost(ghostName: string): Promise<void> {
    const ghost = this.registry.get(ghostName);
    await this.reserve([ghost.name], "deleting it");
    try {
      await this.quiesce(ghost, "deleted");
      await trashPath(ghost.dir, this.trashEnv());
      this.closeConversationEventStreams(ghost.name);
      this.logger.info("trashed ghost", { ghost: ghost.name });
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

  async disposeAll(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.eventRetries) clearTimeout(timer);
    this.eventRetries.clear();
    for (const controller of this.admissions.values()) controller.abort();
    for (const ghostName of [...this.listeners.keys()]) this.closeConversationEventStreams(ghostName);
    await this.localModel?.stop("daemon stopping");
  }
}
