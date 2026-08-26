/**
 * The model indicator + switcher surface.
 *
 * The shell's "Connect a model" affordance becomes a current-model indicator
 * that an owner clicks to switch among the models their ghost can actually
 * use, or to browse the full catalogue. This module is the daemon half of
 * that: it resolves which model answers a ghost's turns, lists the usable and
 * the catalogue-wide models, and writes a new `roles.chat_model` selection.
 *
 * ## Provider catalogue is OMP's; harness entries are ours
 *
 * Every provider model this module reports comes from OMP's `ModelRegistry`:
 * `getModels` for the full models.dev-backed catalogue and `getAvailable` for
 * models a credentialed provider can serve now. The daemon hardcodes no model
 * list, so registry updates appear without Ghost code changes. A
 * `GhostOmpRuntime` is scoped to the ghost's own `models.json` + `agent.db`, so
 * "usable" is per-ghost by construction. The
 * single code-owned row, `claude-code/default`, is a runtime selector rather
 * than a model id: its usability is the external Claude Code plan-login
 * status, and selecting it bypasses OMP's model lookup.
 *
 * ## Secrets
 *
 * Nothing here reads or emits a credential. `getProviderAuthStatus` reports
 * only a boolean `configured`, and `isUsingOAuth` only which flow backs it —
 * an api key or OAuth token is never on a model, never on a response.
 *
 * The runtime is injected (`createRuntime`) so tests drive a fake catalogue
 * without a real provider or a network call, exactly as `LoginManager` does.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
  buildBrowserItems,
  sortModelItems,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";
import {
  CLAUDE_CODE_BINARY_ENV,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeProbe,
  isClaudePlanAuth,
} from "./claude-code.js";
import { GhostError, ghostPaths, type GhostRegistry } from "./ghosts.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import { silentLogger, type Logger } from "./log.js";
import {
  appendGhostModelFallback,
  clearGhostModelRole,
  clearGhostModelFallbacks,
  GHOST_MODEL_ROLES,
  GHOST_TO_OMP_MODEL_ROLE,
  ghostAuthPath,
  ghostModelSelector,
  ghostModelsPath,
  readGhostModels,
  replaceGhostModelFallbacks,
  resolveChatModelRef,
  resolveOmpChatModel,
  setChatModelRole,
  setGhostModelRole,
  type GhostModelRole,
  type GhostModelRoleBinding,
  type GhostModelsFile,
} from "./models.js";
import { createGhostOmpRuntime, type GhostOmpRuntime } from "./omp-runtime.js";

/**
 * The compatibility slice of OMP's registry/auth storage this module reads;
 * tests pass a fake catalogue through the same boundary.
 */
export interface ModelCatalogRuntime {
  /** The full catalogue, synchronous. Optionally scoped to one provider. */
  getModels(providerId?: string): readonly Model<Api>[];
  /** One model, or undefined when the pair is not in the catalogue. */
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  /** Models a credentialed provider can serve now. Optionally scoped. */
  getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
  /** Whether the ghost has a working credential for this provider. */
  getProviderAuthStatus(providerId: string): { configured: boolean };
  /** Whether a configured provider is backed by OAuth (vs an api key). */
  isUsingOAuth(providerId: string): boolean;
  /** Release the per-operation credential and catalogue handles. */
  close(): void;
}

/** OMP model fields exposed through Ghost's catalogue views. */
export type CatalogModel = Pick<Model<Api>, "provider" | "id">
  & Partial<Pick<Model<Api>, "name" | "priority" | "input" | "contextWindow" | "cost">>;

/** How a model is shown as the current selection: no cost, no credential. */
export interface ModelView {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  hasVision: boolean;
}

export type CurrentModelSource = "role" | "default" | "none";

export interface CurrentModel {
  /** The resolved chat model, or null when nothing usable resolves. */
  current: ModelView | null;
  /**
   * How it was chosen. `role` — `roles.chat_model` is set and resolves.
   * `default` — OMP's provider-default-aware fallback. `none` — nothing usable,
   * `current` is null.
   */
  source: CurrentModelSource;
}

