/**
 * Per-ghost model configuration.
 *
 * A ghost is model-agnostic across Oh My Pi providers. The one explicit runtime
 * marker is `claude-code/default`, because an installed Claude Code process
 * has different auth/accounting semantics than OMP's Anthropic provider.
 * Durable model/runtime choice lives in the ghost's own
 * `<home>/models.json`. `omp-runtime.ts` projects the provider portion to
 * OMP while retaining Ghost's role and fallback metadata. Provider and MCP
 * values are service/account references into Ghost's Secret Service schema;
 * legacy plaintext sources are imported, verified, and scrubbed once.
 *
 * ## The file
 *
 * ```jsonc
 * {
 *   "providers": {
 *     "<providerId>": { "name", "baseUrl", "api", "apiKey", "headers", "models": [...] }
 *   },
 *   "roles": { "chat_model": { "provider": "<providerId>", "modelId": "<id>" } },
 *   "fallbacks": { "chat_model": [{ "provider": "<providerId>", "modelId": "<id>" }] }
 * }
 * ```
 *
 * A provider that OMP already knows (`openrouter`, `openai-codex`,
 * `anthropic`, `openai`, `github-copilot`, `xai`, …) needs NO `providers`
 * entry at all — declare only the `roles` binding and log in. An
 * OpenAI-compatible endpoint OMP does not know (Ollama, vLLM, llama.cpp, a
 * relay speaking `pi-messages`) is declared in full under `providers`.
 *
 * ## Credentials
 *
 * Never from the environment or a ghost-home literal — see env-scrub.ts.
 * `models.json` contains only `keyring:<service>/<account>[#<field>]`
 * references and an `accounts` policy list. Secret values live at machine
 * scope in Linux Secret Service and are injected through OMP's
 * `AuthCredentialStore` boundary.
 *
 * `claude-code/default` uses neither source: the official Agent SDK invokes
 * the installed `claude`, and that unmodified executable reads the owner's
 * own external Claude Code login. The upstream provider path and this external
 * `anthropic` OAuth uses per-token extra usage rather than included plan
 * limits; the two selections must not be conflated.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
  pickDefaultAvailableModel,
  resolveModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
  fsyncPath,
  PrivateReadError,
  readPrivateFileText,
  type PrivateReadRefusal,
} from "./private-file.js";
import {
  parseSecretAccountName,
  parseSecretReference,
  SECRET_REFERENCE_PREFIX,
} from "./secret-reference.js";

export interface GhostModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  [key: string]: unknown;
}

export interface GhostProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  /** Device-local secret. Absent for keyless local servers and for OAuth. */
  apiKey?: string;
  headers?: Record<string, string>;
  models?: GhostModelDefinition[];
  [key: string]: unknown;
}

export interface GhostModelRoleBinding {
  provider: string;
  modelId: string;
}

/**
 * The inference roles a ghost binds. Only `chat_model` is load-bearing for a
 * chat turn; the rest exist so a role added later does not need a file
 * migration. `vision_model` is the first to take that promise up — a plain
 * addition to this union, and every existing `models.json` keeps working,
 * because `roles` is optional and each role within it is optional.
 *
 * - `chat_model` — answers the turn.
 * - `vision_model` — reads images when `chat_model` cannot; must be a model
 *   whose `input` includes `"image"`. The role is consumed natively: it
 *   projects onto OMP's `modelRoles.vision`, OMP's `inspect_image` resolves
 *   `@vision` first, and OMP's attachment describe-fallback prefers it too.
 *   When the resolved model cannot accept images, OMP raises its own
 *   actionable error rather than dropping the image in silence. Unbound, there
 *   is no ghost-side cheapest-model default — that was removed deliberately:
 *   reading an image is quality work, not throwaway work, so the owner
 *   configures the role instead of inheriting the cheapest thing with eyes.
 * - `smol_model` — the cheap, fast lane for a ghost's throwaway completions:
 *   the name of a new conversation (`title.ts`), the opening line of an empty
 *   chat (`greeting.ts`), and trusted command-hook classification
 *   (`hook-smol-complete.ts`). Unbound, the daemon falls back to the cheapest USABLE
 *   model, subscription-aware: a capable model on an already-authenticated
 *   subscription (OAuth / included plan → zero marginal cost) is preferred over
 *   a cheaper metered model. Every use is a single, fire-and-forget completion;
 *   a failure never affects the conversation.
 * - `slow_model`, `plan_model`, `designer_model`, `commit_model`,
 *   `tiny_model`, `task_model`, `advisor_model` — OMP's remaining built-in
 *   roles. Keeping their native role identities lets bundled agents and modes
 *   resolve the same `@role` aliases they do in the terminal client.
 * - `general_purpose_model`, `research_model` — older Ghost custom roles,
 *   retained so an existing home keeps its routing.
 */
