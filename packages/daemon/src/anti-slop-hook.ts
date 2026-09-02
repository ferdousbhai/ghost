/**
 * Built-in `session_stop` anti-slop review. Deterministically lints only the
 * text blocks of the final assistant reply with the ported slop-detector
 * engine; tool payloads and private reasoning never reach the linter. Per
 * ghost, `settings.yml` selects `antiSlop.mode` (off | advisory | strict) and
 * `antiSlop.disabledRules`. Strict mode requests at most one visible rewrite
 * continuation; every failure fails open.
 */
import { analyzeSlopProse, renderAntiSlopPromptSection, type SlopFinding } from "./anti-slop.js";
import { loadGhostSettings, type GhostSettings } from "./ghost-settings.js";
import { FeedbackRecords } from "./hook-feedback.js";
import type {
  GhostBeforePromptResult,
  GhostHookFactory,
  GhostSessionStopEvent,
  GhostSessionStopResult,
} from "./hooks.js";
import { silentLogger, type Logger } from "./log.js";

export const ANTI_SLOP_SETTINGS_KEY = "anti_slop";

const MAX_EXCERPT_CHARS = 80;
const MAX_CONTEXT_CHARS = 2000;

export type AntiSlopMode = "off" | "advisory" | "strict";

export function antiSlopMode(settings: GhostSettings): AntiSlopMode {
  const mode = settings.getString("antiSlop.mode");
  return mode === "advisory" || mode === "strict" ? mode : "off";
}

/**
 * The style-contract section for a session's system prompt, or undefined when
 * this ghost's anti-slop mode is off. Session prompts are assembled once at
 * open, so the section follows a settings.yml edit at the next session while
 * the stop-time review follows it at the next reply.
 */
export function antiSlopPromptSection(settings: GhostSettings): string | undefined {
  if (antiSlopMode(settings) === "off") return undefined;
  const section = renderAntiSlopPromptSection(
    settings.getStringList("antiSlop.disabledRules") ?? [],
  );
  return section === "" ? undefined : section;
}

/** The joined `text` content blocks of an assistant message; nothing else. */
function assistantText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") texts.push(text);
  }
  return texts.join("\n\n");
}

/** Findings-per-rule counts: bounded, and free of any reply text. */
function ruleCounts(findings: readonly SlopFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.ruleId] = (counts[f.ruleId] ?? 0) + 1;
  return counts;
}

function excerpt(text: string, f: SlopFinding): string {
  // Slice by code point so a trimmed excerpt cannot end in a lone surrogate.
  const chars = [...text.slice(f.start, f.end).replace(/\s+/gu, " ").trim()];
  return chars.length > MAX_EXCERPT_CHARS
    ? `${chars.slice(0, MAX_EXCERPT_CHARS - 1).join("")}…`
    : chars.join("");
}

function continuationContext(findings: readonly SlopFinding[], text: string): string {
  const header = "Ghost's anti-slop review flagged your reply:";
  const trailer = "Rewrite the reply applying these fixes, or keep the original wording and "
    + "state your overrule reason in one sentence.";
  const ordered = [
    ...findings.filter((f) => f.severity === "major"),
    ...findings.filter((f) => f.severity === "minor"),
  ];
  const lines: string[] = [];
  let used = header.length + trailer.length + 2;
  for (const [index, f] of ordered.entries()) {
    const quoted = excerpt(text, f);
    const line = `${index + 1}. [${f.severity}] ${f.ruleId}: ${f.message} Fix: ${f.instruction}`
      + (quoted ? ` Excerpt: "${quoted}"` : "");
    if (used + line.length + 1 > MAX_CONTEXT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [header, ...lines, trailer].join("\n");
}

function nudge(counts: Record<string, number>): GhostBeforePromptResult {
  const list = Object.entries(counts)
    .map(([ruleId, count]) => (count > 1 ? `${ruleId} ×${count}` : ruleId))
    .join(", ");
  return {
    additionalContext: "Ghost's anti-slop review flagged your previous reply: "
      + `${list}. Avoid these patterns in this reply.`,
  };
}

function review(
  event: GhostSessionStopEvent,
  logger: Logger,
  feedback: FeedbackRecords<Record<string, number>>,
): GhostSessionStopResult {
  const log = logger.child({ ghost: event.ghost_name, conversation: event.conversation_id });
  try {
    const settings = loadGhostSettings(event.ghost_home);
    const mode = antiSlopMode(settings);
    if (mode === "off") return {};
    const text = assistantText(event.last_assistant_message);
    if (!text.trim()) return {};
    const findings = analyzeSlopProse(text, {
      disabledRules: settings.getStringList("antiSlop.disabledRules") ?? [],
    });
    // The last pass of the turn owns the record, so a clean rewrite un-nudges.
    if (findings.length === 0) {
      feedback.clear(event);
      return {};
    }
    const counts = ruleCounts(findings);
    feedback.set(event, counts);
    const major = findings.filter((f) => f.severity === "major").length;
    // One rewrite at most: a continuation pass is accepted whatever it says.
    const rewrite = mode === "strict" && !event.stop_hook_active && major > 0;
    log.info("anti-slop findings", {
      mode,
      continuation: event.stop_hook_active,
      rewrite,
      findings: findings.length,
      major,
      rules: counts,
    });
    return rewrite
      ? { continue: true, additionalContext: continuationContext(findings, text) }
      : {};
  } catch (error) {
    log.warn("anti-slop review failed open", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export function createAntiSlopHook(options: { logger?: Logger } = {}): GhostHookFactory {
  const logger = options.logger ?? silentLogger;
  const feedback = new FeedbackRecords<Record<string, number>>();
  return (api) => {
    api.on("before_prompt", (event) => {
      const counts = feedback.take(event);
      return counts && nudge(counts);
    }, {
      name: "Anti-slop feedback",
      description: "Reminds the ghost once which anti-slop rules its previous reply broke.",
    });
    api.on("session_stop", (event) => review(event, logger, feedback), {
      name: "Anti-slop review",
      description: "Deterministically lints the final assistant reply; in strict mode it may request one visible rewrite continuation.",
      settingsKey: ANTI_SLOP_SETTINGS_KEY,
    });
  };
}
