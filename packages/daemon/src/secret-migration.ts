/** Idempotent migration from portable plaintext into machine Secret Service. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
  addGhostAccounts,
  readGhostModels,
  writeGhostModels,
  type GhostModelsFile,
} from "./models.js";
import {
  GhostSecretContext,
  validateAuthCredential,
} from "./keyring-credential-store.js";
import { mcpServerValidationErrors } from "./mcp-server-shape.js";
import {
  formatSecretReference,
  isSecretReference,
  parseSecretReference,
  SECRET_REFERENCE_PREFIX,
  secretAccountName,
  serviceForCredentialProvider,
  type SecretAccountRef,
} from "./secret-reference.js";
import { SecretServiceError, type SecretServiceClient } from "./secret-service.js";

const MCP_FILENAME = "mcp.json";
const MAX_CONFIG_BYTES = 1_048_576;
const SENSITIVE_ARGUMENT = /(?:^|[-_])(api[-_]?key|auth|bearer|credential|password|secret|token)(?:$|[-_])/i;
const SENSITIVE_ARGUMENT_VALUE = /(?:authorization\s*:|bearer\s+|api[-_ ]?key\s*[:=])/i;
const SENSITIVE_QUERY = /(?:^|[-_])(api[-_]?key|auth|bearer|credential|password|secret|token)(?:$|[-_])/i;

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

function privateJson(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new SecretServiceError(
      "secret_migration_failed",
      `Ghost refused to migrate unsafe plaintext source ${path}: ${(error as Error).message}`,
    );
  }
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {
      throw new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate unsafe plaintext source ${path}.`,
      );
    }
    if (before.size > MAX_CONFIG_BYTES) {
      throw new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate ${path} because it exceeds 1 MiB.`,
      );
    }
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.dev !== after.dev || current.ino !== after.ino
      || current.isSymbolicLink() || current.nlink !== 1) {
      throw new SecretServiceError(
        "secret_migration_failed",
        `Ghost refused to migrate ${path} because it changed while being read.`,
      );
    }
  } finally {
    closeSync(fd);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SecretServiceError("secret_migration_failed", `${path} is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SecretServiceError("secret_migration_failed", `${path} is not valid JSON.`);
  }
}

function atomicPrivateJson(path: string, value: unknown): void {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_CONFIG_BYTES) {
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
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
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
    throw new SecretServiceError("secret_migration_failed", "agent.db contains malformed credential JSON.");
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

function readAgentDb(path: string): { credentials: PlainCredentialRow[]; hasCredentialTable: boolean } {
  if (!existsSync(path)) return { credentials: [], hasCredentialTable: false };
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new SecretServiceError("secret_migration_failed", `Ghost refused to migrate unsafe ${path}.`);
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const table = db.query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
    ).get() as { present: number } | null;
    if (!table) return { credentials: [], hasCredentialTable: false };
    const rows = db.query(`
      SELECT provider, credential_type, data
      FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id
    `).all() as Array<{ provider: unknown; credential_type: unknown; data: unknown }>;
    return {
      credentials: rows.map((row) => {
        if (typeof row.provider !== "string" || row.provider.length === 0) {
          throw new SecretServiceError("secret_migration_failed", "agent.db contains an invalid provider id.");
        }
        return { provider: row.provider, credential: parseStoredCredential(row.credential_type, row.data) };
      }),
      hasCredentialTable: true,
    };
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

export function mcpSecretService(serverName: string): string {
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
      || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key)),
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
  return (equals > 0 && SENSITIVE_ARGUMENT.test(flag))
    || (typeof previous === "string" && SENSITIVE_ARGUMENT.test(previous))
    || SENSITIVE_ARGUMENT_VALUE.test(value)
    || sensitiveUrl(value);
}

function requireAuthorizedReference(value: string, allowed: ReadonlySet<string>): void {
  let ref: ReturnType<typeof parseSecretReference>;
  try {
    ref = parseSecretReference(value);
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
    if (typeof config.apiKey === "string" && !isSecretReference(config.apiKey)) {
      planned.value = config.apiKey;
    }
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (!isSecretReference(value)) planned[`models.header.${fieldToken(name)}`] = value;
    }
    const account = context.selectLiteralAccount(service, planned, {
      ...(planned.value === undefined ? {} : { apiKey: planned.value }),
    });
    try {
      if (typeof config.apiKey === "string") {
        if (isSecretReference(config.apiKey)) requireAuthorizedReference(config.apiKey, allowed);
        else {
          config.apiKey = storeLiteral(context, account, "value", config.apiKey, "models.apiKey", addedAccounts);
          changed = true;
        }
      }
      if (config.headers) {
        for (const [name, value] of Object.entries(config.headers)) {
          if (isSecretReference(value)) requireAuthorizedReference(value, allowed);
          else {
            config.headers[name] = storeLiteral(
              context,
              account,
              `models.header.${fieldToken(name)}`,
              value,
              "models.header",
              addedAccounts,
            );
            changed = true;
          }
        }
      }
    } finally {
      context.releaseLiteralAccount(account);
    }
  }
  return changed;
}

/** Convert one MCP server config before it is allowed onto portable disk. */
export function materializeMcpSecretReferences(
  serverName: string,
  input: MCPServerConfig,
  context: GhostSecretContext,
): { config: MCPServerConfig; addedAccounts: string[] } {
  const config = structuredClone(input) as MCPServerConfig & Record<string, unknown>;
  const service = mcpSecretService(serverName);
  const added = new Set<string>();
  const allowed = context.allowedAccounts;
  const planned: Record<string, string> = {};
  const plan = (value: string, field: string): void => {
    if (value.startsWith(SECRET_REFERENCE_PREFIX)) {
      requireAuthorizedReference(value, allowed);
      return;
    }
    planned[field] = value;
  };

  const type = config.type ?? "stdio";
  if (type === "stdio") {
    const stdio = config as MCPServerConfig & { args?: string[]; env?: Record<string, string> };
    for (const [key, value] of Object.entries(stdio.env ?? {})) {
      plan(value, `env.${fieldToken(key)}`);
    }
    const args = stdio.args ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index] as string;
      if (sensitiveCommandArgument(args, index)) plan(value, `arg.${index}`);
      else if (value.startsWith(SECRET_REFERENCE_PREFIX)) requireAuthorizedReference(value, allowed);
    }
  } else {
    const remote = config as MCPServerConfig & { url: string; headers?: Record<string, string> };
    for (const [key, value] of Object.entries(remote.headers ?? {})) {
      plan(value, `header.${fieldToken(key)}`);
    }
    if (remote.url.startsWith(SECRET_REFERENCE_PREFIX)) requireAuthorizedReference(remote.url, allowed);
    else if (sensitiveUrl(remote.url)) plan(remote.url, "url");
  }
  const plannedAuth = config.auth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof plannedAuth?.clientSecret === "string") {
    plan(plannedAuth.clientSecret, "auth.clientSecret");
  }
  const plannedOauth = config.oauth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
  if (typeof plannedOauth?.clientSecret === "string") {
    plan(plannedOauth.clientSecret, "oauth.clientSecret");
  }
  const account = context.selectLiteralAccount(service, planned);
  const convert = (value: string, field: string, purpose: string): string => {
    if (value.startsWith(SECRET_REFERENCE_PREFIX)) {
      requireAuthorizedReference(value, allowed);
      return value;
    }
    return storeLiteral(context, account, field, value, purpose, added);
  };

  try {
    if (type === "stdio") {
      const stdio = config as MCPServerConfig & {
        args?: string[];
        env?: Record<string, string>;
      };
      if (stdio.env) {
        for (const [key, value] of Object.entries(stdio.env)) {
          stdio.env[key] = convert(value, `env.${fieldToken(key)}`, "mcp.env");
        }
      }
      if (stdio.args) {
        for (let index = 0; index < stdio.args.length; index += 1) {
          const value = stdio.args[index] as string;
          if (sensitiveCommandArgument(stdio.args, index)) {
            stdio.args[index] = convert(value, `arg.${index}`, "mcp.argument");
          } else if (value.startsWith(SECRET_REFERENCE_PREFIX)) {
            requireAuthorizedReference(value, allowed);
          }
        }
      }
    } else {
      const remote = config as MCPServerConfig & { url: string; headers?: Record<string, string> };
      if (remote.headers) {
        for (const [key, value] of Object.entries(remote.headers)) {
          remote.headers[key] = convert(value, `header.${fieldToken(key)}`, "mcp.header");
        }
      }
      if (isSecretReference(remote.url)) requireAuthorizedReference(remote.url, allowed);
      else if (sensitiveUrl(remote.url)) remote.url = convert(remote.url, "url", "mcp.url");
    }

    const auth = config.auth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
    if (typeof auth?.clientSecret === "string") {
      auth.clientSecret = convert(auth.clientSecret, "auth.clientSecret", "mcp.client-secret");
    }
    const oauth = config.oauth as (Record<string, unknown> & { clientSecret?: string }) | undefined;
    if (typeof oauth?.clientSecret === "string") {
      oauth.clientSecret = convert(oauth.clientSecret, "oauth.clientSecret", "mcp.client-secret");
    }
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

function scrubAgentDb(path: string): void {
  if (!existsSync(path)) return;
  const db = new Database(path, { create: false, strict: true });
  try {
    const table = db.query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
    ).get();
    if (!table) return;
    db.exec("PRAGMA journal_mode = DELETE");
    db.transaction(() => {
      db.query("DELETE FROM auth_credentials").run();
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((row) => row.name));
      if (names.has("auth_credential_refresh_leases")) {
        db.query("DELETE FROM auth_credential_refresh_leases").run();
      }
      if (names.has("auth_credential_blocks")) db.query("DELETE FROM auth_credential_blocks").run();
    }).exclusive();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removePlainFile(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
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
  importCredentials([...database.credentials, ...legacy], context, addedAccounts);

  const previousAccounts = models.accounts ?? [];
  const mergedAccounts = [...previousAccounts];
  const seen = new Set(previousAccounts);
  for (const account of addedAccounts) {
    if (!seen.has(account)) {
      seen.add(account);
      mergedAccounts.push(account);
    }
  }
  if (mergedAccounts.length > 0) models.accounts = mergedAccounts;
  context.allowAccounts(mergedAccounts);

  if (modelsChanged || mergedAccounts.length !== previousAccounts.length) {
    writeGhostModels(options.home, models);
  }
  if (mcp.changed && mcp.document) atomicPrivateJson(join(options.home, MCP_FILENAME), mcp.document);

  // Plaintext is removed only after every keyring write was read back and both
  // portable config replacements are durable. Every preceding step is
  // idempotent, so a crash is resumed from the surviving source.
  if (database.hasCredentialTable) scrubAgentDb(agentDb);
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

/** Add policy after an already-verified interactive write. */
export function authorizeGhostAccounts(home: string, context: GhostSecretContext, accounts: readonly string[]): void {
  if (accounts.length === 0) return;
  addGhostAccounts(home, accounts);
  context.allowAccounts(accounts);
}
