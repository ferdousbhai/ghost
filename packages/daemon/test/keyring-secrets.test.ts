import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  KeyringAuthCredentialStore,
  type GhostSecretContext,
} from "../src/keyring-credential-store.js";
import { openGhostSecretContext } from "../src/secret-migration.js";
import {
  formatSecretReference,
  parseSecretReference,
  serviceForCredentialProvider,
} from "../src/secret-reference.js";
import { MemorySecretServiceClient, SecretServiceError } from "../src/secret-service.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ghost-keyring-test-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Machine metadata defaults beside the home; tests that share one pass it. */
function openContext(
  home: string,
  client: MemorySecretServiceClient,
  metadataPath = join(home, "state.sqlite"),
): GhostSecretContext {
  return openGhostSecretContext({ home, client, metadataPath });
}

/** A machine home holding one plaintext provider key. */
function literalHome(machine: string, name: string, apiKey: string): string {
  const home = join(machine, name);
  mkdirSync(home);
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: { openrouter: { apiKey } },
  }));
  return home;
}

/**
 * A legacy OMP `agent.db`: the credential tables named beside the identity,
 * usage, and cache tables the scrub has to reach too. Table names are OMP's,
 * because those are what the scrub's keep-list decides on; columns are only the
 * ones a test reads back, because the scrub itself is column-blind.
 * `AUTOINCREMENT` earns its place — it makes SQLite create `sqlite_sequence`,
 * so the enumeration meets a table the keep-list skips by prefix.
 */
function legacyAgentDb(agentDir: string): void {
  const db = new Database(join(agentDir, "agent.db"));
  db.exec(`
    CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      credential_type TEXT,
      data TEXT,
      disabled_cause TEXT
    );
    CREATE TABLE auth_credential_blocks (credential_id INTEGER, provider_key TEXT);
    CREATE TABLE auth_credential_refresh_leases (credential_id INTEGER PRIMARY KEY, owner TEXT);
    CREATE TABLE auth_credential_block_mirror_guard (credential_id INTEGER PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE usage_history (provider TEXT, account_key TEXT, email TEXT, account_id TEXT);
    CREATE TABLE clients (install_id TEXT PRIMARY KEY, hostname TEXT);
    CREATE TABLE client_usage (install_id TEXT, model TEXT, cost_usd REAL);
    INSERT INTO auth_schema_version VALUES (1, 3);
    INSERT INTO auth_change_revision VALUES (1, 17);
    INSERT INTO auth_credential_blocks VALUES (1, 'openai:oauth');
    INSERT INTO auth_credential_refresh_leases VALUES (1, 'owner-a');
    INSERT INTO auth_credential_block_mirror_guard VALUES (1);
    INSERT INTO cache VALUES ('usage_cache:openai:acct-identity', 'cached-usage-payload');
    INSERT INTO usage_history VALUES ('openai', 'acct-identity', 'someone@example.test', 'acct-identity');
    INSERT INTO clients VALUES ('install-identity', 'workstation-identity');
    INSERT INTO client_usage VALUES ('install-identity', 'gpt-identity', 6.0);
  `);
  const credential = db.query(`
    INSERT INTO auth_credentials(provider, credential_type, data, disabled_cause) VALUES (?, 'api_key', ?, ?)
  `);
  credential.run("openai", JSON.stringify({ key: "live-secret" }), null);
  credential.run("anthropic", JSON.stringify({ key: "disabled-secret" }), "revoked by provider");
  db.close();
}

describe("keyring references", () => {
  it("round-trips service/account with an optional field", () => {
    expect(parseSecretReference("keyring:openrouter/personal")).toEqual({
      service: "openrouter",
      account: "personal",
      field: "value",
    });
    expect(formatSecretReference(
      { service: "mcp.github", account: "work" },
      "header.QXV0aG9yaXphdGlvbg",
    )).toBe("keyring:mcp.github/work#header.QXV0aG9yaXphdGlvbg");
    expect(() => parseSecretReference("keyring:OpenRouter/personal"))
      .toThrow(/lowercase letters/);
  });

  it("confines opaque OMP credential ids to a stable Ghost service name", () => {
    const first = serviceForCredentialProvider("mcp_oauth:https://example.test/path");
    expect(first).toMatch(/^provider\.mcp-oauth-https-example-test-path\.[0-9a-f]{16}$/);
    expect(serviceForCredentialProvider("mcp_oauth:https://example.test/path")).toBe(first);
  });
});

