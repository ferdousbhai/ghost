/**
 * Provider isolation for ghost sessions.
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
  // selectors/channels. The global scrub also removes CLAUDE_CONFIG_DIR after
  // the dedicated Claude environment has captured the owner's native login.
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
 * Claude request through a third party or silently select a backend
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
  "AWS_CA_BUNDLE",
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
  // pi settings and shell wrapping must remain session-scoped in the pi
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
 * Non-secret selectors accepted by the external, owner-installed Claude Code
 * harness. Keep this inventory aligned with
 * Anthropic's current authentication, environment-variable, Bedrock, Vertex,
 * Foundry, Claude Platform on AWS, gateway, and corporate-proxy references.
 * Primary inventory: https://code.claude.com/docs/en/env-vars,
 * /authentication, /amazon-bedrock, /google-vertex-ai, /microsoft-foundry,
 * /claude-platform-on-aws, /llm-gateway, and /network-config.
 *
 * Credential values never cross this boundary. A wrapper chosen with
 * GHOST_CLAUDE_BINARY is the owner-controlled place for an environment-only
 * native credential: Ghost starts the literal wrapper with this non-secret
 * environment, and the wrapper injects the credential before execing Claude.
 */
export const CLAUDE_CODE_VERTEX_REGION_ENV_VARS = [
  "VERTEX_REGION_CLAUDE_3_5_HAIKU",
  "VERTEX_REGION_CLAUDE_3_5_SONNET",
  "VERTEX_REGION_CLAUDE_3_7_SONNET",
  "VERTEX_REGION_CLAUDE_4_0_OPUS",
  "VERTEX_REGION_CLAUDE_4_0_SONNET",
  "VERTEX_REGION_CLAUDE_4_1_OPUS",
  "VERTEX_REGION_CLAUDE_4_5_OPUS",
  "VERTEX_REGION_CLAUDE_4_5_SONNET",
  "VERTEX_REGION_CLAUDE_4_6_OPUS",
  "VERTEX_REGION_CLAUDE_4_6_SONNET",
  "VERTEX_REGION_CLAUDE_4_7_OPUS",
  "VERTEX_REGION_CLAUDE_4_8_OPUS",
  "VERTEX_REGION_CLAUDE_5_OPUS",
  "VERTEX_REGION_CLAUDE_5_SONNET",
  "VERTEX_REGION_CLAUDE_FABLE_5",
  "VERTEX_REGION_CLAUDE_HAIKU_4_5",
] as const;

export const CLAUDE_CODE_SAFE_ENV_VARS: readonly string[] = [
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "AWS_CA_BUNDLE",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_DEFAULT_REGION",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_ENDPOINT",
  "AWS_ENDPOINT_URL",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SEND_CERTIFICATE_CHAIN",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_TENANT_ID",
  "AZURE_TOKEN_CREDENTIALS",
  "AZURE_USERNAME",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS",
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_GB_BASE_URL",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_AWS_CRED_CACHE",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLOUD_ML_REGION",
  "GCLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "USE_VERTEX",
  ...CLAUDE_CODE_VERTEX_REGION_ENV_VARS,
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** Credential-bearing names that must never enter Ghost's Claude launch env. */
export const CLAUDE_CODE_CREDENTIAL_VALUE_ENV_PATTERN =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|SESSION_ACCESS_TOKEN|BEARER_TOKEN|TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|CLIENT_SECRET|PASSWORD|PASSPHRASE|SECRET|AUTHORIZATION|CUSTOM_HEADERS|EXTRA_BODY)$/u;

const CLAUDE_ENV_FAMILY_PREFIXES = [
  "ANTHROPIC_",
  "AWS_",
  "AZURE_",
  "CLAUDE_",
  "GCLOUD_",
  "GOOGLE_",
] as const;
export const NATIVE_HARNESS_OPERATIONAL_ENV_VARS = [
  "COLORTERM",
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  "DISPLAY",
  "HOME",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_STATE_HOME",
] as const;
export const CODEX_NATIVE_SAFE_ENV_VARS = ["CODEX_HOME"] as const;
export const PI_NATIVE_SAFE_ENV_VARS = ["PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR"] as const;

export type NativeHarnessEnvironmentProfile =
  | "claude-principal"
  | "claude-native"
  | "codex-native"
  | "pi-native";

const NATIVE_HARNESS_ENVIRONMENT_SNAPSHOTS: Readonly<
  Record<NativeHarnessEnvironmentProfile, symbol>
> = {
  "claude-principal": Symbol("ClaudePrincipalEnvironmentSnapshot"),
  "claude-native": Symbol("ClaudeNativeEnvironmentSnapshot"),
  "codex-native": Symbol("CodexNativeEnvironmentSnapshot"),
  "pi-native": Symbol("PiNativeEnvironmentSnapshot"),
};

function isClaudeEnvironmentFamily(name: string): boolean {
  return name === "CLAUDECODE"
    || name === "CLOUD_ML_REGION"
    || name === "USE_VERTEX"
    || name.startsWith("VERTEX_REGION_CLAUDE_")
    || CLAUDE_ENV_FAMILY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Derive one launch-time environment for an owner-installed harness. Values
 * remain opaque: this boundary copies them but never inspects, logs,
 * serializes, or returns them.
 */
export function captureNativeHarnessEnvironment(
  profile: NativeHarnessEnvironmentProfile,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> {
  const marker = NATIVE_HARNESS_ENVIRONMENT_SNAPSHOTS[profile];
  if ((source as NodeJS.ProcessEnv & {
    [key: symbol]: true | undefined;
  })[marker]) return source;

  const environment: NodeJS.ProcessEnv = {};
  for (const name of NATIVE_HARNESS_OPERATIONAL_ENV_VARS) {
    if (source[name] !== undefined) environment[name] = source[name];
  }

  const safeNames = profile.startsWith("claude-")
    ? CLAUDE_CODE_SAFE_ENV_VARS
    : profile === "codex-native" ? CODEX_NATIVE_SAFE_ENV_VARS : PI_NATIVE_SAFE_ENV_VARS;
  for (const name of safeNames) {
    if (CLAUDE_CODE_CREDENTIAL_VALUE_ENV_PATTERN.test(name)) {
      throw new Error(`Native harness environment misclassified credential-bearing ${name}.`);
    }
    if (source[name] !== undefined) environment[name] = source[name];
  }
  if (profile.startsWith("claude-")) {
    environment.CLAUDE_AGENT_SDK_CLIENT_APP = "ghostd/0.0.1";
  }
  if (profile === "claude-principal") {
    environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }
  Object.defineProperty(environment, marker, { value: true });
  return Object.freeze(environment);
}

/** Preserve the principal Claude runtime's existing environment contract. */
export function captureClaudeCodeEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> {
  return captureNativeHarnessEnvironment("claude-principal", source);
}

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
  // The Claude snapshot is captured first. Pi and every ordinary daemon child
  // then lose the complete Claude/cloud family, including variables added by
  // a future CLI release before Ghost's direct pass-through list is updated.
  if (isClaudeEnvironmentFamily(name)) return true;
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
