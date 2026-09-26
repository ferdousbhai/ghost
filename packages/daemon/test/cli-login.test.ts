import { describe, expect, it } from "vitest";
import type { LoginView, ProviderInfo } from "../src/auth.js";
import type { CliFetch, GhostCliOptions } from "../src/cli/types.js";
import { runCli } from "./helpers/cli.js";

const OPENROUTER: ProviderInfo = {
  id: "openrouter",
  name: "OpenRouter",
  subscription: false,
  authTypes: ["api_key"],
  configured: false,
};

const ANTHROPIC: ProviderInfo = {
  id: "anthropic",
  name: "Anthropic",
  subscription: false,
  authTypes: ["oauth"],
  configured: true,
  connectedVia: "oauth",
};

function view(overrides: Partial<LoginView>): LoginView {
  return {
    loginId: "login-1",
    providerId: "openrouter",
    authType: "api_key",
    status: "starting",
    ...overrides,
  };
}

interface FakeDaemon {
  fetch: CliFetch;
  /** Method and path of every request, in order. */
  calls: string[];
  bodies: unknown[];
}

/**
 * Answers the provider and login routes from a script of successive
 * `LoginView`s: the first is the start response, the rest are handed out in
 * order to each poll and each answered prompt.
 */
function loginDaemon(providers: ProviderInfo[], views: LoginView[]): FakeDaemon {
  const remaining = [...views];
  const daemon: FakeDaemon = { calls: [], bodies: [], fetch: async () => new Response() };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  daemon.fetch = async (input, init) => {
    const { pathname } = new URL(input);
    const method = init?.method ?? "GET";
    daemon.calls.push(`${method} ${pathname}`);
    if (init?.body !== undefined) daemon.bodies.push(JSON.parse(String(init.body)));
    if (pathname === "/api/ghosts/casper/providers") return json({ providers });
    if (pathname.includes("/providers/") && method === "DELETE") {
      return json({ ok: true, providerId: "openrouter" });
    }
    if (pathname.startsWith("/api/ghosts/casper/login")) {
      const next = remaining.shift();
      if (!next) return json({ error: { message: "the script ran out of views" } }, 500);
      return json(next, method === "POST" && pathname.endsWith("/login") ? 201 : 200);
    }
    return json({ error: { message: `unexpected ${method} ${pathname}` } }, 500);
  };
  return daemon;
}

function options(daemon: FakeDaemon, extra: Partial<GhostCliOptions> = {}): GhostCliOptions {
  return {
    env: { GHOSTD_PORT: "7718" },
    home: "/tmp/ghost-cli-login",
    fetch: daemon.fetch,
    ...extra,
  };
}

