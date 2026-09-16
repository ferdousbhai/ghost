import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";
import { isAggregatorRouter } from "./model-routing.js";
import type { GhostPiRuntime } from "./pi-runtime.js";

export const SMOL_MODEL_ROLE = "smol_model";
export type HookModelRole = typeof SMOL_MODEL_ROLE;

/**
 * The models a role can be given, which is every usable candidate that is a
 * model. An aggregator sells routers beside its models and prices some of them
 * at zero, so a cheapest-first rule reaches for one of those before it reaches
 * a real model — `auto` costs nothing to route and bills whatever it routed to.
 * auth.ts keeps them out of a chat binding for the same reason.
 */
function modelsIn(catalog: SmolModelCatalog, provider?: string): readonly SmolCandidate[] {
  const usable = catalog.usable()
    .filter((candidate) => provider === undefined || candidate.model.provider === provider);
  // The rule is provider-relative: it reads "is this namespaced under its own
  // provider rather than under a vendor", which only means anything against
  // that provider's own ids. Judged across a mixed catalogue, a provider whose
  // ids carry no vendor at all (anthropic's `claude-opus-5`) would be called a
  // router because some other provider's id happens to contain a slash.
  const siblings = new Map<string, { id: string }[]>();
  for (const candidate of usable) {
    const list = siblings.get(candidate.model.provider) ?? [];
    list.push({ id: candidate.model.id });
    siblings.set(candidate.model.provider, list);
  }
  return usable.filter((candidate) => !isAggregatorRouter(
    candidate.model.id,
    candidate.model.provider,
    siblings.get(candidate.model.provider) ?? [],
  ));
}



export type SmolModel = Pick<Model<Api>, "provider" | "id">
  & Partial<Pick<Model<Api>, "name" | "cost">>
  & { priority?: number };

export interface SmolCandidate {
  readonly model: SmolModel;
  /**
   * True when the provider is authenticated via a subscription with no marginal
   * per-token cost — an included plan or an OAuth sign-in. Such a model ranks as
   * zero cost regardless of its published `cost.input`.
   */
  readonly subscription: boolean;
}

/**
 * The slice of a model catalogue the resolver reads. Narrowed to an interface
 * so the rules can be tested against a fixture with no pi runtime at all.
 */
export interface SmolModelCatalog {
  usable(): readonly SmolCandidate[];
  find(provider: string, modelId: string): SmolCandidate | undefined;
  hasCredentials(candidate: SmolCandidate): boolean;
}

export interface ResolvedSmolModel {
  readonly model: SmolModel;
  /** `driver` means the choice followed the chat model's provider. */
  readonly via: "role" | "cheapest" | "driver";
}

export interface ResolveSmolOptions {
  /** The chat model's provider; an unset role follows it before anything else. */
  readonly chatProvider?: string | null;
}

/**
 * No model can do the ghost's cheap work, and the caller (a fire-and-forget
 * generator) should log why. Carries a `code` so it reads like the daemon's
 * other structured errors even though it never reaches an HTTP response.
 */
export class SmolModelUnavailableError extends Error {
  readonly code = "smol_model_unavailable";
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "SmolModelUnavailableError";
    this.reason = reason;
  }
}

export function smolModelLabel(model: SmolModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Effective per-input-token cost: zero for a subscription model, otherwise the
 * published `cost.input` (infinite when unknown, so a priced model always beats
 * a costless-unknown one).
 */
/**
 * A published price, or Infinity when there is not one to read.
 *
 * Negative is not a price. pi's catalogue prices `openrouter/auto` at -1000000,
 * a sentinel for "this bills whatever it picked", and a plain finite check
 * reads that as the cheapest model on offer — so ranking by cost alone would
 * choose the one router guaranteed to charge. Unknown sorts last, which is what
 * a sentinel deserves.
 */
function knownCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : Number.POSITIVE_INFINITY;
}

export function effectiveInputCost(candidate: SmolCandidate): number {
  if (candidate.subscription) return 0;
  return knownCost(candidate.model.cost?.input);
}

function publishedCost(candidate: SmolCandidate, side: "input" | "output"): number {
  return knownCost(candidate.model.cost?.[side]);
}

/**
 * Ascending order over costs that may be `Infinity` (an unknown or sentinel
 * price). Subtracting two infinities gives `NaN`, which a comparator must
 * never return, so compare rather than subtract.
 */
