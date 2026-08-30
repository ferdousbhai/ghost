/**
 * The login state machine, driven through a fake Pi runtime that simulates
 * each auth callback path — URL, device code, paste, select, failure,
 * timeout — with no real provider and no network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthInteraction } from "../src/auth.js";
import {
  bindDefaultChatModelIfUnset,
  LoginManager,
  type LoginManagerOptions,
  type LoginView,
} from "../src/auth.js";
import { ghostPaths } from "../src/ghosts.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import {
  ghostModelsPath,
  readGhostModels,
  setChatModelRole,
} from "../src/models.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import {
  apiKeyCredential,
  deferred,
  makeFakeRuntime,
  oauthCredential,
  type LoginImpl,
} from "./helpers/fake-login-runtime.js";
import { fakePiModel } from "./helpers/fake-catalog-runtime.js";
import { recordingLogger } from "./helpers/recording-logger.js";

let temp: TempGhosts | null = null;
const managers: LoginManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  temp?.cleanup();
  temp = null;
});

function setup(
  login: LoginImpl,
  options: Partial<LoginManagerOptions> & { models?: Record<string, string[]> } = {},
): { manager: LoginManager; root: string } {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  const { models, ...rest } = options;
  const manager = new LoginManager({
    registry: temp.registry,
    createRuntime: async () => makeFakeRuntime({ login, ...(models ? { models } : {}) }),
    ...rest,
  });
  managers.push(manager);
  return { manager, root: temp.root };
}

async function waitFor(
  read: () => LoginView,
  predicate: (view: LoginView) => boolean,
  ms = 3000,
): Promise<LoginView> {
  const start = Date.now();
  for (;;) {
    const view = read();
    if (predicate(view)) return view;
    if (Date.now() - start > ms) throw new Error(`timed out; last = ${JSON.stringify(view)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("listProviders", () => {
  it("derives the loginable providers from pi's registry, filtering ambient-only", async () => {
    const { manager } = setup(async () => oauthCredential());
    const providers = await manager.listProviders("casper");
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("openai-codex");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("anthropic");
    // Ambient-only (no oauth, no interactive api-key login) is not loginable.
    expect(ids).not.toContain("amazon-bedrock");
    // Sorted by name.
    expect(providers.map((p) => p.name)).toEqual([...providers.map((p) => p.name)].sort());

    const codex = providers.find((p) => p.id === "openai-codex")!;
    expect(codex.subscription).toBe(true);
    expect(codex.authTypes).toEqual(["oauth"]);

    const openrouter = providers.find((p) => p.id === "openrouter")!;
    expect(openrouter.authTypes).toEqual(["oauth", "api_key"]);
    expect(openrouter.loginLabel).toBe("Sign in with OpenRouter");

    const anthropic = providers.find((p) => p.id === "anthropic")!;
    expect(anthropic.subscription).toBe(false);
    expect(anthropic.loginLabel).toBe("Sign in (extra usage)");
    expect(anthropic.billingNote).toContain("not Claude plan limits");
  });

  it("does not advertise providers an empty Pi registry cannot start", async () => {
    const login: LoginImpl = async () => oauthCredential();
    const { manager } = setup(login, {
      createRuntime: async () => makeFakeRuntime({ login, providers: [] }),
    });

    expect(await manager.listProviders("casper")).toEqual([]);
    await expect(manager.start("casper", "openai-codex", "oauth")).rejects.toMatchObject({
      code: "unknown_provider",
      status: 400,
    });
  });
});

describe("short-lived auth runtime home leases", () => {
  it.each([
    ["provider listing", (manager: LoginManager) => manager.listProviders("casper"), "rename"],
    [
      "logout",
      (manager: LoginManager) => manager.logout("casper", "openrouter", "personal"),
      "delete",
    ],
  ] as const)("holds the lease through %s runtime construction and use", async (
    _label,
    use,
    move,
  ) => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const oldHome = seedGhost(temp.root, { name: "casper" });
    const homeOperations = new HomeOperationCoordinator(temp.registry);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const probeName = "auth-runtime-probe";
    const runtime = {
      ...makeFakeRuntime({ login: async () => oauthCredential() }),
      logout: async () => {},
    };
    const manager = new LoginManager({
      registry: temp.registry,
      homeOperations,
      createRuntime: async (input) => {
        entered.resolve();
        await resume.promise;
        mkdirSync(dirname(input.authPath), { recursive: true });
        writeFileSync(join(dirname(input.authPath), probeName), "leased\n");
        return runtime;
      },
    });
    managers.push(manager);

    const using = use(manager);
    await entered.promise;
    let moved = false;
    let movedHome = "";
    const moving = homeOperations.reserveMove("casper").then((release) => {
      try {
        movedHome = move === "rename"
          ? temp!.registry.rename("casper", "wisp").dir
          : temp!.registry.trash("casper").trash;
        moved = true;
      } finally {
        release();
      }
    });
    await Promise.resolve();
    expect(homeOperations.moveReservationCount).toBe(1);
    expect(moved).toBe(false);

    resume.resolve();
    await using;
    await moving;
    expect(existsSync(oldHome)).toBe(false);
    expect(existsSync(join(ghostPaths(movedHome).agentDir, probeName))).toBe(true);
  });
});

describe("OAuth url + paste flow", () => {
  it("exposes the auth URL and a paste field, then succeeds on submitted code", async () => {
    const received: string[] = [];
    const login: LoginImpl = async (_id, _type, interaction: AuthInteraction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example/authorize?x=1" });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      received.push(code);
      return oauthCredential();
    };
    const { manager } = setup(login);

    const started = await manager.start("casper", "openai-codex", "oauth");
    const seen: string[] = [];
    const awaiting = await waitFor(
      () => {
        const v = manager.view("casper", started.loginId);
        seen.push(JSON.stringify(v));
        return v;
      },
      (v) => v.status === "awaiting_input",
    );
    expect(awaiting.authUrl).toBe("https://auth.example/authorize?x=1");
    expect(awaiting.prompt?.kind).toBe("manual_code");
    expect(awaiting.prompt?.secret).toBe(true);

    manager.submitInput("casper", started.loginId, "PASTED-SECRET-CODE");
    const done = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "succeeded" || v.status === "failed",
    );
    expect(done.status).toBe("succeeded");
    expect(received).toEqual(["PASTED-SECRET-CODE"]);
    // The pasted secret never surfaced in any polled view.
    expect(seen.join("|")).not.toContain("PASTED-SECRET-CODE");
    expect(JSON.stringify(done)).not.toContain("PASTED-SECRET-CODE");
  });
});

describe("device-code flow", () => {
  it("shows the user code and verification URL, then succeeds when the poll resolves", async () => {
    const gate = deferred();
    const login: LoginImpl = async (_id, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "WXYZ-1234",
        verificationUri: "https://device.example/activate",
        expiresInSeconds: 900,
      });
      await gate.promise;
      return oauthCredential();
    };
    const { manager } = setup(login);

    const started = await manager.start("casper", "openai-codex", "oauth");
    const waiting = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "awaiting_device_code",
    );
    expect(waiting.deviceCode).toBe("WXYZ-1234");
    expect(waiting.verificationUrl).toBe("https://device.example/activate");
    expect(waiting.deviceExpiresInSeconds).toBe(900);

    gate.resolve();
    const done = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "succeeded",
    );
    expect(done.status).toBe("succeeded");
  });
});

describe("api-key paste flow", () => {
  it("masks the field, keeps the key out of the view, and binds a default model", async () => {
    const received: string[] = [];
    const login: LoginImpl = async (_id, _type, interaction) => {
      const key = await interaction.prompt({ type: "secret", message: "OpenRouter API key" });
      received.push(key);
      return apiKeyCredential();
    };
    const { manager, root } = setup(login, { models: { openrouter: ["deepseek/deepseek-r1:free"] } });

    const started = await manager.start("casper", "openrouter", "api_key");
    const awaiting = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "awaiting_input",
    );
    expect(awaiting.prompt?.secret).toBe(true);

    manager.submitInput("casper", started.loginId, "sk-or-SECRET-KEY");
    const done = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "succeeded" || v.status === "failed",
    );
    expect(done.status).toBe("succeeded");
    expect(received).toEqual(["sk-or-SECRET-KEY"]);
    expect(JSON.stringify(done)).not.toContain("sk-or-SECRET-KEY");

    // A ghost with no chat model gets one bound on success.
    expect(done.modelBound).toEqual({ provider: "openrouter", modelId: "deepseek/deepseek-r1:free" });
    const models = JSON.parse(readFileSync(ghostModelsPath(ghostPaths(join(root, "casper")).home), "utf8"));
    expect(models.roles.chat_model).toEqual({ provider: "openrouter", modelId: "deepseek/deepseek-r1:free" });
    // The secret is nowhere in the ghost's models.json either.
    expect(JSON.stringify(models)).not.toContain("sk-or-SECRET-KEY");
  });
});

describe("successful login refresh", () => {
  it("does not publish succeeded until the cached-runtime hook settles", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const refreshed: string[] = [];
    const { manager } = setup(async () => oauthCredential(), {
      onLoginSucceeded: async (ghostName) => {
        refreshed.push(ghostName);
        entered.resolve();
        await release.promise;
      },
    });

    const started = await manager.start("casper", "openai-codex", "oauth");
    await entered.promise;
    expect(manager.view("casper", started.loginId)).toMatchObject({
      status: "working",
      message: "Finishing sign-in.",
    });
    expect(refreshed).toEqual(["casper"]);

    release.resolve();
    await expect(waitFor(
      () => manager.view("casper", started.loginId),
      (view) => view.status === "succeeded",
    )).resolves.toMatchObject({ status: "succeeded" });
  });

  it("binds the default model in a renamed home when discovery was already pending", async () => {
    const discoveryStarted = deferred<void>();
    const finishDiscovery = deferred<readonly ReturnType<typeof fakePiModel>[]>();
    const { manager, root } = setup(async () => oauthCredential(), {
      createRuntime: async () => {
        const runtime = makeFakeRuntime({
          login: async () => oauthCredential(),
          models: { openrouter: ["rename-default"] },
        });
        runtime.getAvailable = async () => {
          discoveryStarted.resolve();
          return finishDiscovery.promise;
        };
        return runtime;
      },
    });

    const started = await manager.start("casper", "openrouter", "oauth");
    await discoveryStarted.promise;
    const renamed = temp!.registry.rename("casper", "wisp");
    manager.renameGhost(renamed);
    finishDiscovery.resolve([fakePiModel({ provider: "openrouter", id: "rename-default" })]);

    const done = await waitFor(
      () => manager.view("wisp", started.loginId),
      (view) => view.status === "succeeded",
    );
    expect(done.modelBound).toEqual({ provider: "openrouter", modelId: "rename-default" });
    expect(existsSync(join(root, "casper"))).toBe(false);
    expect(readGhostModels(ghostPaths(join(root, "wisp")).home)?.roles?.chat_model)
      .toEqual({ provider: "openrouter", modelId: "rename-default" });
  });

  it("aborts a finishing hook at the login TTL and never resurrects success", async () => {
    const entered = deferred<void>();
    const finished = deferred<void>();
    let hookSignal: AbortSignal | undefined;
    const { manager } = setup(async () => oauthCredential(), {
      loginTtlMs: 30,
      retainSettledMs: 1_000,
      onLoginSucceeded: async (_ghostName, signal) => {
        hookSignal = signal;
        entered.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        finished.resolve();
      },
    });

    const started = await manager.start("casper", "openai-codex", "oauth");
    await entered.promise;
    const timedOut = await waitFor(
      () => manager.view("casper", started.loginId),
      (view) => view.status === "failed",
    );
    await finished.promise;
    expect(hookSignal?.aborted).toBe(true);
    expect(timedOut.error).toMatch(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.view("casper", started.loginId).status).toBe("failed");
  });

  it("does not enter the refresh hook when the TTL expires during default binding", async () => {
    const finishDiscovery = deferred<readonly ReturnType<typeof fakePiModel>[]>();
    const refreshed: string[] = [];
    const { manager, root } = setup(async () => oauthCredential(), {
      loginTtlMs: 30,
      retainSettledMs: 1_000,
      createRuntime: async () => {
        const runtime = makeFakeRuntime({
          login: async () => oauthCredential(),
          models: { "openai-codex": ["default-after-timeout"] },
        });
        runtime.getAvailable = () => finishDiscovery.promise;
        return runtime;
      },
      onLoginSucceeded: async (ghostName) => {
        refreshed.push(ghostName);
      },
    });

    const started = await manager.start("casper", "openai-codex", "oauth");
    const timedOut = await waitFor(
      () => manager.view("casper", started.loginId),
      (view) => view.status === "failed",
    );
    finishDiscovery.resolve([
      fakePiModel({ provider: "openai-codex", id: "default-after-timeout" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(timedOut.error).toMatch(/timed out/i);
    const terminal = manager.view("casper", started.loginId);
    expect(terminal.status).toBe("failed");
    expect(terminal.modelBound).toBeUndefined();
    expect(refreshed).toEqual([]);
    expect(readGhostModels(ghostPaths(join(root, "casper")).home)?.roles?.chat_model)
      .toBeUndefined();
  });

  it("cannot bind or publish a model after disposal during default discovery", async () => {
    const finishDiscovery = deferred<readonly ReturnType<typeof fakePiModel>[]>();
    const { manager, root } = setup(async () => oauthCredential(), {
      createRuntime: async () => {
        const runtime = makeFakeRuntime({
          login: async () => oauthCredential(),
          models: { "openai-codex": ["default-after-dispose"] },
        });
        runtime.getAvailable = () => finishDiscovery.promise;
        return runtime;
      },
    });

    const started = await manager.start("casper", "openai-codex", "oauth");
    await waitFor(
      () => manager.view("casper", started.loginId),
      (view) => view.status === "working",
    );
    manager.dispose();
    finishDiscovery.resolve([
      fakePiModel({ provider: "openai-codex", id: "default-after-dispose" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.size).toBe(0);
    expect(readGhostModels(ghostPaths(join(root, "casper")).home)?.roles?.chat_model)
      .toBeUndefined();
  });
});

describe("default model binding", () => {
  it("does not overwrite an explicit choice made while provider discovery is pending", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const dir = seedGhost(temp.root, { name: "casper" });
    const agentDir = ghostPaths(dir).home;
    const discoveryStarted = deferred();
    const finishDiscovery = deferred<readonly ReturnType<typeof fakePiModel>[]>();
    const binding = bindDefaultChatModelIfUnset(
      agentDir,
      {
        async getAvailable() {
          discoveryStarted.resolve();
          return finishDiscovery.promise;
        },
        getModels() {
          return [];
        },
      },
      "openrouter",
    );
    await discoveryStarted.promise;

    setChatModelRole(agentDir, "openai-codex", "gpt-5-codex");
    finishDiscovery.resolve([fakePiModel({ provider: "openrouter", id: "login-default" })]);

    await expect(binding).resolves.toBeNull();
    expect(readGhostModels(agentDir)?.roles?.chat_model).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5-codex",
    });
  });
});

describe("select flow", () => {
  it("offers options and rejects an unlisted value", async () => {
    const chosen: string[] = [];
    const login: LoginImpl = async (_id, _type, interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "How do you want to sign in?",
        options: [
          { id: "callback", label: "Open a browser" },
          { id: "device_code", label: "Use a device code" },
        ],
      });
      chosen.push(method);
      return oauthCredential();
    };
    const { manager } = setup(login);

    const started = await manager.start("casper", "openai-codex", "oauth");
    const awaiting = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "awaiting_select",
    );
    expect(awaiting.prompt?.options?.map((o) => o.id)).toEqual(["callback", "device_code"]);

    expect(() => manager.submitInput("casper", started.loginId, "not-an-option")).toThrowError(
      /not one of the offered options/,
    );

    manager.submitInput("casper", started.loginId, "device_code");
    const done = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "succeeded",
    );
    expect(done.status).toBe("succeeded");
    expect(chosen).toEqual(["device_code"]);
  });
});

describe("failure", () => {
  it("surfaces the provider's error message", async () => {
    const login: LoginImpl = async () => {
      throw new Error("invalid_grant: the code has expired");
    };
    const { manager } = setup(login);
    const started = await manager.start("casper", "anthropic", "oauth");
    const done = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "failed",
    );
    expect(done.error).toContain("invalid_grant");
  });
});

describe("timeout and cleanup", () => {
  it("abandons an unfinished login and then drops it", async () => {
    // A login that hangs until aborted.
    const login: LoginImpl = (_id, _type, interaction) =>
      new Promise((_resolve, reject) => {
        interaction.notify({ type: "auth_url", url: "https://auth.example/hang" });
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const { manager } = setup(login, { loginTtlMs: 40, retainSettledMs: 60 });

    const started = await manager.start("casper", "openrouter", "oauth");
    const failed = await waitFor(
      () => manager.view("casper", started.loginId),
      (v) => v.status === "failed",
    );
    expect(failed.error).toBe("Login timed out.");

    // After the retention window the session is gone entirely.
    const deadline = Date.now() + 3000;
    while (manager.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(manager.size).toBe(0);
    expect(() => manager.view("casper", started.loginId)).toThrowError(/No login/);
  });
});

describe("per-ghost isolation", () => {
  it("keeps a login private to its ghost and writes only that ghost's models.json", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    seedGhost(temp.root, { name: "mina" });
    const login: LoginImpl = async (_id, _type, interaction) => {
      await interaction.prompt({ type: "secret", message: "key" });
      return apiKeyCredential();
    };
    const manager = new LoginManager({
      registry: temp.registry,
      createRuntime: async () => makeFakeRuntime({ login, models: { openrouter: ["m-1"] } }),
    });
    managers.push(manager);

    const started = await manager.start("casper", "openrouter", "api_key");
    await waitFor(() => manager.view("casper", started.loginId), (v) => v.status === "awaiting_input");

    // A different ghost cannot read casper's login.
    expect(() => manager.view("mina", started.loginId)).toThrowError(/No login/);

    manager.submitInput("casper", started.loginId, "sk-secret");
    await waitFor(() => manager.view("casper", started.loginId), (v) => v.status === "succeeded");

    // Only casper's models.json was written; mina's is untouched.
    const casperModels = ghostModelsPath(ghostPaths(join(temp.root, "casper")).home);
    const minaModels = ghostModelsPath(ghostPaths(join(temp.root, "mina")).home);
    expect(readFileSync(casperModels, "utf8")).toContain("openrouter");
    expect(() => readFileSync(minaModels, "utf8")).toThrowError();
  });
});

describe("logging never carries secrets", () => {
  it("keeps a pasted key out of every log line", async () => {
    const logger = recordingLogger();
    const login: LoginImpl = async (_id, _type, interaction) => {
      await interaction.prompt({ type: "secret", message: "key" });
      return apiKeyCredential();
    };
    const { manager } = setup(login, { logger, models: { openrouter: ["m-1"] } });
    const started = await manager.start("casper", "openrouter", "api_key");
    await waitFor(() => manager.view("casper", started.loginId), (v) => v.status === "awaiting_input");
    manager.submitInput("casper", started.loginId, "sk-TOP-SECRET");
    await waitFor(() => manager.view("casper", started.loginId), (v) => v.status === "succeeded");
    expect(JSON.stringify(logger.records)).not.toContain("sk-TOP-SECRET");
    // But something WAS logged (start + success), proving the assertion is live.
    expect(logger.records.some(({ message }) => message.includes("login succeeded"))).toBe(true);
  });
});

describe("validation", () => {
  it("rejects an unknown provider and an unsupported auth type", async () => {
    const { manager } = setup(async () => oauthCredential());
    await expect(manager.start("casper", "nope", "oauth")).rejects.toMatchObject({ code: "unknown_provider" });
    // openai-codex offers oauth only.
    await expect(manager.start("casper", "openai-codex", "api_key")).rejects.toMatchObject({
      code: "unsupported_auth_type",
    });
  });
  it("404s a login for an unknown ghost", async () => {
    const { manager } = setup(async () => oauthCredential());
    await expect(manager.start("ghosty", "openrouter", "oauth")).rejects.toMatchObject({ code: "not_found" });
  });
});
