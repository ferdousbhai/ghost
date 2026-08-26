/**
 * The login HTTP surface, end to end over a real listening loopback server,
 * with a fake OMP login runtime so no real provider is touched.
 *
 *   GET  /api/ghosts/:name/providers
 *   POST /api/ghosts/:name/login
 *   GET  /api/ghosts/:name/login/:loginId
 *   POST /api/ghosts/:name/login/:loginId/input
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthInteraction, LoginManagerOptions } from "../src/auth.js";
import { LoginManager } from "../src/auth.js";
import { ghostPaths } from "../src/ghosts.js";
import { readGhostModels } from "../src/models.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import {
  apiKeyCredential,
  deferred,
  makeFakeRuntime,
  oauthCredential,
  type LoginImpl,
} from "./helpers/fake-login-runtime.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
let login: LoginManager | null = null;
let listening: ListeningServer | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  login?.dispose();
  login = null;
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

async function serveWithRuntime(
  createRuntime: NonNullable<LoginManagerOptions["createRuntime"]>,
): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({ registry: temp.registry, offline: true });
  login = new LoginManager({
    registry: temp.registry,
    createRuntime,
  });
  listening = await startDaemonServer({
    registry: temp.registry, host, login, port: 0, relay: null, apiToken: null,
  });
  return `http://127.0.0.1:${listening.port}`;
}

async function serve(loginImpl: LoginImpl, models?: Record<string, string[]>): Promise<string> {
  return serveWithRuntime(async () =>
    makeFakeRuntime({ login: loginImpl, ...(models ? { models } : {}) }));
}

async function poll(
  base: string,
  loginId: string,
  ghostName = "casper",
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/api/ghosts/${ghostName}/login/${loginId}`);
  return (await response.json()) as Record<string, unknown>;
}

async function waitForStatus(
  base: string,
  loginId: string,
  status: string,
  ghostName = "casper",
  ms = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const view = await poll(base, loginId, ghostName);
    if (view.status === status) return view;
    if (["succeeded", "failed"].includes(view.status as string) && view.status !== status) {
      throw new Error(`settled as ${view.status}, wanted ${status}: ${JSON.stringify(view)}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}: ${JSON.stringify(view)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function waitForMoveReservation(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (login?.moveReservationCount !== 1) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the login move gate");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function startLogin(base: string): Promise<Response> {
  return fetch(`${base}/api/ghosts/casper/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "openrouter", authType: "api_key" }),
  });
}

function deferredFilesystemRuntime(): {
  createRuntime: NonNullable<LoginManagerOptions["createRuntime"]>;
  constructionStarted: Promise<{ authPath: string }>;
  finishConstruction: () => void;
  marker: string;
  calls: () => number;
} {
  const started = deferred<{ authPath: string }>();
  const finish = deferred();
  const marker = "runtime-opened";
  let calls = 0;
  return {
    createRuntime: async (input) => {
      calls += 1;
      started.resolve({ authPath: input.authPath });
      await finish.promise;
      mkdirSync(dirname(input.authPath), { recursive: true });
      writeFileSync(join(dirname(input.authPath), marker), "ready", "utf8");
      return makeFakeRuntime({
        login: async (_providerId, _authType, interaction) => {
          await interaction.prompt({ type: "secret", message: "Paste the API key" });
          return apiKeyCredential();
        },
      });
    },
    constructionStarted: started.promise,
    finishConstruction: () => finish.resolve(),
    marker,
    calls: () => calls,
  };
}

describe("GET /api/ghosts/:name/providers", () => {
  it("returns the loginable providers", async () => {
    const base = await serve(async () => oauthCredential());
    const response = await fetch(`${base}/api/ghosts/casper/providers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: { id: string }[] };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toContain("openai-codex");
    expect(ids).toContain("openrouter");
    expect(ids).not.toContain("amazon-bedrock");
  });
});

describe("POST /api/ghosts/:name/login", () => {
  it("rejects a bad body and an unknown provider", async () => {
    const base = await serve(async () => oauthCredential());
    const bad = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openrouter", authType: "nope" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_request" } });

    const unknown = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "made-up", authType: "oauth" }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown_provider" } });
  });

  it("binds OMP's provider default after login instead of the first catalogue row", async () => {
    const base = await serve(
      async () => apiKeyCredential(),
      { openrouter: ["deepseek/deepseek-r1:free", "openai/gpt-5.5"] },
    );
    const response = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openrouter", authType: "api_key" }),
    });
    const { loginId } = (await response.json()) as { loginId: string };

    const done = await waitForStatus(base, loginId, "succeeded");
    expect(done.modelBound).toEqual({ provider: "openrouter", modelId: "openai/gpt-5.5" });
    expect(readGhostModels(ghostPaths(join(temp!.root, "casper")).home)?.roles?.chat_model)
      .toEqual({ provider: "openrouter", modelId: "openai/gpt-5.5" });
  });
});

describe("the full url + paste state machine", () => {
  it("walks start → awaiting_input → succeeded and never leaks the pasted code", async () => {
    const received: string[] = [];
    const impl: LoginImpl = async (_id, _type, interaction: AuthInteraction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example/go" });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      received.push(code);
      return oauthCredential();
    };
    const base = await serve(impl);

    const start = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex", authType: "oauth" }),
    });
    expect(start.status).toBe(201);
    const { loginId } = (await start.json()) as { loginId: string };

    const awaiting = await waitForStatus(base, loginId, "awaiting_input");
    expect(awaiting.authUrl).toBe("https://auth.example/go");
    expect((awaiting.prompt as { secret: boolean }).secret).toBe(true);

    const input = await fetch(`${base}/api/ghosts/casper/login/${loginId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "PASTE-XYZ-SECRET" }),
    });
    expect(input.status).toBe(200);

    const done = await waitForStatus(base, loginId, "succeeded");
    expect(done.status).toBe("succeeded");
    expect(received).toEqual(["PASTE-XYZ-SECRET"]);

    // The secret never appears in a subsequent GET body.
    const finalRaw = await (await fetch(`${base}/api/ghosts/casper/login/${loginId}`)).text();
    expect(finalRaw).not.toContain("PASTE-XYZ-SECRET");
  });

  it("keeps the login and credential store attached to a renamed ghost home", async () => {
    const base = await serveWithRuntime(async ({ authPath }) => {
      const authStorage = await AuthStorage.create(join(dirname(authPath), "agent.db"));
      await authStorage.reload();
      return {
        ...makeFakeRuntime({
          models: { openrouter: ["m-1"] },
          login: async (providerId, _authType, interaction) => {
            const key = await interaction.prompt({ type: "secret", message: "Paste the API key" });
            const credential = { type: "api_key" as const, key };
            await authStorage.set(providerId, credential);
            return credential;
          },
        }),
        close: () => authStorage.close(),
      };
    });

    const start = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openrouter", authType: "api_key" }),
    });
    const { loginId } = (await start.json()) as { loginId: string };
    await waitForStatus(base, loginId, "awaiting_input");

    const renamed = await fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob" }),
    });
    expect(renamed.status).toBe(200);
    expect((await poll(base, loginId, "bob")).status).toBe("awaiting_input");
    expect((await fetch(`${base}/api/ghosts/casper/login/${loginId}`)).status).toBe(404);

    const input = await fetch(`${base}/api/ghosts/bob/login/${loginId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-after-rename" }),
    });
    expect(input.status).toBe(200);
    const done = await waitForStatus(base, loginId, "succeeded", "bob");
    expect(done.modelBound).toEqual({ provider: "openrouter", modelId: "m-1" });

    const agentDir = ghostPaths(join(temp!.root, "bob")).agentDir;
    const database = join(agentDir, "agent.db");
    expect(existsSync(database)).toBe(true);
    const stored = await AuthStorage.create(database);
    try {
      await stored.reload();
      expect(stored.get("openrouter")).toEqual({ type: "api_key", key: "sk-after-rename" });
    } finally {
      stored.close();
    }
    expect(readGhostModels(ghostPaths(join(temp!.root, "bob")).home)?.roles?.chat_model)
      .toEqual({ provider: "openrouter", modelId: "m-1" });
  });

  it("cancels a deleted ghost's login and does not give it to a replacement", async () => {
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    try {
      const base = await serve(async (_providerId, _authType, interaction) => {
        await interaction.prompt({ type: "secret", message: "Paste the API key" });
        return apiKeyCredential();
      });
      process.env.XDG_DATA_HOME = join(temp!.root, "xdg-data");

      const start = await fetch(`${base}/api/ghosts/casper/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "openrouter", authType: "api_key" }),
      });
      const { loginId } = (await start.json()) as { loginId: string };
      await waitForStatus(base, loginId, "awaiting_input");

      const deleted = await fetch(`${base}/api/ghosts/casper?confirm=casper`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);
      expect(login?.size).toBe(0);

      temp!.registry.create("casper");
      const replacement = await fetch(`${base}/api/ghosts/casper/login/${loginId}`);
      expect(replacement.status).toBe(404);
      expect(await replacement.json()).toMatchObject({ error: { code: "login_not_found" } });
    } finally {
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
  });
});

describe("whole-home moves during login runtime construction", () => {
  it("drains construction before rename and gates a second login start", async () => {
    const runtime = deferredFilesystemRuntime();
    const base = await serveWithRuntime(runtime.createRuntime);
    const starting = startLogin(base);
    const { authPath } = await runtime.constructionStarted;

    const renaming = fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob" }),
    });
    await waitForMoveReservation();

    const blocked = await startLogin(base);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "ghost_busy" } });
    expect(runtime.calls()).toBe(1);

    runtime.finishConstruction();
    const [started, renamed] = await Promise.all([starting, renaming]);
    expect(started.status).toBe(201);
    expect(renamed.status).toBe(200);
    const { loginId } = (await started.json()) as { loginId: string };
    await waitForStatus(base, loginId, "awaiting_input", "bob");

    expect(existsSync(join(temp!.root, "casper"))).toBe(false);
    expect(existsSync(join(temp!.root, "bob", ".pi", runtime.marker))).toBe(true);
    expect(dirname(authPath)).toBe(join(temp!.root, "casper", ".pi"));
    expect(login?.moveReservationCount).toBe(0);
  });

  it("drains construction before delete without recreating the old home", async () => {
    const runtime = deferredFilesystemRuntime();
    const base = await serveWithRuntime(runtime.createRuntime);
    const starting = startLogin(base);
    await runtime.constructionStarted;

    const deleting = fetch(`${base}/api/ghosts/casper?confirm=casper`, { method: "DELETE" });
    await waitForMoveReservation();

    const blocked = await startLogin(base);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "ghost_busy" } });
    expect(runtime.calls()).toBe(1);

    runtime.finishConstruction();
    const [started, deleted] = await Promise.all([starting, deleting]);
    expect(started.status).toBe(201);
    expect(deleted.status).toBe(200);
    const { loginId } = (await started.json()) as { loginId: string };
    const { trash } = (await deleted.json()) as { trash: string };

    expect(existsSync(join(temp!.root, "casper"))).toBe(false);
    expect(existsSync(join(trash, ".pi", runtime.marker))).toBe(true);
    expect(login?.size).toBe(0);
    expect(login?.moveReservationCount).toBe(0);

    const gone = await fetch(`${base}/api/ghosts/casper/login/${loginId}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("releases the login gate when the home move is refused", async () => {
    const base = await serve(async (_providerId, _authType, interaction) => {
      await interaction.prompt({ type: "secret", message: "Paste the API key" });
      return apiKeyCredential();
    });
    temp!.registry.create("bob");

    const collision = await fetch(`${base}/api/ghosts/casper/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob" }),
    });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({ error: { code: "already_exists" } });
    expect(login?.moveReservationCount).toBe(0);

    const started = await startLogin(base);
    expect(started.status).toBe(201);
  });
});

describe("input errors", () => {
  it("409s when there is no pending prompt and 404s an unknown login", async () => {
    const impl: LoginImpl = async (_id, _type, interaction) => {
      await interaction.prompt({ type: "secret", message: "key" });
      return apiKeyCredential();
    };
    const base = await serve(impl, { openrouter: ["m-1"] });

    const missing = await fetch(`${base}/api/ghosts/casper/login/does-not-exist`, { method: "GET" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "login_not_found" } });

    const start = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openrouter", authType: "api_key" }),
    });
    const { loginId } = (await start.json()) as { loginId: string };
    await waitForStatus(base, loginId, "awaiting_input");
    // Satisfy it, then a second input has no pending prompt.
    await fetch(`${base}/api/ghosts/casper/login/${loginId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-key" }),
    });
    await waitForStatus(base, loginId, "succeeded");
    const late = await fetch(`${base}/api/ghosts/casper/login/${loginId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "again" }),
    });
    expect(late.status).toBe(409);
  });
});

describe("encoded login route segments", () => {
  it("returns a typed 400 for malformed login ids on status and input routes", async () => {
    const base = await serve(async () => oauthCredential());
    for (const request of [
      { path: "/api/ghosts/casper/login/%", init: undefined },
      {
        path: "/api/ghosts/casper/login/%/input",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "code" }),
        },
      },
    ]) {
      const response = await fetch(`${base}${request.path}`, request.init);
      expect(response.status, request.path).toBe(400);
      expect(await response.json(), request.path).toEqual({
        error: {
          code: "invalid_request",
          message: "URL path segments must use valid percent-encoding.",
        },
      });
    }
  });

  it("decodes valid login ids on status and input routes", async () => {
    const impl: LoginImpl = async (_id, _type, interaction) => {
      const value = await interaction.prompt({ type: "text", message: "Paste the code" });
      expect(value).toBe("accepted");
      return oauthCredential();
    };
    const base = await serve(impl);
    const start = await fetch(`${base}/api/ghosts/casper/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex", authType: "oauth" }),
    });
    const { loginId } = (await start.json()) as { loginId: string };
    const encodedLoginId = loginId.replace("-", "%2D");

    expect((await waitForStatus(base, encodedLoginId, "awaiting_input")).loginId).toBe(loginId);
    const input = await fetch(`${base}/api/ghosts/casper/login/${encodedLoginId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "accepted" }),
    });
    expect(input.status).toBe(200);
    expect((await input.json() as { loginId: string }).loginId).toBe(loginId);
    expect((await waitForStatus(base, encodedLoginId, "succeeded")).loginId).toBe(loginId);
  });
});
