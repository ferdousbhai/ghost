/**
 * Ghost's Linux Secret Service credentials, presented as pi's `CredentialStore`.
 *
 * pi keeps one credential per provider and serializes refreshes through
 * `modify`. Ghost keeps several keyring accounts per provider and lets a
 * ghost's `models.json` choose which of them a session may see; this store
 * presents the first allowed account as the provider's credential, writes a
 * login to the account the caller selected, and fences concurrent refreshes
 * across processes with the metadata database's refresh leases.
 */
import { randomUUID } from "node:crypto";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { Credential as AuthCredential } from "@earendil-works/pi-ai";
import {
  credentialData,
  validateAuthCredential,
  type CredentialRow,
  type GhostSecretContext,
  type ProviderAccountStatus,
} from "./keyring-credential-store.js";
import { serializeByKey } from "./promise-chain.js";
import {
  parseSecretAccountName,
  secretAccountName,
  serviceForCredentialProvider,
  type SecretAccountRef,
} from "./secret-reference.js";

const CREDENTIAL_FIELD = "auth";
const REFRESH_LEASE_MS = 60_000;
const LEASE_POLL_MS = 100;

export class GhostPiCredentialStore implements CredentialStore {
  private readonly context: GhostSecretContext;
  private readonly authorizeAccounts: ((accounts: readonly string[]) => void) | undefined;
  private writeAccount: SecretAccountRef | undefined;
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Decoded secrets by row id, valid for one metadata revision: pi reads per request and a keyring read spawns a process. */
  private readonly cache = new Map<number, { revision: number; credential: AuthCredential }>();

  constructor(
    context: GhostSecretContext,
    options: { authorizeAccounts?: (accounts: readonly string[]) => void } = {},
  ) {
    this.context = context;
    this.authorizeAccounts = options.authorizeAccounts;
  }

  /** Direct the next login or logout at one explicit account. */
  setWriteAccount(provider: string, account: string): void {
    this.writeAccount = parseSecretAccountName(`${serviceForCredentialProvider(provider)}/${account}`);
  }

  clearWriteAccount(): void {
    this.writeAccount = undefined;
  }

  allowAccounts(accounts: readonly string[]): void {
    this.context.allowAccounts(accounts);
  }

  listProviderAccounts(provider: string): ProviderAccountStatus[] {
    return this.context.listProviderAccounts(provider);
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    const row = this.currentRow(providerId);
    return row ? this.credentialForRow(row) : undefined;
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const byProvider = new Map<string, CredentialInfo>();
    for (const row of this.context.allowedCredentialRows()) {
      if (!byProvider.has(row.provider)) {
        byProvider.set(row.provider, { providerId: row.provider, type: row.credential_type });
      }
    }
    return [...byProvider.values()];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, () => this.modifyLocked(providerId, fn));
  }

  delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      const accounts = this.writeAccount
        ? [this.writeAccount]
        : this.context.allowedProviderAccounts(providerId);
      for (const account of accounts) this.context.removeAccount(account);
    });
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    return serializeByKey(this.chains, providerId, task);
  }

  /**
   * pi's contract: `fn` returning `undefined` leaves the credential as it is
   * (that is what its refresh path returns for a still-valid token); removal
   * goes through `delete`.
   */
  private async modifyLocked(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const row = this.currentRow(providerId);
    if (!row) {
      const next = await fn(undefined);
      if (next !== undefined) this.store(providerId, next);
      return next;
    }

    // A refresh may take a network round trip, so the metadata transaction
    // cannot span it. The lease keeps two processes from refreshing the same
    // token at once; a lost fence means another writer already stored a newer
    // credential, which is the one to return.
    const owner = randomUUID();
    const current = this.credentialForRow(row);
    if (!this.context.tryAcquireRefreshLease(row.id, owner, Date.now() + REFRESH_LEASE_MS)) {
      await this.waitForLease(row.id);
      return this.read(providerId);
    }
    try {
      const next = await fn(current);
      if (next === undefined) return current;
      const checked = validateAuthCredential(next);
      if (credentialData(checked) === credentialData(current)) return current;
      const written = this.context.tryUpdateCredential(
        row.id,
        credentialData(current),
        checked,
        { owner, nowMs: Date.now() },
      );
      return written ? next : this.read(providerId);
    } finally {
      this.context.releaseRefreshLease(row.id, owner);
    }
  }

  private store(providerId: string, credential: Credential): void {
    const account = this.writeAccount
      ?? this.context.allowedProviderAccounts(providerId)[0]
      ?? { service: serviceForCredentialProvider(providerId), account: "personal" };
    if (this.writeAccount && this.writeAccount.service !== serviceForCredentialProvider(providerId)) {
      throw new Error(`A login may write only a ${providerId} account.`);
    }
    this.context.registerCredential(
      providerId,
      { ...account, field: CREDENTIAL_FIELD },
      validateAuthCredential(credential),
    );
    const name = secretAccountName(account);
    if (this.writeAccount || this.context.allowedAccounts.has(name)) return;
    this.authorizeAccounts?.([name]);
    this.context.allowAccounts([name]);
  }

  private currentRow(providerId: string): CredentialRow | undefined {
    const rows = this.context.allowedCredentialRows(providerId);
    const selected = this.writeAccount;
    if (!selected) return rows[0];
    return rows.find((row) => row.service === selected.service && row.account === selected.account);
  }

  private credentialForRow(row: CredentialRow): AuthCredential {
    const revision = this.context.metadata.revision();
    const cached = this.cache.get(row.id);
    if (cached && cached.revision === revision) return cached.credential;
    const credential = this.context.credentialForRow(row);
    this.cache.set(row.id, { revision, credential });
    return credential;
  }

  private async waitForLease(id: number): Promise<void> {
    for (;;) {
      const expiresAt = this.context.refreshLeaseExpiresAt(id);
      if (expiresAt === undefined || expiresAt <= Date.now()) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(LEASE_POLL_MS, expiresAt - Date.now())));
    }
  }
}
