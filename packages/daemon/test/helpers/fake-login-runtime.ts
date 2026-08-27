/**
 * A fake `LoginRuntime` whose `login()` is scripted per test, so the login
 * state machine can be walked through every callback path (url, device code,
 * paste, select, failure, timeout) without a real provider or a network call.
 */
import type {
  AuthInteraction,
  AuthType,
  Credential,
  LoginRuntime,
} from "../../src/auth.js";
import { fakeOmpModel } from "./fake-catalog-runtime.js";

export type LoginImpl = (
  providerId: string,
  authType: AuthType,
  interaction: AuthInteraction,
  account?: string,
) => Promise<Credential>;

export interface FakeProvider {
  id: string;
  name: string;
  oauth?: { isSubscription?: boolean; loginLabel?: string };
  apiKeyLogin?: boolean;
  configured?: boolean;
  usingOAuth?: boolean;
}

/** A realistic-enough registry: two subscription OAuth providers, one keyed. */
export const DEFAULT_FAKE_PROVIDERS: FakeProvider[] = [
  { id: "openai-codex", name: "OpenAI Codex", oauth: { isSubscription: true } },
  { id: "anthropic", name: "Anthropic", oauth: { isSubscription: true }, apiKeyLogin: true },
  {
    id: "openrouter",
    name: "OpenRouter",
    oauth: { isSubscription: false, loginLabel: "Sign in with OpenRouter" },
    apiKeyLogin: true,
  },
  // Ambient-only: no oauth, no interactive api-key login. Must be filtered out.
  { id: "amazon-bedrock", name: "Amazon Bedrock" },
];

export interface FakeRuntimeOptions {
  login: LoginImpl;
  providers?: FakeProvider[];
  /** Models each provider reports available; drives default-model binding. */
  models?: Record<string, string[]>;
}

export function makeFakeRuntime(options: FakeRuntimeOptions): LoginRuntime {
  const providers = options.providers ?? DEFAULT_FAKE_PROVIDERS;
  const models = options.models ?? {};
  return {
    getProviders() {
      return providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        auth: {
          ...(provider.oauth ? { oauth: provider.oauth } : {}),
          ...(provider.apiKeyLogin ? { apiKey: { login: () => undefined } } : {}),
        },
      }));
    },
    getProviderAuthStatus(providerId) {
      return { configured: providers.find((p) => p.id === providerId)?.configured ?? false };
    },
    isUsingOAuth(providerId) {
      return providers.find((p) => p.id === providerId)?.usingOAuth ?? false;
    },
    getModels(providerId) {
      return (models[providerId ?? ""] ?? []).map((id) => fakeOmpModel({
        provider: providerId ?? "",
        id,
      }));
    },
    async getAvailable(providerId) {
      return (models[providerId ?? ""] ?? []).map((id) => fakeOmpModel({
        provider: providerId ?? "",
        id,
      }));
    },
    login: options.login,
  };
}

/** A resolvable barrier a scripted login can wait on so a test can observe an
 *  intermediate state before letting the flow finish. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function oauthCredential(): Credential {
  return { type: "oauth", refresh: "fake-refresh", access: "fake-access", expires: Date.now() + 3_600_000 };
}

export function apiKeyCredential(): Credential {
  return { type: "api_key", key: "fake-key" };
}
