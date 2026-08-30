import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { GhostSecretContext } from "../src/keyring-credential-store.js";
import {
  type AgentDbFaultStage,
  openGhostSecretContext,
} from "../src/secret-migration.js";
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

function openContext(
  home: string,
  client: MemorySecretServiceClient,
  metadataPath = join(home, "state.sqlite"),
): GhostSecretContext {
  return openGhostSecretContext({ home, client, metadataPath });
}

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
function legacyAgentDb(agentDir: string, fileName = "agent.db"): void {
  const db = new Database(join(agentDir, fileName));
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

/** A stable copied SQLite set whose only enabled credential lives in the WAL. */
function hotWalAgentDb(agentDir: string): void {
  const source = join(agentDir, "wal-source.db");
  legacyAgentDb(agentDir, "wal-source.db");
  const writer = new Database(source);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.exec("DELETE FROM auth_credentials");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.query(`
    INSERT INTO auth_credentials(provider, credential_type, data, disabled_cause)
    VALUES (?, 'api_key', ?, NULL)
  `).run("wal-provider", JSON.stringify({ key: "wal-secret" }));

  const target = join(agentDir, "agent.db");
  copyFileSync(source, target);
  copyFileSync(`${source}-wal`, `${target}-wal`);
  copyFileSync(`${source}-shm`, `${target}-shm`);
  writer.close();
  rmSync(source, { force: true });
  rmSync(`${source}-wal`, { force: true });
  rmSync(`${source}-shm`, { force: true });
}

function credentialRowCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as {
      count: number;
    }).count;
  } finally {
    db.close();
  }
}

function listCredentials(context: GhostSecretContext, provider?: string) {
  return context.allowedCredentialRows(provider).map((row) => ({
    id: row.id,
    provider: row.provider,
    credential: context.credentialForRow(row),
  }));
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
    expect(listCredentials(second, "openrouter")).toMatchObject([
      { id: personalId, credential: { key: "personal-key" } },
      { id: workId, credential: { key: "work-key" } },
    ]);
    second.close();
  });

  it("serializes refresh CAS and lease fencing across contexts", () => {
    const dir = root();
    const client = new MemorySecretServiceClient();
    const first = openContext(dir, client);
    const second = openContext(dir, client);
    first.allowAccounts(["openrouter/personal"]);
    second.allowAccounts(["openrouter/personal"]);
    const id = first.registerCredential(
      "openrouter",
      { service: "openrouter", account: "personal", field: "auth" },
      { type: "api_key", key: "before" },
    );
    expect(first.tryAcquireRefreshLease(id, "owner-a", Date.now() + 60_000)).toBe(true);
    expect(second.tryAcquireRefreshLease(id, "owner-b", Date.now() + 60_000)).toBe(false);
    const fence = { owner: "owner-a", nowMs: Date.now() };
    expect(first.tryUpdateCredential(
      id,
      JSON.stringify({ key: "before" }),
      { type: "api_key", key: "after" },
      fence,
    )).toBe(true);
    expect(second.tryUpdateCredential(
      id,
      JSON.stringify({ key: "before" }),
      { type: "api_key", key: "stale" },
      fence,
    )).toBe(false);
    expect(listCredentials(second, "openrouter")[0]?.credential).toEqual({
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
    context.removeAccount({ service: "openrouter", account: "personal" });
    expect(client.items.has("openrouter/personal")).toBe(false);
    expect(client.items.has("openrouter/work")).toBe(true);
    expect(listCredentials(context, "openrouter")).toMatchObject([
      { credential: { key: "work-key" } },
    ]);
    context.close();
  });
});

