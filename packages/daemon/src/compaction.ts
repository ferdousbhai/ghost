
/**
 * The summary instructions handed to pi's compaction. Modeled on Anthropic's
 * context-compaction approach (a structured, faithful hand-off of the load-
 * bearing state of a conversation), but kept deliberately provider-neutral —
 * no Anthropic/Claude-specific tokens or formatting — because a ghost may run
 * on any provider. Written to be understood by whatever model generates the
 * summary and by whatever model later reads it to continue the conversation.
 */
export const GHOST_COMPACTION_PROMPT = `You are compacting an ongoing conversation so it can continue without its full history in context. Write a faithful, structured briefing of everything that matters. Do not continue the conversation or answer any question in it; only produce the briefing.

Write in the third person and the past tense, as a hand-off to a continuation that will pick up seamlessly from your summary. Be non-lossy on load-bearing details: if a fact, name, path, number, or identifier could be needed later, keep it verbatim rather than paraphrasing it away. Prefer completeness over brevity when in doubt.

Cover, under clear headings:
1. Goals and intent — what the user is trying to accomplish, and any standing preferences, constraints, or instructions they have given for how it should be done.
2. Decisions and rationale — the choices that were made and why, including approaches that were considered and rejected.
3. Current state — what has been done so far and where things stand right now.
4. Open threads and next steps — what is unfinished, what was promised, and what should happen next.
5. Key facts and references — specific names, paths, identifiers, values, and other concrete details referenced in the conversation that a continuation would need.`;

export const DEFAULT_THRESHOLD_FRACTION = 0.8;
const GHOST_COMPACTION_KEEP_RECENT_TOKENS = 500;

export interface CompactionConfig {
  enabled: boolean;
  /** Absolute token threshold; takes precedence over the fraction. */
  thresholdTokens?: number;
  /** Fraction of the model's context window at which compaction triggers. */
  thresholdFraction?: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = { enabled: true };

/**
 * The `compaction` block of pi's settings for one model. pi triggers when the
 * context exceeds the window minus `reserveTokens`, so the owner's threshold
 * is projected against the bound model's window.
 */
export function nativeCompactionSettings(
  config: CompactionConfig,
  contextWindow: number | undefined,
): { enabled: boolean; reserveTokens?: number; keepRecentTokens: number } {
  if (!config.enabled || !contextWindow) {
    return {
      enabled: config.enabled,
      keepRecentTokens: GHOST_COMPACTION_KEEP_RECENT_TOKENS,
    };
  }
  const threshold = config.thresholdTokens !== undefined
    ? Math.min(config.thresholdTokens, contextWindow)
    : contextWindow * (config.thresholdFraction ?? DEFAULT_THRESHOLD_FRACTION);
  return {
    enabled: true,
    reserveTokens: Math.max(1, Math.round(contextWindow - threshold)),
    keepRecentTokens: GHOST_COMPACTION_KEEP_RECENT_TOKENS,
  };
}
