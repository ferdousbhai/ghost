/** Idempotent migration from portable plaintext into machine Secret Service. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { MCPServerConfig } from "./mcp-config.js";
import {
  addGhostAccounts,
  readGhostModels,
  writeGhostModels,
  type GhostModelsFile,
  type GhostProviderConfig,
} from "./models.js";
import {
  authorizedSecretReference,
  GhostSecretContext,
  validateAuthCredential,
} from "./keyring-credential-store.js";
import { mcpServerValidationErrors } from "./mcp-server-shape.js";
import {
  fsyncPath,
  MAX_PRIVATE_FILE_BYTES,
  PrivateReadError,
  readPrivateFileText,
} from "./private-file.js";
import {
  DEFAULT_SECRET_FIELD,
  formatSecretReference,
  isSecretReference,
  SECRET_REFERENCE_PREFIX,
  secretAccountName,
  serviceForCredentialProvider,
  type SecretAccountRef,
} from "./secret-reference.js";
import { SecretServiceError, type SecretServiceClient } from "./secret-service.js";

const MCP_FILENAME = "mcp.json";
const SENSITIVE_NAME = /(?:^|[-_])(api[-_]?key|auth|bearer|credential|password|secret|token)(?:$|[-_])/i;
const SENSITIVE_ARGUMENT_VALUE = /(?:authorization\s*:|bearer\s+|api[-_ ]?key\s*[:=])/i;

interface PlainCredentialRow {
  provider: string;
  credential: AuthCredential;
}

interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GhostSecretMigrationOptions {
  home: string;
  authPath?: string;
  client?: SecretServiceClient;
  metadataPath?: string;
}

function refusedSource(path: string, error: PrivateReadError): SecretServiceError {
  switch (error.refusal) {
    case "open":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate unsafe plaintext source ${path}: ${(error.cause as Error).message}`,
      );
    case "unsafe":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate unsafe plaintext source ${path}.`,
      );
    case "too_large":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate ${path} because it exceeds 1 MiB.`,
      );
    case "changed":
      return new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate ${path} because it changed while being read.`,
      );
    case "encoding":
      return new SecretServiceError("secret_migration_failed", `${path} is not valid UTF-8.`);
  }
}

function privateJson(path: string): unknown {
  let text: string;
  try {
    text = readPrivateFileText(path);
  } catch (error) {
    if (!(error instanceof PrivateReadError)) throw error;
    throw refusedSource(path, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SecretServiceError("secret_migration_failed", `${path} is not valid JSON.`);
  }
}

export function atomicPrivateJson(path: string, value: unknown): void {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_PRIVATE_FILE_BYTES) {
    throw new SecretServiceError("secret_migration_failed", `${path} would exceed 1 MiB after migration.`);
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, rendered, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    fsyncPath(dirname(path));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function parseStoredCredential(type: unknown, data: unknown): AuthCredential {
  if ((type !== "api_key" && type !== "oauth") || typeof data !== "string") {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid credential row.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains malformed credential JSON.");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.hasOwn(record, "type")) {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid credential row.");
  }
  try {
    return validateAuthCredential({ ...record, type });
  } catch {
    throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid credential row.");
  }
}

/**
 * A row OMP disabled is skipped rather than migrated: the keyring store has no
 * disabled state to carry it into, and the scrub below deletes it with the rest
 * of the file.
 */
function readAgentDb(path: string): PlainCredentialRow[] {
  if (!existsSync(path)) return [];
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new SecretServiceError("secret_migration_failed", `Ghost refused to migrate unsafe ${path}.`);
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const table = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
    ).get();
    if (!table) return [];
    const rows = db.query(`
      SELECT provider, credential_type, data
      FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id
    `).all() as Array<{ provider: unknown; credential_type: unknown; data: unknown }>;
    return rows.map((row) => {
      if (typeof row.provider !== "string" || row.provider.length === 0) {
        throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid provider id.");
      }
      return { provider: row.provider, credential: parseStoredCredential(row.credential_type, row.data) };
    });
  } finally {
    db.close();
  }
}

function legacyCredentials(path: string): PlainCredentialRow[] {
  if (!existsSync(path)) return [];
  const parsed = privateJson(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretServiceError("secret_migration_failed", `${path} must contain a credential object.`);
  }
  const rows: PlainCredentialRow[] = [];
  for (const [provider, value] of Object.entries(parsed)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SecretServiceError("secret_migration_failed", `${path} contains an invalid credential.`);
      }
      try {
        rows.push({ provider, credential: validateAuthCredential(entry) });
      } catch {
        throw new SecretServiceError("secret_migration_failed", `${path} contains an invalid credential.`);
      }
    }
  }
  return rows;
}

