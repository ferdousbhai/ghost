import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import {
  ModelCatalog,
  type ModelCatalogRuntime,
  type ModelRouteView,
} from "../src/model-catalog.js";
import {
  GHOST_MODEL_ROLES,
  readGhostModels,
  writeGhostModels,
} from "../src/models.js";
import {
  makeFakeCatalogRuntime,
  type FakeCatalogModel,
} from "./helpers/fake-catalog-runtime.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

const models: FakeCatalogModel[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    input: ["text", "image"],
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    input: ["text", "image"],
  },
  {
    provider: "openai-codex",
    id: "gpt-5.4",
    input: ["text", "image"],
  },
  {
    provider: "openai-codex",
    id: "text-only-mini",
    input: ["text"],
  },
];

function setup(): { catalog: ModelCatalog; agentDir: string; notified: string[] } {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  const home = seedGhost(temp.root, { name: "casper" });
  const runtime = makeFakeCatalogRuntime({
    models,
    credentialed: ["anthropic", "openai-codex"],
  });
  const notified: string[] = [];
  return {
    agentDir: ghostPaths(home).home,
    notified,
    catalog: new ModelCatalog({
      registry: temp.registry,
      offline: true,
      createRuntime: async () => runtime,
      claudeCodeStatus: async () => null,
      onModelRoutingChanged: (ghostName) => {
        notified.push(ghostName);
      },
    }),
  };
}

function byRole(roles: ModelRouteView[], role: ModelRouteView["role"]): ModelRouteView {
  const found = roles.find((candidate) => candidate.role === role);
  if (!found) throw new Error(`missing ${role}`);
  return found;
}

describe("ModelCatalog Ghost role inventory and effective routing", () => {
  it("exposes every Ghost built-in without empty legacy custom roles and reports automatic sources", async () => {
    const { catalog, agentDir } = setup();
    writeGhostModels(agentDir, {
      providers: {},
      roles: {
        chat_model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      },
    });

    const routing = await catalog.getModelRouting("casper");

    expect(routing.roles.map((role) => role.role)).toEqual(
      GHOST_MODEL_ROLES.filter((role) =>
        role !== "general_purpose_model" && role !== "research_model"),
    );
    expect(routing.roles.map(({ ompRole, label }) => ({ ompRole, label }))).toEqual([
      { ompRole: "default", label: "Chat" },
      { ompRole: "smol", label: "Fast" },
      { ompRole: "slow", label: "Thinking" },
      { ompRole: "vision", label: "Vision" },
      { ompRole: "plan", label: "Architect" },
      { ompRole: "designer", label: "Designer" },
      { ompRole: "commit", label: "Commit" },
      { ompRole: "tiny", label: "Tiny" },
      { ompRole: "task", label: "Subtask" },
      { ompRole: "advisor", label: "Advisor" },
    ]);
    expect(byRole(routing.roles, "chat_model")).toMatchObject({
      source: "explicit",
      primary: { provider: "anthropic", id: "claude-sonnet-4-6" },
      effective: { provider: "anthropic", id: "claude-sonnet-4-6" },
    });
    // Ghost's fast, slow, designer, and task roles inherit the configured chat
    // default when unbound.
    for (const role of ["smol_model", "slow_model", "designer_model", "task_model"] as const) {
      expect(byRole(routing.roles, role)).toMatchObject({
        source: "auto",
        primary: null,
        effective: { provider: "anthropic", id: "claude-sonnet-4-6", usable: true },
      });
    }
    // Tiny and advisor use Ghost's built-in priority semantics without any
    // hard-coded model ids. They resolve against the current Pi catalogue.
    expect(byRole(routing.roles, "tiny_model")).toMatchObject({
      source: "auto",
      effective: { provider: "anthropic", id: "claude-haiku-4-5" },
    });
    expect(byRole(routing.roles, "advisor_model")).toMatchObject({
      source: "auto",
      effective: { provider: "openai-codex", id: "gpt-5.4" },
    });
    for (const role of [
      "vision_model",
      "plan_model",
      "commit_model",
    ] as const) {
      expect(byRole(routing.roles, role)).toMatchObject({
        source: "unavailable",
        primary: null,
        effective: null,
      });
    }
  });

  it("keeps General and Research bindings as explicit legacy custom roles", async () => {
    const { catalog, agentDir } = setup();
    writeGhostModels(agentDir, {
      providers: {},
      roles: {
        general_purpose_model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
        research_model: { provider: "openai-codex", modelId: "gpt-5.4" },
      },
    });

    const routing = await catalog.getModelRouting("casper");

    expect(byRole(routing.roles, "general_purpose_model")).toMatchObject({
      ompRole: "general",
      source: "explicit",
      effective: { provider: "anthropic", id: "claude-sonnet-4-6" },
    });
    expect(byRole(routing.roles, "research_model")).toMatchObject({
      ompRole: "research",
      source: "explicit",
      effective: { provider: "openai-codex", id: "gpt-5.4" },
    });
  });
});

