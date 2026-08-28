/**
 * The model indicator + switcher HTTP surface, end to end over a real
 * listening loopback server, with a fake catalogue so no real OMP registry,
 * provider, or network is touched.
 *
 *   GET /api/ghosts/:name/model
 *   GET /api/ghosts/:name/models?scope=available|catalog&provider=&q=&limit=&offset=
 *   PUT /api/ghosts/:name/model  { provider, id }
 */
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import {
  DEFAULT_MODELS_LIMIT,
  MAX_MODELS_LIMIT,
  ModelCatalog,
  type ModelCatalogRuntime,
} from "../src/model-catalog.js";
import { readGhostModels, setChatModelRole, writeGhostModels } from "../src/models.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import {
  makeFakeCatalogRuntime,
  sampleCatalog,
  type FakeCatalogModel,
} from "./helpers/fake-catalog-runtime.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

interface ServeOptions {
  models?: FakeCatalogModel[];
  credentialed?: string[];
  oauth?: string[];
  claudePlan?: boolean;
}

async function serve(options: ServeOptions = {}): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({ registry: temp.registry, offline: true });
  const runtime: ModelCatalogRuntime = makeFakeCatalogRuntime({
    models: options.models ?? sampleCatalog(),
    ...(options.credentialed ? { credentialed: options.credentialed } : {}),
    ...(options.oauth ? { oauth: options.oauth } : {}),
  });
  const catalog = new ModelCatalog({
    registry: temp.registry,
    offline: true,
    createRuntime: async () => runtime,
    claudeCodePlanStatus: async () => options.claudePlan ?? false,
  });
  listening = await startDaemonServer({
    registry: temp.registry, host, catalog, port: 0, relay: null, apiToken: null,
  });
  return `http://127.0.0.1:${listening.port}`;
}

function agentDir(name = "casper"): string {
  if (!temp) throw new Error("no temp ghosts");
  return ghostPaths(`${temp.root}/${name}`).home;
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await fetch(url);
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

describe("GET /api/ghosts/:name/model", () => {
  it("reports the external Claude Code runtime without asking OMP to resolve it", async () => {
    const base = await serve({ claudePlan: true });
    setChatModelRole(agentDir(), "claude-code", "default");
    const { status, body } = await getJson(`${base}/api/ghosts/casper/model`);
    expect(status).toBe(200);
    expect(body).toEqual({
      current: {
        provider: "claude-code",
        id: "default",
        name: "Claude Code (your Claude plan)",
        hasVision: true,
      },
      source: "role",
    });
  });

  it("reports source=role when roles.chat_model is set and resolves", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    setChatModelRole(agentDir(), "openai-codex", "gpt-5-codex");
    const { status, body } = await getJson(`${base}/api/ghosts/casper/model`);
    expect(status).toBe(200);
    expect(body.source).toBe("role");
    expect(body.current).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5-codex",
      hasVision: true,
      contextWindow: 400_000,
    });
  });

  it("reports source=default from a hand-declared provider model when no role is set", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    // A providers block with a model but no roles.chat_model: pi's fallback.
    writeGhostModels(agentDir(), {
      providers: { "openai-codex": { models: [{ id: "gpt-5-mini" }] } },
    });
    const { body } = await getJson(`${base}/api/ghosts/casper/model`);
    expect(body.source).toBe("default");
    expect(body.current).toMatchObject({ provider: "openai-codex", id: "gpt-5-mini" });
  });

  it("reports source=default from the first available model when nothing is declared", async () => {
    const base = await serve({ credentialed: ["anthropic"] });
    const { body } = await getJson(`${base}/api/ghosts/casper/model`);
    expect(body.source).toBe("default");
    expect(body.current).toMatchObject({ provider: "anthropic", id: "claude-opus-4" });
  });

  it("matches the provider-aware default OMP gives a fresh session", async () => {
    const base = await serve({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-6", input: ["text"] },
        { provider: "anthropic", id: "claude-opus-4-8", input: ["text"] },
      ],
      credentialed: ["anthropic"],
    });

    const { body } = await getJson(`${base}/api/ghosts/casper/model`);
    expect(body).toMatchObject({
      source: "default",
      current: { provider: "anthropic", id: "claude-opus-4-8" },
    });
  });

  it("reports source=none when nothing is usable", async () => {
    const base = await serve({ credentialed: [] });
    const { body } = await getJson(`${base}/api/ghosts/casper/model`);
    expect(body).toEqual({ current: null, source: "none" });
  });
});

