/**
 * Ghost's compatibility boundary onto the modern Oh My Pi runtime.
 *
 * OMP 18 replaced the JSON `ModelRuntime` with a SQLite-backed `AuthStorage`
 * plus `ModelRegistry`. Ghost keeps its public per-home files stable: this
 * adapter imports legacy `auth.json` once (without deleting it) and projects
 * the Ghost-only `roles` key out of `models.json` before OMP validates the
 * provider catalogue.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  type AuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import {
  completeSimple,
  type AssistantMessage,
  type Context,
  type Model,
} from "@oh-my-pi/pi-ai";
import {
  getOAuthProviders,
  getProviderDefinition,
} from "@oh-my-pi/pi-ai/registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
  AuthInteraction,
  AuthType,
  Credential,
  LoginRuntime,
} from "./auth.js";
import type { ModelCatalogRuntime } from "./model-catalog.js";

const OMP_AUTH_DB = "agent.db";
const OMP_MODELS_VIEW = "models.omp.json";
const AUTH_IMPORT_MARKER = ".auth-json-imported-v18";
const SUBSCRIPTION_PROVIDERS = new Set([
  "openai-codex",
  "openai-codex-device",
  "github-copilot",
  "google-gemini-cli",
  "xai-oauth",
]);

interface LegacyAuthFile {
  [provider: string]: Credential | Credential[];
}

interface RuntimeInput {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
  settings?: Settings;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Credential>;
  return candidate.type === "api_key"
    ? typeof candidate.key === "string" && candidate.key.length > 0
    : candidate.type === "oauth"
      && typeof candidate.access === "string"
      && typeof candidate.refresh === "string"
      && typeof candidate.expires === "number";
}

function legacyAuthFile(value: unknown): LegacyAuthFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: LegacyAuthFile = {};
  for (const [provider, entry] of Object.entries(value)) {
    if (isCredential(entry)) result[provider] = entry;
    else if (Array.isArray(entry)) {
      const credentials = entry.filter(isCredential);
      if (credentials.length > 0) result[provider] = credentials;
    }
  }
  return result;
}

async function importLegacyAuth(
  storage: AuthStorage,
  authPath: string,
  agentDir: string,
): Promise<void> {
  const marker = join(agentDir, AUTH_IMPORT_MARKER);
  if (existsSync(marker) || !existsSync(authPath)) return;

  const legacy = legacyAuthFile(readJson(authPath));
  for (const [provider, entry] of Object.entries(legacy)) {
    // A modern login always wins. The import is deliberately non-destructive.
    if (!storage.has(provider)) {
      await storage.set(provider, entry as AuthCredential | AuthCredential[]);
    }
  }
  try {
    writeFileSync(
      marker,
      `${JSON.stringify({ importedAt: new Date().toISOString(), source: authPath })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    chmodSync(marker, 0o600);
  } catch (error) {
    // Model listing, login, and session construction can open the same ghost
    // concurrently. Another opener winning the one-time marker race means the
    // migration succeeded; every other write failure remains fatal.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function ompModelsDocument(value: unknown): { providers: Record<string, unknown> } {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as { providers?: unknown }
    : {};
  const providers: Record<string, unknown> = {};
  if (source.providers && typeof source.providers === "object" && !Array.isArray(source.providers)) {
    for (const [provider, raw] of Object.entries(source.providers)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const { name: _ghostDisplayName, ...config } = raw as Record<string, unknown>;
      if (
        Array.isArray(config.models)
        && config.models.length > 0
        && config.apiKey === undefined
        && config.auth === undefined
      ) {
        // Legacy Ghost treated an omitted key on custom endpoints as keyless.
        config.auth = "none";
      }
      providers[provider] = config;
    }
  }
  return { providers };
}

function syncOmpModelsView(modelsPath: string): string {
  const agentDir = dirname(modelsPath);
  const target = join(agentDir, OMP_MODELS_VIEW);
  const input = existsSync(modelsPath) ? readJson(modelsPath) : { providers: {} };
  const rendered = `${JSON.stringify(ompModelsDocument(input), null, 2)}\n`;
  if (existsSync(target) && readFileSync(target, "utf8") === rendered) return target;

  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, rendered, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  return target;
}

function providerName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** A small old-shape facade so Ghost's stable HTTP/CLI contracts need not leak OMP internals. */
export class GhostOmpRuntime implements LoginRuntime, ModelCatalogRuntime {
  readonly modelRegistry: ModelRegistry;
  readonly authStorage: AuthStorage;

  private constructor(authStorage: AuthStorage, modelRegistry: ModelRegistry) {
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
  }