function cheaper(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Every usable model, cheapest EFFECTIVE cost first. Ties break on output cost
 * and then `provider/id`, so the choice is stable across runs — a conversation
 * whose title model silently changed between restarts would be hard to reason
 * about.
 */
export function rankSmolModels(catalog: SmolModelCatalog): readonly SmolCandidate[] {
  return modelsIn(catalog)
    .slice()
    .sort(
      (a, b) =>
        cheaper(effectiveInputCost(a), effectiveInputCost(b))
        || cheaper(publishedCost(a, "output"), publishedCost(b, "output"))
        || smolModelLabel(a.model).localeCompare(smolModelLabel(b.model)),
    );
}

/**
 * The provider's own small tier: its cheapest usable model, with a name that
 * reads as small winning over a subscription's flat zero cost.
 */
export function smallestWithinProvider(
  catalog: SmolModelCatalog,
  provider: string,
): SmolCandidate | undefined {
  return modelsIn(catalog, provider).slice().sort(
    (a, b) =>
      cheaper(publishedCost(a, "input"), publishedCost(b, "input"))
      || cheaper(publishedCost(a, "output"), publishedCost(b, "output"))
      || smolModelLabel(a.model).localeCompare(smolModelLabel(b.model)),
  )[0];
}

/**
 * Resolve a background-work model: an explicit ref is honoured or errors
 * loudly; otherwise the role takes the cheapest model from the chat model's
 * provider, then the cheapest usable model anywhere; a genuinely empty
 * catalogue is a loud error.
 */
export function resolveSmolModel(
  catalog: SmolModelCatalog,
  ref?: GhostModelRoleBinding | null,
  role: HookModelRole = SMOL_MODEL_ROLE,
  options: ResolveSmolOptions = {},
): ResolvedSmolModel {
  if (ref?.provider && ref.modelId) {
    const candidate = catalog.find(ref.provider, ref.modelId);
    if (!candidate) {
      throw new SmolModelUnavailableError(
        `This ghost's ${role} role names ${ref.provider}/${ref.modelId}, `
        + `which is not in its model catalogue. Fix roles.${role} in `
        + "models.json, or declare that provider and model there.",
        "unknown_model",
      );
    }
    if (!catalog.hasCredentials(candidate)) {
      throw new SmolModelUnavailableError(
        `This ghost's ${role} role names ${smolModelLabel(candidate.model)}, but `
        + `there are no credentials for "${candidate.model.provider}". Sign that provider `
        + `in, or point roles.${role} at one that is authenticated.`,
        "no_credentials",
      );
    }
    return { model: candidate.model, via: "role" };
  }

  const withinDriver = options.chatProvider
    ? smallestWithinProvider(catalog, options.chatProvider)
    : undefined;
  if (withinDriver) return { model: withinDriver.model, via: "driver" };

  const cheapest = rankSmolModels(catalog)[0];
  if (!cheapest) {
    throw new SmolModelUnavailableError(
      "This ghost has no usable model for its cheap background work: no provider in its "
      + "catalogue is authenticated. Sign a provider in, or set roles.smol_model in "
      + "models.json.",
      "none_available",
    );
  }
  return { model: cheapest.model, via: "cheapest" };
}


/**
 * The slice of `GhostPiRuntime` this module drives. A test passes a fake.
 * `getModels`/`getModel` read
 * the static catalogue synchronously (no availability network call), and the
 * subscription/OAuth/credential predicates are the ones `ModelCatalog` reads.
 */
export type SmolRuntime = Pick<
  GhostPiRuntime,
  | "getModels"
  | "getModel"
  | "hasConfiguredAuth"
  | "isUsingSubscription"
  | "isUsingOAuth"
  | "complete"
>;

function isSubscriptionProvider(runtime: SmolRuntime, provider: string): boolean {
  return runtime.isUsingSubscription(provider) || runtime.isUsingOAuth(provider);
}

function toCandidate(runtime: SmolRuntime, model: SmolModel): SmolCandidate {
  return { model, subscription: isSubscriptionProvider(runtime, model.provider) };
}

/**
 * Build a `SmolModelCatalog` over a `GhostPiRuntime`. "Usable" is a model whose
 * provider has a configured credential — the same credential-based notion of
 * usability the model switcher reports, computed synchronously so a background
 * title or greeting never blocks on an availability probe.
 */
export function smolCatalogFromRuntime(runtime: SmolRuntime): SmolModelCatalog {
  return {
    usable: () =>
      runtime.getModels()
        .filter((model) => runtime.hasConfiguredAuth(model.provider))
        .map((model) => toCandidate(runtime, model)),
    find: (provider, modelId) => {
      const model = runtime.getModel(provider, modelId);
      return model ? toCandidate(runtime, model) : undefined;
    },
    hasCredentials: (candidate) => runtime.hasConfiguredAuth(candidate.model.provider),
  };
}

/**
 * The plain text of one assistant message. Both smol consumers drive the same
 * `complete()` path with the same "one raw completion, text only" expectation.
 */
export function assistantText(assistant: AssistantMessage): string {
  return assistant.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}