describe("Secret Service boundary", () => {
  it("fails distinctly for a locked service, a forbidden account, and an absent field", () => {
    const dir = root();
    const client = new MemorySecretServiceClient();
    client.available = false;
    expect(() => openContext(dir, client))
      .toThrowError(expect.objectContaining({ code: "keyring_unavailable" }));

    client.available = true;
    client.locked = true;
    expect(() => openContext(dir, client))
      .toThrowError(expect.objectContaining({ code: "keyring_locked" }));

    client.locked = false;
    const context = openContext(dir, client);
    expect(() => context.resolve("keyring:openrouter/personal"))
      .toThrowError(expect.objectContaining({ code: "secret_not_authorized" }));
    context.allowAccounts(["openrouter/personal"]);
    expect(() => context.resolve("keyring:openrouter/personal"))
      .toThrowError(expect.objectContaining({ code: "secret_reference_missing" }));
    context.close();
  });

  it("preserves two provider accounts and stable row ids across opens", () => {
    const dir = root();
    const client = new MemorySecretServiceClient();
    const allowed = ["openrouter/personal", "openrouter/work"];
    const first = openContext(dir, client);
    first.allowAccounts(allowed);
    const personalId = first.registerCredential(
      "openrouter",
      { service: "openrouter", account: "personal", field: "auth" },
      { type: "api_key", key: "personal-key" },
    );
    const workId = first.registerCredential(
      "openrouter",
      { service: "openrouter", account: "work", field: "auth" },
      { type: "api_key", key: "work-key" },
    );
    first.close();

    const second = openContext(dir, client);
    second.allowAccounts(allowed);
    const store = new KeyringAuthCredentialStore(second);
    expect(store.listAuthCredentials("openrouter")).toMatchObject([
      { id: personalId, credential: { key: "personal-key" } },
      { id: workId, credential: { key: "work-key" } },
    ]);
    store.close();
  });

  it("serializes refresh CAS, lease fencing, and shared cooldown maxima", () => {
    const dir = root();
    const client = new MemorySecretServiceClient();
    const firstContext = openContext(dir, client);
    const secondContext = openContext(dir, client);
    firstContext.allowAccounts(["openrouter/personal"]);
    secondContext.allowAccounts(["openrouter/personal"]);
    const first = new KeyringAuthCredentialStore(firstContext);
    const second = new KeyringAuthCredentialStore(secondContext);
    first.setWriteAccount("openrouter", "personal");
    const [stored] = first.upsertAuthCredentialForProvider(
      "openrouter",
      { type: "api_key", key: "before" },
    );
    const id = stored!.id;
    expect(first.tryAcquireCredentialRefreshLease(id, "owner-a", Date.now() + 60_000)).toBe(true);
    expect(second.tryAcquireCredentialRefreshLease(id, "owner-b", Date.now() + 60_000)).toBe(false);
    const fence = { owner: "owner-a", nowMs: Date.now() };
    expect(first.tryUpdateAuthCredentialIfMatches(
      id,
      JSON.stringify({ key: "before" }),
      { type: "api_key", key: "after" },
      fence,
    )).toBe(true);
    expect(second.tryUpdateAuthCredentialIfMatches(
      id,
      JSON.stringify({ key: "before" }),
      { type: "api_key", key: "stale" },
      fence,
    )).toBe(false);

    first.upsertCredentialBlock({
      credentialId: id,
      providerKey: "openrouter:model",
      blockScope: "rate-limit",
      blockedUntilMs: 500,
    });
    second.upsertCredentialBlock({
      credentialId: id,
      providerKey: "openrouter:model",
      blockScope: "rate-limit",
      blockedUntilMs: 300,
    });
    expect(second.getCredentialBlock(id, "openrouter:model", "rate-limit")).toBe(500);
    expect(second.listAuthCredentials("openrouter")[0]?.credential).toEqual({
      type: "api_key",
      key: "after",
    });
    first.close();
    second.close();
  });

  it("reserves literal account allocation across concurrent contexts", () => {
    const dir = root();
    const client = new MemorySecretServiceClient();
    const metadataPath = join(dir, "state.sqlite");
    const first = openContext(join(dir, "one"), client, metadataPath);
    const second = openContext(join(dir, "two"), client, metadataPath);
    const personal = first.selectLiteralAccount("openrouter", { value: "first" });
    const other = second.selectLiteralAccount("openrouter", { value: "second" });
    expect(personal).toEqual({ service: "openrouter", account: "personal" });
    expect(other).toEqual({ service: "openrouter", account: "account-2" });
    first.releaseLiteralAccount(personal);
    second.releaseLiteralAccount(other);
    first.close();
    second.close();
  });

  it("logs out exactly one whole service/account item", () => {
    const dir = root();
    const client = new MemorySecretServiceClient();
    const context = openContext(dir, client);
    context.allowAccounts(["openrouter/personal", "openrouter/work"]);
    context.putField(
      { service: "openrouter", account: "personal", field: "value" },
      "personal-model-key",
      "models.apiKey",
    );
    context.registerCredential(
      "openrouter",
      { service: "openrouter", account: "personal", field: "auth" },
      { type: "api_key", key: "personal-auth-key" },
    );
    context.registerCredential(
      "openrouter",
      { service: "openrouter", account: "work", field: "auth" },
      { type: "api_key", key: "work-key" },
    );
    const store = new KeyringAuthCredentialStore(context);
    store.setWriteAccount("openrouter", "personal");
    store.deleteAuthCredentialsForProvider("openrouter", "deleted by user");
    expect(client.items.has("openrouter/personal")).toBe(false);
    expect(client.items.has("openrouter/work")).toBe(true);
    expect(store.listAuthCredentials("openrouter")).toMatchObject([
      { credential: { key: "work-key" } },
    ]);
    store.close();
  });
});