describe("plaintext migration", () => {
  it("preserves a concurrent models.json replacement and migrates it on retry", () => {
    const home = literalHome(root(), "ghost", "admitted-model-secret");
    const path = join(home, "models.json");
    const displaced = `${path}.admitted`;
    const client = new MemorySecretServiceClient();
    let replaced = false;

    expect(() => openGhostSecretContext({
      home,
      client,
      metadataPath: join(home, "state.sqlite"),
      portableCommitProbe: (source, sourcePath) => {
        if (source !== "models" || replaced) return;
        replaced = true;
        renameSync(sourcePath, displaced);
        writeFileSync(sourcePath, JSON.stringify({
          providers: { winner: { apiKey: "replacement-model-secret" } },
          roles: { chat_model: { provider: "winner", modelId: "winner-model" } },
        }));
      },
    })).toThrow(/changed before its private migration could be committed/);

    expect(readFileSync(path, "utf8")).toContain("replacement-model-secret");
    expect(readFileSync(displaced, "utf8")).toContain("admitted-model-secret");

    openContext(home, client).close();
    const migrated = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      providers: { winner: { apiKey: "keyring:winner/personal" } },
      roles: { chat_model: { provider: "winner", modelId: "winner-model" } },
      accounts: ["winner/personal"],
    });
  });

  it("preserves a concurrent mcp.json replacement and authorizes its references on retry", () => {
    const home = root();
    const path = join(home, "mcp.json");
    const displaced = `${path}.admitted`;
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        admitted: { type: "http", url: "https://admitted.test", headers: { Authorization: "admitted-mcp-secret" } },
      },
    }));
    const client = new MemorySecretServiceClient();
    let replaced = false;

    expect(() => openGhostSecretContext({
      home,
      client,
      metadataPath: join(home, "state.sqlite"),
      portableCommitProbe: (source, sourcePath) => {
        if (source !== "mcp" || replaced) return;
        replaced = true;
        renameSync(sourcePath, displaced);
        writeFileSync(sourcePath, JSON.stringify({
          mcpServers: {
            winner: { type: "http", url: "https://winner.test/path", headers: { Authorization: "replacement-mcp-secret" } },
          },
        }));
      },
    })).toThrow(/changed before its private migration could be committed/);

    expect(readFileSync(path, "utf8")).toContain("replacement-mcp-secret");
    expect(readFileSync(displaced, "utf8")).toContain("admitted-mcp-secret");

    openContext(home, client).close();
    const migratedMcp = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const winner = (migratedMcp.mcpServers as Record<string, Record<string, unknown>>).winner!;
    const authorization = (winner.headers as Record<string, string>).Authorization!;
    expect(winner).toMatchObject({ type: "http", url: "https://winner.test/path" });
    expect(authorization).toMatch(/^keyring:mcp\.winner\.[0-9a-f]+\/personal#header\./);
    const reference = parseSecretReference(authorization)!;
    const migratedModels = JSON.parse(readFileSync(join(home, "models.json"), "utf8")) as { accounts: string[] };
    expect(migratedModels.accounts).toContain(`${reference.service}/${reference.account}`);
    expect(migratedModels.accounts).toHaveLength(2);
  });

  it.each(["models.json", "mcp.json"])("recovers an interrupted %s CAS before retry", (name) => {
    const home = root();
    const path = join(home, name);
    const value = name === "models.json"
      ? { providers: { openrouter: { apiKey: "recover-model-secret" } } }
      : { mcpServers: { recover: { type: "http", url: "https://recover.test", headers: { Authorization: "recover-mcp-secret" } } } };
    writeFileSync(path, JSON.stringify(value));
    renameSync(path, `${path}.ghost-migration-cas`);

    openContext(home, new MemorySecretServiceClient()).close();

    expect(existsSync(`${path}.ghost-migration-cas`)).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("keyring:");
  });

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

    expect(listCredentials(context).map((row) => row.provider).sort()).toEqual(["anthropic", "openai"]);
    context.close();
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

  it("imports a hot-WAL credential and removes every plaintext SQLite sidecar", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    hotWalAgentDb(agentDir);
    expect(existsSync(join(agentDir, "agent.db-wal"))).toBe(true);
    expect(existsSync(join(agentDir, "agent.db-shm"))).toBe(true);

    const context = openContext(home, new MemorySecretServiceClient());
    expect(listCredentials(context)).toMatchObject([
      { provider: "wal-provider", credential: { key: "wal-secret" } },
    ]);
    context.close();

    expect(existsSync(join(agentDir, "agent.db-wal"))).toBe(false);
    expect(existsSync(join(agentDir, "agent.db-shm"))).toBe(false);
    expect(readFileSync(join(agentDir, "agent.db")).includes(Buffer.from("wal-secret"))).toBe(false);
  });

  it.each([
    ["-wal", "symlink"],
    ["-wal", "hardlink"],
    ["-shm", "symlink"],
    ["-shm", "hardlink"],
  ] as const)("refuses an unsafe agent.db%s %s", (suffix, kind) => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const target = join(agentDir, `sidecar-target${suffix}`);
    const sidecar = join(agentDir, `agent.db${suffix}`);
    writeFileSync(target, "plaintext-sidecar");
    if (kind === "symlink") symlinkSync(target, sidecar);
    else linkSync(target, sidecar);

    expect(() => openContext(home, new MemorySecretServiceClient()))
      .toThrow(SecretServiceError);
    expect(readFileSync(join(agentDir, "agent.db")).includes(Buffer.from("live-secret"))).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("plaintext-sidecar");
  });

  it.each(["symlink", "hardlink"] as const)(
    "refuses to scrub an agent.db %s",
    (kind) => {
      const home = root();
      const agentDir = join(home, ".pi");
      mkdirSync(agentDir, { recursive: true });
      legacyAgentDb(agentDir);
      const path = join(agentDir, "agent.db");
      const target = join(agentDir, "target.db");
      renameSync(path, target);
      if (kind === "symlink") symlinkSync(target, path);
      else linkSync(target, path);

      expect(() => openContext(home, new MemorySecretServiceClient()))
        .toThrow(SecretServiceError);
      expect(credentialRowCount(target)).toBeGreaterThan(0);
    },
  );

  it("rejects pathname replacement between agent.db admission and claim", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const path = join(agentDir, "agent.db");
    const displaced = join(agentDir, "admitted.db");
    let replaced = false;

    expect(() => openGhostSecretContext({
      home,
      client: new MemorySecretServiceClient(),
      metadataPath: join(home, "state.sqlite"),
      agentDbProbe: (stage) => {
        if (stage !== "admitted" || replaced) return;
        replaced = true;
        renameSync(path, displaced);
        writeFileSync(path, readFileSync(displaced));
      },
    })).toThrow(SecretServiceError);

    expect(credentialRowCount(path)).toBeGreaterThan(0);
    expect(credentialRowCount(displaced)).toBeGreaterThan(0);
  });

  it("never opens an original-path replacement at the SQLite constructor boundary", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const path = join(agentDir, "agent.db");
    const replacement = readFileSync(path);
    let replaced = false;

    expect(() => openGhostSecretContext({
      home,
      client: new MemorySecretServiceClient(),
      metadataPath: join(home, "state.sqlite"),
      agentDbProbe: (stage, originalPath) => {
        if (stage !== "opening" || replaced) return;
        replaced = true;
        expect(originalPath).toBe(path);
        writeFileSync(originalPath, replacement);
      },
    })).toThrow(SecretServiceError);

    expect(credentialRowCount(path)).toBeGreaterThan(0);
    const claimDir = readdirSync(agentDir).find((entry) => entry.endsWith(".migration"));
    expect(claimDir).toBeDefined();
    expect(credentialRowCount(join(agentDir, claimDir!, "agent.db"))).toBeGreaterThan(0);
  });

  it.each(["auth", "mcp"] as const)("refuses a dangling %s plaintext source", (source) => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    const path = source === "auth" ? join(agentDir, "auth.json") : join(home, "mcp.json");
    symlinkSync("missing.json", path);

    expect(() => openContext(home, new MemorySecretServiceClient()))
      .toThrow(SecretServiceError);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("does not delete a replacement auth.json after migrating the admitted login", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    const path = join(agentDir, "auth.json");
    const displaced = join(agentDir, "admitted-auth.json");
    writeFileSync(path, JSON.stringify({
      openai: { type: "api_key", key: "admitted-login" },
    }));
    let replaced = false;

    expect(() => openGhostSecretContext({
      home,
      client: new MemorySecretServiceClient(),
      metadataPath: join(home, "state.sqlite"),
      plainFileProbe: (stage, sourcePath) => {
        if (stage !== "removing" || replaced) return;
        replaced = true;
        renameSync(sourcePath, displaced);
        writeFileSync(sourcePath, JSON.stringify({
          openai: { type: "api_key", key: "replacement-login" },
        }));
      },
    })).toThrow(/changed plaintext source/);

    expect(readFileSync(path, "utf8")).toContain("replacement-login");
    expect(readFileSync(displaced, "utf8")).toContain("admitted-login");
  });

  it.each([
    "state-written",
    "file-renamed",
    "phase-claimed",
    "phase-committed",
    "phase-scrubbing",
    "phase-scrubbed",
    "main-linked",
    "main-unlinked",
    "state-unlinked",
  ] as const)("reconciles an abrupt agent.db stop after %s", (targetStage) => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const client = new MemorySecretServiceClient();
    let stopped = false;

    expect(() => openGhostSecretContext({
      home,
      client,
      metadataPath: join(home, "state.sqlite"),
      agentDbFault: (stage) => {
        if (stage !== targetStage || stopped) return;
        stopped = true;
        throw new Error("stop now");
      },
    })).toThrow(/abrupt stop/);
    expect(stopped).toBe(true);

    const context = openContext(home, client);
    expect(listCredentials(context)).toMatchObject([
      { provider: "openai", credential: { key: "live-secret" } },
    ]);
    context.close();
    expect(readdirSync(agentDir).filter((name) => name.endsWith(".migration"))).toEqual([]);
    expect(credentialRowCount(join(agentDir, "agent.db"))).toBe(0);
  });

  it("finishes every partially claimed hot-WAL file after restart", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    hotWalAgentDb(agentDir);
    const client = new MemorySecretServiceClient();
    let stopped = false;

    expect(() => openGhostSecretContext({
      home,
      client,
      metadataPath: join(home, "state.sqlite"),
      agentDbFault: (stage, path) => {
        if (stage !== "file-renamed" || !path.endsWith("-wal") || stopped) return;
        stopped = true;
        throw new Error("stop after WAL rename");
      },
    })).toThrow(/abrupt stop/);

    const context = openContext(home, client);
    expect(listCredentials(context)).toMatchObject([
      { provider: "wal-provider", credential: { key: "wal-secret" } },
    ]);
    context.close();
    expect(readdirSync(agentDir).filter((name) => name.endsWith(".migration"))).toEqual([]);
  });

  it("retries after interruption while removing private claim evidence", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const client = new MemorySecretServiceClient();
    let stopped = false;

    expect(() => openGhostSecretContext({
      home,
      client,
      metadataPath: join(home, "state.sqlite"),
      agentDbFault: (stage: AgentDbFaultStage, path) => {
        if (stage === "phase-scrubbed") {
          writeFileSync(join(dirname(path), "cleanup-marker"), "durable evidence");
        }
        if (stage !== "claim-entry-unlinked" || stopped) return;
        stopped = true;
        throw new Error("stop during private cleanup");
      },
    })).toThrow(/abrupt stop/);

    openContext(home, client).close();
    expect(readdirSync(agentDir).filter((name) => name.endsWith(".migration"))).toEqual([]);
    expect(credentialRowCount(join(agentDir, "agent.db"))).toBe(0);
  });

  it.each(["linked", "unlinked"] as const)(
    "reconciles a crash after a restore %s the public inode",
    (point) => {
      const home = root();
      const agentDir = join(home, ".pi");
      mkdirSync(agentDir, { recursive: true });
      legacyAgentDb(agentDir);
      const client = new MemorySecretServiceClient();

      expect(() => openGhostSecretContext({
        home,
        client,
        metadataPath: join(home, "state.sqlite"),
        agentDbFault: (stage) => {
          if (stage === "phase-claimed") throw new Error("stop with a complete claim");
        },
      })).toThrow(/abrupt stop/);

      const claimDir = readdirSync(agentDir).find((name) => name.endsWith(".migration"))!;
      const claimed = join(agentDir, claimDir, "agent.db");
      const original = join(agentDir, "agent.db");
      linkSync(claimed, original);
      if (point === "unlinked") unlinkSync(claimed);

      openContext(home, client).close();
      expect(readdirSync(agentDir).filter((name) => name.endsWith(".migration"))).toEqual([]);
      expect(credentialRowCount(original)).toBe(0);
    },
  );

  it("retires a claim directory left before its initial state publication", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const orphan = join(agentDir, ".agent-db-1-deadbeef.migration");
    mkdirSync(orphan, { mode: 0o700 });
    writeFileSync(join(orphan, "state.json.1.deadbeef.tmp"), "partial state");

    openContext(home, new MemorySecretServiceClient()).close();
    expect(existsSync(orphan)).toBe(false);
    expect(credentialRowCount(join(agentDir, "agent.db"))).toBe(0);
  });

  it("reverifies the claimed agent.db before destructive cleanup", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);
    const displaced = join(agentDir, "claimed-original.db");
    let replacement = "";

    expect(() => openGhostSecretContext({
      home,
      client: new MemorySecretServiceClient(),
      metadataPath: join(home, "state.sqlite"),
      agentDbProbe: (stage, claimPath) => {
        if (stage !== "scrubbing" || replacement) return;
        replacement = claimPath;
        renameSync(claimPath, displaced);
        writeFileSync(claimPath, readFileSync(displaced));
      },
    })).toThrow(SecretServiceError);

    expect(replacement).not.toBe("");
    expect(credentialRowCount(replacement)).toBeGreaterThan(0);
    expect(credentialRowCount(displaced)).toBeGreaterThan(0);
  });

  it("deletes a credential OMP had disabled instead of migrating it", () => {
    const home = root();
    const agentDir = join(home, ".pi");
    mkdirSync(agentDir, { recursive: true });
    legacyAgentDb(agentDir);

    const client = new MemorySecretServiceClient();
    const context = openContext(home, client);
    expect(listCredentials(context)).toMatchObject([
      { provider: "openai", credential: { key: "live-secret" } },
    ]);
    expect([...client.items.values()].join("\n")).not.toContain("disabled-secret");
    context.close();
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
