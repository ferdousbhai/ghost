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
  type AdvisorSeverity,
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
import {
  compileLintRules,
  loadLintRules,
  runLint,
  withoutLintRules,
  type LoadedLintRules,
  type LintFinding,
} from "./lint.js";
import { BUILTIN_LINT_RULES } from "./lint-rules.js";
import { silentLogger, type Logger } from "./log.js";
import { ProjectBindingStore } from "./project-binding.js";
import { discoverWatchdogFiles } from "./watchdog-files.js";

export const REVIEW_SETTINGS_KEY = "review";
const DEFAULT_IMMUNE_TURNS = 3;
const MAX_ADVISOR_NOTES = 16;
const MAX_ADVISOR_NOTE_CHARS = 4_000;
const MAX_ADVISOR_REPLY_BYTES = 64 * 1024;
const MAX_REVIEW_STATES = 64;
const BUILTIN_LINT_RULE_SET = compileLintRules(BUILTIN_LINT_RULES, { source: "built-in lint rules" });

export type ReviewMode = "off" | "lint" | "advisory" | "strict";

type AdvisorCompletion = (
  input: HookSmolInput,
  options?: HookSmolOptions,
) => Promise<string>;

interface ReviewConversationState {
  guard: AdvisorEmissionGuard;
  ledger: AdvisorNoteLedger;
  delivered: AdvisorNote[];
  immuneTurnStart?: number;
}

export interface ReviewHookOptions {
  logger?: Logger;
  complete?: AdvisorCompletion;
  /** Enables validated project WATCHDOG and lint-pack discovery. */
  ownerHome?: string;
  projectBindings?: Pick<ProjectBindingStore, "read">;
}

export function reviewMode(settings: GhostSettings): ReviewMode {
  const mode = settings.getString("review.mode");
  return mode === "lint" || mode === "advisory" || mode === "strict" ? mode : "off";
}

export function reviewImmuneTurns(settings: GhostSettings): number {
  const configured = settings.getNumber("review.immuneTurns");
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

function createConversationState(): ReviewConversationState {
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
    logger.warn("review project policy lookup failed open");
    return undefined;
  }
}

function lintNote(finding: LintFinding): AdvisorNote {
  const detail = [
    `[${finding.ruleId}] ${finding.message}`,
    ...(finding.fix ? [`Fix: ${finding.fix}`] : []),
    ...(finding.excerpt ? [`Excerpt: ${JSON.stringify(finding.excerpt)}`] : []),
  ].join(" ");
  return {
    note: detail,
    severity: finding.severity,
    advisor: `lint:${finding.ruleId}`,
    authority: "lint",
  };
}

function deliverLintFindings(
  findings: readonly LintFinding[],
  state: ReviewConversationState,
): void {
  state.ledger.beginUpdate(false);
  for (const finding of findings) {
    const note = lintNote(finding);
    state.guard.beginUpdate();
    if (state.guard.accept(note.note)) state.ledger.add(note);
  }
}

function deliverAdvisorNotes(notes: readonly AdvisorNote[], state: ReviewConversationState): void {
  state.guard.beginUpdate();
  state.ledger.beginUpdate(false);
  const mostSevereFirst = notes.toSorted((left, right) =>
    advisorSeverityRank(right.severity) - advisorSeverityRank(left.severity)
  );
  for (const note of mostSevereFirst) {
    if (state.guard.accept(note.note)) state.ledger.add(note);
  }
}