export type GhostModelRole =
  | "chat_model"
  | "smol_model"
  | "slow_model"
  | "vision_model"
  | "plan_model"
  | "designer_model"
  | "commit_model"
  | "tiny_model"
  | "task_model"
  | "advisor_model"
  | "general_purpose_model"
  | "research_model";

export const GHOST_MODEL_ROLES: readonly GhostModelRole[] = [
  "chat_model",
  "smol_model",
  "slow_model",
  "vision_model",
  "plan_model",
  "designer_model",
  "commit_model",
  "tiny_model",
  "task_model",
  "advisor_model",
  "general_purpose_model",
  "research_model",
];

/**
 * Keep Ghost's public role vocabulary stable and translate only at the harness
 * boundary. Every OMP built-in retains its native id; `general` and `research`
 * remain custom roles solely for compatibility with earlier Ghost homes.
 */
export const GHOST_TO_OMP_MODEL_ROLE: Readonly<Record<GhostModelRole, string>> = {
  chat_model: "default",
  smol_model: "smol",
  slow_model: "slow",
  vision_model: "vision",
  plan_model: "plan",
  designer_model: "designer",
  commit_model: "commit",
  tiny_model: "tiny",
  task_model: "task",
  advisor_model: "advisor",
  general_purpose_model: "general",
  research_model: "research",
};

/**
 * `smol_model` was called `title_model` before the role grew a second consumer.
 * `readGhostModels` normalises the old key away, so nothing downstream of a read
 * — including every writer, which round-trips through it — ever sees it again.
 */
const LEGACY_SMOL_MODEL_ROLE = "title_model";

export interface GhostModelsFile {
  providers: Record<string, GhostProviderConfig>;
  accounts?: string[];
  roles?: Partial<Record<GhostModelRole, GhostModelRoleBinding>>;
  fallbacks?: Partial<Record<GhostModelRole, GhostModelRoleBinding[]>>;
  [key: string]: unknown;
}

export interface GhostOmpModelRouting {
  modelRoles: Record<string, string>;
  fallbackChains: Record<string, string[]>;
}

export function ghostModelSelector(binding: GhostModelRoleBinding): string {
  return `${binding.provider}/${binding.modelId}`;
}

/**
 * Resolve OMP's initial chat/default choice from Ghost's projected role.
 *
 * This is the shared daemon-side mirror of `createAgentSession`: a usable
 * configured default role wins, otherwise OMP's provider-default-aware picker
 * chooses from the same availability-ordered candidates.
 */
export function resolveOmpChatModel(
  binding: GhostModelRoleBinding | null | undefined,
  availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
  const candidates = [...availableModels];
  const roleValue = binding ? ghostModelSelector(binding) : undefined;
  return resolveModelRoleValue(roleValue, candidates).model
    ?? pickDefaultAvailableModel(candidates);
}

/**
 * Project Ghost's durable model routing onto modern OMP settings.
 *
 * The implicit first declared chat model remains supported for hand-written
 * one-provider files. Other roles are explicit: silently borrowing the chat
 * model for vision/smol/research would defeat the reason those roles exist.
 */