/** One row in a `available`/`catalog` listing. */
export interface ModelListItem {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  hasVision: boolean;
  /** How the provider is signed in, when it is. Absent for an uncredentialed one. */
  connectedVia?: "oauth" | "api_key" | "claude_plan";
  /** `catalog` scope only: whether the provider is credentialed. */
  usable?: boolean;
  /** True for the ghost's current chat-model selection. */
  current: boolean;
}

export type ModelScope = "available" | "catalog";

export interface ListModelsQuery {
  scope?: ModelScope;
  /** Restrict to one provider id. */
  provider?: string;
  /** Case-insensitive substring match on model id and name. */
  q?: string;
  /** Page size. Clamped to [1, MAX_MODELS_LIMIT]; defaults to DEFAULT_MODELS_LIMIT. */
  limit?: number;
  /** Page offset into the filtered list. Clamped to >= 0. */
  offset?: number;
}

export interface ListModelsResult {
  scope: ModelScope;
  models: ModelListItem[];
  /** How many models matched the filters, before the page cap. */
  total: number;
  limit: number;
  offset: number;
  provider?: string;
  q?: string;
}

export interface SetModelResult {
  ok: true;
  /** Whether the chosen model's provider is signed in and can answer now. */
  usable: boolean;
  /** Present when `usable` is false: a message the shell can turn into a login prompt. */
  warning?: string;
  current: ModelView;
  /** Always `role`: the write set `roles.chat_model`. */
  source: "role";
}

export type ModelRouteTarget = "primary" | "fallback";

export interface ModelRouteModel extends ModelView {
  /** False means the binding remains configured but is absent from the current catalogue. */
  resolved: boolean;
  usable: boolean;
}

export type ModelRouteSource = "explicit" | "auto" | "unavailable";

export interface ModelRouteView {
  role: GhostModelRole;
  ompRole: string;
  label: string;
  /** Configured primary. Chat keeps its legacy implicit-provider primary here. */
  primary: ModelRouteModel | null;
  /** The model the role currently resolves to, including OMP automatic roles. */
  effective: ModelRouteModel | null;
  source: ModelRouteSource;
  fallbacks: ModelRouteModel[];
}

export interface ModelRoutingView {
  roles: ModelRouteView[];
}

const MODEL_ROLE_LABELS: Readonly<Record<GhostModelRole, string>> = {
  chat_model: "Chat",
  smol_model: "Fast",
  slow_model: "Thinking",
  vision_model: "Vision",
  plan_model: "Architect",
  designer_model: "Designer",
  commit_model: "Commit",
  tiny_model: "Tiny",
  task_model: "Subtask",
  advisor_model: "Advisor",
  general_purpose_model: "General purpose",
  research_model: "Research",
};

const LEGACY_COMPATIBILITY_ROLES: ReadonlySet<GhostModelRole> = new Set([
  "general_purpose_model",
  "research_model",
]);

export interface ModelRouteSelection {
  provider: string;
  id: string;
}

/**
 * The catalogue holds ~1,270 models. A listing is therefore always paginated:
 * `total` reports the full filtered count so the shell can page or refine its
 * `q`, and one response never ships more than `MAX_MODELS_LIMIT` rows.
 */
export const DEFAULT_MODELS_LIMIT = 100;
export const MAX_MODELS_LIMIT = 500;

export interface ModelCatalogOptions {
  registry: GhostRegistry;
  /** Shared gate for path-bound mutations and whole-home moves. */
  homeOperations?: HomeOperationCoordinator;
  logger?: Logger;
  /** OMP's offline posture; forbids catalogue network refresh when true. */
  offline?: boolean;
  /** Test seam: build the per-ghost runtime the catalogue reads. */
  createRuntime?: (input: {
    authPath: string;
    modelsPath: string;
    allowModelNetwork: boolean;
  }) => Promise<ModelCatalogRuntime>;
  /** Test seam for the external, credential-free Claude Code status probe. */
  claudeCodePlanStatus?: () => Promise<boolean>;
  /** Shared executable/auth probe used by both catalogue reads and turns. */
  claudeCodeProbe?: ClaudeCodeProbe;
  /**
   * Notified after `roles.chat_model` is written, with the ghost name, so a
   * live cached session rebinds to the new model instead of answering on the
   * old one forever (a cached session binds its model once, at construction).
   * The daemon wires this to `SessionHost.rebindModel`. Awaited so the switch
   * is in effect before the response returns; a failure is logged, never fatal
   * to the write.
   */
  onModelRoutingChanged?: (ghostName: string) => void | Promise<void>;
  /** @deprecated Use `onModelRoutingChanged`. Kept for API compatibility. */
  onChatModelChanged?: (ghostName: string) => void | Promise<void>;
}

