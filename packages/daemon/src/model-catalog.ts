/**
 * The model indicator + switcher surface.
 *
 * The shell's "Connect a model" affordance becomes a current-model indicator
 * that an owner clicks to switch among the models their ghost can actually
 * use, or to browse the full catalogue. This module is the daemon half of
 * that: it resolves which model answers a ghost's turns, lists the usable and
 * the catalogue-wide models, and writes a new `roles.chat_model` selection.
 *
 * ## Provider catalogue is pi's; harness entries are ours
 *
 * Every provider model this module reports comes from pi's `ModelRuntime`:
 * `getModels` for the full models.dev-backed catalogue and `getAvailable` for
 * models a credentialed provider can serve now. The daemon hardcodes no model
 * list, so registry updates appear without Ghost code changes. A
 * `GhostPiRuntime` is scoped to the ghost's own model/account policy plus the
 * machine keyring, so "usable" is per-ghost by construction. The
 * single code-owned row, `claude-code/default`, is a runtime selector rather
 * than a model id: its usability and descriptive connection method come from
 * the external Claude Code authentication status, and selecting it bypasses
 * pi's model lookup.
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
import type { Api, Model } from "@earendil-works/pi-ai";
import { preferredRoleModel, resolveChatModel, sortCatalogModels } from "./model-routing.js";
import {
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeProbe,
  claudeCodeConnectionMethod,
  claudeCodeSubscriptionType,
  isClaudeCodeAuthenticated,
  type ClaudeCodeAuthStatus,
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
  ghostModelsPath,
  readGhostModels,
  replaceGhostModelFallbacks,
  resolveChatModelRef,
  setChatModelRole,
  setGhostModelRole,
  type GhostModelRole,
  type GhostModelRoleBinding,
  type GhostModelsFile,
} from "./models.js";
import { createGhostPiRuntime, type GhostPiRuntime } from "./pi-runtime.js";

/**
 * The slice of `GhostPiRuntime` this module reads;
 * tests pass a fake catalogue through the same boundary.
 */
export interface ModelCatalogRuntime {
  /** The full catalogue, synchronous. Optionally scoped to one provider. */
  getModels(providerId?: string): readonly Model<Api>[];
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
  getProviderAuthStatus(providerId: string): { configured: boolean };
  isUsingOAuth(providerId: string): boolean;
  close(): void;
}

export type CatalogModel = Pick<Model<Api>, "provider" | "id">
  & Partial<Pick<Model<Api>, "name" | "input" | "contextWindow" | "cost">>
  & { priority?: number };

export interface ModelView {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  hasVision: boolean;
  connectedVia?: string;
  subscriptionType?: string;
  resolved?: boolean;
  usable?: boolean;
}

export type CurrentModelSource = "role" | "default" | "none";

export interface CurrentModel {
  current: ModelView | null;
  /**
   * How it was chosen. `role` — `roles.chat_model` is set and resolves.
   * `default` — the catalogue default (`model-routing.ts`). `none` — nothing usable,
   * `current` is null.
   */
  source: CurrentModelSource;
}

export interface ModelListItem {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  hasVision: boolean;
  connectedVia?: string;
  subscriptionType?: string;
  usable?: boolean;
  current: boolean;
}

export type ModelScope = "available" | "catalog";

