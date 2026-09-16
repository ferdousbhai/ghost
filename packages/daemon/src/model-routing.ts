/**
 * Ghost's own model routing over official pi's catalog: which model a role
 * binding names, which model a session starts on, and the order the model
 * switcher lists a catalog in. Role bindings are Ghost policy from
 * `models.json`; pi supplies the models, their availability, and any fallback
 * between them.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";

/** The `provider/id` selector form the shell and `models.json` share. */
export function findModel(
  binding: GhostModelRoleBinding | null | undefined,
  models: readonly Model<Api>[],
): Model<Api> | undefined {
  if (!binding) return undefined;
  const provider = binding.provider.toLowerCase();
  const id = binding.modelId.toLowerCase();
  return models.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id)
    ?? models.find((model) => model.id.toLowerCase() === id);
}

/**
 * The model a session starts on: the bound role when it is available, else
 * the first available model. Availability is pi's word (configured auth).
 */
export function resolveChatModel(
  binding: GhostModelRoleBinding | null | undefined,
  availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
  return findModel(binding, availableModels) ?? defaultModel(availableModels);
}

/** The first catalogue provider's best-ranked model (see `sortCatalogModels`). */
export function defaultModel<T extends { provider: string; id: string; priority?: number }>(
  models: readonly T[],
): T | undefined {
  return sortCatalogModels([...models])[0];
}

/**
 * What a role needs from a model, in pi's own terms. pi declares `input`,
 * `reasoning` and `contextWindow` on every model, so a binding can read the
 * capability instead of guessing it from the id.
 *
 * `sortCatalogModels` answers a different question — the order the switcher
 * lists a catalogue in — and its `versionNumber` reads the first number in an
 * id, so a parameter count (`nemotron-nano-12b`) parses as version 12 and
 * outranks a genuinely newer model. Ordering a list for a human to read can
 * afford that; choosing what to bind cannot.
 */
export interface ModelNeed {
  /** Hard requirement: every listed modality must be in the model's `input`. */
  readonly modality?: readonly ("text" | "image")[];
  /** Ranking preference, not a filter. */
  readonly preferReasoning?: boolean;
  /** Ranking preference, not a filter. */
  readonly preferLargeContext?: boolean;
}

/** Whether a model can do the job at all. Preferences are not consulted. */
export function meetsNeed(model: { input?: readonly string[] }, need: ModelNeed): boolean {
  return (need.modality ?? []).every((modality) => model.input?.includes(modality) ?? false);
}

/**
 * The models that can do the job, best first. Ties fall through to
 * `sortCatalogModels`, so a catalogue whose models are equally capable keeps
 * the order it has today.
 */
export function rankForNeed<T extends { provider: string; id: string; priority?: number; input?: readonly string[]; reasoning?: boolean; contextWindow?: number }>(
  models: readonly T[],
  need: ModelNeed,
): T[] {
  const capable = models.filter((model) => meetsNeed(model, need));
  const order = new Map(sortCatalogModels([...capable]).map((model, index) => [model, index]));
  return capable.sort((a, b) => {
    if (need.preferReasoning && !!a.reasoning !== !!b.reasoning) return a.reasoning ? -1 : 1;
    if (need.preferLargeContext && (a.contextWindow ?? 0) !== (b.contextWindow ?? 0)) {
      return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
    }
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}

/** The single best model for a need, or undefined when none can do the job. */
export function bestForNeed<T extends { provider: string; id: string; priority?: number; input?: readonly string[]; reasoning?: boolean; contextWindow?: number }>(
  models: readonly T[],
  need: ModelNeed,
): T | undefined {
  return rankForNeed(models, need)[0];
}

/** A ghost's conversational model: text in, and as much room and reasoning as the tier offers. */
export const CHAT_MODEL_NEED: ModelNeed = {
  modality: ["text"],
  preferReasoning: true,
  preferLargeContext: true,
};

/**
 * Routers an aggregator sells beside its models — `auto`, `openrouter/free`,
 * `openrouter/fusion` — which pick a model per request rather than being one.
 *
 * Told apart by shape rather than by name: an aggregator namespaces a real
 * model under its vendor (`nvidia/…`, `google/…`) and its own routers under
 * itself or under no vendor at all. Reading that from the candidates in hand
 * keeps the rule provider-relative — a provider whose ids never carry a vendor
 * (`anthropic`'s `claude-opus-5`) has no vendor-namespaced sibling, so nothing
 * there is mistaken for a router.
 */
export function isAggregatorRouter(
  id: string,
  providerId: string,
  candidates: readonly { id: string }[],
): boolean {
  const vendor = id.indexOf("/");
  if (vendor < 0) return candidates.some((candidate) => candidate.id.includes("/"));
  return id.slice(0, vendor) === providerId;
}

function versionNumber(id: string): number {
  const dotted = /(?:^|[-_])(\d+\.\d+)/.exec(id);
  if (dotted) return Number.parseFloat(dotted[1] ?? "0");
  const dashed = /(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/.exec(id);
  if (dashed) return Number.parseFloat(`${dashed[1]}.${dashed[2]}`);
  const single = /(?:^|[-_])(\d+)/.exec(id);
  return single ? Number.parseFloat(single[1] ?? "0") : 0;
}

/**
 * Stable catalog order for the model switcher: providers in the order the
 * catalogue declares them, then a provider's own priority, then newest
 * version first, `-latest` before dated snapshots, then name.
 */
export function sortCatalogModels<T extends { provider: string; id: string; priority?: number }>(models: T[]): T[] {
  const providerRank = new Map<string, number>();
  const keys = new Map<T, { provider: number; version: number; latest: boolean; date: string }>();
  for (const model of models) {
    if (!providerRank.has(model.provider)) providerRank.set(model.provider, providerRank.size);
    keys.set(model, {
      provider: providerRank.get(model.provider) ?? 0,
      version: versionNumber(model.id),
      latest: /-latest$/.test(model.id),
      date: /-(\d{8})$/.exec(model.id)?.[1] ?? "",
    });
  }
  const keyOf = (model: T) => keys.get(model) ?? { provider: 0, version: 0, latest: false, date: "" };
  return models.sort((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    if (left.provider !== right.provider) return left.provider - right.provider;
    const priority = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
    if (priority !== 0) return priority;
    if (left.version !== right.version) return right.version - left.version;
    if (left.latest !== right.latest) return left.latest ? -1 : 1;
    if (left.date !== right.date) return right.date.localeCompare(left.date);
    return a.id.localeCompare(b.id);
  });
}
