/**
 * `@ghost/daemon` — the local process that hosts a user's ghosts.
 *
 * The binary is `ghostd` (`src/main.ts`); everything below is the library
 * surface, so a UI shell or a test can drive the same pieces in-process.
 */
export {
  ANTHROPIC_EXTRA_USAGE_NOTE,
  bindDefaultChatModelIfUnset,
  LoginManager,
  type LoginManagerOptions,
  type LoginPromptView,
  type LoginRuntime,
  type LoginStatus,
  type LoginView,
  type ProviderInfo,
} from "./auth.js";
export {
  assertLoopback,
  DEFAULT_GHOSTS_DIRNAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultConfigPath,
  loadConfig,
  type DaemonConfig,
  type DaemonConfigFile,
  type DaemonConfigOverrides,
} from "./config.js";
export {
  CLAUDE_CODE_BINARY_ENV,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeProcessError,
  ClaudeCodeRuntime,
  claudeSessionMetadataPath,
  isClaudePlanAuth,
  readClaudeCodeAuthStatus,
  resolveClaudeCodeExecutable,
  type ClaudeCodeAuthStatus,
  type ClaudeCodeQueryFactory,
  type ClaudeCodeRuntimeOptions,
  type ClaudeSessionMetadata,
} from "./claude-code.js";
export {
  createClaudePiMessagesAdapter,
  type ClaudePiMessagesAdapter,
} from "./claude-pi-messages.js";
export {
  findProviderCredentialEnv,
  PI_OFFLINE_ENV_VAR,
  PROVIDER_CREDENTIAL_ENV_PATTERNS,
  PROVIDER_CREDENTIAL_ENV_VARS,
  scrubProviderEnv,
  type ScrubOptions,
  type ScrubResult,
} from "./env-scrub.js";
export {
  CREATOR_SCOPE,
  resolveGhostExtensions,
  resolveGhostScope,
  visitorScope,
  type GhostExtensionOptions,
  type GhostScope,
  type ResolvedGhostExtensions,
} from "./extensions.js";
export {
  assertValidGhostName,
  GHOST_AGENT_DIRNAME,
  GHOST_CHARACTER_FILENAME,
  GHOST_SESSIONS_DIRNAME,
  GhostError,
  GhostRegistry,
  ghostPaths,
  isGhostHome,
  isValidGhostName,
  type Ghost,
} from "./ghosts.js";
export { createLogger, silentLogger, type Logger, type LogLevel } from "./log.js";
export {
  DEFAULT_MODELS_LIMIT,
  MAX_MODELS_LIMIT,
  ModelCatalog,
  type CatalogModel,
  type CurrentModel,
  type ListModelsQuery,
  type ListModelsResult,
  type ModelCatalogOptions,
  type ModelListItem,
  type ModelScope,
  type ModelView,
  type SetModelResult,
} from "./model-catalog.js";
export {
  AUTH_FILENAME,
  builtinProviderPreset,
  ghostAuthPath,
  ghostModelsPath,
  MODELS_FILENAME,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_FREE_MODEL,
  OPENROUTER_PROVIDER_ID,
  openAiCompatiblePreset,
  openRouterPreset,
  readGhostModels,
  resolveChatModelRef,
  writeGhostModels,
  type GhostModelDefinition,
  type GhostModelRole,
  type GhostModelRoleBinding,
  type GhostModelsFile,
  type GhostProviderConfig,
} from "./models.js";
export {
  createPiMessagesAdapter,
  encodeSseEvent,
  parsePiMessagesRequest,
  PiMessagesRequestError,
  SSE_HEADERS,
  SSE_KEEPALIVE_COMMENT,
  SSE_KEEPALIVE_INTERVAL_MS,
  textFromParts,
  zeroUsage,
  type PiMessagesAdapter,
  type PiMessagesAdapterOptions,
  type PiMessagesEvent,
  type PiMessagesRequest,
} from "./pi-messages.js";
export {
  attachRelay,
  createRelayHub,
  RELAY_CLOSE_GOING_AWAY,
  RELAY_PING_INTERVAL_MS,
  RELAY_TIMEOUT_GRACE_MS,
  RelayHub,
  type RelayHubOptions,
  type RelayStatus,
} from "./relay.js";
export {
  authorizeRelayUpgrade,
  encodeServerFrame,
  isRelayOp,
  MAX_FRAME_BYTES,
  parseClientFrame,
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
  type ParsedClientFrame,
  type RelayClientFrame,
  type RelayRequestFrame,
  type RelayServerFrame,
  type RelayUpgradeDecision,
} from "./relay-protocol.js";
export {
  defaultRelayTokenPath,
  readOrCreateRelayToken,
  readRelayToken,
  RELAY_TOKEN_FILENAME,
  relayTokenCommand,
  relayTokenMatches,
  rotateRelayToken,
  type RelayTokenStoreOptions,
} from "./relay-token.js";
export {
  createDaemonServer,
  relayHubOf,
  startDaemonServer,
  type ListeningServer,
  type ServerOptions,
} from "./server.js";
export {
  PI_BUILTIN_TOOL_NAMES,
  SessionHost,
  sessionFileNameFor,
  type GhostSessionHandle,
  type RunTurnOptions,
  type SessionHostOptions,
} from "./session-host.js";