function fieldToken(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64url");
  return encoded.length <= 160
    ? encoded
    : `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

function modelsHeaderField(name: string): string {
  return `models.header.${fieldToken(name)}`;
}

/**
 * Every provider field that may hold a credential, in a stable order, rewritten
 * in place with whatever the visitor returns.
 *
 * Planning, conversion, and connection-time resolution all drive this one walk,
 * for the same reason the MCP walk below does: a field only one of them knew
 * about would either keep a plaintext secret on disk or hand a provider the
 * reference text instead of the credential. Deriving the envelope field here
 * also keeps the account chosen for a header the account it is written into.
 */
export function visitProviderSecretFields(
  config: GhostProviderConfig,
  visit: (value: string, field: string, purpose: string) => string,
): void {
  if (typeof config.apiKey === "string") {
    config.apiKey = visit(config.apiKey, DEFAULT_SECRET_FIELD, "models.apiKey");
  }
  if (config.headers) {
    for (const [name, value] of Object.entries(config.headers)) {
      config.headers[name] = visit(value, modelsHeaderField(name), "models.header");
    }
  }
}

function mcpSecretService(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72)
    || "server";
  const digest = createHash("sha256").update(serverName).digest("hex").slice(0, 12);
  return `mcp.${slug}.${digest}`;
}

function sensitiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(
      url.username
      || url.password
      || url.hash.length > 1
      || /(?:^|\/)(?:api[-_]?key|auth|bearer|credential|password|secret|token)(?:\/|=|:)/i
        .test(url.pathname)
      || [...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key)),
    );
  } catch {
    return false;
  }
}

function sensitiveCommandArgument(args: readonly string[], index: number): boolean {
  const value = args[index] as string;
  const previous = index > 0 ? args[index - 1] : undefined;
  const equals = value.indexOf("=");
  const flag = equals > 0 ? value.slice(0, equals) : value;
  return (equals > 0 && SENSITIVE_NAME.test(flag))
    || (typeof previous === "string" && SENSITIVE_NAME.test(previous))
    || SENSITIVE_ARGUMENT_VALUE.test(value)
    || sensitiveUrl(value);
}

function storeLiteral(
  context: GhostSecretContext,
  account: SecretAccountRef,
  field: string,
  value: string,
  purpose: string,
  addedAccounts: Set<string>,
): string {
  const ref = { ...account, field };
  context.putField(ref, value, purpose);
  const accountName = secretAccountName(account);
  addedAccounts.add(accountName);
  context.allowAccounts([accountName]);
  return formatSecretReference(ref, field);
}

function migrateModels(
  models: GhostModelsFile,
  context: GhostSecretContext,
  addedAccounts: Set<string>,
): boolean {
  let changed = false;
  const allowed = new Set(models.accounts ?? []);
  for (const [provider, config] of Object.entries(models.providers)) {
    const storageProvider = getProviderDefinition(provider)?.storeCredentialsAs ?? provider;
    const service = serviceForCredentialProvider(storageProvider);
    const planned: Record<string, string> = {};
    visitProviderSecretFields(config, (value, field) => {
      if (!isSecretReference(value)) planned[field] = value;
      return value;
    });
    const plannedApiKey = planned[DEFAULT_SECRET_FIELD];
    const account = context.selectLiteralAccount(service, planned, {
      ...(plannedApiKey === undefined ? {} : { apiKey: plannedApiKey }),
    });
    try {
      visitProviderSecretFields(config, (value, field, purpose) => {
        if (isSecretReference(value)) {
          authorizedSecretReference(value, allowed);
          return value;
        }
        const reference = storeLiteral(context, account, field, value, purpose, addedAccounts);
        changed = true;
        return reference;
      });
    } finally {
      context.releaseLiteralAccount(account);
    }
  }
  return changed;
}

/**
 * Every MCP field that may hold a credential, in a stable order, rewritten in
 * place with whatever the visitor returns. `capture` is this traversal's own
 * judgement that a literal there is a secret; a value already written as a
 * reference is offered whatever that judgement is, because an unauthorized
 * reference is refused wherever it appears.
 *
 * Planning, conversion, and connection-time resolution all drive this one walk.
 * A field only one of them knew about would either keep a plaintext secret on
 * disk or hand an MCP server the reference text instead of the credential.
 */
export function visitMcpSecretFields(
  config: MCPServerConfig & Record<string, unknown>,
  visit: (value: string, field: string, purpose: string, capture: boolean) => string,
): void {
  if ((config.type ?? "stdio") === "stdio") {
    const stdio = config as MCPServerConfig & { args?: string[]; env?: Record<string, string> };
    if (stdio.env) {
      for (const [key, value] of Object.entries(stdio.env)) {
        stdio.env[key] = visit(value, `env.${fieldToken(key)}`, "mcp.env", true);
      }
    }
    if (stdio.args) {
      for (let index = 0; index < stdio.args.length; index += 1) {
        const value = stdio.args[index] as string;
        const capture = sensitiveCommandArgument(stdio.args, index);
        stdio.args[index] = visit(value, `arg.${index}`, "mcp.argument", capture);
      }
    }
  } else {
    const remote = config as MCPServerConfig & { url: string; headers?: Record<string, string> };
    if (remote.headers) {
      for (const [key, value] of Object.entries(remote.headers)) {
        remote.headers[key] = visit(value, `header.${fieldToken(key)}`, "mcp.header", true);
      }
    }
    remote.url = visit(remote.url, "url", "mcp.url", sensitiveUrl(remote.url));
  }
  const auth = config.auth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof auth?.clientSecret === "string") {
    auth.clientSecret = visit(auth.clientSecret, "auth.clientSecret", "mcp.client-secret", true);
  }
  const oauth = config.oauth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof oauth?.clientSecret === "string") {
    oauth.clientSecret = visit(oauth.clientSecret, "oauth.clientSecret", "mcp.client-secret", true);
  }
}

export function materializeMcpSecretReferences(
  serverName: string,
  input: MCPServerConfig,
  context: GhostSecretContext,
): { config: MCPServerConfig; addedAccounts: string[] } {
  const config = structuredClone(input) as MCPServerConfig & Record<string, unknown>;
  const added = new Set<string>();
  const allowed = context.allowedAccounts;

  // The account is chosen from everything this row wants to store, so the whole
  // row is planned before any of it is written.
  const planned: Record<string, string> = {};
  visitMcpSecretFields(config, (value, field, _purpose, capture) => {
    if (value.startsWith(SECRET_REFERENCE_PREFIX)) authorizedSecretReference(value, allowed);
    else if (capture) planned[field] = value;
    return value;
  });

  const account = context.selectLiteralAccount(mcpSecretService(serverName), planned);
  try {
    visitMcpSecretFields(config, (value, field, purpose, capture) => {
      if (value.startsWith(SECRET_REFERENCE_PREFIX)) {
        authorizedSecretReference(value, allowed);
        return value;
      }
      if (!capture) return value;
      return storeLiteral(context, account, field, value, purpose, added);
    });
    return { config, addedAccounts: [...added] };
  } finally {
    context.releaseLiteralAccount(account);
  }
}

function migrateMcpFile(
  home: string,
  context: GhostSecretContext,
): { document: McpConfigDocument | null; changed: boolean; addedAccounts: string[] } {
  const path = join(home, MCP_FILENAME);
  if (!existsSync(path)) return { document: null, changed: false, addedAccounts: [] };
  const parsed = privateJson(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretServiceError("secret_migration_failed", `${path} must contain a JSON object.`);
  }
  const document = parsed as McpConfigDocument;
  if (document.mcpServers !== undefined
    && (!document.mcpServers || typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers))) {
    throw new SecretServiceError("secret_migration_failed", `${path} "mcpServers" must be an object.`);
  }
  let changed = false;
  const accounts = new Set<string>();
  for (const [name, value] of Object.entries(document.mcpServers ?? {})) {
    // A row the MCP catalogue itself rejects is left exactly as written. Its
    // taxonomy already owns that case (`invalid_mcp_server`/`skipped`), and a
    // neighbour's typo is not the fail-closed condition this migration exists
    // for: that is the keyring being locked or absent. Any secret such a row
    // still holds stays plaintext and visibly invalid until the owner fixes
    // the row, and the next open migrates it.
    if (mcpServerValidationErrors(name, value).length > 0) continue;
    const migrated = materializeMcpSecretReferences(name, value as MCPServerConfig, context);
    if (JSON.stringify(migrated.config) !== JSON.stringify(value)) {
      (document.mcpServers as Record<string, unknown>)[name] = migrated.config;
      changed = true;
    }
    for (const account of migrated.addedAccounts) accounts.add(account);
  }
  return { document, changed, addedAccounts: [...accounts] };
}

function importCredentials(
  rows: readonly PlainCredentialRow[],
  context: GhostSecretContext,
  accounts: Set<string>,
): void {
  for (const row of rows) {
    const existing = context.findCredentialReference(row.provider, row.credential);
    if (existing) {
      accounts.add(secretAccountName(existing));
      continue;
    }
    const account = context.selectLiteralAccount(
      serviceForCredentialProvider(row.provider),
      {},
      { credential: row.credential },
    );
    try {
      context.registerCredential(row.provider, { ...account, field: "auth" }, row.credential);
      accounts.add(secretAccountName(account));
    } finally {
      context.releaseLiteralAccount(account);
    }
  }
}

/** What the file is, rather than whose it was: schema number and change counter. */
const AGENT_DB_SCHEMA_TABLES = new Set(["auth_schema_version", "auth_change_revision"]);

/**
 * Empty the legacy database down to those two rows.
 *
 * The keep-list is a list of what stays, not of what goes, on purpose: naming
 * the credential tables left the identity sitting beside them, and nothing
 * creates or reads `agent.db` after migration — the injected credential store
 * bypasses it entirely — so deleting every table not named here covers whatever
 * OMP adds later by default.
 */
function scrubAgentDb(path: string): void {
  if (!existsSync(path)) return;
  const db = new Database(path, { create: false, strict: true });
  try {
    const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tables = rows
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_") && !AGENT_DB_SCHEMA_TABLES.has(name));
    if (tables.length === 0) return;
    db.exec("PRAGMA journal_mode = DELETE");
    db.transaction(() => {
      for (const name of tables) db.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
    }).exclusive();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  fsyncPath(path);
}

function removePlainFile(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  fsyncPath(dirname(path));
}

function migrateWithContext(
  options: GhostSecretMigrationOptions,
  context: GhostSecretContext,
): void {
  const authPath = options.authPath ?? join(options.home, ".pi", "auth.json");
  const agentDb = join(dirname(authPath), "agent.db");
  const models = readGhostModels(options.home) ?? { providers: {} };
  const addedAccounts = new Set<string>();
  const modelsChanged = migrateModels(models, context, addedAccounts);
  const mcp = migrateMcpFile(options.home, context);
  for (const account of mcp.addedAccounts) addedAccounts.add(account);

  const database = readAgentDb(agentDb);
  const legacy = legacyCredentials(authPath);
  importCredentials([...database, ...legacy], context, addedAccounts);

  const previousAccounts = models.accounts ?? [];
  const mergedAccounts = [...new Set([...previousAccounts, ...addedAccounts])];
  if (mergedAccounts.length > 0) models.accounts = mergedAccounts;
  context.allowAccounts(mergedAccounts);

  if (modelsChanged || mergedAccounts.length !== previousAccounts.length) {
    writeGhostModels(options.home, models);
  }
  if (mcp.changed && mcp.document) atomicPrivateJson(join(options.home, MCP_FILENAME), mcp.document);

  // Plaintext is removed only after every keyring write was read back and both
  // portable config replacements are durable. Every preceding step is
  // idempotent, so a crash is resumed from the surviving source.
  scrubAgentDb(agentDb);
  removePlainFile(authPath);
}

export function openGhostSecretContext(options: GhostSecretMigrationOptions): GhostSecretContext {
  const models = readGhostModels(options.home);
  const context = new GhostSecretContext({
    allowedAccounts: models?.accounts ?? [],
    ...(options.client ? { client: options.client } : {}),
    ...(options.metadataPath ? { metadataPath: options.metadataPath } : {}),
  });
  try {
    context.withMigrationLease(options.home, () => migrateWithContext(options, context));
    return context;
  } catch (error) {
    context.close();
    if (error instanceof SecretServiceError) throw error;
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new SecretServiceError(
      "secret_migration_failed",
      `Ghost stopped the keyring migration safely; no plaintext source was removed before its verified replacement.${detail}`,
    );
  }
}

export function authorizeGhostAccounts(home: string, context: GhostSecretContext, accounts: readonly string[]): void {
  if (accounts.length === 0) return;
  addGhostAccounts(home, accounts);
  context.allowAccounts(accounts);
}
