/**
 * Conversations, as ghostd hosts them: each turn runs on the local model
 * (`local-turn.ts`) in the conversation's own directory with the ghost's
 * persona, its output streamed to the client and recorded in the conversation
 * log. ghostd owns the persona, the log, the owner's hooks, and the ghost's
 * lifecycle; nothing of a turn leaves the machine unless a command the model
 * runs sends it.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildGhostSystemPrompt, FIRST_MEETING_SECTION, isSeededCharacter } from "./persona.js";
import { readCharacter } from "./home.js";
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
  type AssistantPart,
  type TranscriptMessage,
} from "./conversation-log.js";
import { ghostPaths, type Ghost } from "./ghosts.js";
import { chooseCodingAgent } from "./coding-agent.js";
import { runProcess } from "./process.js";
import { GhostHookRunner, type HookObserver } from "./hooks.js";
import { silentLogger, type Logger } from "./log.js";
import {
  OMARCHY_COMPUTER_USE_POLICY,
  GHOST_POLICY,
  renderOwnerContextPolicy,
} from "./prompt-policy.js";
import type { TurnEvent } from "./turn-events.js";
import { type OwnerQuestion, pinsPath, questionsPath, readPins, readQuestions, readReads, readsPath, writePins, writeQuestions, writeReads } from "./sidecars.js";
import { serializeByKey } from "./promise-chain.js";
import { trashPath } from "./trash.js";
import type { LocalModel } from "./local-model.js";
import { completeLocally, runLocalTurn, type PassEvent, type PassInput } from "./local-turn.js";


/** Same prefix Claude Code and Codex put on Stop-hook continuation prompts. */
const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:\n";

/** The live tail of a tool's output shown on its card. */
const TOOL_SUMMARY_MAX = 800;
/**
 * A conversation name is a label in a sidebar, not a description. The cap is
 * generous for a sentence and short enough to stay a label.
 */
const MAX_CONVERSATION_TITLE_LENGTH = 120;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_QUESTION_OPTIONS = 6;
const MAX_QUESTION_OPTION_LENGTH = 120;

export interface SessionHostOptions {
  /** The machine's one ghost. */
  ghost: Ghost;
  ownerHome?: string;
  logger?: Logger;
  hooks?: GhostHookRunner;
  /** The app's link to a conversation for `turn_end`'s `url`, or null. */
  conversationUrl?: (id: string) => Promise<string | null>;
  /** The model ghostd runs (CONTRACTS.md "Local model"); without one no turn can run. */
  localModel?: LocalModel | null;
  /** What answers in place of the local model; a test supplies a script. */
  answerer?: Answerer | null;
  /** The owner's coding agent, which a turn's prompt names; production asks Omarchy. */
  codingAgent?: () => Promise<string | null>;
  /** The environment commands run with; the daemon's own by default. */
  env?: NodeJS.ProcessEnv;
}

/** What answers a ghost's turns and its hooks' completions. */
export interface Answerer {
  /** One pass; throws with the message the turn reports as its error. */
  turn(input: PassInput): Promise<void>;
  /** One completion with no persona, conversation, or tools. */
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}

const NO_LOCAL_MODEL = "No local model is configured: set `local.model` in ~/.config/ghost/config.json.";

