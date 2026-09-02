import { analyzeSlopProse } from "./anti-slop.js";
import { AdvisorEmissionGuard } from "./advisor-emission-guard.js";
import { AdvisorNoteLedger } from "./advisor-notes.js";
import { buildAdvisorPrompt } from "./advisor-prompt.js";
import { quarantineAdvisorUnsafeOutput } from "./advisor-quarantine.js";
import {
  advisorSeverityRank,
  formatAdvisorBatchContent,
  isAdvisorInterruptImmuneTurnActive,
  resolveAdvisorDeliveryChannel,
  type AdvisorNote,
} from "./advisor-severity.js";
import { reconstructAdvisorTurnDelta, advisorAssistantText } from "./advisor-transcript.js";
import { conversationIdentity } from "./conversation-identity.js";
import { loadGhostSettings, type GhostSettings } from "./ghost-settings.js";
import { ghostPaths } from "./ghosts.js";
import { FeedbackRecords } from "./hook-feedback.js";
import {
  completeHookSmol,
  type HookSmolInput,
  type HookSmolOptions,
} from "./hook-smol-complete.js";
import type {
  GhostHookFactory,
  GhostSessionStopEvent,
  GhostSessionStopResult,
} from "./hooks.js";
import { silentLogger, type Logger } from "./log.js";
import { ProjectBindingStore } from "./project-binding.js";
import { discoverWatchdogFiles } from "./watchdog-files.js";

export const ADVISOR_SETTINGS_KEY = "advisor";
const DEFAULT_IMMUNE_TURNS = 3;
const MAX_ADVISOR_NOTES = 16;
const MAX_ADVISOR_NOTE_CHARS = 4_000;
const MAX_ADVISOR_REPLY_BYTES = 64 * 1024;
const MAX_ADVISOR_STATES = 64;

export type AdvisorMode = "off" | "advisory" | "strict";

type AdvisorCompletion = (
  input: HookSmolInput,
  options?: HookSmolOptions,
) => Promise<string>;

interface AdvisorConversationState {
  guard: AdvisorEmissionGuard;
  ledger: AdvisorNoteLedger;
  delivered: AdvisorNote[];
  immuneTurnStart?: number;
}

export interface AdvisorHookOptions {
  logger?: Logger;
  complete?: AdvisorCompletion;
  /** Enables validated project WATCHDOG discovery in the daemon process. */
  ownerHome?: string;
  projectBindings?: Pick<ProjectBindingStore, "read">;
}

export function advisorMode(settings: GhostSettings): AdvisorMode {
  const mode = settings.getString("advisor.mode");
  return mode === "advisory" || mode === "strict" ? mode : "off";
}

export function advisorImmuneTurns(settings: GhostSettings): number {
  const configured = settings.getNumber("advisor.immuneTurns");
  if (configured === undefined || !Number.isFinite(configured) || configured < 0) {
    return DEFAULT_IMMUNE_TURNS;
  }
  return configured === 0 ? 0 : Math.trunc(configured);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseAdvisorReply(raw: string): AdvisorNote[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_ADVISOR_REPLY_BYTES) {
    throw new Error("advisor reply exceeds its byte limit");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !exactKeys(parsed, ["notes"]) || !Array.isArray(parsed.notes)) {
    throw new Error("advisor reply must be an object containing only notes");
  }
  if (parsed.notes.length > MAX_ADVISOR_NOTES) throw new Error("advisor reply contains too many notes");
  return parsed.notes.map((value) => {
    if (!isRecord(value)
      || !exactKeys(value, ["severity", "text"])
      || (value.severity !== "nit" && value.severity !== "concern" && value.severity !== "blocker")
      || typeof value.text !== "string"
      || value.text.trim() === ""
      || value.text.length > MAX_ADVISOR_NOTE_CHARS) {
      throw new Error("advisor reply contains a malformed note");
    }
    return { note: value.text.trim(), severity: value.severity };
  });
}

function createConversationState(): AdvisorConversationState {
  const delivered: AdvisorNote[] = [];
  return {
    guard: new AdvisorEmissionGuard(),
    ledger: new AdvisorNoteLedger((note) => delivered.push(note)),
    delivered,
  };
}

function conversationKey(event: GhostSessionStopEvent): string {
  return `${event.ghost_name}\u0000${event.runtime}\u0000${event.conversation_id}`;
}

async function trustedProjectRoot(
  event: GhostSessionStopEvent,
  bindings: Pick<ProjectBindingStore, "read"> | undefined,
  logger: Logger,
): Promise<string | undefined> {
  if (!bindings) return undefined;
  try {
    const identity = conversationIdentity(event.runtime, event.conversation_id);
    const project = await bindings.read(
      ghostPaths(event.ghost_home).sessionDir,
      identity.id,
      event.runtime,
      event.conversation_id,
    );
    return project.root ?? undefined;
  } catch {
    logger.warn("advisor project WATCHDOG lookup failed open");
    return undefined;
  }
}

