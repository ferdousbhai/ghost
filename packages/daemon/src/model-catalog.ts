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
import {
  CLAUDE_CODE_BINARY_ENV,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  isClaudePlanAuth,
  readClaudeCodeAuthStatus,
  resolveClaudeCodeExecutable,
} from "./claude-code.js";
import { GhostError, ghostPaths, type GhostRegistry } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  appendGhostModelFallback,
  clearGhostModelFallbacks,
  GHOST_MODEL_ROLES,
  GHOST_TO_OMP_MODEL_ROLE,
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
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
  getModels(providerId?: string): readonly CatalogModel[];
  /** One model, or undefined when the pair is not in the catalogue. */
  getModel(providerId: string, modelId: string): CatalogModel | undefined;
  /** Models a credentialed provider can serve now. Optionally scoped. */
  getAvailable(providerId?: string): Promise<readonly CatalogModel[]>;
  /** Whether the ghost has a working credential for this provider. */
  getProviderAuthStatus(providerId: string): { configured: boolean };
  /** Whether a configured provider is backed by OAuth (vs an api key). */
  isUsingOAuth(providerId: string): boolean;
}

/** The subset of a pi `Model` this module reads. `Model<Api>` is assignable. */
export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  /** Provider-assigned display priority, when the catalogue exposes one. Lower is better. */
  priority?: number | null;
  input?: readonly ("text" | "image")[];
  contextWindow?: number | null;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

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
   * `default` — Ghost/OMP's fallback (a hand-declared provider's first model, then the
   * first available model). `none` — nothing usable, `current` is null.
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

export interface ModelRouteView {
  role: GhostModelRole;
  ompRole: string;
  label: string;
  primary: ModelRouteModel | null;
  fallbacks: ModelRouteModel[];
}

export interface ModelRoutingView {
  roles: ModelRouteView[];
}

const MODEL_ROLE_LABELS: Readonly<Record<GhostModelRole, string>> = {
  chat_model: "Chat",
  vision_model: "Vision",
  smol_model: "Smol",
  general_purpose_model: "General purpose",
  research_model: "Research",
};

/**
 * The catalogue holds ~1,270 models. A listing is therefore always paginated:
 * `total` reports the full filtered count so the shell can page or refine its
 * `q`, and one response never ships more than `MAX_MODELS_LIMIT` rows.
 */
export const DEFAULT_MODELS_LIMIT = 100;
export const MAX_MODELS_LIMIT = 500;

