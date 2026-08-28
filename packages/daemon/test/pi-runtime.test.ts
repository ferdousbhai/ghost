import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyringModelsDocument } from "../src/model-config-view.js";
import { openAiCompatiblePreset, writeGhostModels } from "../src/models.js";
import { GhostPiCredentialStore } from "../src/pi-credential-store.js";
import { GhostPiRuntime } from "../src/pi-runtime.js";
import { openGhostSecretContext } from "../src/secret-migration.js";
import { MemorySecretServiceClient } from "../src/secret-service.js";
import { makeTempGhosts, useCleanups } from "./helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";

const cleanups = useCleanups();

function tempRoot(): string {
  const temp = makeTempGhosts();
  cleanups.push(() => temp.cleanup());
  return temp.root;
}

function openContext(home: string, client: MemorySecretServiceClient) {
  const context = openGhostSecretContext({ home, client, metadataPath: join(home, "state.sqlite") });
  cleanups.push(() => context.close());
  return context;
}

/** A store over a fresh keyring; `allow` lists the accounts policy admits. */
function storeFixture(allow: string[] = []) {
  const home = tempRoot();
  const client = new MemorySecretServiceClient();
  const context = openContext(home, client);
  context.allowAccounts(allow);
  const authorized: string[][] = [];
  const store = new GhostPiCredentialStore(context, {
    authorizeAccounts: (accounts) => authorized.push([...accounts]),
  });
  return { home, client, context, store, authorized };
}

describe("keyringModelsDocument", () => {
  it("projects providers with keyring references replaced by a placeholder", () => {
    expect(keyringModelsDocument({
      providers: {
        fake: {
          name: "Display name",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "keyring:fake/personal",
          headers: { "X-Team": "keyring:fake/personal#team", "X-Plain": "yes" },
          models: [{ id: "m" }],
        },
        keyless: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "k" }] },
      },
      accounts: ["fake/personal"],
    })).toEqual({
      providers: {
        fake: {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "ghost-keyring-reference",
          headers: { "X-Team": "ghost-keyring-reference", "X-Plain": "yes" },
          models: [{ id: "m" }],
        },
        keyless: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "k" }] },
      },
    });
    expect(keyringModelsDocument(
      { providers: { keyless: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "k" }] } } },
      { legacyKeylessAuth: true },
    ).providers.keyless).toMatchObject({ auth: "none" });
  });
});

describe("GhostPiCredentialStore", () => {
  it("presents the first allowed account as the provider credential", async () => {
    const { context, store } = storeFixture(["openrouter/work", "openrouter/personal"]);
    context.registerCredential(
      "openrouter",
      { service: "openrouter", account: "personal", field: "auth" },
      { type: "api_key", key: "personal-key" },
    );
    context.registerCredential(
      "openrouter",
      { service: "openrouter", account: "work", field: "auth" },
      { type: "oauth", refresh: "r", access: "a", expires: 5 },
    );

    expect(await store.read("openrouter")).toEqual({ type: "api_key", key: "personal-key" });
    expect(await store.read("anthropic")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "openrouter", type: "api_key" }]);
    expect(store.listProviderAccounts("openrouter")).toEqual([
      { account: "work", configured: true, connectedVia: "oauth" },
      { account: "personal", configured: true, connectedVia: "api_key" },
    ]);

    store.setWriteAccount("openrouter", "work");
    expect(await store.read("openrouter")).toMatchObject({ type: "oauth", access: "a" });
  });

  it("stores a new login into the selected account and admits an implicit one", async () => {
    const { context, store, authorized } = storeFixture();

    const implicit = await store.modify("anthropic", async (current) => {
      expect(current).toBeUndefined();
      return { type: "api_key", key: "first" };
    });
    expect(implicit).toEqual({ type: "api_key", key: "first" });
    expect(authorized).toEqual([["anthropic/personal"]]);
    expect(context.allowedAccounts.has("anthropic/personal")).toBe(true);

    store.setWriteAccount("anthropic", "work");
    context.allowAccounts(["anthropic/work"]);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "second" }));
    store.clearWriteAccount();
    expect(authorized).toHaveLength(1);
    expect(store.listProviderAccounts("anthropic")).toEqual([
      { account: "personal", configured: true, connectedVia: "api_key" },
      { account: "work", configured: true, connectedVia: "api_key" },
    ]);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "first" });
  });

  it("keeps pi's extra credential fields", async () => {
    const { store } = storeFixture();
    await store.modify("openai", async () => ({ type: "api_key", key: "k", env: { OPENAI_BASE_URL: "x" } }));
    await store.modify("openai-codex", async () => ({
      type: "oauth", refresh: "r", access: "a", expires: 1, accountId: "acct", plan: "pro",
    }));
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "k", env: { OPENAI_BASE_URL: "x" } });
    expect(await store.read("openai-codex")).toMatchObject({ accountId: "acct", plan: "pro" });
  });

  it("refreshes through a lease so a concurrent refresh sees the winner's credential", async () => {
    const { home, client, context: first, store: storeA } = storeFixture(["openai-codex/personal"]);
    const second = openContext(home, client);
    second.allowAccounts(["openai-codex/personal"]);
    first.registerCredential(
      "openai-codex",
      { service: "openai-codex", account: "personal", field: "auth" },
      { type: "oauth", refresh: "r1", access: "a1", expires: 1 },
    );
    const storeB = new GhostPiCredentialStore(second);

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const refreshA = storeA.modify("openai-codex", async (current) => {
      await gate;
      return { ...current!, type: "oauth", access: "a2", expires: 2 } as never;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let refreshedByB = false;
    const refreshB = storeB.modify("openai-codex", async () => {
      refreshedByB = true;
      return { type: "oauth", refresh: "r1", access: "loser", expires: 3 };
    });
    releaseA();
    expect(await refreshA).toMatchObject({ access: "a2" });
    expect(await refreshB).toMatchObject({ access: "a2" });
    expect(refreshedByB).toBe(false);

    // pi's contract: an unchanged result leaves the credential in place.
    expect(await storeB.modify("openai-codex", async () => undefined)).toMatchObject({ access: "a2" });
    expect(await storeA.read("openai-codex")).toMatchObject({ access: "a2" });
  });

  it("deletes only the selected account, otherwise every allowed one", async () => {
    const { client, context, store } = storeFixture(["fake/personal", "fake/work"]);
    for (const account of ["personal", "work"]) {
      context.registerCredential("fake", { service: "fake", account, field: "auth" }, { type: "api_key", key: account });
    }
    store.setWriteAccount("fake", "work");
    await store.delete("fake");
    store.clearWriteAccount();
    expect(store.listProviderAccounts("fake")).toEqual([
      { account: "personal", configured: true, connectedVia: "api_key" },
      { account: "work", configured: false },
    ]);
    await store.delete("fake");
    expect(await store.read("fake")).toBeUndefined();
    expect(client.items.size).toBe(0);
  });
});