describe("ghost login", () => {
  it("spends a piped key on the first secret prompt and never echoes it", async () => {
    const daemon = loginDaemon([OPENROUTER], [
      view({ status: "starting" }),
      view({
        status: "awaiting_input",
        prompt: { kind: "secret", message: "API key", secret: true },
      }),
      view({
        status: "succeeded",
        modelBound: { provider: "openrouter", modelId: "auto" },
      }),
    ]);
    const result = await runCli(
      ["login", "openrouter", "--key-stdin", "-g", "casper"],
      options(daemon, { stdin: "sk-piped-secret\n" }),
    );

    expect(result.code).toBe(0);
    expect(daemon.bodies[0]).toEqual({
      providerId: "openrouter",
      authType: "api_key",
    });
    expect(daemon.bodies[1]).toEqual({ value: "sk-piped-secret" });
    expect(daemon.calls).toEqual([
      "GET /api/ghosts/casper/providers",
      "POST /api/ghosts/casper/login",
      "GET /api/ghosts/casper/login/login-1",
      "POST /api/ghosts/casper/login/login-1/input",
    ]);
    expect(result.stdout).toContain("Signed in to OpenRouter (openrouter).");
    expect(result.stdout).toContain("Chat model set to openrouter/auto.");
    expect(result.stdout).not.toContain("sk-piped-secret");
  });

  it("prints an auth URL once while polling an oauth flow to success", async () => {
    const daemon = loginDaemon([ANTHROPIC], [
      view({ providerId: "anthropic", authType: "oauth", status: "starting" }),
      view({
        providerId: "anthropic",
        authType: "oauth",
        status: "awaiting_url",
        authUrl: "https://example.test/authorize",
        authInstructions: "Approve the request in your browser.",
        message: "Waiting for the browser.",
      }),
      view({ providerId: "anthropic", authType: "oauth", status: "succeeded" }),
    ]);
    const result = await runCli(["login", "anthropic", "-g", "casper"], options(daemon));

    expect(result.code).toBe(0);
    expect(daemon.bodies[0]).toMatchObject({ providerId: "anthropic", authType: "oauth" });
    expect(result.stdout.match(/https:\/\/example\.test\/authorize/g)).toHaveLength(1);
    expect(result.stdout).toContain("Approve the request in your browser.");
    expect(result.stdout).toContain("Pick a model with `ghost model <provider>/<id>`.");
  });

  it("answers a select prompt by number with the option id", async () => {
    const daemon = loginDaemon([OPENROUTER], [
      view({
        status: "awaiting_select",
        prompt: {
          kind: "select",
          message: "Which organization?",
          secret: false,
          options: [
            { id: "org-a", label: "Alpha" },
            { id: "org-b", label: "Beta", description: "the other one" },
          ],
        },
      }),
      view({ status: "succeeded" }),
    ]);
    const result = await runCli(
      ["login", "openrouter", "-g", "casper"],
      options(daemon, { prompt: async () => "2" }),
    );

    expect(result.code).toBe(0);
    expect(daemon.bodies[0]).toMatchObject({ providerId: "openrouter" });
    expect(daemon.bodies[1]).toEqual({ value: "org-b" });
    expect(result.stdout).toContain("  2. Beta — the other one");
  });

  it("reports the daemon's error and exits non-zero when a login fails", async () => {
    const daemon = loginDaemon([OPENROUTER], [
      view({ status: "working", message: "Contacting OpenRouter." }),
      view({ status: "failed", error: "That key was rejected." }),
    ]);
    const result = await runCli(["login", "openrouter", "-g", "casper"], options(daemon));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("That key was rejected.");
    expect(result.stdout).not.toContain("Signed in");
  });

  it("emits only the final view under --json and refuses a prompt it cannot answer", async () => {
    const succeeded = loginDaemon([OPENROUTER], [
      view({ status: "succeeded", modelBound: { provider: "openrouter", modelId: "auto" } }),
    ]);
    const quiet = await runCli(
      ["login", "openrouter", "-g", "casper", "--json"],
      options(succeeded),
    );
    expect(quiet.code).toBe(0);
    expect(JSON.parse(quiet.stdout)).toMatchObject({ status: "succeeded", loginId: "login-1" });

    const asking = loginDaemon([OPENROUTER], [
      view({ status: "awaiting_input", prompt: { kind: "secret", message: "API key", secret: true } }),
    ]);
    const refused = await runCli(
      ["login", "openrouter", "-g", "casper", "--json"],
      options(asking),
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--key-stdin");
    expect(refused.stdout).toBe("");
  });

  it("names the auth types a provider does offer, and the providers it knows", async () => {
    const daemon = loginDaemon([ANTHROPIC], []);
    const wrongType = await runCli(
      ["login", "anthropic", "--api-key", "-g", "casper"],
      options(daemon),
    );
    expect(wrongType.code).toBe(2);
    expect(wrongType.stderr).toContain("does not offer api_key login; it offers oauth");

    const unknown = await runCli(["login", "openrouter", "-g", "casper"], options(daemon));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("ghostd offers anthropic");
    expect(daemon.calls).not.toContain("POST /api/ghosts/casper/login");
  });

  it("needs a provider to sign in to, and lends its flags to no other verb", async () => {
    const daemon = loginDaemon([OPENROUTER], []);
    const bare = await runCli(["login", "-g", "casper"], options(daemon));
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("ghost login needs a provider; ghostd offers openrouter");

    const elsewhere = await runCli(["model", "--oauth", "-g", "casper"], options(daemon));
    expect(elsewhere.code).toBe(2);
    expect(elsewhere.stderr).toContain("Unknown option: --oauth");
    expect(daemon.calls).toEqual(["GET /api/ghosts/casper/providers"]);
  });
});

describe("ghost logout", () => {
  it("signs out of one provider", async () => {
    const daemon = loginDaemon([OPENROUTER], []);
    const result = await runCli(
      ["logout", "openrouter", "-g", "casper"],
      options(daemon),
    );

    expect(result.code).toBe(0);
    expect(daemon.calls).toEqual(["DELETE /api/ghosts/casper/providers/openrouter"]);
    expect(result.stdout).toContain("Signed out of openrouter.");
  });
});

describe("ghost login --list", () => {
  it("tabulates ids, auth types, and sign-in state", async () => {
    const daemon = loginDaemon([OPENROUTER, ANTHROPIC], []);
    const result = await runCli(["login", "--list", "-g", "casper"], options(daemon));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PROVIDER");
    expect(result.stdout).toContain("openrouter  OpenRouter  api_key  —");
    expect(result.stdout).toContain("anthropic   Anthropic   oauth    oauth");
  });
});

describe("ghost model --list", () => {
  it("prints what the signed-in providers reach, one provider/id per line", async () => {
    const daemon = loginDaemon([], []);
    const inner = daemon.fetch;
    daemon.fetch = async (input, init) => new URL(input).pathname === "/api/ghosts/casper/models"
      ? new Response(JSON.stringify({ models: [{ provider: "xai", id: "grok-4.6", name: "Grok 4.6" }] }))
      : inner(input, init);
    const result = await runCli(["model", "--list", "-g", "casper"], options(daemon));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("xai/grok-4.6\n");

    const both = await runCli(["model", "xai/grok-4.6", "--list", "-g", "casper"], options(daemon));
    expect(both.code).toBe(2);
  });
});
