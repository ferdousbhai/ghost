
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