export interface ModelCatalogOptions {
  registry: GhostRegistry;
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

async function defaultClaudeCodePlanStatus(): Promise<boolean> {
  try {
    const binary = await resolveClaudeCodeExecutable(
      process.env[CLAUDE_CODE_BINARY_ENV] ?? "claude",
    );
    return isClaudePlanAuth(await readClaudeCodeAuthStatus(binary));
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
 * Extract the first model-family version from an id. This follows OMP's model
 * browser convention: dotted versions first (`gpt-5.6`), then short dashed
 * versions (`claude-opus-4-6`), then a single numeric generation (`gpt-4o`).
 * Kept in sync with packages/coding-agent/src/modes/components/model-browser.ts
 * at modern Oh My Pi commit 160ed439ac0df594347e7d7018b813a7ffdb5e81 (MIT).
 */
function modelVersion(id: string): number {
  const dotted = id.match(/(?:^|[-_])(\d+\.\d+)/);
  if (dotted?.[1]) return Number.parseFloat(dotted[1]);

  const dashed = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
  if (dashed?.[1] && dashed[2]) return Number.parseFloat(`${dashed[1]}.${dashed[2]}`);

  const single = id.match(/(?:^|[-_])(\d+)/);
  if (single?.[1]) return Number.parseFloat(single[1]);
  return 0;
}

/**
 * OMP-style display order: provider, provider priority, newest model version,
 * then alias/date recency. Id is the deterministic final tie-breaker required
 * for stable offset pagination.
 */
function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
  const provider = a.provider.localeCompare(b.provider);
  if (provider !== 0) return provider;

  const aPriority = a.priority ?? Number.MAX_SAFE_INTEGER;
  const bPriority = b.priority ?? Number.MAX_SAFE_INTEGER;
  if (aPriority !== bPriority) return aPriority - bPriority;

  const version = modelVersion(b.id) - modelVersion(a.id);
  if (version !== 0) return version;

  const datePattern = /-(\d{8})$/;
  const aLatest = a.id.endsWith("-latest");
  const bLatest = b.id.endsWith("-latest");
  const aDate = a.id.match(datePattern)?.[1] ?? "";
  const bDate = b.id.match(datePattern)?.[1] ?? "";
  const aHasRecency = aLatest || aDate !== "";
  const bHasRecency = bLatest || bDate !== "";

  if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;
  if (aLatest !== bLatest) return aLatest ? -1 : 1;
  if (aDate !== bDate) return bDate.localeCompare(aDate);
  return a.id.localeCompare(b.id);
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

  constructor(options: ModelCatalogOptions) {
    this.registry = options.registry;
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.createRuntime = options.createRuntime ?? defaultCreateRuntime;
    this.claudeCodePlanStatus = options.claudeCodePlanStatus ?? defaultClaudeCodePlanStatus;
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

  private async routeModelView(
    runtime: ModelCatalogRuntime,
    binding: GhostModelRoleBinding,
    claudePlan: boolean,
  ): Promise<ModelRouteModel> {
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

  /** All durable Ghost roles and their ordered OMP retry chains. */
  async getModelRouting(ghostName: string): Promise<ModelRoutingView> {
    const { runtime, agentDir } = await this.prepare(ghostName);
    const file = this.readModelsFile(agentDir, ghostName);
    const claudePlan = await this.claudeCodePlanStatus();
    const roles: ModelRouteView[] = [];
    for (const role of GHOST_MODEL_ROLES) {
      const explicit = file?.roles?.[role];
      const primary = role === "chat_model" ? resolveChatModelRef(file) : explicit ?? null;
      roles.push({
        role,
        ompRole: GHOST_TO_OMP_MODEL_ROLE[role],
        label: MODEL_ROLE_LABELS[role],
        primary: primary ? await this.routeModelView(runtime, primary, claudePlan) : null,
        fallbacks: await Promise.all(
          (file?.fallbacks?.[role] ?? []).map((binding) =>
            this.routeModelView(runtime, binding, claudePlan)),
        ),
      });
    }
    return { roles };
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
        `${JSON.stringify(provider + "/" + id)} cannot be assigned to the vision role.`,
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
    const { runtime, agentDir } = await this.prepare(ghostName);
    const model = this.validateRoutingModel(runtime, role, target, provider, id);
    if (target === "primary") {
      setGhostModelRole(agentDir, role, model.provider, model.id);
    } else {
      const file = this.readModelsFile(agentDir, ghostName);
      const primary = role === "chat_model" ? resolveChatModelRef(file) : file?.roles?.[role];
      if (primary?.provider === model.provider && primary.modelId === model.id) {
        throw new GhostError(
          "duplicate_route_model",
          "A role's primary model cannot also be its fallback.",
          400,
        );
      }
      appendGhostModelFallback(agentDir, role, model.provider, model.id);
    }
    await this.notifyModelRoutingChanged(ghostName);
    return this.getModelRouting(ghostName);
  }

  /** Remove every retry fallback for one role. */
  async clearModelFallbacks(
    ghostName: string,
    role: GhostModelRole,
  ): Promise<ModelRoutingView> {
    const { agentDir } = await this.prepare(ghostName);
    clearGhostModelFallbacks(agentDir, role);
    await this.notifyModelRoutingChanged(ghostName);
    return this.getModelRouting(ghostName);
  }

  private async prepare(ghostName: string): Promise<{ runtime: ModelCatalogRuntime; agentDir: string }> {
    const ghost = this.registry.get(ghostName);
    const agentDir = ghostPaths(ghost.dir).agentDir;
    const runtime = await this.createRuntime({
      authPath: ghostAuthPath(agentDir),
      modelsPath: ghostModelsPath(agentDir),
      // Off when offline: gates only catalogue refresh, never a read of the
      // already-cached static catalogue.
      allowModelNetwork: !this.offline,
    });
    return { runtime, agentDir };
  }

  private readModelsFile(agentDir: string, ghostName: string): GhostModelsFile | null {
    try {
      return readGhostModels(agentDir);
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
    const { runtime, agentDir } = await this.prepare(ghostName);
    return this.resolveCurrent(runtime, this.readModelsFile(agentDir, ghostName));
  }

  private async resolveCurrent(
    runtime: ModelCatalogRuntime,
    file: GhostModelsFile | null,
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
      const model = runtime.getModel(role.provider, role.modelId);
      if (model) return { current: modelView(model), source: "role" };
    }
    // Ghost/OMP fallback: a hand-declared provider's first model (resolveChatModelRef),
    // then the first model any credentialed provider can serve.
    const ref = resolveChatModelRef(file);
    if (ref) {
      const model = runtime.getModel(ref.provider, ref.modelId);
      if (model) return { current: modelView(model), source: "default" };
    }
    const available = await runtime.getAvailable();
    if (available[0]) return { current: modelView(available[0]), source: "default" };
    return { current: null, source: "none" };
  }

  /**
   * List models the ghost can use now (`available`) or the whole OMP catalogue
   * (`catalog`). Both honour `provider` and `q` filters and are paginated; the
   * current selection is flagged, and `catalog` rows carry `usable`.
   */
  async listModels(ghostName: string, query: ListModelsQuery = {}): Promise<ListModelsResult> {
    const scope: ModelScope = query.scope === "catalog" ? "catalog" : "available";
    const { runtime, agentDir } = await this.prepare(ghostName);
    const current = await this.resolveCurrent(runtime, this.readModelsFile(agentDir, ghostName));
    const providerFilter = query.provider && query.provider !== "" ? query.provider : undefined;
    const needle = query.q?.trim().toLowerCase();

    const includesClaudeProvider = providerFilter === undefined
      || providerFilter === CLAUDE_CODE_PROVIDER_ID;
    const claudePlan = includesClaudeProvider
      ? await this.claudeCodePlanStatus()
      : false;
    const piSource = scope === "catalog"
      ? runtime.getModels(providerFilter)
      : await runtime.getAvailable(providerFilter);
    const source = [
      ...piSource,
      ...(includesClaudeProvider && (scope === "catalog" || claudePlan)
        ? [CLAUDE_CODE_MODEL]
        : []),
    ];

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

    const filtered = source.filter((model) => {
      if (!needle) return true;
      return model.id.toLowerCase().includes(needle)
        || (model.name ?? "").toLowerCase().includes(needle);
    });
    // Rank before slicing so every page shares the same semantic model order.
    const sorted = [...filtered].sort(compareCatalogModels);

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
    const { runtime, agentDir } = await this.prepare(ghostName);
    if (provider === CLAUDE_CODE_PROVIDER_ID) {
      if (id !== CLAUDE_CODE_DEFAULT_MODEL_ID) {
        throw new GhostError(
          "unknown_model",
          `No model ${JSON.stringify(id)} from provider ${JSON.stringify(provider)} in the catalogue.`,
          400,
        );
      }
      setChatModelRole(agentDir, provider, id);
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
    setChatModelRole(agentDir, model.provider, model.id);
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
