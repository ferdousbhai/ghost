import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
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
import {
  KeyringAuthCredentialStore,
  type GhostSecretContext,
} from "./keyring-credential-store.js";
import {
  collectKeyringProviders,
  mergeConfiguredAccounts,
  providerAccountName,
  syncModelsView,
} from "./model-config-view.js";
import { readGhostModels } from "./models.js";
import {
  authorizeGhostAccounts,
  openGhostSecretContext,
} from "./secret-migration.js";

const OMP_MODELS_VIEW = "models.omp.json";
const SUBSCRIPTION_PROVIDERS = new Set([
  "openai-codex",
  "openai-codex-device",
  "github-copilot",
  "google-gemini-cli",
  "xai-oauth",
]);

interface RuntimeInput {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
  settings?: Settings;
}

function providerName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function authStorageProvider(providerId: string): string {
  return getProviderDefinition(providerId)?.storeCredentialsAs ?? providerId;
}

export class GhostOmpRuntime implements LoginRuntime, ModelCatalogRuntime {
  readonly modelRegistry: ModelRegistry;
  readonly authStorage: AuthStorage;
  readonly secretResolver: GhostSecretContext;
  private readonly credentialStore: KeyringAuthCredentialStore;
  private readonly providerConfigAccounts: ReadonlyMap<string, ReadonlySet<string>>;

  private constructor(
    authStorage: AuthStorage,
    modelRegistry: ModelRegistry,
    credentialStore: KeyringAuthCredentialStore,
    secretResolver: GhostSecretContext,
    providerConfigAccounts: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.credentialStore = credentialStore;
    this.secretResolver = secretResolver;
    this.providerConfigAccounts = providerConfigAccounts;
  }

  static async create(input: RuntimeInput): Promise<GhostOmpRuntime> {
    const agentDir = dirname(input.authPath);
    mkdirSync(agentDir, { recursive: true });
    const home = dirname(input.modelsPath);
    const secretResolver = openGhostSecretContext({ home, authPath: input.authPath });
    const credentialStore = new KeyringAuthCredentialStore(secretResolver, {
      authorizeAccounts: accounts => authorizeGhostAccounts(home, secretResolver, accounts),
    });
    const authStorage = new AuthStorage(credentialStore, {
      sourceLabel: "Ghost Linux Secret Service",
    });
    try {
      await authStorage.reload();

      const models = readGhostModels(home) ?? { providers: {} };
      const ompModelsPath = syncModelsView(models, agentDir, OMP_MODELS_VIEW, { legacyKeylessAuth: true });
      const modelRegistry = new ModelRegistry(authStorage, ompModelsPath, {
        ...(input.settings ? { settings: input.settings } : {}),
        cacheDbPath: join(agentDir, "models.db"),
      });
      const providerConfigAccounts = new Map<string, ReadonlySet<string>>();
      for (const registration of collectKeyringProviders(models, secretResolver, authStorageProvider)) {
        modelRegistry.registerProvider(registration.provider, registration.config, "ghost-keyring");
        if (registration.accounts.size > 0) {
          providerConfigAccounts.set(registration.provider, registration.accounts);
        }
      }
      await modelRegistry.hydrateCredentialScopedModelCaches();
      await modelRegistry.refresh(input.allowModelNetwork ? "online-if-uncached" : "offline");
      return new GhostOmpRuntime(
        authStorage,
        modelRegistry,
        credentialStore,
        secretResolver,
        providerConfigAccounts,
      );
    } catch (error) {
      authStorage.close();
      throw error;
    }
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
    const storageProvider = authStorageProvider(providerId);
    return {
      configured: Boolean(model && this.modelRegistry.hasConfiguredAuth(model))
        || this.authStorage.hasAuth(providerId)
        || this.authStorage.hasAuth(storageProvider),
    };
  }

  hasConfiguredAuth(providerId: string): boolean {
    return this.getProviderAuthStatus(providerId).configured;
  }

  isUsingSubscription(providerId: string): boolean {
    return SUBSCRIPTION_PROVIDERS.has(providerId) && this.isUsingOAuth(providerId);
  }

  isUsingOAuth(providerId: string): boolean {
    return this.authStorage.hasOAuth(providerId)
      || this.authStorage.hasOAuth(authStorageProvider(providerId));
  }

  getProviderAccounts(providerId: string) {
    return mergeConfiguredAccounts(
      this.credentialStore.listProviderAccounts(authStorageProvider(providerId)),
      this.providerConfigAccounts.get(providerId) ?? new Set(),
    );
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
    account = "personal",
  ): Promise<Credential> {
    const storageProvider = authStorageProvider(providerId);
    const accountName = providerAccountName(providerId, account, authStorageProvider);
    // Make the selected row visible to this short-lived login runtime before
    // AuthStorage rebuilds its snapshot. Durable policy is written only after
    // the flow succeeds, against the ghost's current (possibly renamed) home.
    this.credentialStore.allowAccounts([accountName]);
    this.credentialStore.setWriteAccount(storageProvider, account);
    try {
      if (type === "api_key") {
        const key = await interaction.prompt({
          type: "secret",
          message: `Paste the API key for ${providerName(providerId)}`,
          placeholder: "API key",
          signal: interaction.signal,
        });
        if (!key) throw new Error("No API key was entered.");
        const credential: Credential = { type: "api_key", key };
        await this.authStorage.set(storageProvider, credential);
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
      const stored = this.authStorage.get(providerId) ?? this.authStorage.get(storageProvider);
      if (!stored) throw new Error(`OMP completed ${providerId} login without storing a credential.`);
      return stored;
    } finally {
      this.credentialStore.clearWriteAccount();
    }
  }

  authorizeAccount(providerId: string, account: string, home: string): void {
    const accountName = providerAccountName(providerId, account, authStorageProvider);
    authorizeGhostAccounts(home, this.secretResolver, [accountName]);
    this.credentialStore.allowAccounts([accountName]);
  }

  async logout(providerId: string, account: string): Promise<void> {
    const storageProvider = authStorageProvider(providerId);
    this.secretResolver.assertAccountAuthorized(
      providerAccountName(providerId, account, authStorageProvider),
      "logout",
    );
    this.credentialStore.setWriteAccount(storageProvider, account);
    try {
      await this.authStorage.remove(storageProvider);
    } finally {
      this.credentialStore.clearWriteAccount();
    }
  }

  close(): void {
    this.authStorage.close();
  }
}

export async function createGhostOmpRuntime(input: RuntimeInput): Promise<GhostOmpRuntime> {
  return GhostOmpRuntime.create(input);
}
