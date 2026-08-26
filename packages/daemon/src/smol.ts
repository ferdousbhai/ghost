/**
 * The smol lane: which cheap, fast model does a ghost's throwaway work.
 *
 * A ghost has exactly one such lane, OMP's conventional `smol` role, and two
 * things ride on it: the conversation title written after a first turn
 * (`title.ts`) and the opening line the shell asks for on an empty chat
 * (`greeting.ts`). Both are the same shape of work — one raw `complete()` call,
 * no `AgentSession`, no tools, no transcript — so they share one resolution
 * rule and one role rather than each growing a setting of its own.
 *
 * ## The smol_model role and its resolution
 *
 * `smol_model` is the one role Ghost still resolves itself, and it resolves on
 * cost — but cost that is **subscription-aware** (issue #484), which is the
 * deliberate difference from a plain price ranking. Smol work is a throwaway
 * nicety, so the cheapest EFFECTIVE cost wins — and a capable model on an
 * already-authenticated subscription (OAuth or
 * an included plan) has zero marginal cost, so it is preferred over a cheaper
 * metered model. "Cheapest effective cost, subscription = free."
 *
 *   1. `roles.smol_model` — the owner's explicit choice. If it names a model
 *      that is missing or uncredentialed, that is a loud error, not a reason to
 *      quietly pick something else.
 *   2. otherwise the cheapest USABLE model by effective cost (subscription
 *      models rank as zero), ranked stably so the choice does not flap.
 *   3. otherwise a loud error naming `roles.smol_model` — but only when there
 *      is genuinely no usable model at all.
 *
 * The claude-code runtime is never a smol candidate: it is not reachable
 * through a plain `complete()` call, and `getModels()` never lists it.
 */
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";
import type { GhostOmpRuntime } from "./omp-runtime.js";

/** The role name in `<home>/models.json`. Mirrors `GhostModelRole`. */
export const SMOL_MODEL_ROLE = "smol_model";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** OMP model fields the smol resolver ranks. */
export type SmolModel = Pick<Model<Api>, "provider" | "id">
  & Partial<Pick<Model<Api>, "name" | "cost">>;

/** A candidate model plus the one fact ranking needs beyond cost. */
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
 * so the rules can be tested against a fixture with no OMP runtime at all.
 */
export interface SmolModelCatalog {
  /** Every model the ghost can use right now (its provider is credentialed). */
  usable(): readonly SmolCandidate[];
  /** One model by ref (whether or not credentialed), or undefined. */
  find(provider: string, modelId: string): SmolCandidate | undefined;
  /** Whether the ghost has a working credential for a candidate's provider. */
  hasCredentials(candidate: SmolCandidate): boolean;
}

export interface ResolvedSmolModel {
  readonly model: SmolModel;
  /** `role` when `roles.smol_model` named it, `cheapest` when ranked. */
  readonly via: "role" | "cheapest";
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

/** `provider/id`, the label every smol error and log line names a model by. */
export function smolModelLabel(model: SmolModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Effective per-input-token cost: zero for a subscription model, otherwise the
 * published `cost.input` (infinite when unknown, so a priced model always beats
 * a costless-unknown one).
 */
export function effectiveInputCost(candidate: SmolCandidate): number {
  if (candidate.subscription) return 0;
  const cost = candidate.model.cost?.input;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

function outputCost(candidate: SmolCandidate): number {
  const cost = candidate.model.cost?.output;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

/**
 * Every usable model, cheapest EFFECTIVE cost first. Ties break on output cost
 * and then `provider/id`, so the choice is stable across runs — a conversation
 * whose title model silently changed between restarts would be hard to reason
 * about.
 */
export function rankSmolModels(catalog: SmolModelCatalog): readonly SmolCandidate[] {
  return catalog
    .usable()
    .slice()
    .sort((a, b) => {
      const byInput = effectiveInputCost(a) - effectiveInputCost(b);
      if (byInput !== 0 && Number.isFinite(byInput)) return byInput < 0 ? -1 : 1;
      if (effectiveInputCost(a) !== effectiveInputCost(b)) {
        return effectiveInputCost(a) < effectiveInputCost(b) ? -1 : 1;
      }
      const byOutput = outputCost(a) - outputCost(b);
      if (byOutput !== 0 && Number.isFinite(byOutput)) return byOutput < 0 ? -1 : 1;
      if (outputCost(a) !== outputCost(b)) return outputCost(a) < outputCost(b) ? -1 : 1;
      return smolModelLabel(a.model).localeCompare(smolModelLabel(b.model));
    });
}

/**
 * Resolve the smol model: an explicit ref is honoured or errors loudly;
 * otherwise the cheapest usable model; a genuinely empty catalogue is a loud
 * error.
 */
export function resolveSmolModel(
  catalog: SmolModelCatalog,
  ref?: GhostModelRoleBinding | null,
): ResolvedSmolModel {
  if (ref?.provider && ref.modelId) {
    const candidate = catalog.find(ref.provider, ref.modelId);
    if (!candidate) {
      throw new SmolModelUnavailableError(
        `This ghost's ${SMOL_MODEL_ROLE} role names ${ref.provider}/${ref.modelId}, `
        + "which is not in its model catalogue. Fix roles.smol_model in "
        + "models.json, or declare that provider and model there.",
        "unknown_model",
      );
    }
    if (!catalog.hasCredentials(candidate)) {
      throw new SmolModelUnavailableError(
        `This ghost's ${SMOL_MODEL_ROLE} role names ${smolModelLabel(candidate.model)}, but `
        + `there are no credentials for "${candidate.model.provider}". Sign that provider `
        + "in, or point roles.smol_model at one that is authenticated.",
        "no_credentials",
      );
    }
    return { model: candidate.model, via: "role" };
  }

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

// ---------------------------------------------------------------------------
// Runtime adapter
// ---------------------------------------------------------------------------

/**
 * The slice of `GhostOmpRuntime` this module drives. A test passes a fake.
 * `getModels`/`getModel` read
 * the static catalogue synchronously (no availability network call), and the
 * subscription/OAuth/credential predicates are the ones `ModelCatalog` reads.
 */
export type SmolRuntime = Pick<
  GhostOmpRuntime,
  | "getModels"
  | "getModel"
  | "hasConfiguredAuth"
  | "isUsingSubscription"
  | "isUsingOAuth"
  | "complete"
>;

/** Whether a provider's credential is a zero-marginal-cost subscription. */
function isSubscriptionProvider(runtime: SmolRuntime, provider: string): boolean {
  return runtime.isUsingSubscription(provider) || runtime.isUsingOAuth(provider);
}

function toCandidate(runtime: SmolRuntime, model: SmolModel): SmolCandidate {
  return { model, subscription: isSubscriptionProvider(runtime, model.provider) };
}

/**
 * Build a `SmolModelCatalog` over a Ghost OMP runtime. "Usable" is a model whose
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