async function review(
  event: GhostSessionStopEvent,
  options: {
    logger: Logger;
    complete: AdvisorCompletion;
    feedback: FeedbackRecords<AdvisorNote[]>;
    state: AdvisorConversationState;
    projectBindings?: Pick<ProjectBindingStore, "read">;
  },
): Promise<GhostSessionStopResult> {
  const log = options.logger.child({
    ghost: event.ghost_name,
    conversation: event.conversation_id,
  });
  try {
    const settings = loadGhostSettings(event.ghost_home);
    const mode = advisorMode(settings);
    if (mode === "off") return {};

    const delta = await reconstructAdvisorTurnDelta(event);
    if (delta.source === "assistant-fallback" && delta.fallbackReason !== "missing") {
      log.warn("advisor transcript reconstruction fell back", { reason: delta.fallbackReason });
    }
    const projectRoot = await trustedProjectRoot(event, options.projectBindings, log);
    const watchdogBlocks = await discoverWatchdogFiles(event.cwd, event.ghost_home, {
      ...(projectRoot ? { trustedProjectRoot: projectRoot } : {}),
      warn: () => log.warn("advisor WATCHDOG file was skipped"),
    });
    const assistant = advisorAssistantText(event.last_assistant_message);
    const antiSlopRuleIds = [...new Set(analyzeSlopProse(assistant, {
      disabledRules: settings.getStringList("antiSlop.disabledRules") ?? [],
    }).map((finding) => finding.ruleId))];
    const prompt = buildAdvisorPrompt({
      watchdogBlocks,
      turnDelta: delta.text,
      antiSlopRuleIds,
    });
    const raw = await options.complete(
      { ghost_home: event.ghost_home, prompt, role: "advisor_model" },
      { signal: event.signal },
    );
    const notes = parseAdvisorReply(raw);
    const quarantine = quarantineAdvisorUnsafeOutput(raw, delta.text);
    if (quarantine) {
      options.feedback.clear(event);
      log.warn("advisor output was quarantined", { reason: quarantine });
      return {};
    }

    options.state.delivered.length = 0;
    options.state.guard.beginUpdate();
    options.state.ledger.beginUpdate(false);
    const mostSevereFirst = notes.toSorted((left, right) =>
      advisorSeverityRank(right.severity) - advisorSeverityRank(left.severity)
    );
    for (const note of mostSevereFirst) {
      if (options.state.guard.accept(note.note)) options.state.ledger.add(note);
    }
    const delivered = options.state.delivered.slice();
    if (delivered.length === 0) {
      options.feedback.clear(event);
      return {};
    }

    const note = delivered[0];
    if (!note) return {};
    const immune = isAdvisorInterruptImmuneTurnActive({
      completedTurns: event.turn_id,
      immuneTurnStart: options.state.immuneTurnStart,
      immuneTurns: advisorImmuneTurns(settings),
    });
    const channel = resolveAdvisorDeliveryChannel({
      severity: note.severity,
      autoResumeSuppressed: false,
      streaming: false,
      aborting: false,
      terminalAnswerNoQueuedWork: true,
      interruptImmuneTurnActive: immune,
    });
    const continuation = mode === "strict"
      && note.severity === "blocker"
      && channel === "steer"
      && !immune
      && !event.stop_hook_active;
    log.info("advisor review completed", {
      mode,
      notes: delivered.length,
      severity: note.severity,
      channel: continuation ? "continuation" : "next-turn",
      immune,
      continuationPass: event.stop_hook_active,
    });
    if (continuation) {
      options.feedback.clear(event);
      options.state.immuneTurnStart = event.turn_id + 1;
      return {
        continue: true,
        additionalContext: formatAdvisorBatchContent(delivered),
      };
    }
    options.feedback.set(event, delivered);
    return {};
  } catch (error) {
    log.warn("advisor review failed open", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return {};
  }
}

export function createAdvisorHook(options: AdvisorHookOptions = {}): GhostHookFactory {
  const logger = options.logger ?? silentLogger;
  const complete = options.complete ?? completeHookSmol;
  const feedback = new FeedbackRecords<AdvisorNote[]>();
  const states = new Map<string, AdvisorConversationState>();
  const projectBindings = options.projectBindings
    ?? (options.ownerHome ? new ProjectBindingStore({ ownerHome: options.ownerHome }) : undefined);
  const stateFor = (event: GhostSessionStopEvent): AdvisorConversationState => {
    const key = conversationKey(event);
    const existing = states.get(key);
    if (existing) {
      states.delete(key);
      states.set(key, existing);
      return existing;
    }
    const state = createConversationState();
    states.set(key, state);
    if (states.size > MAX_ADVISOR_STATES) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    return state;
  };
  return (api) => {
    api.on("before_prompt", (event) => {
      const notes = feedback.take(event);
      return notes && { additionalContext: formatAdvisorBatchContent(notes) };
    }, {
      name: "Advisor feedback",
      description: "Delivers one consume-once policy advisory from the previous turn.",
    });
    api.on("session_stop", (event) => review(event, {
      logger,
      complete,
      feedback,
      state: stateFor(event),
      ...(projectBindings ? { projectBindings } : {}),
    }), {
      name: "Advisor review",
      description: "Reviews the settled turn against WATCHDOG policy and may request one strict blocker continuation.",
      settingsKey: ADVISOR_SETTINGS_KEY,
    });
  };
}