describe("ModelCatalog primary and full-chain mutations", () => {
  it("clears an explicit primary and returns to automatic/unavailable resolution", async () => {
    const { catalog, agentDir, notified } = setup();
    await catalog.setModelRoute(
      "casper",
      "plan_model",
      "primary",
      "openai-codex",
      "gpt-5.4",
    );

    const cleared = await catalog.clearModelPrimary("casper", "plan_model");

    expect(byRole(cleared.roles, "plan_model")).toMatchObject({
      source: "unavailable",
      primary: null,
      effective: null,
    });
    expect(readGhostModels(agentDir)?.roles?.plan_model).toBeUndefined();
    expect(notified).toEqual(["casper", "casper"]);
  });

  it("replaces and reorders a complete fallback chain atomically", async () => {
    const { catalog, agentDir } = setup();
    await catalog.setModelRoute(
      "casper",
      "slow_model",
      "primary",
      "openai-codex",
      "gpt-5.4",
    );
    await catalog.replaceModelFallbacks("casper", "slow_model", [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ]);
    const reordered = await catalog.replaceModelFallbacks("casper", "slow_model", [
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ]);

    expect(byRole(reordered.roles, "slow_model").fallbacks.map(({ provider, id }) => ({ provider, id })))
      .toEqual([
        { provider: "anthropic", id: "claude-haiku-4-5" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ]);
    expect(readGhostModels(agentDir)?.fallbacks?.slow_model).toEqual([
      { provider: "anthropic", modelId: "claude-haiku-4-5" },
      { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    ]);

    await expect(catalog.replaceModelFallbacks("casper", "slow_model", [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ])).rejects.toMatchObject({ code: "duplicate_route_model", status: 400 });
    await expect(catalog.replaceModelFallbacks("casper", "slow_model", [
      { provider: "openai-codex", id: "gpt-5.4" },
    ])).rejects.toMatchObject({ code: "duplicate_route_model", status: 400 });
  });

  it("enforces vision capability and keeps Claude Code out of every other role/chain", async () => {
    const { catalog } = setup();

    await expect(catalog.setModelRoute(
      "casper",
      "vision_model",
      "primary",
      "openai-codex",
      "text-only-mini",
    )).rejects.toMatchObject({ code: "model_has_no_vision", status: 400 });
    await expect(catalog.replaceModelFallbacks("casper", "vision_model", [
      { provider: "openai-codex", id: "text-only-mini" },
    ])).rejects.toMatchObject({ code: "model_has_no_vision", status: 400 });
    await expect(catalog.setModelRoute(
      "casper",
      "slow_model",
      "primary",
      "claude-code",
      "default",
    )).rejects.toMatchObject({ code: "unsupported_model_route", status: 400 });
    await expect(catalog.replaceModelFallbacks("casper", "chat_model", [
      { provider: "claude-code", id: "default" },
    ])).rejects.toMatchObject({ code: "unsupported_model_route", status: 400 });
    await expect(catalog.replaceModelFallbacks("casper", "advisor_model", [
      { provider: "claude-code", id: "default" },
    ])).rejects.toMatchObject({ code: "unsupported_model_route", status: 400 });
  });

  it("binds the advisor role to Claude Code as the review teacher", async () => {
    const { catalog } = setup();

    const routing = await catalog.setModelRoute(
      "casper",
      "advisor_model",
      "primary",
      "claude-code",
      "default",
    );
    const advisor = routing.roles.find((role) => role.role === "advisor_model");
    expect(advisor?.source).toBe("explicit");
    expect(advisor?.primary).toMatchObject({
      provider: "claude-code",
      id: "default",
      resolved: true,
    });
  });
});

describe("ModelCatalog runtime lifecycle", () => {
  function setupLifecycle() {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const close = vi.fn();
    const runtime: ModelCatalogRuntime = {
      ...makeFakeCatalogRuntime({
        models,
        credentialed: ["anthropic", "openai-codex"],
      }),
      close,
    };
    const createRuntime = vi.fn(async () => runtime);
    return {
      close,
      createRuntime,
      catalog: new ModelCatalog({
        registry: temp.registry,
        offline: true,
        createRuntime,
        claudeCodeStatus: async () => null,
      }),
    };
  }

  it("reuses and closes one runtime for a successful mutation and response", async () => {
    const { catalog, close, createRuntime } = setupLifecycle();

    const routing = await catalog.setModelRoute(
      "casper",
      "plan_model",
      "primary",
      "openai-codex",
      "gpt-5.4",
    );

    expect(byRole(routing.roles, "plan_model").primary).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the runtime when an operation throws", async () => {
    const { catalog, close, createRuntime } = setupLifecycle();

    await expect(catalog.setChatModel("casper", "missing", "unknown"))
      .rejects.toMatchObject({ code: "unknown_model", status: 400 });

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid Claude harness route before opening the credential runtime", async () => {
    const { catalog, close, createRuntime } = setupLifecycle();

    await expect(catalog.setChatModel("casper", "claude-code", "not-default"))
      .rejects.toMatchObject({ code: "unknown_model", status: 400 });
    await expect(catalog.setModelRoute(
      "casper",
      "chat_model",
      "primary",
      "claude-code",
      "not-default",
    )).rejects.toMatchObject({ code: "unsupported_model_route", status: 400 });
    await expect(catalog.replaceModelFallbacks("casper", "chat_model", [{
      provider: "claude-code",
      id: "default",
    }])).rejects.toMatchObject({ code: "unsupported_model_route", status: 400 });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    ["current model", (catalog: ModelCatalog) => catalog.getCurrent("casper"), "rename"],
    ["model listing", (catalog: ModelCatalog) => catalog.listModels("casper"), "delete"],
    ["model routing", (catalog: ModelCatalog) => catalog.getModelRouting("casper"), "rename"],
  ] as const)("holds the home lease through %s runtime construction and use", async (
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
    const probeName = "catalog-runtime-probe";
    const runtime = makeFakeCatalogRuntime({
      models,
      credentialed: ["anthropic", "openai-codex"],
    });
    const catalog = new ModelCatalog({
      registry: temp.registry,
      homeOperations,
      offline: true,
      createRuntime: async (input) => {
        entered.resolve();
        await resume.promise;
        mkdirSync(dirname(input.authPath), { recursive: true });
        writeFileSync(join(dirname(input.authPath), probeName), "leased\n");
        return runtime;
      },
      claudeCodeStatus: async () => null,
    });

    const reading = use(catalog);
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
    await reading;
    await moving;
    expect(existsSync(oldHome)).toBe(false);
    expect(existsSync(join(ghostPaths(movedHome).agentDir, probeName))).toBe(true);
    if (move === "rename") expect(existsSync(join(temp.root, "wisp"))).toBe(true);
  });
});