async function modelNotes(
  event: GhostSessionStopEvent,
  options: {
    complete: AdvisorCompletion;
    delta: Awaited<ReturnType<typeof reconstructAdvisorTurnDelta>>;
    lintRuleIds: readonly string[];
    log: Logger;
    projectRoot?: string;
  },
): Promise<AdvisorNote[]> {
  try {
    const watchdogBlocks = await discoverWatchdogFiles(event.cwd, event.ghost_home, {
      ...(options.projectRoot ? { trustedProjectRoot: options.projectRoot } : {}),
      warn: () => options.log.warn("review WATCHDOG file was skipped"),
    });
    const prompt = buildAdvisorPrompt({
      watchdogBlocks,
      turnDelta: options.delta.text,
      lintRuleIds: options.lintRuleIds,
    });
    const raw = await options.complete(
      { ghost_home: event.ghost_home, prompt, role: "advisor_model" },
      { signal: event.signal },
    );
    const notes = parseAdvisorReply(raw);
    const quarantine = quarantineAdvisorUnsafeOutput(raw, options.delta.text);
    if (quarantine) {
      options.log.warn("advisor output was quarantined", { reason: quarantine });
      return [];
    }
    return notes;
  } catch (error) {
    options.log.warn("model review failed open", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

function highestSeverity(notes: readonly AdvisorNote[]): AdvisorSeverity | undefined {
  return notes.reduce<AdvisorSeverity | undefined>((highest, note) =>
    highest === undefined || advisorSeverityRank(note.severity) > advisorSeverityRank(highest)
      ? note.severity
      : highest, undefined);
}

async function review(
  event: GhostSessionStopEvent,
  options: {
    logger: Logger;
    complete: AdvisorCompletion;
    feedback: FeedbackRecords<AdvisorNote[]>;
    state: ReviewConversationState;
    projectBindings?: Pick<ProjectBindingStore, "read">;
  },
): Promise<GhostSessionStopResult> {
  const log = options.logger.child({
    ghost: event.ghost_name,
    conversation: event.conversation_id,
  });
  let settings: GhostSettings;
  try {
    settings = loadGhostSettings(event.ghost_home);
  } catch (error) {
    log.warn("review failed open", { error: error instanceof Error ? error.name : "unknown" });
    return {};
  }
  const mode = reviewMode(settings);
  if (mode === "off") {
    options.feedback.clear(event);
    options.state.guard.reset();
    options.state.ledger.reset();
    options.state.immuneTurnStart = undefined;
    return {};
  }

  const delta = await reconstructAdvisorTurnDelta(event);
  if (delta.source === "assistant-fallback" && delta.fallbackReason !== "missing") {
    log.warn("review transcript reconstruction fell back", { reason: delta.fallbackReason });
  }
  const projectRoot = await trustedProjectRoot(event, options.projectBindings, log);
  const assistant = advisorAssistantText(event.last_assistant_message);
  let ownerRules: LoadedLintRules = {
    rules: [],
    disabledBuiltinRuleIds: new Set<string>(),
  };
  try {
    ownerRules = await loadLintRules(event.cwd, event.ghost_home, {
      ...(projectRoot ? { trustedProjectRoot: projectRoot } : {}),
      warn: () => log.warn("lint rule pack was skipped"),
    });
  } catch {
    log.warn("lint rule-pack discovery failed open");
  }
  let findings: LintFinding[] = [];
  try {
    findings = runLint(
      [withoutLintRules(BUILTIN_LINT_RULE_SET, ownerRules.disabledBuiltinRuleIds), ownerRules],
      { prose: assistant, commands: delta.commands, paths: delta.paths },
    );
  } catch {
    log.warn("lint review failed open");
  }

  options.state.delivered.length = 0;
  deliverLintFindings(findings, options.state);
  const lintRuleIds = [...new Set(findings.map((finding) => finding.ruleId))];
  if (mode === "advisory" || mode === "strict") {
    const notes = await modelNotes(event, {
      complete: options.complete,
      delta,
      lintRuleIds,
      log,
      ...(projectRoot ? { projectRoot } : {}),
    });
    deliverAdvisorNotes(notes, options.state);
  }

  const delivered = options.state.delivered.slice();
  if (delivered.length === 0) {
    options.feedback.clear(event);
    return {};
  }
  const severity = highestSeverity(delivered);
  const immune = isAdvisorInterruptImmuneTurnActive({
    completedTurns: event.turn_id,
    immuneTurnStart: options.state.immuneTurnStart,
    immuneTurns: reviewImmuneTurns(settings),
  });
  const channel = resolveAdvisorDeliveryChannel({
    severity,
    autoResumeSuppressed: false,
    streaming: false,
    aborting: false,
    terminalAnswerNoQueuedWork: true,
    interruptImmuneTurnActive: immune,
  });
  const continuation = mode === "strict"
    && severity === "blocker"
    && channel === "steer"
    && !immune
    && !event.stop_hook_active;
  log.info("review completed", {
    mode,
    lintFindings: findings.length,
    notes: delivered.length,
    severity,
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
}

export function createReviewHook(options: ReviewHookOptions = {}): GhostHookFactory {
  const logger = options.logger ?? silentLogger;
  const complete = options.complete ?? completeHookSmol;
  const feedback = new FeedbackRecords<AdvisorNote[]>();
  const states = new Map<string, ReviewConversationState>();
  const projectBindings = options.projectBindings
    ?? (options.ownerHome ? new ProjectBindingStore({ ownerHome: options.ownerHome }) : undefined);
  const stateFor = (event: GhostSessionStopEvent): ReviewConversationState => {
    const key = conversationKey(event);
    const existing = states.get(key);
    if (existing) {
      states.delete(key);
      states.set(key, existing);
      return existing;
    }
    const state = createConversationState();
    states.set(key, state);
    if (states.size > MAX_REVIEW_STATES) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    return state;
  };
  return (api) => {
    api.on("before_prompt", (event) => {
      try {
        if (reviewMode(loadGhostSettings(event.ghost_home)) === "off") {
          feedback.clear(event);
          return;
        }
      } catch {
        feedback.clear(event);
        return;
      }
      const notes = feedback.take(event);
      return notes && { additionalContext: formatAdvisorBatchContent(notes) };
    }, {
      name: "Review feedback",
      description: "Delivers consume-once lint and model-review notes from the previous turn.",
    });
    api.on("session_stop", (event) => review(event, {
      logger,
      complete,
      feedback,
      state: stateFor(event),
      ...(projectBindings ? { projectBindings } : {}),
    }), {
      name: "Review",
      description: "Runs deterministic lint, then optional WATCHDOG model review, through one delivery policy.",
      settingsKey: REVIEW_SETTINGS_KEY,
    });
  };
}