export function ghostOmpModelRouting(file: GhostModelsFile | null): GhostOmpModelRouting {
  const modelRoles: Record<string, string> = {};
  const fallbackChains: Record<string, string[]> = {};
  const chat = resolveChatModelRef(file);
  if (chat) modelRoles.default = ghostModelSelector(chat);
  if (!file) return { modelRoles, fallbackChains };

  for (const role of GHOST_MODEL_ROLES) {
    if (role !== "chat_model") {
      const primary = file.roles?.[role];
      if (primary?.provider && primary.modelId) {
        modelRoles[GHOST_TO_OMP_MODEL_ROLE[role]] = ghostModelSelector(primary);
      }
    }
    const chain = file.fallbacks?.[role];
    if (chain?.length) {
      fallbackChains[GHOST_TO_OMP_MODEL_ROLE[role]] = chain.map(ghostModelSelector);
    }
  }
  return { modelRoles, fallbackChains };
}

export const MODELS_FILENAME = "models.json";
export const AUTH_FILENAME = "auth.json";
const MODELS_LOCK_SUFFIX = ".lock";
const MODELS_LOCK_WAIT_MS = 500;
const MODELS_LOCK_POLL_MS = 10;
const MODELS_READ_REFUSAL: Record<Exclude<PrivateReadRefusal, "open">, string> = {
  unsafe: "must be a single-link regular file",
  too_large: "exceeds the 1 MiB limit",
  changed: "changed while it was being read",
  encoding: "is not valid UTF-8",
};
const lockSleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface GhostModelsLockOwner {
  token: string;
  pid: number;
}

export class GhostModelsWriteConflictError extends Error {
  readonly code = "ghost_models_write_conflict";

  constructor(
    readonly path: string,
    readonly lockPath: string,
    readonly ownerPid: number | undefined,
    readonly retryable: boolean,
  ) {
    const owner = ownerPid === undefined ? "another writer" : `process ${ownerPid}`;
    super(
      retryable
        ? `${path} is locked by ${owner} at ${lockPath}; retry the operation.`
        : `${path} has a re-entrant mutation from ${owner} at ${lockPath}.`,
    );
    this.name = "GhostModelsWriteConflictError";
  }
}

export class GhostModelsLockError extends Error {
  readonly code = "ghost_models_lock_error";

  constructor(readonly lockPath: string, message: string, options?: ErrorOptions) {
    super(`${lockPath}: ${message}`, options);
    this.name = "GhostModelsLockError";
  }
}

export function ghostModelsPath(configDir: string): string {
  return join(configDir, MODELS_FILENAME);
}

export function ghostAuthPath(agentDir: string): string {
  return join(agentDir, AUTH_FILENAME);
}

export function ghostModelsLockPath(configDir: string): string {
  return `${ghostModelsPath(configDir)}${MODELS_LOCK_SUFFIX}`;
}

function parseLockOwner(raw: string): GhostModelsLockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const owner = parsed as Partial<GhostModelsLockOwner> | null;
  if (typeof owner?.token !== "string"
    || !owner.token
    || typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0) {
    return null;
  }
  return owner as GhostModelsLockOwner;
}

function readLockOwner(lockPath: string): GhostModelsLockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Missing/malformed ownership is ambiguous: fail closed and leave the lock
    // for explicit operator inspection/removal rather than guessing it is stale.
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw error;
  }
  return parseLockOwner(raw);
}

function releaseModelsLock(lockPath: string, owner: GhostModelsLockOwner): void {
  const current = readLockOwner(lockPath);
  if (current?.token !== owner.token) {
    throw new GhostModelsLockError(lockPath, "lock ownership was lost before release.");
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    throw new GhostModelsLockError(lockPath, "the owned lock could not be released.", { cause: error });
  }
}

