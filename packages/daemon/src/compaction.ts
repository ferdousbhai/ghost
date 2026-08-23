/**
 * Background context compaction for a ghost's OMP `AgentSession`.
 *
 * A ghost's durable memory is its memory files, not its transcript — but a
 * long conversation still grows the provider-facing context until it nears the
 * model's window and either errors or gets silently truncated. Compaction
 * summarizes the old turns into a briefing and keeps only the recent ones in
 * context, while the full JSONL transcript stays on disk untouched.
 *
 * We do NOT use OMP's built-in auto-compaction. Two harness properties make
 * it unsuitable here:
 *
 *   1. Auto-compaction is awaited inline — `_checkCompaction` runs on the
 *      agent-loop's `agent_end` and again synchronously at the top of the next
 *      `prompt()`. It therefore blocks the user's next turn, which our spec
 *      forbids.
 *   2. The auto path passes `customInstructions: undefined` to `compact()`, so
 *      there is no hook to inject our own summary prompt.
 *
 * So OMP's auto trigger is left OFF (the session's compaction setting stays
 * `enabled: false`, which is exactly what gates `_checkCompaction`), and we
 * drive `session.compact(GHOST_COMPACTION_PROMPT)` ourselves after a completed
 * turn, fire-and-forget. `compact()` ignores the `enabled` flag, keeps the
 * recent turns via `keepRecentTokens`, appends a compaction-summary entry to
 * the JSONL, and rebuilds the in-memory context from the cut point. Any turn
 * that arrives after the cut point is left intact.
 *
 * One OMP constraint the caller must respect: `session.prompt()` throws while a
 * manual compaction is in progress, and `compact()` begins with `await
 * this.abort()`. So the caller (SessionHost) fires compaction only when the
 * session is idle, and awaits any in-flight compaction before the next prompt.
 */

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

/** Hard cap on the token threshold, per spec: never wait past 100k tokens. */
export const CONTEXT_TOKEN_CAP = 100_000;

/** Fraction of the context window to trigger at when not overridden. */
export const DEFAULT_THRESHOLD_FRACTION = 0.8;

/**
 * Fallback context window when a model reports none. OMP's model registry
 * defaults custom models to 128k (see models.ts), so this is mostly defensive.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Tunable compaction policy (see config.ts / DaemonConfig). */
export interface CompactionConfig {
  /** Master switch. When false, no compaction is ever driven. */
  enabled: boolean;
  /**
   * Absolute token threshold. When set, it overrides the fraction/cap
   * computation entirely. Useful for tests and tuning.
   */
  thresholdTokens?: number;
  /** Fraction of the context window to trigger at. Defaults to 0.8. */
  thresholdFraction?: number;
}

/** Default policy: enabled, trigger at min(0.8 × window, 100k). */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = { enabled: true };

/**
 * The trigger threshold in tokens for a given context window:
 * `min(fraction × contextWindow, cap)`, or an explicit override.
 */
export function compactionThreshold(
  contextWindow: number,
  config: CompactionConfig,
): number {
  if (config.thresholdTokens != null) return config.thresholdTokens;
  const fraction = config.thresholdFraction ?? DEFAULT_THRESHOLD_FRACTION;
  const window = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.min(fraction * window, CONTEXT_TOKEN_CAP);
}

/**
 * The subset of OMP's `ContextUsage` (from `session.getContextUsage()`) that the
 * decision consumes. `tokens` is null right after a compaction (before the next
 * LLM response re-establishes a usage number), in which case we cannot decide.
 */
export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
}

/**
 * Whether compaction should fire now, given the current context usage. Pure and
 * side-effect-free so the threshold behavior is trivially testable.
 */
export function shouldCompactNow(
  usage: ContextUsageLike | null | undefined,
  config: CompactionConfig,
): boolean {
  if (!config.enabled) return false;
  if (!usage || usage.tokens == null) return false;
  return usage.tokens >= compactionThreshold(usage.contextWindow, config);
}

/** The minimal surface of OMP's `AgentSession` that the compactor drives. */
export interface CompactableSession {
  readonly isCompacting: boolean;
  getContextUsage(): ContextUsageLike | undefined;
  compact(customInstructions?: string): Promise<unknown>;
}

/** Callbacks for the background compaction, so it never throws into the caller. */
export interface MaybeCompactHandlers {
  /** A compaction failure — logged, never fatal to the conversation. */
  onError: (error: Error) => void;
  /** Fired when compaction is actually kicked off (for logging/metrics). */
  onStart?: (info: { tokens: number; contextWindow: number; threshold: number }) => void;
}

/**
 * Fire background compaction iff over threshold and not already compacting.
 *
 * Fire-and-forget: this returns the in-flight promise (or `undefined` when it
 * did not start one) WITHOUT awaiting it, so the caller is never blocked. The
 * returned promise never rejects — a failure is routed to `handlers.onError`.
 * The caller keeps the promise so it can await it before the next prompt (OMP
 * forbids prompting while a manual compaction is in progress).
 */
export function maybeCompact(
  session: CompactableSession,
  config: CompactionConfig,
  handlers: MaybeCompactHandlers,
): Promise<void> | undefined {
  if (!config.enabled) return undefined;
  // Guard against a second concurrent run: OMP tracks one compaction at a time.
  if (session.isCompacting) return undefined;
  const usage = session.getContextUsage();
  if (!usage || usage.tokens == null || !shouldCompactNow(usage, config)) return undefined;

  const { tokens, contextWindow } = usage;
  handlers.onStart?.({
    tokens,
    contextWindow,
    threshold: compactionThreshold(contextWindow, config),
  });

  return session.compact(GHOST_COMPACTION_PROMPT).then(
    () => {},
    (error: unknown) => {
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    },
  );
}