describe("plaintext migration", () => {
  it("allocates distinct machine accounts instead of overwriting another literal", () => {
    const machine = root();
    const firstHome = literalHome(machine, "one", "first-key");
    const secondHome = literalHome(machine, "two", "second-key");
    const client = new MemorySecretServiceClient();
    const metadataPath = join(machine, "state.sqlite");
    openContext(firstHome, client, metadataPath).close();
    openContext(secondHome, client, metadataPath).close();

    expect(JSON.parse(readFileSync(join(firstHome, "models.json"), "utf8"))).toMatchObject({
      accounts: ["openrouter/personal"],
      providers: { openrouter: { apiKey: "keyring:openrouter/personal" } },
    });
    expect(JSON.parse(readFileSync(join(secondHome, "models.json"), "utf8"))).toMatchObject({
      accounts: ["openrouter/account-2"],
      providers: { openrouter: { apiKey: "keyring:openrouter/account-2" } },
    });
    expect(client.items.get("openrouter/personal")).toContain("first-key");
    expect(client.items.get("openrouter/account-2")).toContain("second-key");
  });

  it("does not overwrite Ghost-schema items when secret-free metadata was lost", () => {
    const machine = root();
    const firstHome = literalHome(machine, "one", "first-key");
    const secondHome = literalHome(machine, "two", "second-key");
    const client = new MemorySecretServiceClient();
    openContext(firstHome, client, join(machine, "first-state.sqlite")).close();
    openContext(secondHome, client, join(machine, "replacement-state.sqlite")).close();

    expect(client.items.get("openrouter/personal")).toContain("first-key");
    expect(client.items.get("openrouter/account-2")).toContain("second-key");
    expect(readFileSync(join(secondHome, "models.json"), "utf8"))
      .toContain("keyring:openrouter/account-2");
  });

  it("verifies keyring writes, replaces portable literals, and scrubs both legacy stores", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify({
      providers: {
        openrouter: {
          apiKey: "model-secret",
          headers: { "X-Provider-Token": "header-secret" },
        },
      },
      roles: {},
    }));
    writeFileSync(join(home, "mcp.json"), JSON.stringify({
      mcpServers: {
        github: {
          type: "http",
          url: "https://user:password@example.test/mcp?token=url-secret",
          headers: { Authorization: "Bearer mcp-secret" },
          oauth: { clientId: "public-client", clientSecret: "client-secret" },
        },
        local: {
          command: "server",
          args: ["--token", "argument-secret", "--verbose"],
          env: { ACCESS_TOKEN: "environment-secret" },
        },
      },
    }));
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: 2_000_000_000_000,
      },
    }));
    legacyAgentDb(agentDir);

    const client = new MemorySecretServiceClient();
    const context = openContext(home, client);
    const modelsText = readFileSync(join(home, "models.json"), "utf8");
    const mcpText = readFileSync(join(home, "mcp.json"), "utf8");
    for (const secret of [
      "model-secret",
      "header-secret",
      "url-secret",
      "mcp-secret",
      "client-secret",
      "argument-secret",
      "environment-secret",
    ]) {
      expect(`${modelsText}\n${mcpText}`).not.toContain(secret);
    }
    expect(modelsText).toContain("keyring:openrouter/personal");
    expect(mcpText).toContain("keyring:mcp.github");
    expect(() => readFileSync(join(agentDir, "auth.json"), "utf8")).toThrow();

    const scrubbedDb = new Database(join(agentDir, "agent.db"), { readonly: true });
    expect((scrubbedDb.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as { count: number }).count)
      .toBe(0);
    scrubbedDb.close();
    expect(readFileSync(join(agentDir, "agent.db")).includes(Buffer.from("live-secret"))).toBe(false);

    const store = new KeyringAuthCredentialStore(context);
    expect(store.listAuthCredentials().map((row) => row.provider).sort()).toEqual(["anthropic", "openai"]);
    store.close();
  });

  it("empties every legacy identity, usage, and cache table down to schema rows", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);

    openContext(home, new MemorySecretServiceClient()).close();

    const scrubbed = new Database(join(agentDir, "agent.db"), { readonly: true });
    const count = (table: string): number =>
      (scrubbed.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    for (const table of [
      "auth_credentials",
      "auth_credential_blocks",
      "auth_credential_refresh_leases",
      "auth_credential_block_mirror_guard",
      "cache",
      "usage_history",
      "clients",
      "client_usage",
    ]) {
      expect(count(table), table).toBe(0);
    }
    expect(scrubbed.query("SELECT version FROM auth_schema_version WHERE id = 1").get())
      .toEqual({ version: 3 });
    expect(scrubbed.query("SELECT revision FROM auth_change_revision WHERE id = 1").get())
      .toEqual({ revision: 17 });
    scrubbed.close();

    const bytes = readFileSync(join(agentDir, "agent.db"));
    for (const residue of [
      "live-secret",
      "disabled-secret",
      "someone@example.test",
      "acct-identity",
      "workstation-identity",
      "cached-usage-payload",
      "gpt-identity",
    ]) {
      expect(bytes.includes(Buffer.from(residue)), residue).toBe(false);
    }
  });

  it("deletes a credential OMP had disabled instead of migrating it", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);

    const client = new MemorySecretServiceClient();
    const context = openContext(home, client);
    const store = new KeyringAuthCredentialStore(context);
    expect(store.listAuthCredentials()).toMatchObject([
      { provider: "openai", credential: { key: "live-secret" }, disabledCause: null },
    ]);
    expect([...client.items.values()].join("\n")).not.toContain("disabled-secret");
    store.close();
  });

  it("retains every plaintext source when keyring verification fails", () => {
    const home = root();
    writeFileSync(join(home, "models.json"), JSON.stringify({
      providers: { openrouter: { apiKey: "keep-me" } },
    }));
    const client = new MemorySecretServiceClient();
    client.write = () => {};
    expect(() => openContext(home, client)).toThrow(SecretServiceError);
    expect(readFileSync(join(home, "models.json"), "utf8")).toContain("keep-me");
  });
});