describe("GET /api/ghosts/:name/models?scope=available", () => {
  it("includes Claude Code only when the external CLI has plan auth", async () => {
    const base = await serve({ claudePlan: true });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?provider=claude-code`);
    expect(body.models).toEqual([expect.objectContaining({
      provider: "claude-code",
      id: "default",
      connectedVia: "claude_plan",
      hasVision: true,
    })]);
  });

  it("lists only credentialed providers and flags the current selection", async () => {
    const base = await serve({ credentialed: ["openai-codex"], oauth: ["openai-codex"] });
    setChatModelRole(agentDir(), "openai-codex", "gpt-5-codex");
    const { body } = await getJson(`${base}/api/ghosts/casper/models`);
    expect(body.scope).toBe("available");
    const models = body.models as Array<Record<string, unknown>>;
    // Only openai-codex is credentialed; anthropic must be absent.
    expect(models.every((m) => m.provider === "openai-codex")).toBe(true);
    expect(models).toHaveLength(2);
    const current = models.find((m) => m.current === true);
    expect(current).toMatchObject({ id: "gpt-5-codex", connectedVia: "oauth", hasVision: true });
    // available rows carry cost and connectedVia but no `usable` flag.
    expect(current).toHaveProperty("cost");
    expect(current).not.toHaveProperty("usable");
  });

  it("returns an empty list when no provider is credentialed", async () => {
    const base = await serve({ credentialed: [] });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?scope=available`);
    expect(body.models).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("orders models by provider priority, then newest version like OMP", async () => {
    const models: FakeCatalogModel[] = [
      { provider: "openai-codex", id: "gpt-5.3-codex-spark", input: ["text"] },
      { provider: "openai-codex", id: "gpt-5.6-terra", input: ["text"] },
      { provider: "openai-codex", id: "gpt-5.4-mini", input: ["text"] },
      { provider: "openai-codex", id: "gpt-5.6-luna", input: ["text"] },
      { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
      { provider: "openai-codex", id: "gpt-5.6-sol", input: ["text"] },
      { provider: "priority", id: "model-9", priority: 5, input: ["text"] },
      { provider: "priority", id: "model-2", priority: 1, input: ["text"] },
    ];
    const base = await serve({ models, credentialed: ["openai-codex", "priority"] });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?scope=available`);
    const ids = (body.models as Array<{ provider: string; id: string }>).map(
      (model) => `${model.provider}/${model.id}`,
    );

    expect(ids).toEqual([
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.4-mini",
      "openai-codex/gpt-5.3-codex-spark",
      "priority/model-2",
      "priority/model-9",
    ]);
  });

  it("ranks dashed versions, latest aliases, and dated snapshots like OMP", async () => {
    const models: FakeCatalogModel[] = [
      { provider: "anthropic", id: "claude-opus-4-5", input: ["text"] },
      { provider: "anthropic", id: "claude-opus-4-6", input: ["text"] },
      { provider: "anthropic", id: "claude-opus-4-6-20260701", input: ["text"] },
      { provider: "anthropic", id: "claude-opus-4-6-latest", input: ["text"] },
      { provider: "anthropic", id: "claude-opus-4-6-20260801", input: ["text"] },
    ];
    const base = await serve({ models, credentialed: ["anthropic"] });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?scope=available`);

    expect((body.models as Array<{ id: string }>).map((model) => model.id)).toEqual([
      "claude-opus-4-6-latest",
      "claude-opus-4-6-20260801",
      "claude-opus-4-6-20260701",
      "claude-opus-4-6",
      "claude-opus-4-5",
    ]);
  });

  it("keeps providers in catalogue order while using OMP order within each provider", async () => {
    const base = await serve({
      models: [
        { provider: "z-provider", id: "model-1", input: ["text"] },
        { provider: "a-provider", id: "model-2", input: ["text"] },
      ],
      credentialed: ["z-provider", "a-provider"],
    });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?scope=available`);

    expect((body.models as Array<{ provider: string }>).map((model) => model.provider)).toEqual([
      "z-provider",
      "a-provider",
    ]);
  });
});

describe("GET /api/ghosts/:name/models?scope=catalog", () => {
  it("shows an unauthenticated Claude Code choice with usable=false", async () => {
    const base = await serve({ claudePlan: false });
    const { body } = await getJson(
      `${base}/api/ghosts/casper/models?scope=catalog&provider=claude-code`,
    );
    expect(body.models).toEqual([expect.objectContaining({
      provider: "claude-code",
      id: "default",
      usable: false,
    })]);
  });

  it("includes uncredentialed models with usable=false and connectedVia only when usable", async () => {
    const base = await serve({ credentialed: ["openai-codex"], oauth: ["openai-codex"] });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?scope=catalog`);
    expect(body.scope).toBe("catalog");
    const models = body.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(4);
    const anthropic = models.find((m) => m.provider === "anthropic");
    expect(anthropic).toMatchObject({ usable: false });
    expect(anthropic).not.toHaveProperty("connectedVia");
    const codex = models.find((m) => m.id === "gpt-5-codex");
    expect(codex).toMatchObject({ usable: true, connectedVia: "oauth" });
    const claudeCode = models.find((m) => m.provider === "claude-code");
    expect(claudeCode).toMatchObject({ usable: false });
  });

  it("honors the provider filter", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    const { body } = await getJson(`${base}/api/ghosts/casper/models?scope=catalog&provider=anthropic`);
    const models = body.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: "anthropic", id: "claude-opus-4" });
    expect(body.provider).toBe("anthropic");
  });

  it("honors the q substring filter on id and name", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    const byId = await getJson(`${base}/api/ghosts/casper/models?scope=catalog&q=mini`);
    expect((byId.body.models as unknown[]).length).toBe(1);
    expect((byId.body.models as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "gpt-5-mini" });
    const byName = await getJson(`${base}/api/ghosts/casper/models?scope=catalog&q=opus`);
    expect((byName.body.models as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "claude-opus-4" });
  });

  it("paginates and caps a large catalogue", async () => {
    const big: FakeCatalogModel[] = Array.from({ length: 250 }, (_, i) => ({
      provider: "big",
      id: `model-${String(i).padStart(3, "0")}`,
      input: ["text"] as const,
    }));
    const base = await serve({ models: big, credentialed: [] });

    // Default page caps at DEFAULT_MODELS_LIMIT with the full count in `total`.
    const first = await getJson(`${base}/api/ghosts/casper/models?scope=catalog&provider=big`);
    expect((first.body.models as unknown[]).length).toBe(DEFAULT_MODELS_LIMIT);
    expect(first.body.total).toBe(250);
    expect(first.body.limit).toBe(DEFAULT_MODELS_LIMIT);
    expect((first.body.models as Array<{ id: string }>)[0]?.id).toBe("model-249");

    // offset pages into the sorted list.
    const paged = await getJson(
      `${base}/api/ghosts/casper/models?scope=catalog&provider=big&limit=10&offset=100`,
    );
    const ids = (paged.body.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe("model-149");

    // limit is clamped to MAX_MODELS_LIMIT.
    const huge = await getJson(
      `${base}/api/ghosts/casper/models?scope=catalog&provider=big&limit=100000`,
    );
    expect(huge.body.limit).toBe(MAX_MODELS_LIMIT);
    expect((huge.body.models as unknown[]).length).toBe(250);
  });

  it("400s an invalid scope", async () => {
    const base = await serve();
    const { status, body } = await getJson(`${base}/api/ghosts/casper/models?scope=bogus`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("PUT /api/ghosts/:name/model", () => {
  async function put(base: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}/api/ghosts/casper/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("writes roles.chat_model and round-trips through GET", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    const set = await put(base, { provider: "openai-codex", id: "gpt-5-codex" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      ok: true,
      usable: true,
      source: "role",
      current: { provider: "openai-codex", id: "gpt-5-codex" },
    });
    expect(set.body).not.toHaveProperty("warning");

    const after = await getJson(`${base}/api/ghosts/casper/model`);
    expect(after.body.source).toBe("role");
    expect(after.body.current).toMatchObject({ provider: "openai-codex", id: "gpt-5-codex" });
  });

  it("selects the externally authenticated Claude Code plan runtime", async () => {
    const base = await serve({ claudePlan: true });
    const set = await put(base, { provider: "claude-code", id: "default" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      ok: true,
      usable: true,
      current: { provider: "claude-code", id: "default" },
    });
    expect(set.body).not.toHaveProperty("warning");

    const after = await getJson(`${base}/api/ghosts/casper/model`);
    expect(after.body.current).toMatchObject({ provider: "claude-code", id: "default" });
  });

  it("writes Claude Code selection but explains external login when unavailable", async () => {
    const base = await serve({ claudePlan: false });
    const set = await put(base, { provider: "claude-code", id: "default" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, usable: false });
    expect(set.body.warning).toContain("claude auth login");
  });

  it("still writes an uncredentialed provider but returns usable=false + warning", async () => {
    const base = await serve({ credentialed: [] });
    const set = await put(base, { provider: "anthropic", id: "claude-opus-4" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, usable: false });
    expect(typeof set.body.warning).toBe("string");
    // The role was written, but it is not current until its provider is usable.
    const after = await getJson(`${base}/api/ghosts/casper/model`);
    expect(after.body).toEqual({ current: null, source: "none" });
  });

  it("400s a model not in the catalogue", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    const { status, body } = await put(base, { provider: "openai-codex", id: "no-such-model" });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "unknown_model" } });
  });

  it("400s a missing provider or id", async () => {
    const base = await serve();
    expect((await put(base, { id: "gpt-5-codex" })).status).toBe(400);
    expect((await put(base, { provider: "openai-codex" })).status).toBe(400);
  });
});

