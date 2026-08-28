/**
 * The runtime-neutral half of a Ghost model runtime: how a ghost's
 * `models.json` is projected into the file the hosting runtime reads, how its
 * keyring references are resolved into in-memory provider registrations, and
 * how account policy is reported. Both the OMP and the pi runtime compose this.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GhostSecretContext, ProviderAccountStatus } from "./keyring-credential-store.js";
import type { GhostModelsFile, GhostProviderConfig } from "./models.js";
import { atomicPrivateJson } from "./secret-migration.js";
import {
  isSecretReference,
  parseSecretReference,
  secretAccountName,
  serviceForCredentialProvider,
} from "./secret-reference.js";
import { resolveProviderSecrets } from "./secret-resolution.js";

export const KEYRING_PLACEHOLDER = "ghost-keyring-reference";

/** Maps a provider id to the id its credentials are stored under. */
export type StorageProviderFor = (providerId: string) => string;

export const sameStorageProvider: StorageProviderFor = (providerId) => providerId;

export interface ModelsViewOptions {
  /** Treat an omitted key on a custom endpoint with models as keyless (`auth: "none"`). */
  legacyKeylessAuth?: boolean;
}

function placeholderFor(value: unknown): unknown {
  return typeof value === "string" && isSecretReference(value) ? KEYRING_PLACEHOLDER : value;
}

/**
 * The `models.json` a runtime reads: the ghost's provider entries with every
 * keyring reference replaced by a placeholder. Real values are registered in
 * memory through {@link collectKeyringProviders} and never reach this file.
 */
export function keyringModelsDocument(
  models: GhostModelsFile,
  options: ModelsViewOptions = {},
): { providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  for (const [provider, raw] of Object.entries(models.providers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const { name: _ghostDisplayName, ...config } = raw;
    config.apiKey = placeholderFor(config.apiKey) as string | undefined;
    if (config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)) {
      config.headers = Object.fromEntries(
        Object.entries(config.headers).map(([name, header]) => [name, placeholderFor(header)]),
      ) as Record<string, string>;
    }
    if (
      options.legacyKeylessAuth
      && Array.isArray(config.models)
      && config.models.length > 0
      && config.apiKey === undefined
      && config.auth === undefined
    ) {
      config.auth = "none";
    }
    providers[provider] = config;
  }
  return { providers };
}

/** Write the projected view under `agentDir` when it changed; returns its path. */
export function syncModelsView(
  models: GhostModelsFile,
  agentDir: string,
  filename: string,
  options: ModelsViewOptions = {},
): string {
  const target = join(agentDir, filename);
  const document = keyringModelsDocument(models, options);
  const rendered = `${JSON.stringify(document, null, 2)}\n`;
  if (!existsSync(target) || readFileSync(target, "utf8") !== rendered) {
    atomicPrivateJson(target, document);
  }
  return target;
}

export interface KeyringProviderRegistration {
  provider: string;
  /** The provider's own accounts its configuration names. */
  accounts: ReadonlySet<string>;
  config: Pick<GhostProviderConfig, "apiKey" | "headers">;
}

/**
 * Resolve each provider whose configuration names keyring references into
 * the values a runtime registers in memory.
 */
export function collectKeyringProviders(
  models: GhostModelsFile,
  resolver: GhostSecretContext,
  storageProviderFor: StorageProviderFor = sameStorageProvider,
): KeyringProviderRegistration[] {
  const registrations: KeyringProviderRegistration[] = [];
  for (const [provider, config] of Object.entries(models.providers)) {
    const references = [config.apiKey, ...Object.values(config.headers ?? {})]
      .filter((value): value is string => typeof value === "string" && isSecretReference(value))
      .map(parseSecretReference);
    if (references.length === 0) continue;
    const service = serviceForCredentialProvider(storageProviderFor(provider));
    const resolved = resolveProviderSecrets(config, resolver);
    registrations.push({
      provider,
      accounts: new Set(references.filter((ref) => ref.service === service).map((ref) => ref.account)),
      config: {
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
      },
    });
  }
  return registrations;
}

export function providerAccountName(
  providerId: string,
  account: string,
  storageProviderFor: StorageProviderFor = sameStorageProvider,
): string {
  return secretAccountName({
    service: serviceForCredentialProvider(storageProviderFor(providerId)),
    account,
  });
}

/**
 * Keyring account rows plus the accounts `models.json` names for the
 * provider. A named account is configured even when the keyring holds only a
 * plain secret for it rather than a login credential row.
 */
export function mergeConfiguredAccounts(
  rows: readonly ProviderAccountStatus[],
  configured: ReadonlySet<string>,
): ProviderAccountStatus[] {
  const byAccount = new Map(rows.map((row) => [row.account, row]));
  for (const account of configured) {
    const row = byAccount.get(account);
    byAccount.set(account, {
      account,
      configured: true,
      connectedVia: row?.connectedVia ?? "api_key",
    });
  }
  return [...byAccount.values()];
}
