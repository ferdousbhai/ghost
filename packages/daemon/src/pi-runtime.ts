/**
 * Ghost's model runtime on official pi.
 *
 * Composes pi's `ModelRuntime` with the ghost's `models.json` and pi's own
 * file-backed credential store under the ghost's `.pi/auth.json`. pi owns
 * providers, OAuth flows, token refresh, streaming, subscription
 * classification, and the catalog; Ghost owns only which models a ghost binds.
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
import { syncModelsView } from "./model-config-view.js";
import { readGhostModels } from "./models.js";

const PI_MODELS_VIEW = "models.pi.json";
const NETWORK_REFRESH_TIMEOUT_MS = 15_000;

export interface GhostPiRuntimeInput {
  /** Directory for pi's derived runtime state: the models view, catalog cache, and `auth.json`. */
  agentDir: string;
  /** The ghost home holding `models.json`. */
  home: string;
  allowModelNetwork: boolean;
  /** pi's credential file; defaults to `auth.json` under `agentDir`. */
  authPath?: string;
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
  /** pi's own runtime, for the session that streams through it. */
  readonly runtime: ModelRuntime;
  private constructor(runtime: ModelRuntime) {
    this.runtime = runtime;
  }

  static async create(input: GhostPiRuntimeInput): Promise<GhostPiRuntime> {
    mkdirSync(input.agentDir, { recursive: true });
    const models = readGhostModels(input.home) ?? { providers: {} };
    const runtime = await ModelRuntime.create({
      authPath: input.authPath ?? join(input.agentDir, "auth.json"),
      modelsPath: syncModelsView(models, input.agentDir, PI_MODELS_VIEW),
      modelsStorePath: join(input.agentDir, "models-store.json"),
      refreshOnCreate: false,
    });
    await runtime.refresh({
      allowNetwork: input.allowModelNetwork,
      ...(input.allowModelNetwork ? { signal: AbortSignal.timeout(NETWORK_REFRESH_TIMEOUT_MS) } : {}),
    });
    return new GhostPiRuntime(runtime);
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

  /** The availability pass the last `refresh` computed; no provider work. */
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

  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    return this.runtime.login(providerId, type, interaction);
  }

  logout(providerId: string): Promise<void> {
    return this.runtime.logout(providerId);
  }

  /** pi's runtime holds no external handle; kept so callers keep one lifecycle shape. */
  close(): void {}
}

/** The paths every daemon caller already holds, resolved to a runtime input. */
export function createGhostPiRuntime(input: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
}): Promise<GhostPiRuntime> {
  return GhostPiRuntime.create({
    agentDir: dirname(input.authPath),
    home: dirname(input.modelsPath),
    authPath: input.authPath,
    allowModelNetwork: input.allowModelNetwork,
  });
}
