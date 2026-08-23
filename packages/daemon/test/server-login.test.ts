/**
 * The login HTTP surface, end to end over a real listening loopback server,
 * with a fake `ModelRuntime.login()` so no real provider is touched.
 *
 *   GET  /api/ghosts/:name/providers
 *   POST /api/ghosts/:name/login
 *   GET  /api/ghosts/:name/login/:loginId
 *   POST /api/ghosts/:name/login/:loginId/input
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { LoginManager } from "../src/auth.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { apiKeyCredential, makeFakeRuntime, oauthCredential, type LoginImpl } from "./helpers/fake-login-runtime.js";

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

async function serve(loginImpl: LoginImpl, models?: Record<string, string[]>): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({ registry: temp.registry, offline: true });
  login = new LoginManager({
    registry: temp.registry,
    createRuntime: async () => makeFakeRuntime({ login: loginImpl, ...(models ? { models } : {}) }),
  });
  listening = await startDaemonServer({
    registry: temp.registry, host, login, port: 0, relay: null, apiToken: null,
  });
  return `http://127.0.0.1:${listening.port}`;
}

async function poll(base: string, loginId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/api/ghosts/casper/login/${loginId}`);
  return (await response.json()) as Record<string, unknown>;
}

async function waitForStatus(base: string, loginId: string, status: string, ms = 3000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const view = await poll(base, loginId);
    if (view.status === status) return view;
    if (["succeeded", "failed"].includes(view.status as string) && view.status !== status) {
      throw new Error(`settled as ${view.status}, wanted ${status}: ${JSON.stringify(view)}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}: ${JSON.stringify(view)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
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