function tryCreateModelsLock(lockPath: string): GhostModelsLockOwner | null {
  const owner: GhostModelsLockOwner = {
    token: randomUUID(),
    pid: process.pid,
  };
  try {
    writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(lockPath, 0o600);
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw new GhostModelsLockError(
      lockPath,
      "the writer lock could not be initialized; inspect and remove it before retrying if it exists.",
      { cause: error },
    );
  }
}

function acquireModelsLock(path: string): { lockPath: string; owner: GhostModelsLockOwner } {
  const lockPath = `${path}${MODELS_LOCK_SUFFIX}`;
  const deadline = Date.now() + MODELS_LOCK_WAIT_MS;
  for (;;) {
    const acquired = tryCreateModelsLock(lockPath);
    if (acquired) return { lockPath, owner: acquired };
    const owner = readLockOwner(lockPath);
    if (owner?.pid === process.pid) {
      throw new GhostModelsWriteConflictError(path, lockPath, owner.pid, false);
    }
    if (Date.now() >= deadline) {
      throw new GhostModelsWriteConflictError(path, lockPath, owner?.pid, true);
    }
    Atomics.wait(lockSleepCell, 0, 0, MODELS_LOCK_POLL_MS);
  }
}

function withSerializedModelsWrite<T>(path: string, mutation: () => T): T {
  const { lockPath, owner } = acquireModelsLock(path);
  let value: T;
  try {
    value = mutation();
  } catch (error) {
    try {
      releaseModelsLock(lockPath, owner);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `${path} failed during mutation and its writer lock could not be released.`,
      );
    }
    throw error;
  }
  releaseModelsLock(lockPath, owner);
  return value;
}

/**
 * Replace `models.json` atomically with a private inode.
 *
 * The temporary lives beside the destination so `renameSync` cannot cross a
 * filesystem boundary. Its random, exclusive name prevents concurrent daemon
 * processes from sharing a staging file; mode 0600 protects an embedded
 * keyring reference during staging as well as after rename.
 */
function persistGhostModels(path: string, file: GhostModelsFile): void {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Creation mode is filtered through umask; force the promised final mode.
    chmodSync(temporary, 0o600);
    fsyncPath(temporary);
    renameSync(temporary, path);
    fsyncPath(dirname(path));
  } catch (error) {
    try {
      // `writeFileSync` may create and partially populate the temporary before
      // throwing, so cleanup cannot depend on the call having returned.
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${path} could not be replaced and its private temporary file could not be removed.`,
      );
    }
    throw error;
  }
}

/**
 * Fold a legacy `title_model` entry into `smol_model`, in place.
 *
 * The old key is always removed, so a file read here and written back — every
 * mutation in this module round-trips that way — loses it. A file carrying both
 * keys is one an older Ghost wrote after a newer one had already migrated it:
 * the new key is the current truth and wins.
 */
function migrateLegacySmolRole<T>(
  bindings: Partial<Record<string, T>> | undefined,
): Partial<Record<GhostModelRole, T>> | undefined {
  if (!bindings || !(LEGACY_SMOL_MODEL_ROLE in bindings)) {
    return bindings as Partial<Record<GhostModelRole, T>> | undefined;
  }
  const { [LEGACY_SMOL_MODEL_ROLE]: legacy, ...rest } = bindings;
  const migrated = rest as Partial<Record<GhostModelRole, T>>;
  if (migrated.smol_model === undefined && legacy !== undefined) {
    migrated.smol_model = legacy;
  }
  return migrated;
}

function assertParses(path: string, value: string, parse: (input: string) => unknown): void {
  try {
    parse(value);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

function assertSecretValue(path: string, value: string): void {
  if (!value.startsWith(SECRET_REFERENCE_PREFIX)) return;
  assertParses(path, value, parseSecretReference);
}

function assertAccountPolicy(path: string, accounts: unknown): void {
  if (accounts === undefined) return;
  if (!Array.isArray(accounts) || !accounts.every((entry) => typeof entry === "string")) {
    throw new Error(`${path}: "accounts" must be an array of service/account strings.`);
  }
  const seen = new Set<string>();
  for (const account of accounts as string[]) {
    assertParses(path, account, parseSecretAccountName);
    if (seen.has(account)) throw new Error(`${path}: "accounts" must not contain duplicates.`);
    seen.add(account);
  }
}

function assertProviderShape(path: string, providers: Record<string, unknown>): void {
  for (const [provider, value] of Object.entries(providers)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}: provider ${JSON.stringify(provider)} must be an object.`);
    }
    const config = value as Record<string, unknown>;
    if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
      throw new Error(`${path}: provider ${JSON.stringify(provider)} "apiKey" must be a string.`);
    }
    if (typeof config.apiKey === "string") assertSecretValue(path, config.apiKey);
    if (config.headers === undefined) continue;
    if (config.headers === null || typeof config.headers !== "object" || Array.isArray(config.headers)) {
      throw new Error(`${path}: provider ${JSON.stringify(provider)} "headers" must be an object.`);
    }
    for (const header of Object.values(config.headers as Record<string, unknown>)) {
      if (typeof header !== "string") {
        throw new Error(`${path}: provider ${JSON.stringify(provider)} header values must be strings.`);
      }
      assertSecretValue(path, header);
    }
  }
}

