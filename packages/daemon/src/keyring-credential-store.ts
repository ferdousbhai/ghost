/** Machine-wide Ghost credential store backed by Linux Secret Service. */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AuthCredential,
  AuthCredentialStore,
  CredentialRefreshLeaseFence,
  StoredAuthCredential,
  StoredCredentialBlock,
} from "@oh-my-pi/pi-ai/auth-storage";
import {
  assertSecretReference,
  formatSecretReference,
  parseSecretAccountName,
  parseSecretReference,
  secretAccountName,
  serviceForCredentialProvider,
  type SecretAccountRef,
  type SecretReference,
} from "./secret-reference.js";
import {
  createSecretServiceClient,
  SecretServiceError,
  type SecretServiceClient,
} from "./secret-service.js";

const SECRET_METADATA_FILENAME = "keyring-metadata.sqlite";
const SECRET_ENVELOPE_VERSION = 1;
const SECRET_ENVELOPE_MAX_BYTES = 1_048_576;

interface SecretEnvelope {
  version: 1;
  fields: Record<string, unknown>;
}

const CREDENTIAL_ROW_COLUMNS = "id, provider, service, account, field, credential_type, active";

export interface CredentialRow {
  id: number;
  provider: string;
  service: string;
  account: string;
  field: string;
  credential_type: "api_key" | "oauth";
  active: number;
}

interface CacheRow {
  value: string;
  expires_at_sec: number;
}

function defaultSecretMetadataPath(): string {
  const configured = process.env.XDG_STATE_HOME;
  const stateHome = configured && configured.length > 0
    ? configured
    : join(homedir(), ".local", "state");
  return join(stateHome, "ghost", SECRET_METADATA_FILENAME);
}

function ensurePrivateStatePath(path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStats = lstatSync(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new SecretServiceError(
      "keyring_unavailable",
      `Ghost credential metadata directory ${parent} is not a real directory.`,
    );
  }
  chmodSync(parent, 0o700);
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new SecretServiceError(
        "keyring_unavailable",
        `Ghost credential metadata ${path} must be a single-link regular file.`,
      );
    }
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseEnvelope(raw: string, ref: SecretAccountRef): SecretEnvelope {
  if (Buffer.byteLength(raw, "utf8") > SECRET_ENVELOPE_MAX_BYTES) {
    throw new SecretServiceError(
      "keyring_unavailable",
      `Ghost keyring item ${secretAccountName(ref)} exceeds the 1 MiB limit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretServiceError(
      "keyring_unavailable",
      `Ghost keyring item ${secretAccountName(ref)} is not valid Ghost secret data.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || record.version !== SECRET_ENVELOPE_VERSION
    || !record.fields
    || typeof record.fields !== "object"
    || Array.isArray(record.fields)) {
    throw new SecretServiceError(
      "keyring_unavailable",
      `Ghost keyring item ${secretAccountName(ref)} has an unsupported schema.`,
    );
  }
  for (const field of Object.keys(record.fields as Record<string, unknown>)) {
    assertSecretReference(ref, field);
  }
  return { version: 1, fields: record.fields as Record<string, unknown> };
}

function renderEnvelope(envelope: SecretEnvelope): string {
  const rendered = JSON.stringify(envelope);
  if (Buffer.byteLength(rendered, "utf8") > SECRET_ENVELOPE_MAX_BYTES) {
    throw new SecretServiceError(
      "keyring_unavailable",
      "Ghost refused to write a keyring item larger than 1 MiB.",
    );
  }
  return rendered;
}

function credentialData(credential: AuthCredential): string {
  if (credential.type === "api_key") {
    return JSON.stringify(credential.source === "login"
      ? { key: credential.key, source: "login" }
      : { key: credential.key });
  }
  const { type: _type, ...data } = credential;
  return JSON.stringify(data);
}

const API_KEY_CREDENTIAL_FIELDS = new Set(["type", "key", "source"]);
const OAUTH_CREDENTIAL_FIELDS = new Set([
  "type",
  "refresh",
  "access",
  "expires",
  "enterpriseUrl",
  "projectId",
  "email",
  "accountId",
  "apiEndpoint",
  "orgId",
  "orgName",
  "authorizedAt",
]);
const OAUTH_STRING_FIELDS = [
  "enterpriseUrl",
  "projectId",
  "email",
  "accountId",
  "apiEndpoint",
  "orgId",
  "orgName",
] as const;

export function validateAuthCredential(value: unknown): AuthCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecretServiceError("keyring_unavailable", "A Ghost keyring credential is malformed.");
  }
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key"
    && Object.keys(credential).every((key) => API_KEY_CREDENTIAL_FIELDS.has(key))
    && typeof credential.key === "string"
    && credential.key.length > 0) {
    if (credential.source !== undefined && credential.source !== "login") {
      throw new SecretServiceError("keyring_unavailable", "A Ghost keyring API-key credential is malformed.");
    }
    return credential as AuthCredential;
  }
  if (credential.type === "oauth"
    && Object.keys(credential).every((key) => OAUTH_CREDENTIAL_FIELDS.has(key))
    && typeof credential.access === "string"
    && typeof credential.refresh === "string"
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires)
    && OAUTH_STRING_FIELDS.every((field) =>
      credential[field] === undefined || typeof credential[field] === "string")
    && (credential.authorizedAt === undefined
      || (typeof credential.authorizedAt === "number" && Number.isFinite(credential.authorizedAt)))) {
    return credential as AuthCredential;
  }
  throw new SecretServiceError("keyring_unavailable", "A Ghost keyring credential is malformed.");
}