export interface ListModelsQuery {
  scope?: ModelScope;
  provider?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListModelsResult {
  scope: ModelScope;
  models: ModelListItem[];
  total: number;
  limit: number;
  offset: number;
  provider?: string;
  q?: string;
}

export interface SetModelResult {
  ok: true;
  usable: boolean;
  warning?: string;
  current: ModelView;
  source: "role";
}

export type ModelRouteTarget = "primary" | "fallback";

export interface ModelRouteModel extends ModelView {
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
  homeOperations?: HomeOperationCoordinator;
  logger?: Logger;
  offline?: boolean;
  createRuntime?: (input: {
    authPath: string;
    modelsPath: string;
    allowModelNetwork: boolean;
  }) => Promise<ModelCatalogRuntime>;
  claudeCodeStatus?: () => Promise<ClaudeCodeAuthStatus | null>;
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
  name: "Claude Code (external harness)",
  input: ["text", "image"],
};

async function defaultClaudeCodeStatus(probe: ClaudeCodeProbe): Promise<ClaudeCodeAuthStatus | null> {
  try {
    return (await probe.read()).authStatus;
  } catch {
    return null;
  }
}

interface ClaudeCodeAvailability {
  usable: boolean;
  connectedVia?: string;
  subscriptionType?: string;
}

function claudeCodeAvailability(status: ClaudeCodeAuthStatus | null): ClaudeCodeAvailability {
  if (!status || !isClaudeCodeAuthenticated(status)) return { usable: false };
  const subscriptionType = claudeCodeSubscriptionType(status);
  return {
    usable: true,
    connectedVia: claudeCodeConnectionMethod(status),
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

function claudeCodeDisplayMetadata(
  availability: ClaudeCodeAvailability,
  usable = availability.usable,
): Pick<ModelView, "connectedVia" | "subscriptionType"> {
  if (!usable) return {};
  return {
    ...(availability.connectedVia ? { connectedVia: availability.connectedVia } : {}),
    ...(availability.subscriptionType ? { subscriptionType: availability.subscriptionType } : {}),
  };
}

async function defaultCreateRuntime(input: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
}): Promise<ModelCatalogRuntime> {
  return createGhostPiRuntime({
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

const CHAT_INHERITING_ROLES: ReadonlySet<GhostModelRole> = new Set([
  "chat_model",
  "task_model",
  "smol_model",
  "slow_model",
  "designer_model",
]);

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/**
 * Reads a ghost's model catalogue and writes its chat-model selection. One
 * instance is shared by the daemon; every call builds a fresh per-ghost
 * runtime so it always reflects the ghost's current model/account policy and
 * keyring metadata.
 */
export class ModelCatalog {
  private readonly registry: GhostRegistry;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly createRuntime: NonNullable<ModelCatalogOptions["createRuntime"]>;
  private readonly claudeCodeStatus: NonNullable<
    ModelCatalogOptions["claudeCodeStatus"]
  >;
  private readonly onModelRoutingChanged: ModelCatalogOptions["onModelRoutingChanged"];
  private readonly homeOperations: HomeOperationCoordinator;

  constructor(options: ModelCatalogOptions) {
    this.registry = options.registry;
    this.homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.createRuntime = options.createRuntime ?? defaultCreateRuntime;
    const claudeCodeProbe = options.claudeCodeProbe ?? new ClaudeCodeProbe();
    this.claudeCodeStatus = options.claudeCodeStatus
      ?? (() => defaultClaudeCodeStatus(claudeCodeProbe));
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
    claudeCode: ClaudeCodeAvailability,
  ): ModelRouteModel {
    if (binding.provider === CLAUDE_CODE_PROVIDER_ID) {
      const resolved = binding.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID;
      return {
        ...modelView({
          ...CLAUDE_CODE_MODEL,
          id: binding.modelId,
          ...(binding.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID
            ? {}
            : { name: `Claude Code (${binding.modelId})` }),
        }),
        resolved,
        usable: resolved && claudeCode.usable,
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

  private automaticDefaultView(
    file: GhostModelsFile | null,
    available: readonly Model<Api>[],
  ): ModelRouteModel | null {
    const ref = resolveChatModelRef(file);
    const model = resolveChatModel(ref, available);
    return model
      ? { ...modelView(model), resolved: true, usable: true }
      : null;
  }

  /**
   * Resolve an unassigned role. Working roles inherit the chat default;
   * `tiny` and `advisor` follow Ghost's own preference lists; the rest stay
   * unset until the owner binds them.
   */
  private automaticRoleView(
    file: GhostModelsFile | null,
    role: GhostModelRole,
    available: readonly Model<Api>[],
  ): ModelRouteModel | null {
    if (CHAT_INHERITING_ROLES.has(role)) {
      const effectiveDefault = this.automaticDefaultView(file, available);
      // Claude Code is a separate harness, not a model a task role can invoke.
      if (role === "task_model" && effectiveDefault?.provider === CLAUDE_CODE_PROVIDER_ID) return null;
      return effectiveDefault;
    }
    const model = role === "tiny_model"
      ? preferredRoleModel("tiny", available)
      : role === "advisor_model"
        ? preferredRoleModel("advisor", available)
        : undefined;
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
    const [claudeStatus, available] = await Promise.all([
      this.claudeCodeStatus(),
      runtime.getAvailable(),
    ]);
    const claudeCode = claudeCodeAvailability(claudeStatus);
    const roles: ModelRouteView[] = [];
    for (const role of GHOST_MODEL_ROLES) {
      // General/Research predate the current role set. Keep an existing
      // binding editable without presenting empty custom roles to a new owner.
      if (LEGACY_COMPATIBILITY_ROLES.has(role)
        && !file?.roles?.[role]
        && !(file?.fallbacks?.[role]?.length)) {
        continue;
      }
      const explicit = file?.roles?.[role];
      const primary = role === "chat_model" ? resolveChatModelRef(file) : explicit ?? null;
      const primaryView = primary ? this.routeModelView(runtime, primary, claudeCode) : null;
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
          this.routeModelView(runtime, binding, claudeCode)),
      });
    }
    return { roles };
  }

  /** All durable Ghost roles and their ordered fallback chains. */
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
    const harness = this.validateHarnessRoute(role, target, provider, id);
    if (harness) return harness;
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

  /** Validate Ghost-owned harness routes without opening pi's credential store. */
  private validateHarnessRoute(
    role: GhostModelRole,
    target: ModelRouteTarget,
    provider: string,
    id: string,
  ): CatalogModel | null {
    if (provider !== CLAUDE_CODE_PROVIDER_ID) return null;
    if (role === "chat_model" && target === "primary" && id === CLAUDE_CODE_DEFAULT_MODEL_ID) {
      return CLAUDE_CODE_MODEL;
    }
    throw new GhostError(
      "unsupported_model_route",
      "Claude Code can only be the primary chat model; it cannot be a role fallback.",
      400,
    );
  }

  async setModelRoute(
    ghostName: string,
    role: GhostModelRole,
    target: ModelRouteTarget,
    provider: string,
    id: string,
  ): Promise<ModelRoutingView> {
    this.validateHarnessRoute(role, target, provider, id);
    return this.withRuntime(ghostName, async ({ runtime, configDir }) => {
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

  async clearModelFallbacks(
    ghostName: string,
    role: GhostModelRole,
  ): Promise<ModelRoutingView> {
    return this.withRuntime(ghostName, async ({ runtime, configDir }) => {
      clearGhostModelFallbacks(configDir, role);
      await this.notifyModelRoutingChanged(ghostName);
      return this.resolveModelRouting(ghostName, runtime, configDir);
    });
  }

  async clearModelPrimary(
    ghostName: string,
    role: GhostModelRole,
  ): Promise<ModelRoutingView> {
    return this.withRuntime(ghostName, async ({ runtime, configDir }) => {
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
    for (const selection of selections) {
      this.validateHarnessRoute(role, "fallback", selection.provider, selection.id);
    }
    return this.withRuntime(ghostName, async ({ runtime, configDir }) => {
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
    return this.homeOperations.withLease(ghostName, () =>
      this.withRuntimeLeased(ghostName, operation)
    );
  }

  private async withRuntimeLeased<T>(
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
      // if unconfigured (the catalogue default applies) and log it, mirroring how
      // session-host tolerates the same file.
      this.logger.warn("models.json is unusable", { ghost: ghostName, error: (error as Error).message });
      return null;
    }
  }

  async getCurrent(ghostName: string): Promise<CurrentModel> {
    return this.withRuntime(ghostName, async ({ runtime, configDir }) => {
      const [available, claudeStatus] = await Promise.all([
        runtime.getAvailable(),
        this.claudeCodeStatus(),
      ]);
      return this.resolveCurrent(
        this.readModelsFile(configDir, ghostName),
        available,
        claudeCodeAvailability(claudeStatus),
      );
    });
  }

  private resolveCurrent(
    file: GhostModelsFile | null,
    availableModels: readonly Model<Api>[],
    claudeCode: ClaudeCodeAvailability,
  ): CurrentModel {
    const role = file?.roles?.chat_model;
    if (role?.provider && role.modelId) {
      if (role.provider === CLAUDE_CODE_PROVIDER_ID) {
        const resolved = role.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID;
        return {
          current: {
            ...modelView({
              ...CLAUDE_CODE_MODEL,
              id: role.modelId,
              ...(resolved ? {} : { name: `Claude Code (${role.modelId})` }),
            }),
            ...claudeCodeDisplayMetadata(claudeCode, resolved && claudeCode.usable),
            resolved,
            usable: resolved && claudeCode.usable,
          },
          source: "role",
        };
      }
      const model = resolveChatModel(role, availableModels);
      if (model?.provider === role.provider && model.id === role.modelId) {
        return { current: modelView(model), source: "role" };
      }
      if (model) return { current: modelView(model), source: "default" };
      return { current: null, source: "none" };
    }
    const model = resolveChatModel(resolveChatModelRef(file), availableModels);
    if (model) return { current: modelView(model), source: "default" };
    return { current: null, source: "none" };
  }

  /**
   * List models the ghost can use now (`available`) or the whole pi catalogue
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
    const [available, claudeStatus] = await Promise.all([
      runtime.getAvailable(),
      this.claudeCodeStatus(),
    ]);
    const claudeCode = claudeCodeAvailability(claudeStatus);
    const current = this.resolveCurrent(file, available, claudeCode);
    const piSource = scope === "catalog"
      ? runtime.getModels(providerFilter)
      : providerFilter
        ? available.filter((model) => model.provider === providerFilter)
        : available;

    // Cache per-provider credential facts: getAvailable/getProviderAuthStatus
    // are not free, and a catalogue page revisits the same providers often.
    const connectedVia = new Map<string, string | undefined>();
    const usableOf = (provider: string): boolean => {
      if (provider === CLAUDE_CODE_PROVIDER_ID) return claudeCode.usable;
      if (scope === "available") return true;
      return runtime.getProviderAuthStatus(provider).configured;
    };
    const connectedViaOf = (
      provider: string,
      usable: boolean,
    ): string | undefined => {
      if (!usable) return undefined;
      if (provider === CLAUDE_CODE_PROVIDER_ID) return claudeCode.connectedVia;
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
      && (scope === "catalog" || claudeCode.usable)
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
      if (model.provider === CLAUDE_CODE_PROVIDER_ID && usable && claudeCode.subscriptionType) {
        item.subscriptionType = claudeCode.subscriptionType;
      }
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
    if (provider === CLAUDE_CODE_PROVIDER_ID && id !== CLAUDE_CODE_DEFAULT_MODEL_ID) {
      throw new GhostError(
        "unknown_model",
        `No model ${JSON.stringify(id)} from provider ${JSON.stringify(provider)} in the catalogue.`,
        400,
      );
    }
    return this.withRuntime(ghostName, ({ runtime, configDir }) =>
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
      setChatModelRole(configDir, provider, id);
      await this.notifyModelRoutingChanged(ghostName);
      const claudeCode = claudeCodeAvailability(await this.claudeCodeStatus());
      const usable = claudeCode.usable;
      this.logger.info("ghost chat model set", {
        ghost: ghostName,
        provider,
        model: id,
        usable,
      });
      return {
        ok: true,
        usable,
        current: {
          ...modelView(CLAUDE_CODE_MODEL),
          ...claudeCodeDisplayMetadata(claudeCode),
        },
        source: "role",
        ...(!usable
          ? {
              warning: "The owner-installed Claude Code runtime is unavailable. Verify the "
                + "exact SDK install documented by Ghost and configure or sign into `claude` as "
                + "this desktop user; Ghost never receives that credential. If an SDK import failed "
                + "or its loaded files changed, repair the install and restart `ghostd`.",
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

({}) as GhostPiRuntime satisfies ModelCatalogRuntime;
