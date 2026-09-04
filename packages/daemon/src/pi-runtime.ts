/**
 * Ghost's model runtime on official pi.
 *
 * Composes pi's `ModelRuntime` with Ghost's Secret Service credential store
 * and the ghost's `models.json`. Ghost owns which keyring accounts a ghost may
 * use and the login/logout account selection; pi owns providers, OAuth flows,
 * token refresh, streaming, subscription classification, and the catalog.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AuthInteraction,
  AuthType,
  Context,
  Credential,
  Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GhostSecretContext, ProviderAccountStatus } from "./keyring-credential-store.js";
import {
  detectLocalModelProviders,
  withLocalProviders,
  type DetectedLocalProvider,
  type LocalRunner,
} from "./local-models.js";
import {
  collectKeyringProviders,
  mergeConfiguredAccounts,
  providerAccountName,
  syncModelsView,
} from "./model-config-view.js";
import { readGhostModels } from "./models.js";
import { GhostPiCredentialStore } from "./pi-credential-store.js";
import {
  authorizeGhostAccounts,
  openGhostSecretContext,
} from "./secret-migration.js";
import type { SecretServiceClient } from "./secret-service.js";

const PI_MODELS_VIEW = "models.pi.json";
const NETWORK_REFRESH_TIMEOUT_MS = 15_000;

export interface GhostPiRuntimeInput {
  /** Directory for pi's derived runtime state: the models view and catalog cache. */
  agentDir: string;
  /** The ghost home holding `models.json`. */
  home: string;
  allowModelNetwork: boolean;
  /** Offline skips local-endpoint detection along with the catalog refresh. */
  offline?: boolean;
  /** Test seams: the legacy plaintext auth file the keyring migration retires, and the Secret Service boundary. */
  authPath?: string;
  client?: SecretServiceClient;
  metadataPath?: string;
  localRunners?: readonly LocalRunner[];
}

export interface GhostProviderSummary {
  id: string;
  name: string;
  auth: {
    oauth?: { isSubscription?: boolean; loginLabel?: string };
    apiKey?: { login?: unknown };
  };
}

export class GhostPiRuntime {
  readonly secretResolver: GhostSecretContext;
  /** pi's own runtime, for the session that streams through it. */
  readonly runtime: ModelRuntime;
  /** Local endpoints this runtime's own detection pass found, in preference order. */
  readonly localProviders: readonly DetectedLocalProvider[];
  private readonly credentialStore: GhostPiCredentialStore;
  private readonly providerConfigAccounts: ReadonlyMap<string, ReadonlySet<string>>;
  private closed = false;

  private constructor(
    runtime: ModelRuntime,
    credentialStore: GhostPiCredentialStore,
    secretResolver: GhostSecretContext,
    providerConfigAccounts: ReadonlyMap<string, ReadonlySet<string>>,
    localProviders: readonly DetectedLocalProvider[],
  ) {
    this.runtime = runtime;
    this.credentialStore = credentialStore;
    this.secretResolver = secretResolver;
    this.providerConfigAccounts = providerConfigAccounts;
    this.localProviders = localProviders;
  }

  static async create(input: GhostPiRuntimeInput): Promise<GhostPiRuntime> {
    mkdirSync(input.agentDir, { recursive: true });
    const secretResolver = openGhostSecretContext({
      home: input.home,
      authPath: input.authPath ?? join(input.agentDir, "auth.json"),
      ...(input.client ? { client: input.client } : {}),
      ...(input.metadataPath ? { metadataPath: input.metadataPath } : {}),
    });
    try {
      const credentialStore = new GhostPiCredentialStore(secretResolver, {
        authorizeAccounts: (accounts) => authorizeGhostAccounts(input.home, secretResolver, accounts),
      });
      const models = readGhostModels(input.home) ?? { providers: {} };
      // The detection pass rides this runtime's catalog refresh: a local
      // endpoint reaches pi as an ordinary provider, and nothing is persisted.
      const localProviders = await detectLocalModelProviders({
        offline: input.offline ?? false,
        ...(input.localRunners ? { runners: input.localRunners } : {}),
      });
      const runtime = await ModelRuntime.create({
        credentials: credentialStore,
        modelsPath: syncModelsView(withLocalProviders(models, localProviders), input.agentDir, PI_MODELS_VIEW),
        modelsStorePath: join(input.agentDir, "models-store.json"),
        // One catalog pass, after the keyring providers are registered.
        refreshOnCreate: false,
      });
      const providerConfigAccounts = new Map<string, ReadonlySet<string>>();
      for (const registration of collectKeyringProviders(models, secretResolver)) {
        runtime.registerProvider(registration.provider, registration.config);
        if (registration.accounts.size > 0) {
          providerConfigAccounts.set(registration.provider, registration.accounts);
        }
      }
      await runtime.refresh({
        allowNetwork: input.allowModelNetwork,
        ...(input.allowModelNetwork ? { signal: AbortSignal.timeout(NETWORK_REFRESH_TIMEOUT_MS) } : {}),
      });
      return new GhostPiRuntime(
        runtime,
        credentialStore,
        secretResolver,
        providerConfigAccounts,
        localProviders,
      );
    } catch (error) {
      secretResolver.close();
      throw error;
    }
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    return this.runtime.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.runtime.getModel(providerId, modelId);
  }

  getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
    return this.runtime.getAvailable(providerId);
  }

  /** The availability pass the last `refresh` computed; no provider or keyring work. */
  getAvailableSnapshot(): readonly Model<Api>[] {
    return this.runtime.getAvailableSnapshot();
  }

  getProviderAuthStatus(providerId: string): { configured: boolean } {
    return this.runtime.getProviderAuthStatus(providerId);
  }

  hasConfiguredAuth(providerId: string): boolean {
    return this.runtime.hasConfiguredAuth(providerId);
  }

  isUsingOAuth(providerId: string): boolean {
    return this.runtime.isUsingOAuth(providerId);
  }

  isUsingSubscription(providerId: string): boolean {
    return this.runtime.isUsingSubscription(providerId);
  }

  getProviderAccounts(providerId: string): ProviderAccountStatus[] {
    return mergeConfiguredAccounts(
      this.credentialStore.listProviderAccounts(providerId),
      this.providerConfigAccounts.get(providerId) ?? new Set(),
    );
  }

  complete(
    model: Model<Api>,
    context: Context,
    options: { signal?: AbortSignal } = {},
  ): Promise<AssistantMessage> {
    return this.runtime.completeSimple(model, context, options.signal ? { signal: options.signal } : {});
  }

  getProviders(): GhostProviderSummary[] {
    return this.runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      auth: {
        ...(provider.auth.oauth
          ? {
              oauth: {
                isSubscription: provider.auth.oauth.isSubscription ?? false,
                loginLabel: provider.auth.oauth.loginLabel ?? `Sign in with ${provider.auth.oauth.name}`,
              },
            }
          : {}),
        ...(provider.auth.apiKey ? { apiKey: { login: true } } : {}),
      },
    }));
  }

  async login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
    account = "personal",
  ): Promise<Credential> {
    // The selected account becomes visible to this login before pi stores into
    // it; durable policy is the caller's `authorizeAccount` once the flow succeeds.
    this.credentialStore.allowAccounts([providerAccountName(providerId, account)]);
    this.credentialStore.setWriteAccount(providerId, account);
    try {
      return await this.runtime.login(providerId, type, interaction);
    } finally {
      this.credentialStore.clearWriteAccount();
    }
  }

  authorizeAccount(providerId: string, account: string, home: string): void {
    const accountName = providerAccountName(providerId, account);
    authorizeGhostAccounts(home, this.secretResolver, [accountName]);
    this.credentialStore.allowAccounts([accountName]);
  }

  async logout(providerId: string, account: string): Promise<void> {
    this.secretResolver.assertAccountAuthorized(providerAccountName(providerId, account), "logout");
    this.credentialStore.setWriteAccount(providerId, account);
    try {
      await this.runtime.logout(providerId);
    } finally {
      this.credentialStore.clearWriteAccount();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.secretResolver.close();
  }
}

/** The paths every daemon caller already holds, resolved to a runtime input. */
export function createGhostPiRuntime(input: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
  offline?: boolean;
}): Promise<GhostPiRuntime> {
  return GhostPiRuntime.create({
    agentDir: dirname(input.authPath),
    home: dirname(input.modelsPath),
    authPath: input.authPath,
    allowModelNetwork: input.allowModelNetwork,
    ...(input.offline === undefined ? {} : { offline: input.offline }),
  });
}