  static async create(input: RuntimeInput): Promise<GhostOmpRuntime> {
    const agentDir = dirname(input.authPath);
    mkdirSync(agentDir, { recursive: true });
    const authStorage = await AuthStorage.create(join(agentDir, OMP_AUTH_DB), {
      sourceLabel: `Ghost ${agentDir}`,
    });
    await authStorage.reload();
    await importLegacyAuth(authStorage, input.authPath, agentDir);

    const ompModelsPath = syncOmpModelsView(input.modelsPath);
    const modelRegistry = new ModelRegistry(authStorage, ompModelsPath, {
      ...(input.settings ? { settings: input.settings } : {}),
      cacheDbPath: join(agentDir, "models.db"),
    });
    await modelRegistry.hydrateCredentialScopedModelCaches();
    await modelRegistry.refresh(input.allowModelNetwork ? "online-if-uncached" : "offline");
    return new GhostOmpRuntime(authStorage, modelRegistry);
  }

  getModels(providerId?: string) {
    const models = this.modelRegistry.getAll();
    return providerId ? models.filter(model => model.provider === providerId) : models;
  }

  getModel(providerId: string, modelId: string) {
    return this.modelRegistry.find(providerId, modelId);
  }

  async getAvailable(providerId?: string) {
    const models = this.modelRegistry.getAvailable();
    return providerId ? models.filter(model => model.provider === providerId) : models;
  }

  getProviderAuthStatus(providerId: string): { configured: boolean } {
    const model = this.modelRegistry.getAll().find(candidate => candidate.provider === providerId);
    return {
      configured: model
        ? this.modelRegistry.hasConfiguredAuth(model)
        : this.authStorage.hasAuth(providerId),
    };
  }

  hasConfiguredAuth(providerId: string): boolean {
    return this.getProviderAuthStatus(providerId).configured;
  }

  isUsingSubscription(providerId: string): boolean {
    return SUBSCRIPTION_PROVIDERS.has(providerId) && this.authStorage.hasOAuth(providerId);
  }

  isUsingOAuth(providerId: string): boolean {
    return this.authStorage.hasOAuth(providerId);
  }

  complete(
    model: Model<never>,
    context: Context,
    options: { signal?: AbortSignal } = {},
  ): Promise<AssistantMessage> {
    return completeSimple(
      model,
      context,
      {
        apiKey: this.modelRegistry.resolver(model),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  getProviders() {
    const oauth = new Map(getOAuthProviders().map(provider => [provider.id, provider]));
    const ids = new Set(this.modelRegistry.getAll().map(model => model.provider));
    for (const id of oauth.keys()) ids.add(id);
    return [...ids].map(id => {
      const login = oauth.get(id);
      const definition = getProviderDefinition(id);
      return {
        id,
        name: login?.name ?? definition?.name ?? providerName(id),
        auth: {
          ...(login
            ? {
                oauth: {
                  isSubscription: SUBSCRIPTION_PROVIDERS.has(id),
                  loginLabel: `Sign in with ${login.name}`,
                },
              }
            : {}),
          // Ghost deliberately retains direct key entry even though OMP's
          // native login picker now focuses on provider-owned login flows.
          apiKey: { login: true },
        },
      };
    });
  }

  async login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    if (type === "api_key") {
      const key = await interaction.prompt({
        type: "secret",
        message: `Paste the API key for ${providerName(providerId)}`,
        placeholder: "API key",
        signal: interaction.signal,
      });
      if (!key) throw new Error("No API key was entered.");
      const credential: Credential = { type: "api_key", key };
      await this.authStorage.set(providerId, credential);
      return credential;
    }

    await this.authStorage.login(providerId, {
      signal: interaction.signal,
      onAuth: info => interaction.notify({
        type: "auth_url",
        url: info.launchUrl ?? info.url,
        ...(info.instructions ? { instructions: info.instructions } : {}),
      }),
      onProgress: message => interaction.notify({ type: "progress", message }),
      onPrompt: prompt => interaction.prompt({
        type: "text",
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        signal: interaction.signal,
      }),
      onManualCodeInput: () => interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization code (or full redirect URL)",
        signal: interaction.signal,
      }),
    });
    const stored = this.authStorage.get(providerId)
      ?? this.authStorage.get(getProviderDefinition(providerId)?.storeCredentialsAs ?? providerId);
    if (!stored) throw new Error(`OMP completed ${providerId} login without storing a credential.`);
    return stored;
  }

  close(): void {
    this.authStorage.close();
  }
}

export async function createGhostOmpRuntime(input: RuntimeInput): Promise<GhostOmpRuntime> {
  return GhostOmpRuntime.create(input);
}