const CLAUDE_CODE_MODEL: CatalogModel = {
  provider: CLAUDE_CODE_PROVIDER_ID,
  id: CLAUDE_CODE_DEFAULT_MODEL_ID,
  name: "Claude Code (your Claude plan)",
  input: ["text", "image"],
};

async function defaultClaudeCodePlanStatus(probe: ClaudeCodeProbe): Promise<boolean> {
  try {
    return isClaudePlanAuth((await probe.read()).authStatus);
  } catch {
    return false;
  }
}

async function defaultCreateRuntime(input: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
}): Promise<ModelCatalogRuntime> {
  return createGhostOmpRuntime({
    authPath: input.authPath,
    modelsPath: input.modelsPath,
    allowModelNetwork: input.allowModelNetwork,
  });
}

function hasVision(model: CatalogModel): boolean {
  return (model.input ?? []).includes("image");
}

function modelView(model: CatalogModel): ModelView {
  const view: ModelView = { provider: model.provider, id: model.id, hasVision: hasVision(model) };
  if (model.name && model.name !== model.id) view.name = model.name;
  if (typeof model.contextWindow === "number") view.contextWindow = model.contextWindow;
  return view;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_MODELS_LIMIT;
  return Math.max(1, Math.min(MAX_MODELS_LIMIT, Math.floor(limit)));
}

/**
 * Keep registry provider order while delegating every within-provider ranking
 * rule to OMP's model browser.
 */
