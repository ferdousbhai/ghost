/**
 * Credential isolation for hosted ghost sessions.
 *
 * pi's `ModelRuntime` resolves provider credentials from the ambient
 * environment as a fallback when a provider has no stored auth. The spike
 * proved the consequence: with `GEMINI_API_KEY` merely *present* in the
 * shell, a sovereign ghost silently gained 22 Google cloud models it was
 * never configured for. A ghost must be able to reach exactly the endpoints
 * its own `<home>/.pi/models.json` declares — nothing the daemon happened to
 * inherit from the user's login shell, a systemd `EnvironmentFile`, or a
 * terminal that had just sourced a project `.envrc`.
 *
 * There is no per-session environment in pi 0.84.2: `getAuth()` reads
 * `process.env` for the whole process. So the scrub is process-global and
 * must run **before the first session is created**. `ghostd` runs it at boot
 * (`main.ts`) and `SessionHost` runs it again in its constructor, which is
 * idempotent — the second call finds nothing left to remove.
 *
 * Credentials therefore come from exactly two places, both per-ghost and
 * both inside the ghost home:
 *   - `<home>/.pi/models.json` — provider definitions incl. `apiKey`
 *   - `<home>/.pi/auth.json`   — pi's own credential store
 *
 * ## What is removed
 *
 * Every provider-credential variable pi-ai 0.84.2 reads, plus the ambient
 * cloud-credential variables that let a provider authenticate without an
 * explicit key. Listed exhaustively (rather than by pattern alone) so that a
 * reader can audit the policy without grepping pi's source; the patterns
 * below then catch provider variables added by a future pi release.
 */

/** Exact variable names, grouped by why they are dangerous. */
export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  // Direct provider API keys read by pi-ai's built-in providers.
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  // Ambient cloud credentials — no API key needed, the SDK finds these itself.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
];

/**
 * Forward compatibility: any variable whose *name* says "credential" goes
 * too. Nothing in ghostd reads a key from the environment, so a broad sweep
 * here costs nothing and closes the gap when a future pi adds a provider we
 * have not enumerated.
 */
export const PROVIDER_CREDENTIAL_ENV_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/,
  /_AUTH_TOKEN$/,
  /_OAUTH_TOKEN$/,
  /_ACCESS_TOKEN$/,
  /_SECRET_ACCESS_KEY$/,
];

/**
 * `PI_OFFLINE` kills pi's own network traffic (update checks, provider
 * catalog refresh, telemetry). It is NOT set by the scrub: it is a separate,
 * opt-in policy (`offline` in the daemon config), because it also stops
 * catalog refresh and would break a ghost whose provider publishes its model
 * list over the network. Credential isolation is what the scrub guarantees,
 * and that guarantee does not depend on being offline.
 */
export const PI_OFFLINE_ENV_VAR = "PI_OFFLINE";

export interface ScrubOptions {
  /** Set `PI_OFFLINE`; when false, an inherited `PI_OFFLINE` is cleared. */
  offline?: boolean;
}

export interface ScrubResult {
  /** Names (never values) of the variables removed. Safe to log. */
  removed: string[];
}

function isCredentialVar(name: string): boolean {
  if (PROVIDER_CREDENTIAL_ENV_VARS.includes(name)) return true;
  return PROVIDER_CREDENTIAL_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Remove every provider credential from `env` (default `process.env`) and
 * apply the daemon's own pi environment. Idempotent; returns the names it
 * removed so the caller can log the fact — never the values.
 */
export function scrubProviderEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ScrubOptions = {},
): ScrubResult {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isCredentialVar(name)) continue;
    delete env[name];
    removed.push(name);
  }
  if (options.offline === true) {
    env[PI_OFFLINE_ENV_VAR] = "1";
  } else if (options.offline === false) {
    // The daemon's policy wins over whatever the launching shell had set.
    delete env[PI_OFFLINE_ENV_VAR];
  }
  return { removed: removed.sort() };
}

/** Names still present that the scrub would remove. Empty once scrubbed. */
export function findProviderCredentialEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(env).filter(isCredentialVar).sort();
}
