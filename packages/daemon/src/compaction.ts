/** Ghost's small policy projection onto OMP's native compaction settings. */

/**
 * The summary instructions handed to OMP's compaction. Modeled on Anthropic's
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

/** Fraction of the context window to trigger at when not overridden. */
export const DEFAULT_THRESHOLD_FRACTION = 0.8;

/** Tunable compaction policy (see config.ts / DaemonConfig). */
export interface CompactionConfig {
  /** Master switch projected onto OMP's native auto-compaction. */
  enabled: boolean;
  /**
   * Absolute token threshold. OMP gives this precedence over the percentage,
   * matching Ghost's existing owner-facing configuration.
   */
  thresholdTokens?: number;
  /** Fraction of the active model's context window. Defaults to 0.8. */
  thresholdFraction?: number;
}

/** Default policy: OMP-native async compaction at 80% of the active window. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = { enabled: true };

export interface NativeCompactionSettings {
  "compaction.enabled": boolean;
  "compaction.asyncEnabled": true;
  "compaction.thresholdTokens": number;
  "compaction.thresholdPercent": number;
}

/**
 * Translate daemon config into OMP settings. The old implicit
 * `min(80% of window, 100k)` rule cannot be represented by one native setting,
 * so the default is deliberately the model-relative 80%. This stays correct
 * across OMP-owned model changes without a second settings mutation path.
 */
export function nativeCompactionSettings(
  config: CompactionConfig,
): NativeCompactionSettings {
  const native: NativeCompactionSettings = {
    "compaction.enabled": config.enabled,
    "compaction.asyncEnabled": true,
    // OMP uses -1 as the native "unset" value. Project it explicitly so a
    // ghost-home OMP setting cannot silently override the daemon policy.
    "compaction.thresholdTokens": config.thresholdTokens ?? -1,
    "compaction.thresholdPercent": (
      config.thresholdFraction ?? DEFAULT_THRESHOLD_FRACTION
    ) * 100,
  };
  return native;
}