function sortCatalogModels(models: readonly Model<Api>[]): Model<Api>[] {
  const byProvider = new Map<string, Model<Api>[]>();
  for (const model of models) {
    const group = byProvider.get(model.provider);
    if (group) group.push(model);
    else byProvider.set(model.provider, [model]);
  }

  return [...byProvider.values()].flatMap((group) => {
    const items = buildBrowserItems(group);
    sortModelItems(items);
    return items.map((item) => item.model);
  });
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/**
 * Reads a ghost's model catalogue and writes its chat-model selection. One
 * instance is shared by the daemon; every call builds a fresh per-ghost
 * runtime so it always reflects the ghost's current `models.json`/`agent.db`.
 */
export class ModelCatalog {
  private readonly registry: GhostRegistry;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly createRuntime: NonNullable<ModelCatalogOptions["createRuntime"]>;
  private readonly claudeCodePlanStatus: NonNullable<
    ModelCatalogOptions["claudeCodePlanStatus"]
  >;
  private readonly onModelRoutingChanged: ModelCatalogOptions["onModelRoutingChanged"];
  private readonly homeOperations: HomeOperationCoordinator;

  constructor(options: ModelCatalogOptions) {
    this.registry = options.registry;
    this.homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.createRuntime = options.createRuntime ?? defaultCreateRuntime;
    const claudeCodeProbe = options.claudeCodeProbe ?? new ClaudeCodeProbe({
      binaryPath: process.env[CLAUDE_CODE_BINARY_ENV] ?? "claude",
    });
    this.claudeCodePlanStatus = options.claudeCodePlanStatus
      ?? (() => defaultClaudeCodePlanStatus(claudeCodeProbe));
    this.onModelRoutingChanged = options.onModelRoutingChanged ?? options.onChatModelChanged;
  }

  /**
   * Fire the post-write hook so live sessions rebind to the new model. Never
   * throws: a failure to rebind must not turn a successful write into an error.
   */
  private async notifyModelRoutingChanged(ghostName: string): Promise<void> {
    if (!this.onModelRoutingChanged) return;
    try {
      await this.onModelRoutingChanged(ghostName);
    } catch (error) {
      this.logger.warn("model-routing change hook failed", {
        ghost: ghostName,
        error: (error as Error).message,
      });
    }
  }

  private routeModelView(
    runtime: ModelCatalogRuntime,
    binding: GhostModelRoleBinding,
    claudePlan: boolean,
  ): ModelRouteModel {
    if (binding.provider === CLAUDE_CODE_PROVIDER_ID) {
      return {
        ...modelView({
          ...CLAUDE_CODE_MODEL,
          id: binding.modelId,
          ...(binding.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID
            ? {}
            : { name: `Claude Code (${binding.modelId})` }),
        }),
        resolved: binding.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID,
        usable: claudePlan,
      };
    }
    const model = runtime.getModel(binding.provider, binding.modelId);
    if (!model) {
      return {
        provider: binding.provider,
        id: binding.modelId,
        hasVision: false,
        resolved: false,
        usable: false,
      };
    }
    return {
      ...modelView(model),
      resolved: true,
      usable: runtime.getProviderAuthStatus(model.provider).configured,
    };
  }

  /** The effective chat/default selection without treating it as explicit. */
  private automaticDefaultView(
    file: GhostModelsFile | null,
    available: readonly Model<Api>[],
  ): ModelRouteModel | null {
    const ref = resolveChatModelRef(file);
    const model = resolveOmpChatModel(ref, available);
    return model
      ? { ...modelView(model), resolved: true, usable: true }
      : null;
  }

  /**
   * Resolve an unassigned role using OMP's own `@role` expansion and priority
   * rules. `@task` is special in OMP's agent executor: it inherits the active
   * session model, so mirror that functional behavior in the routing view.
   */
  private automaticRoleView(
    file: GhostModelsFile | null,
    role: GhostModelRole,
    available: readonly Model<Api>[],
  ): ModelRouteModel | null {
    if (role === "chat_model" || role === "task_model") {
      const effectiveDefault = this.automaticDefaultView(file, available);
      // Claude Code is a separate harness, not an OMP model a task role can invoke.
      if (role === "task_model" && effectiveDefault?.provider === CLAUDE_CODE_PROVIDER_ID) return null;
      return effectiveDefault;
    }

    const ompRole = GHOST_TO_OMP_MODEL_ROLE[role];
    const roleLookup = {
      getModelRole: (candidate: string): string | undefined => {
        const ghostRole = GHOST_MODEL_ROLES.find(
          (known) => GHOST_TO_OMP_MODEL_ROLE[known] === candidate,
        );
        if (!ghostRole) return undefined;
        const binding = ghostRole === "chat_model"
          ? resolveChatModelRef(file)
          : file?.roles?.[ghostRole] ?? null;
        return binding ? ghostModelSelector(binding) : undefined;
      },
    };
    const resolved = resolveModelRoleValue(
      `@${ompRole}`,
      [...available],
      { roleLookup },
    );
    const model = resolved.model;
    return model
      ? { ...modelView(model), resolved: true, usable: true }
      : null;
  }

  private async resolveModelRouting(
    ghostName: string,
    runtime: ModelCatalogRuntime,
    configDir: string,
  ): Promise<ModelRoutingView> {
    const file = this.readModelsFile(configDir, ghostName);
    // Availability is ghost-wide, not role-wide. Resolve it once alongside
    // the independent harness check, then reuse it for every automatic role.
    const [claudePlan, available] = await Promise.all([
      this.claudeCodePlanStatus(),
      runtime.getAvailable(),
    ]);
    const roles: ModelRouteView[] = [];
    for (const role of GHOST_MODEL_ROLES) {
      // General/Research predate OMP's complete built-in role set. Keep an
      // existing binding editable without presenting empty custom roles to a
      // new owner as if OMP itself required them.
      if (LEGACY_COMPATIBILITY_ROLES.has(role)
        && !file?.roles?.[role]
        && !(file?.fallbacks?.[role]?.length)) {
        continue;
      }
      const explicit = file?.roles?.[role];
      const primary = role === "chat_model" ? resolveChatModelRef(file) : explicit ?? null;
      const primaryView = primary ? this.routeModelView(runtime, primary, claudePlan) : null;
      const effective = explicit
        ? primaryView
        : this.automaticRoleView(file, role, available);
      roles.push({
        role,
        ompRole: GHOST_TO_OMP_MODEL_ROLE[role],
        label: MODEL_ROLE_LABELS[role],
        primary: primaryView,
        effective,
        source: explicit ? "explicit" : effective ? "auto" : "unavailable",
        fallbacks: (file?.fallbacks?.[role] ?? []).map((binding) =>
          this.routeModelView(runtime, binding, claudePlan)),
      });
    }
    return { roles };
  }

  /** All durable Ghost roles and their ordered OMP retry chains. */
  async getModelRouting(ghostName: string): Promise<ModelRoutingView> {
    return this.withRuntime(ghostName, ({ runtime, configDir }) =>
      this.resolveModelRouting(ghostName, runtime, configDir));
  }

  private validateRoutingModel(
    runtime: ModelCatalogRuntime,
    role: GhostModelRole,
    target: ModelRouteTarget,
    provider: string,
    id: string,
  ): CatalogModel {
    if (provider === CLAUDE_CODE_PROVIDER_ID) {
      if (role === "chat_model" && target === "primary" && id === CLAUDE_CODE_DEFAULT_MODEL_ID) {
        return CLAUDE_CODE_MODEL;
      }
      throw new GhostError(
        "unsupported_model_route",
        "Claude Code can only be the primary chat model; OMP cannot invoke it as a role fallback.",
        400,
      );
    }
    const model = runtime.getModel(provider, id);
    if (!model) {
      throw new GhostError(
        "unknown_model",
        `No model ${JSON.stringify(id)} from provider ${JSON.stringify(provider)} in the catalogue.`,
        400,
      );
    }
    if (role === "vision_model" && !hasVision(model)) {
      throw new GhostError(
        "model_has_no_vision",
        `${JSON.stringify(`${provider}/${id}`)} cannot be assigned to the vision role.`,
        400,
      );
    }
    return model;
  }

  /** Set a role primary or append an ordered retry fallback. */
  async setModelRoute(
    ghostName: string,
    role: GhostModelRole,
    target: ModelRouteTarget,
    provider: string,
    id: string,
  ): Promise<ModelRoutingView> {
    return this.withMutationRuntime(ghostName, async ({ runtime, configDir }) => {
      const model = this.validateRoutingModel(runtime, role, target, provider, id);
      if (target === "primary") {
        setGhostModelRole(configDir, role, model.provider, model.id);
      } else {
        const file = this.readModelsFile(configDir, ghostName);
        const primary = role === "chat_model" ? resolveChatModelRef(file) : file?.roles?.[role];
        if (primary?.provider === model.provider && primary.modelId === model.id) {
          throw new GhostError(
            "duplicate_route_model",
            "A role's primary model cannot also be its fallback.",
            400,
          );
        }
        appendGhostModelFallback(configDir, role, model.provider, model.id);
      }
      await this.notifyModelRoutingChanged(ghostName);
      return this.resolveModelRouting(ghostName, runtime, configDir);
    });
  }

  /** Remove every retry fallback for one role. */
  async clearModelFallbacks(
    ghostName: string,
    role: GhostModelRole,
  ): Promise<ModelRoutingView> {
    return this.withMutationRuntime(ghostName, async ({ runtime, configDir }) => {
      clearGhostModelFallbacks(configDir, role);
      await this.notifyModelRoutingChanged(ghostName);
      return this.resolveModelRouting(ghostName, runtime, configDir);
    });
  }

  /** Clear one explicit role primary; automatic OMP resolution becomes visible immediately. */
  async clearModelPrimary(
    ghostName: string,
    role: GhostModelRole,
  ): Promise<ModelRoutingView> {
    return this.withMutationRuntime(ghostName, async ({ runtime, configDir }) => {
      clearGhostModelRole(configDir, role);
      await this.notifyModelRoutingChanged(ghostName);
      return this.resolveModelRouting(ghostName, runtime, configDir);
    });
  }

  /**
   * Validate and replace a complete ordered retry chain in one models.json
   * mutation. The same operation supports removal and reordering without a
   * sequence of observable intermediate states.
   */
  async replaceModelFallbacks(
    ghostName: string,
    role: GhostModelRole,
    selections: readonly ModelRouteSelection[],
  ): Promise<ModelRoutingView> {
    return this.withMutationRuntime(ghostName, async ({ runtime, configDir }) => {
      const file = this.readModelsFile(configDir, ghostName);
      const primary = role === "chat_model" ? resolveChatModelRef(file) : file?.roles?.[role];
      const bindings: GhostModelRoleBinding[] = [];
      const seen = new Set<string>();
      for (const selection of selections) {
        if (!selection || typeof selection.provider !== "string" || selection.provider === ""
          || typeof selection.id !== "string" || selection.id === "") {
          throw new GhostError(
            "invalid_request",
            "Every fallback must have non-empty provider and id strings.",
            400,
          );
        }
        const model = this.validateRoutingModel(
          runtime,
          role,
          "fallback",
          selection.provider,
          selection.id,
        );
        const key = `${model.provider}\0${model.id}`;
        if (seen.has(key)) {
          throw new GhostError("duplicate_route_model", "A fallback chain cannot contain duplicates.", 400);
        }
        if (primary?.provider === model.provider && primary.modelId === model.id) {
          throw new GhostError(
            "duplicate_route_model",
            "A role's primary model cannot also be its fallback.",
            400,
          );
        }
        seen.add(key);
        bindings.push({ provider: model.provider, modelId: model.id });
      }
      replaceGhostModelFallbacks(configDir, role, bindings);
      await this.notifyModelRoutingChanged(ghostName);
      return this.resolveModelRouting(ghostName, runtime, configDir);
    });
  }

  private async withRuntime<T>(
    ghostName: string,
    operation: (prepared: { runtime: ModelCatalogRuntime; configDir: string }) => T | Promise<T>,
  ): Promise<T> {
    const prepared = await this.prepare(ghostName);
    try {
      return await operation(prepared);
    } finally {
      prepared.runtime.close();
    }
  }

  private withMutationRuntime<T>(
    ghostName: string,
    operation: (prepared: { runtime: ModelCatalogRuntime; configDir: string }) => T | Promise<T>,
  ): Promise<T> {
    return this.homeOperations.withLease(ghostName, () => this.withRuntime(ghostName, operation));
  }

  private async prepare(ghostName: string): Promise<{ runtime: ModelCatalogRuntime; configDir: string }> {
    const ghost = this.registry.get(ghostName);
    const paths = ghostPaths(ghost.dir);
    const configDir = paths.home;
    const runtime = await this.createRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(configDir),
      // Off when offline: gates only catalogue refresh, never a read of the
      // already-cached static catalogue.
      allowModelNetwork: !this.offline,
    });
    return { runtime, configDir };
  }

  private readModelsFile(configDir: string, ghostName: string): GhostModelsFile | null {
    try {
      return readGhostModels(configDir);
    } catch (error) {
      // A broken models.json is not fatal to *reading* the catalogue: report as
      // if unconfigured (OMP's default applies) and log it, mirroring how
      // session-host tolerates the same file.
      this.logger.warn("models.json is unusable", { ghost: ghostName, error: (error as Error).message });
      return null;
    }
  }

  /** Which model answers this ghost's turns, and why. Mirrors session-host. */
  async getCurrent(ghostName: string): Promise<CurrentModel> {
    return this.withRuntime(ghostName, ({ runtime, configDir }) =>
      this.resolveCurrent(runtime, this.readModelsFile(configDir, ghostName)));
  }

  private async resolveCurrent(
    runtime: ModelCatalogRuntime,
    file: GhostModelsFile | null,
    availableModels?: readonly Model<Api>[],
  ): Promise<CurrentModel> {
    const role = file?.roles?.chat_model;
    if (role?.provider && role.modelId) {
      if (role.provider === CLAUDE_CODE_PROVIDER_ID) {
        return {
          current: modelView({
            ...CLAUDE_CODE_MODEL,
            id: role.modelId,
            ...(role.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID
              ? {}
              : { name: `Claude Code (${role.modelId})` }),
          }),
          source: "role",
        };
      }
      const available = availableModels ?? await runtime.getAvailable();
      const model = resolveOmpChatModel(role, available);
      if (model?.provider === role.provider && model.id === role.modelId) {
        return { current: modelView(model), source: "role" };
      }
      if (model) return { current: modelView(model), source: "default" };
      return { current: null, source: "none" };
    }
    const available = availableModels ?? await runtime.getAvailable();
    const model = resolveOmpChatModel(resolveChatModelRef(file), available);
    if (model) return { current: modelView(model), source: "default" };
    return { current: null, source: "none" };
  }

  /**
   * List models the ghost can use now (`available`) or the whole OMP catalogue
   * (`catalog`). Both honour `provider` and `q` filters and are paginated; the
   * current selection is flagged, and `catalog` rows carry `usable`.
   */
  async listModels(ghostName: string, query: ListModelsQuery = {}): Promise<ListModelsResult> {
    return this.withRuntime(ghostName, ({ runtime, configDir }) =>
      this.listModelsWithRuntime(ghostName, runtime, configDir, query));
  }

  private async listModelsWithRuntime(
    ghostName: string,
    runtime: ModelCatalogRuntime,
    configDir: string,
    query: ListModelsQuery,
  ): Promise<ListModelsResult> {
    const scope: ModelScope = query.scope === "catalog" ? "catalog" : "available";
    const file = this.readModelsFile(configDir, ghostName);
    const providerFilter = query.provider && query.provider !== "" ? query.provider : undefined;
    const needle = query.q?.trim().toLowerCase();

    const includesClaudeProvider = providerFilter === undefined
      || providerFilter === CLAUDE_CODE_PROVIDER_ID;
    const configured = file?.roles?.chat_model;
    const needsAvailable = scope === "available"
      || configured?.provider !== CLAUDE_CODE_PROVIDER_ID;
    const [available, claudePlan] = await Promise.all([
      needsAvailable
        ? runtime.getAvailable()
        : Promise.resolve([] as readonly Model<Api>[]),
      includesClaudeProvider
        ? this.claudeCodePlanStatus()
        : Promise.resolve(false),
    ]);
    const current = await this.resolveCurrent(runtime, file, available);
    const piSource = scope === "catalog"
      ? runtime.getModels(providerFilter)
      : providerFilter
        ? available.filter((model) => model.provider === providerFilter)
        : available;

    // Cache per-provider credential facts: getAvailable/getProviderAuthStatus
    // are not free, and a catalogue page revisits the same providers often.
    const connectedVia = new Map<
      string,
      "oauth" | "api_key" | "claude_plan" | undefined
    >();
    const usableOf = (provider: string): boolean => {
      if (provider === CLAUDE_CODE_PROVIDER_ID) return claudePlan;
      if (scope === "available") return true;
      return runtime.getProviderAuthStatus(provider).configured;
    };
    const connectedViaOf = (
      provider: string,
      usable: boolean,
    ): "oauth" | "api_key" | "claude_plan" | undefined => {
      if (!usable) return undefined;
      if (provider === CLAUDE_CODE_PROVIDER_ID) return "claude_plan";
      if (!connectedVia.has(provider)) {
        connectedVia.set(provider, runtime.isUsingOAuth(provider) ? "oauth" : "api_key");
      }
      return connectedVia.get(provider);
    };

    const filteredPi = piSource.filter((model) => {
      if (!needle) return true;
      return model.id.toLowerCase().includes(needle)
        || (model.name ?? "").toLowerCase().includes(needle);
    });
    const sorted: CatalogModel[] = sortCatalogModels(filteredPi);
    if (
      includesClaudeProvider
      && (scope === "catalog" || claudePlan)
      && (!needle
        || CLAUDE_CODE_MODEL.id.toLowerCase().includes(needle)
        || (CLAUDE_CODE_MODEL.name ?? "").toLowerCase().includes(needle))
    ) {
      sorted.push(CLAUDE_CODE_MODEL);
    }

    const total = sorted.length;
    const limit = clampLimit(query.limit);
    const offset = Math.min(clampOffset(query.offset), total);
    const page = sorted.slice(offset, offset + limit);

    const models = page.map((model): ModelListItem => {
      const usable = usableOf(model.provider);
      const item: ModelListItem = {
        provider: model.provider,
        id: model.id,
        hasVision: hasVision(model),
        current: current.current?.provider === model.provider && current.current.id === model.id,
      };
      if (model.name && model.name !== model.id) item.name = model.name;
      if (typeof model.contextWindow === "number") item.contextWindow = model.contextWindow;
      if (model.cost) {
        item.cost = {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
        };
      }
      const via = connectedViaOf(model.provider, usable);
      if (via) item.connectedVia = via;
      if (scope === "catalog") item.usable = usable;
      return item;
    });

    return {
      scope,
      models,
      total,
      limit,
      offset,
      ...(providerFilter ? { provider: providerFilter } : {}),
      ...(needle ? { q: query.q?.trim() } : {}),
    };
  }

  /**
   * Bind `roles.chat_model` to a catalogue model. Rejects a model not in the
   * catalogue with a structured 400. If the provider is not signed in, still
   * writes the selection but reports `usable: false` with a `warning`, so the
   * shell can prompt a login rather than the switch silently failing.
   */
  async setChatModel(ghostName: string, provider: string, id: string): Promise<SetModelResult> {
    return this.withMutationRuntime(ghostName, ({ runtime, configDir }) =>
      this.setChatModelWithRuntime(ghostName, runtime, configDir, provider, id));
  }

  private async setChatModelWithRuntime(
    ghostName: string,
    runtime: ModelCatalogRuntime,
    configDir: string,
    provider: string,
    id: string,
  ): Promise<SetModelResult> {
    if (provider === CLAUDE_CODE_PROVIDER_ID) {
      if (id !== CLAUDE_CODE_DEFAULT_MODEL_ID) {
        throw new GhostError(
          "unknown_model",
          `No model ${JSON.stringify(id)} from provider ${JSON.stringify(provider)} in the catalogue.`,
          400,
        );
      }
      setChatModelRole(configDir, provider, id);
      await this.notifyModelRoutingChanged(ghostName);
      const usable = await this.claudeCodePlanStatus();
      this.logger.info("ghost chat model set", {
        ghost: ghostName,
        provider,
        model: id,
        usable,
      });
      return {
        ok: true,
        usable,
        current: modelView(CLAUDE_CODE_MODEL),
        source: "role",
        ...(!usable
          ? {
              warning: "Claude Code is not signed into a Claude.ai plan. Run `claude auth login` "
                + "as this desktop user; Ghost never receives that credential.",
            }
          : {}),
      };
    }
    const model = runtime.getModel(provider, id);
    if (!model) {
      throw new GhostError(
        "unknown_model",
        `No model ${JSON.stringify(id)} from provider ${JSON.stringify(provider)} in the catalogue.`,
        400,
      );
    }
    setChatModelRole(configDir, model.provider, model.id);
    await this.notifyModelRoutingChanged(ghostName);
    const usable = runtime.getProviderAuthStatus(model.provider).configured;
    this.logger.info("ghost chat model set", { ghost: ghostName, provider: model.provider, model: model.id, usable });
    const result: SetModelResult = {
      ok: true,
      usable,
      current: modelView(model),
      source: "role",
    };
    if (!usable) {
      result.warning = `${JSON.stringify(model.provider)} is not signed in, so `
        + `${JSON.stringify(model.id)} cannot answer yet — log in to use it.`;
    }
    return result;
  }
}

/** Compile-time proof that the OMP 18 facade satisfies Ghost's stable catalogue seam. */
const _runtimeShapeCheck: (r: GhostOmpRuntime) => ModelCatalogRuntime = (r) => r;
void _runtimeShapeCheck;