export function readGhostModels(configDir: string): GhostModelsFile | null {
  const path = ghostModelsPath(configDir);
  let text: string;
  try {
    text = readPrivateFileText(path);
  } catch (error) {
    if (!(error instanceof PrivateReadError)) throw error;
    if (error.refusal === "open") {
      const cause = error.cause as NodeJS.ErrnoException;
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
    throw new Error(`${path} ${MODELS_READ_REFUSAL[error.refusal]}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const file = parsed as Record<string, unknown> & {
    providers?: unknown;
    accounts?: unknown;
    roles?: unknown;
    fallbacks?: unknown;
  };
  if (file.providers !== undefined
    && (file.providers === null || typeof file.providers !== "object" || Array.isArray(file.providers))) {
    throw new Error(`${path}: "providers" must be an object.`);
  }
  if (file.roles !== undefined
    && (file.roles === null || typeof file.roles !== "object" || Array.isArray(file.roles))) {
    throw new Error(`${path}: "roles" must be an object.`);
  }
  if (file.fallbacks !== undefined
    && (file.fallbacks === null || typeof file.fallbacks !== "object" || Array.isArray(file.fallbacks))) {
    throw new Error(`${path}: "fallbacks" must be an object.`);
  }
  assertAccountPolicy(path, file.accounts);
  const providers = (file.providers as Record<string, unknown>) ?? {};
  assertProviderShape(path, providers);
  return {
    ...file,
    providers: providers as Record<string, GhostProviderConfig>,
    accounts: file.accounts as string[] | undefined,
    roles: migrateLegacySmolRole(file.roles as GhostModelsFile["roles"]),
    fallbacks: migrateLegacySmolRole(file.fallbacks as GhostModelsFile["fallbacks"]),
  };
}

export function addGhostAccounts(configDir: string, additions: readonly string[]): GhostModelsFile {
  for (const account of additions) parseSecretAccountName(account);
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file = readGhostModels(configDir) ?? { providers: {} };
    file.accounts = [...new Set([...(file.accounts ?? []), ...additions])];
    persistGhostModels(path, file);
    return file;
  });
}

export function writeGhostModels(configDir: string, file: GhostModelsFile): void {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  withSerializedModelsWrite(path, () => persistGhostModels(path, file));
}

/**
 * Which model answers a chat turn.
 *
 * `roles.chat_model` wins. Otherwise the first declared model of the first
 * declared provider, so a hand-written `models.json` with one provider needs
 * no roles block. Null means "let pi decide" — its settings, then its first
 * available model.
 */
export function resolveChatModelRef(
  file: GhostModelsFile | null,
): GhostModelRoleBinding | null {
  if (!file) return null;
  const bound = file.roles?.chat_model;
  if (bound?.provider && bound.modelId) return bound;
  for (const [provider, config] of Object.entries(file.providers)) {
    const first = config.models?.[0];
    if (first?.id) return { provider, modelId: first.id };
  }
  return null;
}

/**
 * The explicit `roles.smol_model` binding, or null.
 *
 * Unlike `resolveChatModelRef`, there is NO fallback to the first declared
 * provider's model: an unbound smol role means "let the daemon pick the
 * cheapest usable model" (see `resolveSmolModel` in smol.ts), not "reuse the
 * chat model". Returning null here is exactly that signal.
 */
export function resolveSmolModelRef(
  file: GhostModelsFile | null,
): GhostModelRoleBinding | null {
  const bound = file?.roles?.smol_model;
  if (bound?.provider && bound.modelId) return bound;
  return null;
}

/**
 * Set `roles.chat_model` to a specific (provider, modelId), the writer behind
 * the model switcher. Reuses `readGhostModels`/`writeGhostModels`, preserves
 * every other key (providers, other roles) untouched, and creates the file
 * when the ghost has none yet. Unlike `bindDefaultChatModelIfUnset` in auth.ts,
 * this always overwrites the binding — it is the explicit "switch to this
 * model" action, not a first-run default.
 */
export function setChatModelRole(
  configDir: string,
  provider: string,
  modelId: string,
): GhostModelsFile {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    file.roles = { ...(file.roles ?? {}), chat_model: { provider, modelId } };
    persistGhostModels(path, file);
    return file;
  });
}

export function setGhostModelRole(
  configDir: string,
  role: GhostModelRole,
  provider: string,
  modelId: string,
): GhostModelsFile {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    file.roles = { ...(file.roles ?? {}), [role]: { provider, modelId } };
    persistGhostModels(path, file);
    return file;
  });
}

export function clearGhostModelRole(
  configDir: string,
  role: GhostModelRole,
): GhostModelsFile {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    const roles = { ...(file.roles ?? {}) };
    delete roles[role];
    file.roles = roles;
    persistGhostModels(path, file);
    return file;
  });
}

export function appendGhostModelFallback(
  configDir: string,
  role: GhostModelRole,
  provider: string,
  modelId: string,
): GhostModelsFile {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    const current = [...(file.fallbacks?.[role] ?? [])];
    if (!current.some((binding) => binding.provider === provider && binding.modelId === modelId)) {
      current.push({ provider, modelId });
    }
    file.fallbacks = { ...(file.fallbacks ?? {}), [role]: current };
    persistGhostModels(path, file);
    return file;
  });
}

/**
 * Replace a role's complete retry chain in one serialized models.json write.
 * Ordering is significant. An empty list has the same durable shape as clear.
 */
export function replaceGhostModelFallbacks(
  configDir: string,
  role: GhostModelRole,
  bindings: readonly GhostModelRoleBinding[],
): GhostModelsFile {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    const fallbacks = { ...(file.fallbacks ?? {}) };
    if (bindings.length === 0) delete fallbacks[role];
    else fallbacks[role] = bindings.map((binding) => ({ ...binding }));
    file.fallbacks = fallbacks;
    persistGhostModels(path, file);
    return file;
  });
}

export function clearGhostModelFallbacks(
  configDir: string,
  role: GhostModelRole,
): GhostModelsFile {
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    const fallbacks = { ...(file.fallbacks ?? {}) };
    delete fallbacks[role];
    file.fallbacks = fallbacks;
    persistGhostModels(path, file);
    return file;
  });
}

/**
 * Bind a default only while the role is still unclaimed.
 *
 * Provider discovery is asynchronous, so an owner can make an explicit
 * selection while a just-completed login is resolving its suggested default.
 * Re-reading and testing inside the serialized mutation prevents that stale
 * login snapshot from overwriting the owner's choice.
 */
export function setChatModelRoleIfUnset(
  configDir: string,
  provider: string,
  modelId: string,
  commitAllowed: () => boolean = () => true,
): GhostModelRoleBinding | null {
  // Login discovery is asynchronous. Its owner can time out or be disposed
  // before it reaches this synchronous commit boundary; fail closed before
  // creating anything and re-check under the writer lock.
  if (!commitAllowed()) return null;
  mkdirSync(configDir, { recursive: true });
  const path = ghostModelsPath(configDir);
  return withSerializedModelsWrite(path, () => {
    if (!commitAllowed()) return null;
    const file: GhostModelsFile = readGhostModels(configDir) ?? { providers: {} };
    if (resolveChatModelRef(file)) return null;
    const binding = { provider, modelId };
    file.roles = { ...(file.roles ?? {}), chat_model: binding };
    persistGhostModels(path, file);
    return binding;
  });
}


/**
 * OpenRouter's free roster rotates; this is a **changeable default**, not a
 * hardcode — nothing in the daemon branches on it, it only seeds a config
 * file the user can edit. Check the current free roster with:
 *
 *   curl -s https://openrouter.ai/api/v1/models | jq -r '
 *     .data[] | select(.pricing.prompt=="0") | .id'
 *
 * or https://openrouter.ai/models?max_price=0 .
 */
export const OPENROUTER_DEFAULT_FREE_MODEL = "deepseek/deepseek-r1:free";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterPresetOptions {
  apiKey?: string;
  modelId?: string;
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * OpenRouter as a fully declared provider.
 *
 * OMP has a built-in `openrouter` provider whose catalog is fetched over the
 * network; declaring the model statically here means the ghost works with
 * `offline: true` and on first run, before any catalog has been cached.
 * Cost is zeroed because the intended entry point is a `:free` model —
 * "try the ghost for nothing" needs only an OpenRouter account.
 */
export function openRouterPreset(
  options: OpenRouterPresetOptions = {},
): GhostModelsFile {
  const modelId = options.modelId ?? OPENROUTER_DEFAULT_FREE_MODEL;
  const provider: GhostProviderConfig = {
    name: "OpenRouter",
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: options.modelName ?? modelId,
        input: ["text"],
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: options.maxTokens ?? 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  if (options.apiKey) provider.apiKey = options.apiKey;
  return {
    providers: { [OPENROUTER_PROVIDER_ID]: provider },
    roles: { chat_model: { provider: OPENROUTER_PROVIDER_ID, modelId } },
  };
}

export interface OpenAiCompatiblePresetOptions {
  providerId: string;
  baseUrl: string;
  modelId: string;
  name?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Any OpenAI-compatible endpoint: Ollama, vLLM, llama.cpp, LM Studio, a
 * self-hosted gateway, or a relay speaking `pi-messages`. This is the
 * provider-agnostic path, and the one every other preset is a convenience
 * over.
 */
export function openAiCompatiblePreset(
  options: OpenAiCompatiblePresetOptions,
): GhostModelsFile {
  const provider: GhostProviderConfig = {
    name: options.name ?? options.providerId,
    baseUrl: options.baseUrl,
    api: options.api ?? "openai-completions",
    models: [
      {
        id: options.modelId,
        name: options.modelId,
        input: ["text"],
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: options.maxTokens ?? 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  if (options.apiKey) provider.apiKey = options.apiKey;
  if (options.headers) provider.headers = options.headers;
  return {
    providers: { [options.providerId]: provider },
    roles: { chat_model: { provider: options.providerId, modelId: options.modelId } },
  };
}

/**
 * Bind a model served by a provider OMP already knows, authenticated from the
 * Ghost keyring store. No `providers` entry is emitted: OMP supplies the
 * endpoint and catalogue.
 */
export function builtinProviderPreset(
  providerId: string,
  modelId: string,
): GhostModelsFile {
  return {
    providers: {},
    roles: { chat_model: { provider: providerId, modelId } },
  };
}