/**
 * Parse one portable reference and refuse it unless `allowed` names its
 * account.
 *
 * Migration and connection-time resolution check the same rule against
 * different allow-sets — migration validates a pre-existing reference against
 * the policy as written, before its own writes widen it — so the set is a
 * parameter while the two refusals stay a single definition.
 */
export function authorizedSecretReference(
  reference: string,
  allowed: ReadonlySet<string>,
): SecretReference {
  let ref: SecretReference;
  try {
    ref = parseSecretReference(reference);
  } catch {
    throw new SecretServiceError(
      "invalid_secret_reference",
      "Ghost encountered a malformed keyring reference in portable configuration.",
      400,
    );
  }
  const account = secretAccountName(ref);
  if (!allowed.has(account)) {
    throw new SecretServiceError(
      "secret_not_authorized",
      `Ghost policy does not allow keyring account ${account}; add it to models.json "accounts" before retrying.`,
      403,
    );
  }
  return ref;
}

export class SecretMetadata {
  readonly db: Database;

  constructor(path: string) {
    ensurePrivateStatePath(path);
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ghost_keyring_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO ghost_keyring_meta(key, value) VALUES ('revision', 0);
      CREATE TABLE IF NOT EXISTS ghost_keyring_references (
        service TEXT NOT NULL,
        account TEXT NOT NULL,
        field TEXT NOT NULL,
        purpose TEXT NOT NULL,
        PRIMARY KEY(service, account, field)
      );
      CREATE TABLE IF NOT EXISTS ghost_auth_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        service TEXT NOT NULL,
        account TEXT NOT NULL,
        field TEXT NOT NULL,
        credential_type TEXT NOT NULL CHECK(credential_type IN ('api_key', 'oauth')),
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        UNIQUE(provider, service, account, field)
      );
      CREATE TABLE IF NOT EXISTS ghost_auth_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at_sec INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ghost_credential_blocks (
        credential_id INTEGER NOT NULL,
        provider_key TEXT NOT NULL,
        block_scope TEXT NOT NULL,
        blocked_until_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(credential_id, provider_key, block_scope)
      );
      CREATE TABLE IF NOT EXISTS ghost_refresh_leases (
        credential_id INTEGER PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ghost_migration_leases (
        home TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ghost_literal_account_reservations (
        service TEXT NOT NULL,
        account TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(service, account)
      );
    `);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  bumpRevision(): void {
    this.db.query("UPDATE ghost_keyring_meta SET value = value + 1 WHERE key = 'revision'").run();
  }

  revision(): number {
    const row = this.db.query("SELECT value FROM ghost_keyring_meta WHERE key = 'revision'")
      .get() as { value: number } | null;
    return row?.value ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

/** One opened Secret Service + metadata boundary. It never discovers items. */
export class GhostSecretContext {
  readonly client: SecretServiceClient;
  readonly metadata: SecretMetadata;
  readonly allowedAccounts: Set<string>;
  private readonly literalReservations = new Map<string, string>();

  constructor(options: {
    allowedAccounts?: readonly string[];
    client?: SecretServiceClient;
    metadataPath?: string;
  } = {}) {
    this.client = options.client ?? createSecretServiceClient();
    this.client.assertAvailable();
    this.allowedAccounts = new Set();
    this.allowAccounts(options.allowedAccounts ?? []);
    this.metadata = new SecretMetadata(options.metadataPath ?? defaultSecretMetadataPath());
  }

  allowAccounts(accounts: readonly string[]): void {
    for (const account of accounts) {
      parseSecretAccountName(account);
      this.allowedAccounts.add(account);
    }
  }

  private envelope(ref: SecretAccountRef): SecretEnvelope | null {
    const raw = this.client.read(ref);
    return raw === null ? null : parseEnvelope(raw, ref);
  }

  readField(ref: SecretReference): unknown | undefined {
    const envelope = this.envelope(ref);
    if (!envelope || !Object.hasOwn(envelope.fields, ref.field)) return undefined;
    return envelope.fields[ref.field];
  }

  private putFieldLocked(ref: SecretReference, value: unknown, purpose: string): void {
    assertSecretReference(ref, ref.field);
    const reservationOwner = this.literalReservations.get(secretAccountName(ref));
    if (reservationOwner) {
      this.metadata.db.query(`
        UPDATE ghost_literal_account_reservations SET expires_at_ms = ?
        WHERE service = ? AND account = ? AND owner = ?
      `).run(Date.now() + 30 * 60_000, ref.service, ref.account, reservationOwner);
    }
    const envelope = this.envelope(ref) ?? { version: 1, fields: {} };
    envelope.fields[ref.field] = value;
    const rendered = renderEnvelope(envelope);
    this.client.write(ref, rendered);
    const verified = this.envelope(ref);
    if (!verified || JSON.stringify(verified.fields[ref.field]) !== JSON.stringify(value)) {
      throw new SecretServiceError(
        "secret_migration_failed",
        `Ghost could not verify the keyring write for ${secretAccountName(ref)}. Plaintext sources were left untouched.`,
      );
    }
    this.metadata.db.query(`
      INSERT INTO ghost_keyring_references(service, account, field, purpose)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(service, account, field) DO UPDATE SET purpose = excluded.purpose
    `).run(ref.service, ref.account, ref.field, purpose);
  }

  putField(ref: SecretReference, value: unknown, purpose: string): void {
    this.metadata.transaction(() => {
      this.putFieldLocked(ref, value, purpose);
      this.metadata.bumpRevision();
    });
  }

  resolve(reference: string): string {
    const ref = authorizedSecretReference(reference, this.allowedAccounts);
    const value = this.readField(ref);
    if (value === undefined) {
      throw new SecretServiceError(
        "secret_reference_missing",
        `Credential reference ${reference} is absent from Ghost's keyring. Log in or restore that service/account and retry.`,
      );
    }
    if (typeof value !== "string") {
      throw new SecretServiceError(
        "keyring_unavailable",
        `Credential reference ${reference} does not contain a string value.`,
      );
    }
    return value;
  }

  /** Reuse an exact Ghost-known account, or allocate the next local label. */
  selectLiteralAccount(
    service: string,
    fields: Readonly<Record<string, string>>,
    options: { apiKey?: string; credential?: AuthCredential } = {},
  ): SecretAccountRef {
    parseSecretAccountName(`${service}/personal`);
    for (const field of Object.keys(fields)) {
      assertSecretReference({ service, account: "personal" }, field);
    }
    if (Object.keys(fields).length === 0
      && options.apiKey === undefined
      && options.credential === undefined) {
      return { service, account: "personal" };
    }
    return this.metadata.transaction(() => {
      this.metadata.db.query(
        "DELETE FROM ghost_literal_account_reservations WHERE expires_at_ms <= ?",
      ).run(Date.now());
      const activeReservations = new Set((this.metadata.db.query(`
        SELECT account FROM ghost_literal_account_reservations WHERE service = ?
      `).all(service) as Array<{ account: string }>).map((row) => row.account));
      const known = new Set<string>(activeReservations);
      for (const configured of this.allowedAccounts) {
        const ref = parseSecretAccountName(configured);
        if (ref.service === service) known.add(ref.account);
      }
      const rows = this.metadata.db.query(`
        SELECT account FROM ghost_keyring_references WHERE service = ?
        UNION SELECT account FROM ghost_auth_credentials WHERE service = ?
      `).all(service, service) as Array<{ account: string }>;
      for (const row of rows) known.add(row.account);

      const candidates = [...known].sort((left, right) => {
        if (left === "personal") return -1;
        if (right === "personal") return 1;
        return left.localeCompare(right);
      });
      const compatible = (ref: SecretAccountRef): boolean => {
        const envelope = this.envelope(ref);
        const fieldsMatch = Object.entries(fields).every(([field, value]) =>
          !envelope
          || !Object.hasOwn(envelope.fields, field)
          || envelope.fields[field] === value);
        if (!fieldsMatch) return false;
        if (!envelope || !Object.hasOwn(envelope.fields, "auth")) return true;
        const auth = validateAuthCredential(envelope.fields.auth);
        if (options.apiKey !== undefined && (auth.type !== "api_key" || auth.key !== options.apiKey)) {
          return false;
        }
        return options.credential === undefined
          || credentialData(auth) === credentialData(options.credential);
      };
      let selected: SecretAccountRef | undefined;
      for (const account of candidates) {
        if (activeReservations.has(account)) continue;
        const ref = { service, account };
        if (!compatible(ref)) continue;
        selected = ref;
        break;
      }
      if (!selected) {
        // Exact deterministic lookups are not discovery: Ghost never searches
        // the collection. They prevent metadata loss from making a later
        // migration overwrite an existing Ghost-schema item.
        for (let index = 1; ; index += 1) {
          const account = index === 1 ? "personal" : `account-${index}`;
          if (known.has(account) || activeReservations.has(account)) continue;
          const ref = { service, account };
          if (!compatible(ref)) {
            known.add(account);
            continue;
          }
          selected = ref;
          break;
        }
      }
      const owner = randomUUID();
      this.metadata.db.query(`
        INSERT INTO ghost_literal_account_reservations(service, account, owner, expires_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(selected.service, selected.account, owner, Date.now() + 30 * 60_000);
      this.literalReservations.set(secretAccountName(selected), owner);
      return selected;
    });
  }

  releaseLiteralAccount(ref: SecretAccountRef): void {
    const key = secretAccountName(ref);
    const owner = this.literalReservations.get(key);
    if (!owner) return;
    this.metadata.transaction(() => {
      this.metadata.db.query(`
        DELETE FROM ghost_literal_account_reservations
        WHERE service = ? AND account = ? AND owner = ?
      `).run(ref.service, ref.account, owner);
    });
    this.literalReservations.delete(key);
  }

  registerCredential(provider: string, ref: SecretReference, credential: AuthCredential): number {
    const checked = validateAuthCredential(credential);
    return this.metadata.transaction(() => {
      const previous = this.metadata.db.query(`
        SELECT id, active FROM ghost_auth_credentials
        WHERE provider = ? AND service = ? AND account = ? AND field = ?
      `).get(provider, ref.service, ref.account, ref.field) as { id: number; active: number } | null;
      this.putFieldLocked(ref, checked, "provider-credential");
      this.metadata.db.query(`
        INSERT INTO ghost_auth_credentials(provider, service, account, field, credential_type, active)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(provider, service, account, field)
        DO UPDATE SET credential_type = excluded.credential_type, active = 1
      `).run(provider, ref.service, ref.account, ref.field, checked.type);
      const row = this.metadata.db.query(`
        SELECT id FROM ghost_auth_credentials
        WHERE provider = ? AND service = ? AND account = ? AND field = ?
      `).get(provider, ref.service, ref.account, ref.field) as { id: number };
      if (previous?.active === 0) {
        this.metadata.db.query("DELETE FROM ghost_credential_blocks WHERE credential_id = ?")
          .run(row.id);
        this.metadata.db.query("DELETE FROM ghost_refresh_leases WHERE credential_id = ?")
          .run(row.id);
      }
      this.metadata.bumpRevision();
      return row.id;
    });
  }

  /**
   * The active row for `id`, but only while its stored secret still hashes to
   * `expectedData` and `lease` — when one is supplied — is still the live
   * refresh lease. Callers hold the metadata transaction across the check and
   * their write, so a losing writer sees `null` rather than a stale row.
   */
  private matchedCredential(
    id: number,
    expectedData: string,
    lease: CredentialRefreshLeaseFence | undefined,
  ): CredentialRow | null {
    const row = this.metadata.db.query(
      `SELECT ${CREDENTIAL_ROW_COLUMNS} FROM ghost_auth_credentials WHERE id = ?`,
    ).get(id) as CredentialRow | null;
    if (row?.active !== 1) return null;
    const current = this.readField(row);
    if (current === undefined || credentialData(validateAuthCredential(current)) !== expectedData) {
      return null;
    }
    if (lease) {
      const currentLease = this.metadata.db.query(
        "SELECT owner, expires_at_ms FROM ghost_refresh_leases WHERE credential_id = ?",
      ).get(id) as { owner: string; expires_at_ms: number } | null;
      if (currentLease?.owner !== lease.owner || currentLease.expires_at_ms <= lease.nowMs) {
        return null;
      }
    }
    return row;
  }

  tryUpdateCredential(
    id: number,
    expectedData: string,
    credential: AuthCredential,
    lease?: CredentialRefreshLeaseFence,
  ): boolean {
    const checked = validateAuthCredential(credential);
    return this.metadata.transaction(() => {
      const row = this.matchedCredential(id, expectedData, lease);
      if (!row) return false;
      this.putFieldLocked(row, checked, "provider-credential");
      this.metadata.db.query(`
        UPDATE ghost_auth_credentials SET credential_type = ?, active = 1 WHERE id = ?
      `).run(checked.type, id);
      this.metadata.bumpRevision();
      return true;
    });
  }

  tryDisableCredential(
    id: number,
    expectedData: string,
    lease?: CredentialRefreshLeaseFence,
  ): boolean {
    return this.metadata.transaction(() => {
      if (!this.matchedCredential(id, expectedData, lease)) return false;
      this.metadata.db.query("UPDATE ghost_auth_credentials SET active = 0 WHERE id = ?").run(id);
      this.metadata.bumpRevision();
      return true;
    });
  }

  removeAccount(ref: SecretAccountRef): void {
    this.metadata.transaction(() => {
      this.client.clear(ref);
      if (this.envelope(ref) !== null) {
        throw new SecretServiceError(
          "keyring_unavailable",
          `Ghost could not verify removal of ${secretAccountName(ref)} from the keyring.`,
        );
      }
      const ids = this.metadata.db.query(`
        SELECT id FROM ghost_auth_credentials WHERE service = ? AND account = ?
      `).all(ref.service, ref.account) as Array<{ id: number }>;
      for (const { id } of ids) {
        this.metadata.db.query("DELETE FROM ghost_credential_blocks WHERE credential_id = ?").run(id);
        this.metadata.db.query("DELETE FROM ghost_refresh_leases WHERE credential_id = ?").run(id);
      }
      this.metadata.db.query(`
        UPDATE ghost_auth_credentials SET active = 0 WHERE service = ? AND account = ?
      `).run(ref.service, ref.account);
      this.metadata.db.query(`
        DELETE FROM ghost_keyring_references WHERE service = ? AND account = ?
      `).run(ref.service, ref.account);
      this.metadata.bumpRevision();
    });
  }

  withMigrationLease<T>(home: string, operation: () => T): T {
    const owner = randomUUID();
    const deadline = Date.now() + 30_000;
    const sleep = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    for (;;) {
      const acquired = this.metadata.transaction(() => {
        const current = this.metadata.db.query(
          "SELECT owner, expires_at_ms FROM ghost_migration_leases WHERE home = ?",
        ).get(home) as { owner: string; expires_at_ms: number } | null;
        if (current && current.expires_at_ms > Date.now()) return false;
        this.metadata.db.query(`
          INSERT INTO ghost_migration_leases(home, owner, expires_at_ms) VALUES (?, ?, ?)
          ON CONFLICT(home) DO UPDATE SET owner = excluded.owner, expires_at_ms = excluded.expires_at_ms
        `).run(home, owner, Date.now() + 5 * 60_000);
        return true;
      });
      if (acquired) break;
      if (Date.now() >= deadline) {
        throw new SecretServiceError(
          "secret_migration_failed",
          "Another Ghost process is migrating this home's credentials; retry after it finishes.",
        );
      }
      Atomics.wait(sleep, 0, 0, 25);
    }
    try {
      return operation();
    } finally {
      this.metadata.db.query(
        "DELETE FROM ghost_migration_leases WHERE home = ? AND owner = ?",
      ).run(home, owner);
    }
  }

  /** Active rows, oldest first. Each caller applies its own account policy. */
  activeCredentialRows(provider?: string): CredentialRow[] {
    if (provider === undefined) {
      return this.metadata.db.query(`
        SELECT ${CREDENTIAL_ROW_COLUMNS} FROM ghost_auth_credentials
        WHERE active = 1 ORDER BY id
      `).all() as CredentialRow[];
    }
    return this.metadata.db.query(`
      SELECT ${CREDENTIAL_ROW_COLUMNS} FROM ghost_auth_credentials
      WHERE active = 1 AND provider = ? ORDER BY id
    `).all(provider) as CredentialRow[];
  }

  findCredentialReference(provider: string, credential: AuthCredential): SecretReference | undefined {
    const expected = credentialData(credential);
    for (const row of this.activeCredentialRows(provider)) {
      const value = this.readField(row);
      if (value !== undefined && credentialData(validateAuthCredential(value)) === expected) {
        return { service: row.service, account: row.account, field: row.field };
      }
    }
    return undefined;
  }

  close(): void {
    for (const [key, owner] of this.literalReservations) {
      const ref = parseSecretAccountName(key);
      this.metadata.db.query(`
        DELETE FROM ghost_literal_account_reservations
        WHERE service = ? AND account = ? AND owner = ?
      `).run(ref.service, ref.account, owner);
    }
    this.literalReservations.clear();
    this.metadata.close();
  }
}

export class KeyringAuthCredentialStore implements AuthCredentialStore {
  private readonly context: GhostSecretContext;
  private readonly authorizeAccounts?: (accounts: readonly string[]) => void;
  private writeAccount: SecretAccountRef | undefined;
  private observedRevision: number;
  private closed = false;

  constructor(
    context: GhostSecretContext,
    options: { authorizeAccounts?: (accounts: readonly string[]) => void } = {},
  ) {
    this.context = context;
    this.authorizeAccounts = options.authorizeAccounts;
    this.observedRevision = context.metadata.revision();
  }

  setWriteAccount(provider: string, account: string): void {
    this.writeAccount = parseSecretAccountName(`${serviceForCredentialProvider(provider)}/${account}`);
  }

  clearWriteAccount(): void {
    this.writeAccount = undefined;
  }

  allowAccounts(accounts: readonly string[]): void {
    this.context.allowAccounts(accounts);
  }

  listProviderAccounts(provider: string): Array<{
    account: string;
    configured: boolean;
    connectedVia?: "oauth" | "api_key";
  }> {
    const byAccount = new Map(this.context.activeCredentialRows(provider)
      .filter((row) => this.context.allowedAccounts.has(secretAccountName(row)))
      .map((row) => [row.account, row]));
    return this.allowedProviderAccounts(provider).map((ref) => {
      const row = byAccount.get(ref.account);
      return {
        account: ref.account,
        configured: Boolean(row),
        ...(row ? { connectedVia: row.credential_type } : {}),
      };
    });
  }

  private allowedProviderAccounts(provider: string): SecretAccountRef[] {
    const service = serviceForCredentialProvider(provider);
    return [...this.context.allowedAccounts]
      .map(parseSecretAccountName)
      .filter((ref) => ref.service === service);
  }

  private targetAccounts(provider: string, count: number): SecretAccountRef[] {
    if (count === 0) return [];
    if (this.writeAccount) {
      if (this.writeAccount.service !== serviceForCredentialProvider(provider) || count !== 1) {
        throw new Error(`A login may write exactly one ${provider} account at a time.`);
      }
      return [this.writeAccount];
    }
    const allowed = this.allowedProviderAccounts(provider);
    if (allowed.length >= count) return allowed.slice(0, count);
    if (count === 1 && allowed.length === 0) {
      return [{ service: serviceForCredentialProvider(provider), account: "personal" }];
    }
    throw new Error(`Choose explicit accounts before storing ${count} credentials for ${provider}.`);
  }

  private admitImplicitAccounts(accounts: readonly SecretAccountRef[]): void {
    if (this.writeAccount) return;
    const additions = accounts
      .map(secretAccountName)
      .filter((account) => !this.context.allowedAccounts.has(account));
    if (additions.length === 0) return;
    this.authorizeAccounts?.(additions);
    this.context.allowAccounts(additions);
  }

  private row(id: number): CredentialRow | null {
    return this.context.metadata.db.query(
      `SELECT ${CREDENTIAL_ROW_COLUMNS} FROM ghost_auth_credentials WHERE id = ?`,
    ).get(id) as CredentialRow | null;
  }

  private credentialForRow(row: CredentialRow): AuthCredential {
    const value = this.context.readField({
      service: row.service,
      account: row.account,
      field: row.field,
    });
    if (value === undefined) {
      throw new SecretServiceError(
        "secret_reference_missing",
        `Credential reference ${formatSecretReference(row, row.field)} is absent from Ghost's keyring. Log in again and retry.`,
      );
    }
    const credential = validateAuthCredential(value);
    if (credential.type !== row.credential_type) {
      throw new SecretServiceError("keyring_unavailable", "Ghost keyring credential metadata does not match its secret.");
    }
    return credential;
  }

  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    return this.context.activeCredentialRows(provider)
      .filter((row) => this.context.allowedAccounts.has(secretAccountName(row)))
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        credential: this.credentialForRow(row),
        disabledCause: null,
      }));
  }

  updateAuthCredential(id: number, credential: AuthCredential): void {
    const row = this.row(id);
    if (row?.active !== 1) return;
    this.context.registerCredential(row.provider, row, credential);
  }

  tryUpdateAuthCredentialIfMatches(
    id: number,
    expectedData: string,
    credential: AuthCredential,
    lease?: CredentialRefreshLeaseFence,
  ): boolean {
    return this.context.tryUpdateCredential(id, expectedData, credential, lease);
  }

  deleteAuthCredential(id: number, _disabledCause: string): void {
    this.context.metadata.transaction(() => {
      this.context.metadata.db.query("UPDATE ghost_auth_credentials SET active = 0 WHERE id = ?").run(id);
      this.context.metadata.bumpRevision();
    });
  }

  tryDisableAuthCredentialIfMatches(
    id: number,
    expectedData: string,
    _disabledCause: string,
    lease?: CredentialRefreshLeaseFence,
  ): boolean {
    return this.context.tryDisableCredential(id, expectedData, lease);
  }

  replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
    const accounts = this.targetAccounts(provider, credentials.length);
    credentials.forEach((credential, index) => {
      const account = accounts[index] as SecretAccountRef;
      this.context.registerCredential(provider, { ...account, field: "auth" }, credential);
    });
    this.admitImplicitAccounts(accounts);
    return this.listAuthCredentials(provider);
  }

  upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
    const [account] = this.targetAccounts(provider, 1);
    this.context.registerCredential(provider, { ...account as SecretAccountRef, field: "auth" }, credential);
    this.admitImplicitAccounts([account as SecretAccountRef]);
    return this.listAuthCredentials(provider);
  }

  deleteAuthCredentialsForProvider(provider: string, _disabledCause: string): void {
    const account = this.writeAccount;
    if (account) {
      this.context.removeAccount(account);
      return;
    }
    for (const allowed of this.allowedProviderAccounts(provider)) {
      this.context.removeAccount(allowed);
    }
  }

  getCache(key: string, options: { includeExpired?: boolean } = {}): string | null {
    const row = this.context.metadata.db.query(
      "SELECT value, expires_at_sec FROM ghost_auth_cache WHERE key = ?",
    ).get(key) as CacheRow | null;
    if (!row) return null;
    if (!options.includeExpired && row.expires_at_sec <= Math.floor(Date.now() / 1000)) return null;
    return row.value;
  }

  setCache(key: string, value: string, expiresAtSec: number): void {
    this.context.metadata.transaction(() => {
      this.context.metadata.db.query(`
        INSERT INTO ghost_auth_cache(key, value, expires_at_sec) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at_sec = excluded.expires_at_sec
      `).run(key, value, expiresAtSec);
      this.context.metadata.bumpRevision();
    });
  }

  deleteCachePrefix(prefix: string): void {
    this.context.metadata.transaction(() => {
      this.context.metadata.db.query("DELETE FROM ghost_auth_cache WHERE key LIKE ? ESCAPE '\\'")
        .run(`${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      this.context.metadata.bumpRevision();
    });
  }

  cleanExpiredCache(): void {
    this.context.metadata.db.query("DELETE FROM ghost_auth_cache WHERE expires_at_sec <= ?")
      .run(Math.floor(Date.now() / 1000));
  }

  private credentialBlock(
    credentialId: number,
    providerKey: string,
    blockScope: string,
  ): { blocked_until_ms: number; updated_at_ms: number } | null {
    return this.context.metadata.db.query(`
      SELECT blocked_until_ms, updated_at_ms FROM ghost_credential_blocks
      WHERE credential_id = ? AND provider_key = ? AND block_scope = ?
    `).get(credentialId, providerKey, blockScope) as
      { blocked_until_ms: number; updated_at_ms: number } | null;
  }

  getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
    return this.credentialBlock(credentialId, providerKey, blockScope)?.blocked_until_ms;
  }

  getCredentialBlockReconcileAfter(
    credentialId: number,
    providerKey: string,
    blockScope: string,
  ): number | undefined {
    return this.credentialBlock(credentialId, providerKey, blockScope)?.updated_at_ms;
  }

  upsertCredentialBlock(block: StoredCredentialBlock): void {
    const updatedAt = block.updatedAtMs ?? Date.now();
    this.context.metadata.transaction(() => {
      this.context.metadata.db.query(`
        INSERT INTO ghost_credential_blocks(
          credential_id, provider_key, block_scope, blocked_until_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
          blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
          updated_at_ms = excluded.updated_at_ms
      `).run(block.credentialId, block.providerKey, block.blockScope, block.blockedUntilMs, updatedAt);
      this.context.metadata.bumpRevision();
    });
  }

  deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
    this.context.metadata.transaction(() => {
      const result = this.context.metadata.db.query(`
        DELETE FROM ghost_credential_blocks
        WHERE credential_id = ? AND provider_key = ? AND block_scope = ?
      `).run(credentialId, providerKey, blockScope);
      if (result.changes > 0) this.context.metadata.bumpRevision();
    });
  }

  deleteCredentialBlocks(credentialId: number): void {
    this.context.metadata.transaction(() => {
      const result = this.context.metadata.db.query(
        "DELETE FROM ghost_credential_blocks WHERE credential_id = ?",
      ).run(credentialId);
      if (result.changes > 0) this.context.metadata.bumpRevision();
    });
  }

  cleanExpiredCredentialBlocks(nowMs: number): void {
    this.context.metadata.transaction(() => {
      const result = this.context.metadata.db.query(
        "DELETE FROM ghost_credential_blocks WHERE blocked_until_ms <= ?",
      ).run(nowMs);
      if (result.changes > 0) this.context.metadata.bumpRevision();
    });
  }

  listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
    if (credentialIds.length === 0) return [];
    const allowed = new Set(credentialIds);
    const rows = this.context.metadata.db.query(`
      SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at_ms
      FROM ghost_credential_blocks WHERE blocked_until_ms > ?
    `).all(Date.now()) as Array<{
      credential_id: number;
      provider_key: string;
      block_scope: string;
      blocked_until_ms: number;
      updated_at_ms: number;
    }>;
    return rows.filter((row) => allowed.has(row.credential_id)).map((row) => ({
      credentialId: row.credential_id,
      providerKey: row.provider_key,
      blockScope: row.block_scope,
      blockedUntilMs: row.blocked_until_ms,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  tryAcquireCredentialRefreshLease(id: number, owner: string, expiresAtMs: number): boolean {
    return this.context.metadata.transaction(() => {
      const current = this.context.metadata.db.query(
        "SELECT owner, expires_at_ms FROM ghost_refresh_leases WHERE credential_id = ?",
      ).get(id) as { owner: string; expires_at_ms: number } | null;
      if (current && current.expires_at_ms > Date.now() && current.owner !== owner) return false;
      this.context.metadata.db.query(`
        INSERT INTO ghost_refresh_leases(credential_id, owner, expires_at_ms) VALUES (?, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET owner = excluded.owner, expires_at_ms = excluded.expires_at_ms
      `).run(id, owner, expiresAtMs);
      this.context.metadata.bumpRevision();
      return true;
    });
  }

  getCredentialRefreshLeaseExpiresAt(id: number): number | undefined {
    const row = this.context.metadata.db.query(
      "SELECT expires_at_ms FROM ghost_refresh_leases WHERE credential_id = ?",
    ).get(id) as { expires_at_ms: number } | null;
    return row?.expires_at_ms;
  }

  releaseCredentialRefreshLease(id: number, owner: string): void {
    this.context.metadata.db.query(
      "DELETE FROM ghost_refresh_leases WHERE credential_id = ? AND owner = ?",
    ).run(id, owner);
  }

  renewCredentialRefreshLease(id: number, owner: string, expiresAtMs: number): boolean {
    const result = this.context.metadata.db.query(`
      UPDATE ghost_refresh_leases SET expires_at_ms = ?
      WHERE credential_id = ? AND owner = ? AND expires_at_ms > ?
    `).run(expiresAtMs, id, owner, Date.now());
    return result.changes === 1;
  }

  pollExternalChanges(): boolean {
    const current = this.context.metadata.revision();
    if (current === this.observedRevision) return false;
    this.observedRevision = current;
    return true;
  }

  acknowledgeLocalChanges(): void {
    this.observedRevision = this.context.metadata.revision();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.context.close();
  }
}