interface RunTurnOptions {
  sessionId?: string | null;
  prompt: string;
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

interface LiveTurn {
  /** The owner's queued messages, in order, which a client shows. */
  readonly followUps: string[];
  /** The turn's own stream, which announces each change to `followUps`. */
  readonly emit: (event: TurnEvent) => void;
}

/** One pass: what it said and did, and how it ended. */
interface PassResult {
  readonly content: AssistantPart[];
  readonly error: string | null;
  readonly aborted: boolean;
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



/** The fields every hook event carries (docs/hooks.md). */
function hookEventBase(ghost: Ghost, id: string, sessionDir: string, signal: AbortSignal): GhostHookEventBase {
  return {
    session_id: id, transcript_path: logPath(sessionDir, id), signal, ghost_name: ghost.name,
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
  private readonly ghost: Ghost;
  private readonly ownerHome: string;
  private readonly logger: Logger;
  private readonly hooks: GhostHookRunner;
  private readonly conversationUrl: ((id: string) => Promise<string | null>) | undefined;
  private readonly answerer: Answerer | null;
  private readonly codingAgent: () => Promise<string | null>;
  private readonly localModel: LocalModel | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly live = new Map<string, LiveTurn>();
  /** Each admitted turn's stop: the turn outlives its client, so only `stopTurn` or shutdown ends it early. */
  private readonly admissions = new Map<string, AbortController>();
  /** A session being trashed cannot admit a turn or another mutation. */
  private readonly reservedSessions = new Set<string>();
  private readonly metadataWrites = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<{ listener: ConversationEventListener; close: () => void }>();
  private shuttingDown = false;

  constructor(options: SessionHostOptions) {
    this.ghost = options.ghost;
    this.ownerHome = resolve(options.ownerHome ?? homedir());
    this.logger = options.logger ?? silentLogger;
    this.conversationUrl = options.conversationUrl;
    this.hooks = options.hooks ?? new GhostHookRunner({ logger: this.logger });
    this.env = options.env ?? process.env;
    const local = options.localModel ?? null;
    this.localModel = local;
    this.answerer = options.answerer
      ?? (local ? { turn: (input) => runLocalTurn(local, input), complete: (prompt, signal) => completeLocally(local, prompt, signal) } : null);
    this.codingAgent = options.codingAgent ?? (() => chooseCodingAgent(this.env));
  }

  // ── Conversation events ────────────────────────────────────────────────

  subscribeConversationEvents(
    listener: ConversationEventListener,
    close: () => void = () => {},
  ): () => void {
    const subscription = { listener, close };
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }

  private announce(id: string): void {
    const event: ConversationUpdatedEvent = { type: "conversation-updated", id, updatedAt: new Date().toISOString() };
    for (const { listener } of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("conversation event listener failed", { error: errorMessage(error) });
      }
    }
  }

  private closeConversationEventStreams(): void {
    const set = [...this.listeners];
    this.listeners.clear();
    for (const { close } of set) {
      try {
        close();
      } catch {
        // The stream is going away either way.
      }
    }
  }

  // ── Persona ───────────────────────────────────────────────────────────

  /** Where the owner's sources are read from (CONTRACTS.md "Sources"): the home and environment turns see. */
  sourceContext(signal: AbortSignal): { home: string; env: NodeJS.ProcessEnv; signal: AbortSignal } {
    return { home: this.ownerHome, env: this.env, signal };
  }

  /** The owner's Documents folder, which the prompt names. */
  private documentsDir(): string {
    return resolveDocumentsDirectory(this.env, this.ownerHome);
  }

  /**
   * The ghost's whole system prompt: its character and the stable policy sections.
   * Rendered before every turn, so a character the ghost (or the owner)
   * rewrote is who it is on the next one.
   */
  async renderPersona(ghost: Ghost): Promise<string> {
    const character = await readCharacter(ghost.dir);
    return buildGhostSystemPrompt({
      ghostName: ghost.name,
      character,
      homeDir: ghost.dir,
      extraSections: stablePolicySections({
        documents: this.documentsDir(),
        firstMeeting: isSeededCharacter(ghost.name, character?.body ?? null),
      }),
    });
  }

  // ── Turns ─────────────────────────────────────────────────────────────

  async admitTurn(
    options: Pick<RunTurnOptions, "sessionId" | "prompt">,
  ): Promise<TurnAdmission> {
    const ghost = this.ghost;
    const id = requireConversationId(options.sessionId ?? "default");
    const key = id;
    if (this.shuttingDown) throw new GhostError("shutting_down", "ghostd is shutting down.", 503);
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
          let terminal: Extract<TurnEvent, { type: "done" | "error" }> | undefined;
          const emit = (event: TurnEvent) => {
            if (event.type === "done" || event.type === "error") terminal = event;
            else stream.emit(event);
          };
          try { turnId = await this.runAdmitted(ghost, id, options.prompt, command, { emit }, controller.signal, turnId); }
          catch (error) {
            terminal = { type: "error", reason: controller.signal.aborted ? "aborted" : "error", errorMessage: errorMessage(error) };
          }
          terminal ??= { type: "error", reason: "error", errorMessage: "The turn ended without a terminal event." };
          stream.emit(terminal);
          settled = terminal;
        } finally {
          this.admissions.delete(key);
          this.announce(id);
          // Delivery observes a settled turn; a slow notifier never holds the conversation busy.
          const ended = settled;
          if (ended) void this.turnEnd(ghost, id, ended, controller.signal, turnId);
        }
      },
    };
  }

  /** admitTurn then run, in one call, for tests. */
  async runTurn(options: RunTurnOptions): Promise<void> {
    await (await this.admitTurn(options)).run(options);
  }

  private async runAdmitted(
    ghost: Ghost,
    id: string,
    prompt: string,
    command: ReturnType<typeof ownerCommand>,
    stream: AdmittedTurnOptions,
    signal: AbortSignal,
    initialTurnId: string,
  ): Promise<string> {
    const { sessionDir } = ghostPaths(ghost.dir);
    if (!existsSync(logPath(sessionDir, id))) await appendLog(sessionDir, id, [newConversationEntry(id, new Date())]);
    stream.emit({ type: "start" });
    if (command) {
      this.announce(id);
      await this.runOwnerCommand(ghost, id, command.command, command.excluded, stream, signal);
      return initialTurnId;
    }
    const key = id;
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
      let ownerPrompt = prompt;
      while (next && !signal.aborted) {
        const { text, origin }: Pass = next;
        if (origin === "follow_up") {
          turnId = randomUUID();
          ownerPrompt = text;
        }
        await appendLog(sessionDir, id, [{ type: "user", at: new Date().toISOString(), text, ...(origin ? { origin } : {}) }]);
        // The owner's message answers what the ghost was waiting on.
        if (origin !== "hook") await this.dropQuestion(ghost, id);
        // Other clients learn the turn is running with its prompt already readable.
        this.announce(id);
        const passPrompt = origin === "hook" ? `${STOP_HOOK_FEEDBACK_PREFIX}${text}` : text;
        const failure = await this.runTurnOnModel(ghost, id, passPrompt, stream, blocks, signal);
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
   * Run one prompt on the local model, handed the conversation so far: it
   * keeps no session of its own. Returns the terminal error, or null on success.
   */
  private async runTurnOnModel(
    ghost: Ghost,
    id: string,
    prompt: string,
    stream: AdmittedTurnOptions,
    blocks: { next: number },
    signal: AbortSignal,
  ): Promise<TerminalError | null> {
    if (!this.answerer) return { type: "error", reason: "error", errorMessage: NO_LOCAL_MODEL };
    const { sessionDir } = ghostPaths(ghost.dir);
    const entries = (await readLog(sessionDir, id)) ?? [];
    const carried = handoffContext(entries.slice(0, entries.findLastIndex((entry) => entry.type === "user")));
    const passPrompt = [...(carried ? [`<conversation-so-far>\n${carried}\n</conversation-so-far>`] : []), prompt].join("\n\n");
    stream.emit({ type: "pass" });
    const result = await this.runPass(ghost, id, this.answerer, passPrompt, stream, blocks, signal);
    await appendLog(sessionDir, id, [{
      type: "assistant",
      at: new Date().toISOString(),
      content: result.content,
      ...(result.error ? { error: result.error } : {}),
    }]);
    return result.error === null ? null : { type: "error", reason: result.aborted ? "aborted" : "error", errorMessage: result.error };
  }

  /**
   * One completion for a trusted command hook (`ghostd hook-complete`), on the
   * local model with no persona, conversation, or tools. It takes no
   * admission or conversation lock: the turn awaiting the `session_stop` hook
   * that asks holds its own, and waiting for it would deadlock.
   */
  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    if (!prompt.trim()) throw new GhostError("invalid_request", "prompt must be a non-empty string.", 400);
    if (!this.answerer) throw new GhostError("no_local_model", NO_LOCAL_MODEL, 409);
    const text = (await this.answerer.complete(prompt, signal)).trim();
    if (!text) throw new GhostError("completion_failed", "The local model returned no text for the prompt.", 502);
    return text;
  }

  private async runPass(
    ghost: Ghost,
    id: string,
    answerer: Answerer,
    prompt: string,
    stream: AdmittedTurnOptions,
    blocks: { next: number },
    signal: AbortSignal,
  ): Promise<PassResult> {
    const { sessionDir } = ghostPaths(ghost.dir);
    const dir = conversationDir(sessionDir, id);
    const persona = await this.renderPersona(ghost);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const content: AssistantPart[] = [];
    const tools = new Map<string, { name: string; part: number }>();
    // The text block streaming now and its logged part, the last one while it is open,
    // so a block key reused after a tool call logs a new part, as the stream shows.
    let open: { key: string; index: number; part: number; text: string } | null = null;
    let error: string | null = null;
    let thoughtBlock: string | null = null;
    const closeBlock = () => {
      if (!open) return;
      content[open.part] = { type: "text", text: open.text };
      stream.emit({ type: "text_end", contentIndex: open.index, content: open.text });
      open = null;
    };
    const onEvent = (event: PassEvent): void => {
      switch (event.type) {
        case "thinking":
          // Reasoning streams for the activity line; it is not an answer and is not logged.
          if (event.delta === "") return;
          stream.emit({ type: "thinking", delta: thoughtBlock !== null && thoughtBlock !== event.block ? `\n${event.delta}` : event.delta });
          thoughtBlock = event.block;
          return;
        case "text": {
          if (event.delta === "") return;
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
          closeBlock();
          tools.set(event.id, { name: event.name, part: content.length });
          content.push({ type: "toolCall", id: event.id, name: event.name, arguments: event.args });
          stream.emit({ type: "tool_execution_start", id: event.id, toolName: event.name, arguments: event.args, cwd: dir });
          return;
        case "tool_update": {
          const summary = tools.has(event.id) ? tail(event.output) : undefined;
          if (summary) stream.emit({ type: "tool_execution_update", id: event.id, summary });
          return;
        }
        case "tool_end": {
          const tool = tools.get(event.id);
          if (!tool) return;
          if (event.isError) content[tool.part] = { ...(content[tool.part] as Extract<AssistantPart, { type: "toolCall" }>), failed: true };
          const summary = event.output === undefined ? undefined : tail(event.output);
          stream.emit({ type: "tool_execution_end", id: event.id, toolName: tool.name, isError: event.isError, ...(summary ? { summary } : {}) });
          return;
        }
        case "error":
          error = event.message;
          return;
      }
    };

    await answerer.turn({
      prompt, persona, cwd: dir, signal, onEvent,
      env: { ...this.env, ...conversationEnvironment(id) },
      codingAgent: await this.codingAgent(),
    }).catch((failure: unknown) => {
      if (!signal.aborted) error = errorMessage(failure);
    });
    closeBlock();
    if (signal.aborted) return { content, error: "Turn aborted.", aborted: true };
    return { content, error, aborted: false };
  }

  private async turnEnd(
    ghost: Ghost, id: string, terminal: Extract<TurnEvent, { type: "done" | "error" }>, signal: AbortSignal, turnId: string,
  ): Promise<void> {
    if (!this.hooks.hasHandlers("turn_end") || signal.aborted || (terminal.type === "error" && terminal.reason === "aborted")) return;
    try {
      const { sessionDir } = ghostPaths(ghost.dir), entries = (await readLog(sessionDir, id)) ?? [];
      const last = entries.findLast(entry => entry.type === "assistant" || entry.type === "command");
      const text = terminal.type === "error" ? terminal.errorMessage
        : last?.type === "assistant" ? last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
        : last?.type === "command" ? last.output : "";
      const url = await this.conversationUrl?.(id).catch(() => null) ?? null;
      await this.hooks.emitTurnEnd({
        type: "turn_end", turn_id: turnId, outcome: terminal.type, title: (logState(entries).title ?? ghost.name).slice(0, 160),
        excerpt: (text ?? "").replace(/\s+/gu, " ").trim().slice(0, 280), url,
        ...hookEventBase(ghost, id, sessionDir, signal),
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
    const message = { role: "assistant", content: last.content };
    const result = await this.hooks.emitSessionStop({
      type: "session_stop",
      messages: [message],
      turn_id: turnId,
      last_assistant_message: message,
      ...hookEventBase(ghost, id, sessionDir, signal),
      stop_hook_active: active,
      owner_prompt: ownerPrompt,
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
    const exit = await runProcess({
      argv: ["bash", "-c", command],
      cwd: this.ownerHome,
      env: { ...this.env, ...conversationEnvironment(id) },
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

  queuedMessages(sessionId: string): QueuedMessages {
    const turn = this.live.get(requireConversationId(sessionId));
    return { streaming: turn !== undefined, followUp: turn ? [...turn.followUps] : [] };
  }

  /** Abort the conversation's running turn or owner command; its stream ends `aborted`. */
  stopTurn(sessionId: string): void {
    const controller = this.admissions.get(requireConversationId(sessionId));
    if (!controller) {
      throw new GhostError("session_not_streaming", "This conversation is not currently streaming.", 409);
    }
    controller.abort();
  }

  /** Queue text for after the current pass, which takes no input mid-run. */
  async queueMessage(sessionId: string, text: string): Promise<QueuedMessages> {
    const key = requireConversationId(sessionId);
    const turn = this.live.get(key);
    if (!turn) {
      // A running `!command` has no passes to queue after.
      if (this.admissions.has(key)) throw new GhostError("session_busy", "An owner command is running in this conversation; send this when it ends.", 409);
      throw new GhostError("session_not_streaming", "This conversation is not currently streaming; send a normal message instead.", 409);
    }
    turn.followUps.push(text);
    turn.emit({ type: "queue", followUp: [...turn.followUps] });
    return this.queuedMessages(sessionId);
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

  async listSessions(): Promise<SessionSummary[]> {
    const ghost = this.ghost;
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
      const running = this.admissions.has(id);
      if (state.messageCount === 0 && state.title === null && !running) continue;
      const readAt = reads[id];
      rows.push({
        id,
        title: state.title,
        preview: state.preview,
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

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const ghost = this.ghost;
    const id = await this.requireConversation(ghost, sessionId);
    const { sessionDir } = ghostPaths(ghost.dir);
    await serializeByKey(this.metadataWrites, pinsPath(sessionDir), async () => {
      const existing = new Set(await this.conversationIds(sessionDir));
      const kept = (await readPins(sessionDir)).filter((pin) => pin !== id && existing.has(pin));
      await writePins(sessionDir, pinned ? [...kept, id] : kept);
    });
    this.announce(id);
  }

  /**
   * Record what the ghost asks the owner in a conversation, replacing an
   * earlier open question there. It stays until the owner's next message to
   * that conversation (`dropQuestion`) or until dismissed.
   */
  async setQuestion(sessionId: string, text: string, options: readonly string[]): Promise<OwnerQuestion> {
    const question = validQuestion(text, options);
    const ghost = this.ghost;
    const id = await this.requireConversation(ghost, sessionId);
    await this.updateQuestions(ghost, (questions) => ({ ...questions, [id]: question }));
    this.announce(id);
    return question;
  }

  /** Withdraw a conversation's open question without answering it. */
  async dismissQuestion(sessionId: string): Promise<void> {
    const ghost = this.ghost;
    const id = await this.requireConversation(ghost, sessionId);
    if (await this.dropQuestion(ghost, id)) this.announce(id);
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

  async markRead(sessionId: string, openedAt = new Date()): Promise<string> {
    const ghost = this.ghost;
    const id = await this.requireConversation(ghost, sessionId);
    const { sessionDir } = ghostPaths(ghost.dir);
    let readAt = openedAt.toISOString();
    await serializeByKey(this.metadataWrites, readsPath(sessionDir), async () => {
      const existing = new Set(await this.conversationIds(sessionDir));
      const kept = Object.fromEntries(Object.entries(await readReads(sessionDir)).filter(([read]) => existing.has(read)));
      readAt = kept[id] && kept[id] > readAt ? kept[id] : readAt;
      await writeReads(sessionDir, { ...kept, [id]: readAt });
    });
    this.announce(id);
    return readAt;
  }

  async renameConversation(sessionId: string, title: string): Promise<string> {
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new GhostError("invalid_request", "\"title\" must not be empty.", 400);
    if (trimmed.length > MAX_CONVERSATION_TITLE_LENGTH) {
      throw new GhostError("invalid_request", `"title" must be at most ${MAX_CONVERSATION_TITLE_LENGTH} characters.`, 400);
    }
    if (!/\P{C}/u.test(trimmed)) {
      throw new GhostError("invalid_request", "A conversation title needs at least one printable character.", 400);
    }
    const ghost = this.ghost;
    const id = await this.requireConversation(ghost, sessionId);
    await appendLog(ghostPaths(ghost.dir).sessionDir, id, [{ type: "title", at: new Date().toISOString(), title: trimmed }]);
    this.announce(id);
    return trimmed;
  }

  /** Store an image in the conversation directory, which need not hold a turn yet. */
  async saveAttachment(sessionId: string, bytes: Uint8Array): Promise<string> {
    return saveAttachment(this.attachmentDir(sessionId), bytes);
  }

  async readAttachment(sessionId: string, name: string): Promise<{ bytes: Buffer; type: string }> {
    return readAttachment(this.attachmentDir(sessionId), name);
  }

  private attachmentDir(sessionId: string): string {
    return conversationDir(ghostPaths(this.ghost.dir).sessionDir, requireConversationId(sessionId));
  }

  async readTranscript(
    sessionId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Transcript> {
    const ghost = this.ghost;
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

  /** Move the conversation's directory, log and all, to recoverable Trash. */
  async deleteSession(sessionId: string): Promise<void> {
    const ghost = this.ghost;
    const id = await this.requireConversation(ghost, sessionId);
    const key = id;
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
      this.announce(id);
    } finally {
      this.reservedSessions.delete(key);
    }
  }

  /** The environment `gio trash` resolves the owner's Trash from. */
  private trashEnv(): NodeJS.ProcessEnv {
    return { ...this.env, HOME: this.ownerHome };
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  async disposeAll(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.admissions.values()) controller.abort();
    this.closeConversationEventStreams();
    await this.localModel?.stop("daemon stopping");
  }
}