describe("GhostPiRuntime", () => {
  async function runtimeFixture(): Promise<{
    runtime: GhostPiRuntime;
    home: string;
    agentDir: string;
    client: MemorySecretServiceClient;
    provider: MockProvider;
  }> {
    const machine = tempRoot();
    const provider = await startMockProvider({ script: [{ kind: "text", text: "pong" }], modelId: "fake-1" });
    cleanups.push(() => provider.close());
    const home = join(machine, "ghost");
    mkdirSync(home);
    writeGhostModels(home, openAiCompatiblePreset({
      providerId: "fake",
      name: "Fake",
      baseUrl: provider.url,
      modelId: "fake-1",
      apiKey: "literal-secret",
    }));
    const client = new MemorySecretServiceClient();
    const agentDir = join(home, ".pi");
    const runtime = await GhostPiRuntime.create({
      home,
      agentDir,
      allowModelNetwork: false,
      client,
      metadataPath: join(machine, "state.sqlite"),
    });
    cleanups.push(() => runtime.close());
    return { runtime, home, agentDir, client, provider };
  }

  function models(home: string): { providers: { fake: { apiKey: string } }; accounts?: string[] } {
    return JSON.parse(readFileSync(join(home, "models.json"), "utf8"));
  }

  it("completes through pi with a key that lives only in the keyring", async () => {
    const { runtime, home, agentDir, provider } = await runtimeFixture();
    expect(models(home).providers.fake.apiKey).toBe("keyring:fake/personal");
    expect(readFileSync(join(agentDir, "models.pi.json"), "utf8")).not.toContain("literal-secret");

    const model = runtime.getModel("fake", "fake-1");
    expect(model).toBeDefined();
    expect(runtime.getProviderAuthStatus("fake")).toMatchObject({ configured: true });
    expect(runtime.isUsingOAuth("fake")).toBe(false);
    expect(runtime.getProviderAccounts("fake")).toEqual([
      { account: "personal", configured: true, connectedVia: "api_key" },
    ]);
    expect(runtime.getProviders().find((entry) => entry.id === "openai-codex")).toMatchObject({
      auth: { oauth: { isSubscription: true } },
    });

    const reply = await runtime.complete(model!, {
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    });
    expect(reply.content).toEqual([{ type: "text", text: "pong " }]);
    expect(provider.requests).toMatchObject([{ authorization: "Bearer literal-secret", model: "fake-1" }]);
  });

  it("logs an API key into a named keyring account and logs it out again", async () => {
    const { runtime, home, client } = await runtimeFixture();
    const credential = await runtime.login("anthropic", "api_key", {
      notify: () => {},
      prompt: async (prompt) => {
        expect(prompt.type).toBe("secret");
        return "sk-ant-test";
      },
    }, "work");
    expect(credential).toEqual({ type: "api_key", key: "sk-ant-test" });
    expect(client.items.has("anthropic/work")).toBe(true);
    expect(runtime.getProviderAccounts("anthropic")).toEqual([
      { account: "work", configured: true, connectedVia: "api_key" },
    ]);
    expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
    // Login makes the account visible to this runtime; durable policy is the
    // caller's explicit step once the flow has succeeded.
    expect(models(home).accounts).toEqual(["fake/personal"]);
    runtime.authorizeAccount("anthropic", "work", home);
    expect(models(home).accounts).toEqual(["fake/personal", "anthropic/work"]);

    await expect(runtime.logout("anthropic", "personal"))
      .rejects.toMatchObject({ code: "secret_not_authorized" });
    await runtime.logout("anthropic", "work");
    expect(client.items.has("anthropic/work")).toBe(false);
    expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
  });
});