describe("OMP model roles and fallback chains", () => {
  async function putRouting(
    base: string,
    payload: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}/api/ghosts/casper/model-routing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("lists every OMP built-in with effective source metadata and hides empty legacy roles", async () => {
    const base = await serve({ credentialed: ["openai-codex", "anthropic"] });
    const route = await getJson(`${base}/api/ghosts/casper/model-routing`);
    const roles = route.body.roles as Array<Record<string, unknown>>;

    expect(roles.map((role) => role.role)).toEqual([
      "chat_model",
      "smol_model",
      "slow_model",
      "vision_model",
      "plan_model",
      "designer_model",
      "commit_model",
      "tiny_model",
      "task_model",
      "advisor_model",
    ]);
    expect(roles.every((role) => "effective" in role && "source" in role)).toBe(true);
    expect(roles.some((role) => role.role === "general_purpose_model")).toBe(false);
    expect(roles.some((role) => role.role === "research_model")).toBe(false);
  });

  it("configures a custom role and an ordered fallback chain", async () => {
    const base = await serve({ credentialed: ["openai-codex", "anthropic"] });
    expect((await putRouting(base, {
      role: "research_model",
      target: "primary",
      provider: "openai-codex",
      id: "gpt-5-codex",
    })).status).toBe(200);
    expect((await putRouting(base, {
      role: "research_model",
      target: "fallback",
      provider: "anthropic",
      id: "claude-opus-4",
    })).status).toBe(200);

    const route = await getJson(`${base}/api/ghosts/casper/model-routing`);
    const research = (route.body.roles as Array<Record<string, unknown>>)
      .find((item) => item.role === "research_model") as Record<string, unknown>;
    expect(research).toMatchObject({
      ompRole: "research",
      label: "Research",
      primary: { provider: "openai-codex", id: "gpt-5-codex", resolved: true, usable: true },
      fallbacks: [
        { provider: "anthropic", id: "claude-opus-4", resolved: true, usable: true },
      ],
    });
    expect(readGhostModels(agentDir())).toMatchObject({
      roles: { research_model: { provider: "openai-codex", modelId: "gpt-5-codex" } },
      fallbacks: {
        research_model: [{ provider: "anthropic", modelId: "claude-opus-4" }],
      },
    });
  });

  it("enforces vision capability and excludes Claude Code from OMP fallbacks", async () => {
    const base = await serve({ claudePlan: true });
    const noVision = await putRouting(base, {
      role: "vision_model",
      target: "primary",
      provider: "openai-codex",
      id: "gpt-5-mini",
    });
    expect(noVision).toMatchObject({ status: 400, body: { error: { code: "model_has_no_vision" } } });
    const claudeFallback = await putRouting(base, {
      role: "chat_model",
      target: "fallback",
      provider: "claude-code",
      id: "default",
    });
    expect(claudeFallback).toMatchObject({
      status: 400,
      body: { error: { code: "unsupported_model_route" } },
    });
  });

  it("routes the smol role and rejects its retired title_model name", async () => {
    const base = await serve({ credentialed: ["anthropic"] });
    expect((await putRouting(base, {
      role: "smol_model",
      target: "primary",
      provider: "anthropic",
      id: "claude-opus-4",
    })).status).toBe(200);
    const route = await getJson(`${base}/api/ghosts/casper/model-routing`);
    const smol = (route.body.roles as Array<Record<string, unknown>>)
      .find((item) => item.role === "smol_model") as Record<string, unknown>;
    expect(smol).toMatchObject({
      ompRole: "smol",
      primary: { provider: "anthropic", id: "claude-opus-4", resolved: true },
    });
    expect((route.body.roles as Array<Record<string, unknown>>)
      .some((item) => item.role === "title_model")).toBe(false);
    expect(readGhostModels(agentDir())).toMatchObject({
      roles: { smol_model: { provider: "anthropic", modelId: "claude-opus-4" } },
    });

    // The old name is a client-facing role name, not an alias: it is unknown now.
    expect(await putRouting(base, {
      role: "title_model",
      target: "primary",
      provider: "anthropic",
      id: "claude-opus-4",
    })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
  });

  it("clears a role's fallbacks without changing its primary", async () => {
    const base = await serve({ credentialed: ["openai-codex", "anthropic"] });
    await putRouting(base, {
      role: "chat_model",
      target: "primary",
      provider: "openai-codex",
      id: "gpt-5-codex",
    });
    await putRouting(base, {
      role: "chat_model",
      target: "fallback",
      provider: "anthropic",
      id: "claude-opus-4",
    });
    const cleared = await putRouting(base, {
      role: "chat_model",
      target: "clear_fallbacks",
    });
    expect(cleared.status).toBe(200);
    expect(readGhostModels(agentDir())?.roles?.chat_model?.modelId).toBe("gpt-5-codex");
    expect(readGhostModels(agentDir())?.fallbacks?.chat_model).toBeUndefined();
  });

  it("clears an explicit primary and atomically replaces, reorders, and removes fallbacks", async () => {
    const base = await serve({ credentialed: ["openai-codex", "anthropic"] });
    await putRouting(base, {
      role: "slow_model",
      target: "primary",
      provider: "openai-codex",
      id: "gpt-5-codex",
    });

    const replaced = await putRouting(base, {
      role: "slow_model",
      target: "replace_fallbacks",
      fallbacks: [
        { provider: "anthropic", id: "claude-opus-4" },
        { provider: "openai-codex", id: "gpt-5-mini" },
      ],
    });
    expect(replaced.status).toBe(200);
    const reordered = await putRouting(base, {
      role: "slow_model",
      target: "replace_fallbacks",
      fallbacks: [
        { provider: "openai-codex", id: "gpt-5-mini" },
        { provider: "anthropic", id: "claude-opus-4" },
      ],
    });
    expect(reordered.status).toBe(200);
    expect(readGhostModels(agentDir())?.fallbacks?.slow_model).toEqual([
      { provider: "openai-codex", modelId: "gpt-5-mini" },
      { provider: "anthropic", modelId: "claude-opus-4" },
    ]);

    const removed = await putRouting(base, {
      role: "slow_model",
      target: "replace_fallbacks",
      fallbacks: [{ provider: "anthropic", id: "claude-opus-4" }],
    });
    expect(removed.status).toBe(200);
    expect(readGhostModels(agentDir())?.fallbacks?.slow_model).toEqual([
      { provider: "anthropic", modelId: "claude-opus-4" },
    ]);

    const clearedPrimary = await putRouting(base, {
      role: "slow_model",
      target: "clear_primary",
    });
    expect(clearedPrimary.status).toBe(200);
    expect(readGhostModels(agentDir())?.roles?.slow_model).toBeUndefined();
    const slow = (clearedPrimary.body.roles as Array<Record<string, unknown>>)
      .find((role) => role.role === "slow_model") as Record<string, unknown>;
    expect(slow).toMatchObject({ primary: null, source: "auto" });
  });

  it("validates full fallback replacement bodies before mutation", async () => {
    const base = await serve({ credentialed: ["openai-codex"] });
    expect(await putRouting(base, {
      role: "chat_model",
      target: "replace_fallbacks",
      fallbacks: "not-an-array",
    })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await putRouting(base, {
      role: "chat_model",
      target: "replace_fallbacks",
      fallbacks: [{ provider: "openai-codex" }],
    })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(readGhostModels(agentDir())?.fallbacks?.chat_model).toBeUndefined();
  });
});

describe("no credential ever leaks into a response", () => {
  it("omits the models.json apiKey from every model response", async () => {
    const secret = "sk-super-secret-key-xyz";
    const base = await serve({ credentialed: ["openai-codex"] });
    // A real models.json with an apiKey on disk. The endpoints read the pi
    // catalogue, never the raw file, so the key must never appear.
    writeGhostModels(agentDir(), {
      providers: { "openai-codex": { apiKey: secret, models: [{ id: "gpt-5-codex" }] } },
      roles: { chat_model: { provider: "openai-codex", modelId: "gpt-5-codex" } },
    });
    const current = await getJson(`${base}/api/ghosts/casper/model`);
    const available = await getJson(`${base}/api/ghosts/casper/models?scope=available`);
    const catalog = await getJson(`${base}/api/ghosts/casper/models?scope=catalog`);
    const put = await fetch(`${base}/api/ghosts/casper/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex", id: "gpt-5-codex" }),
    });
    const putRaw = await put.text();
    expect(current.raw).not.toContain(secret);
    expect(available.raw).not.toContain(secret);
    expect(catalog.raw).not.toContain(secret);
    expect(putRaw).not.toContain(secret);
  });
});
