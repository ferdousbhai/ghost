/**
 * The model indicator + switcher surface.
 *
 * The shell's "Connect a model" affordance becomes a current-model indicator
 * that a creator clicks to switch among the models their ghost can actually
 * use, or to browse the full catalogue. This module is the daemon half of
 * that: it resolves which model answers a ghost's turns, lists the usable and
 * the catalogue-wide models, and writes a new `roles.chat_model` selection.
 *
 * ## The catalogue is pi's, never ours
 *
 * Every model this module reports comes from pi's `ModelRuntime` — `getModels`
 * for the full catalogue (pi rides models.dev via its vendored registry, ~1.3k
 * models across every provider) and `getAvailable` for the ones a credentialed
 * provider can serve right now. The daemon hardcodes no model list, so a model
 * pi learns about on its next catalogue refresh appears here with no code
 * change. A `ModelRuntime` built for a ghost home reads that ghost's own
 * `models.json` + `auth.json`, so "usable" is per-ghost by construction.
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
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { GhostError, ghostPaths, type GhostRegistry } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  setChatModelRole,
  type GhostModelsFile,
} from "./models.js";

/**
 * The slice of `ModelRuntime` this module reads. `ModelRuntime` satisfies it
 * structurally (its `Model<Api>` has every field, its `getProviderAuthStatus`
 * returns a superset of `{ configured }`); a test passes a fake catalogue.
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
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
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
   * `default` — pi's fallback (a hand-declared provider's first model, then the
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
  connectedVia?: "oauth" | "api_key";
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
  /** pi's offline posture; forbids catalogue network refresh when true. */
  offline?: boolean;
  /** Test seam: build the per-ghost runtime the catalogue reads. */
  createRuntime?: (input: {
    authPath: string;
    modelsPath: string;
    allowModelNetwork: boolean;
  }) => Promise<ModelCatalogRuntime>;
}

async function defaultCreateRuntime(input: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
}): Promise<ModelCatalogRuntime> {
  return ModelRuntime.create({
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

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/**
 * Reads a ghost's model catalogue and writes its chat-model selection. One
 * instance is shared by the daemon; every call builds a fresh per-ghost
 * runtime so it always reflects the ghost's current `models.json`/`auth.json`.
 */
export class ModelCatalog {
  private readonly registry: GhostRegistry;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly createRuntime: NonNullable<ModelCatalogOptions["createRuntime"]>;

  constructor(options: ModelCatalogOptions) {
    this.registry = options.registry;
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.createRuntime = options.createRuntime ?? defaultCreateRuntime;
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
      // if unconfigured (pi's own default applies) and log it, mirroring how
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
      const model = runtime.getModel(role.provider, role.modelId);
      if (model) return { current: modelView(model), source: "role" };
    }
    // pi's fallback: a hand-declared provider's first model (resolveChatModelRef),
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
   * List models the ghost can use now (`available`) or the whole pi catalogue
   * (`catalog`). Both honour `provider` and `q` filters and are paginated; the
   * current selection is flagged, and `catalog` rows carry `usable`.
   */
  async listModels(ghostName: string, query: ListModelsQuery = {}): Promise<ListModelsResult> {
    const scope: ModelScope = query.scope === "catalog" ? "catalog" : "available";
    const { runtime, agentDir } = await this.prepare(ghostName);
    const current = await this.resolveCurrent(runtime, this.readModelsFile(agentDir, ghostName));
    const providerFilter = query.provider && query.provider !== "" ? query.provider : undefined;
    const needle = query.q?.trim().toLowerCase();

    const source = scope === "catalog"
      ? runtime.getModels(providerFilter)
      : await runtime.getAvailable(providerFilter);

    // Cache per-provider credential facts: getAvailable/getProviderAuthStatus
    // are not free, and a catalogue page revisits the same providers often.
    const connectedVia = new Map<string, "oauth" | "api_key" | undefined>();
    const usableOf = (provider: string): boolean => {
      if (scope === "available") return true;
      return runtime.getProviderAuthStatus(provider).configured;
    };
    const connectedViaOf = (provider: string, usable: boolean): "oauth" | "api_key" | undefined => {
      if (!usable) return undefined;
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
    // Stable, predictable order for paging: provider then model id.
    const sorted = [...filtered].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );

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
    const model = runtime.getModel(provider, id);
    if (!model) {
      throw new GhostError(
        "unknown_model",
        `No model ${JSON.stringify(id)} from provider ${JSON.stringify(provider)} in the catalogue.`,
        400,
      );
    }
    setChatModelRole(agentDir, model.provider, model.id);
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

/** Compile-time proof that a real `ModelRuntime` satisfies `ModelCatalogRuntime`. */
const _runtimeShapeCheck: (r: ModelRuntime) => ModelCatalogRuntime = (r) => r;
void _runtimeShapeCheck;
