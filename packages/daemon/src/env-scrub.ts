/**
 * Provider isolation for hosted ghost sessions.
 *
 * pi's provider layer can resolve credentials from the ambient
 * environment as a fallback when a provider has no stored auth. The spike
 * proved the consequence: with `GEMINI_API_KEY` merely *present* in the
 * shell, a sovereign ghost silently gained 22 Google cloud models it was
 * never configured for. A ghost must be able to reach exactly the endpoints
 * its own `<home>/models.json` declares — nothing the daemon happened to
 * inherit from the user's login shell, a systemd `EnvironmentFile`, or a
 * terminal that had just sourced a project `.envrc`.
 *
 * Provider SDKs read `process.env` for the whole process. So the scrub is
 * process-global and
 * must run **before the first session is created**. `ghostd` runs it at boot
 * (`main.ts`) and `SessionHost` runs it again in its constructor, which is
 * idempotent — the second call finds nothing left to remove.
 *
 * Credentials therefore come only from Ghost's machine-scoped Secret Service
 * schema. A ghost's `models.json` and `mcp.json` hold references plus an
 * account allow-list, never values.
 *
 * ## What is removed
 *
 * Every provider-credential variable the pinned pi providers read, the ambient cloud
 * credentials that let a provider authenticate without an explicit key, and
 * Claude Code routing overrides that can redirect or change a request before
 * it reaches the configured provider. Listed explicitly so a reader can audit
 * the policy without grepping dependency source; the patterns below then catch
 * credential variables added by a future pi release.
 */

export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  // Direct provider credentials read by pi-ai or the Claude Code HTTP agent.
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // The pinned Anthropic SDK otherwise discovers profile files or synthesizes
  // an OIDC-federation credential chain entirely from ambient state.
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  // The pinned Claude CLI reads these mTLS values and alternate credential
  // selectors/channels. CLAUDE_CONFIG_DIR is intentionally retained because
  // it locates the OS owner's existing Claude plan login.
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GITLAB_TOKEN",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_HUB_TOKEN",
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
 * Claude Code endpoint, backend, header, region, and model overrides.
 *
 * These are as security-sensitive as credentials: inheriting one can route a
 * ghost's own-plan request through a third party or silently select a backend
 * or model other than the one chosen for that ghost. Keep this list aligned
 * with the bundled Claude Agent SDK/CLI environment surface.
 */
export const PROVIDER_ROUTING_ENV_VARS: readonly string[] = [
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  // Bypasses the configured Anthropic network route in favor of a local socket.
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_DEFAULT_REGION",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_ENDPOINT",
  "AWS_ENDPOINT_URL",
  "AWS_REGION",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_GB_BASE_URL",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  // Retained for older Claude Code releases that used the unprefixed name.
  "USE_VERTEX",
  // pi settings and shell wrapping must remain session-scoped in the hosted
  // runtime rather than inheriting overlays from ghostd's launcher.
  "PI_CONFIG_FILES",
  "PI_SHELL_PREFIX",
];

/**
 * Forward compatibility: any variable whose *name* says "credential" goes
 * too. Nothing in ghostd reads a key from the environment, so a broad sweep
 * here costs nothing and closes the gap when a future pi release adds a provider we
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
 * `PI_OFFLINE` disables pi's own network traffic (update checks, provider
 * catalog refresh, telemetry). It is NOT set by the scrub: it is a separate,
 * opt-in policy (`offline` in the daemon config), because it also stops
 * catalog refresh and would break a ghost whose provider publishes its model
 * list over the network. Credential isolation is what the scrub guarantees,
 * and that guarantee does not depend on being offline.
 */
export const PI_OFFLINE_ENV_VAR = "PI_OFFLINE";
export const PI_NO_TITLE_ENV_VAR = "PI_NO_TITLE";

export interface ScrubOptions {
  offline?: boolean;
}

export interface ScrubResult {
  removed: string[];
}

function isProviderEnvOverride(name: string): boolean {
  if (PROVIDER_CREDENTIAL_ENV_VARS.includes(name)) return true;
  if (PROVIDER_ROUTING_ENV_VARS.includes(name)) return true;
  if (name.startsWith("VERTEX_REGION_CLAUDE_")) return true;
  return PROVIDER_CREDENTIAL_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Remove every provider credential and routing override from `env` (default
 * `process.env`) and apply the daemon's own pi environment. Idempotent;
 * returns the names it removed so the caller can log the fact — never values.
 */
export function scrubProviderEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ScrubOptions = {},
): ScrubResult {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isProviderEnvOverride(name)) continue;
    delete env[name];
    removed.push(name);
  }
  if (options.offline === true) {
    env[PI_OFFLINE_ENV_VAR] = "1";
  } else if (options.offline === false) {
    // The daemon's policy wins over whatever the launching shell had set.
    delete env[PI_OFFLINE_ENV_VAR];
  }
  env[PI_NO_TITLE_ENV_VAR] = "1";
  return { removed: removed.sort() };
}

export function findProviderCredentialEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(env).filter(isProviderEnvOverride).sort();
}
