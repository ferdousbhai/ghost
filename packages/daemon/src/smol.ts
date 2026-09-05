import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";
import { preferredRoleModel } from "./model-routing.js";
import type { GhostPiRuntime } from "./pi-runtime.js";

export const SMOL_MODEL_ROLE = "smol_model";
export const ADVISOR_MODEL_ROLE = "advisor_model";
export type HookModelRole = typeof SMOL_MODEL_ROLE | typeof ADVISOR_MODEL_ROLE;

/**
 * Claude Code is a harness, not a catalogue entry, so its role defaults are
 * names Claude Code itself resolves: the driver is whatever `claude` defaults
 * to, the cheap work goes to Sonnet, and the teacher is Fable.
 */
export const CLAUDE_CODE_DRIVER_PROVIDER = "claude-code";
export const CLAUDE_CODE_SMOL_MODEL_ID = "sonnet";
export const CLAUDE_CODE_ADVISOR_MODEL_ID = "fable";

/** Model ids that read as a provider's small tier, whatever it charges. */
const SMALL_TIER_HINT = /mini|nano|haiku|flash|lite|small|fast|turbo/i;


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
  readonly via: "role" | "cheapest" | "preferred" | "driver";
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

function publishedCost(candidate: SmolCandidate, side: "input" | "output"): number {
  const cost = candidate.model.cost?.[side];
  return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

/**
 * The provider's own small tier: its cheapest usable model, with a name that
 * reads as small winning over a subscription's flat zero cost.
 */
export function smallestWithinProvider(
  catalog: SmolModelCatalog,
  provider: string,
): SmolCandidate | undefined {
  const within = catalog.usable().filter((candidate) => candidate.model.provider === provider);
  return within.slice().sort((a, b) => {
    const hint = Number(!SMALL_TIER_HINT.test(a.model.id)) - Number(!SMALL_TIER_HINT.test(b.model.id));
    if (hint !== 0) return hint;
    for (const side of ["input", "output"] as const) {
      const byCost = publishedCost(a, side) - publishedCost(b, side);
      if (byCost !== 0 && Number.isFinite(byCost)) return byCost < 0 ? -1 : 1;
      if (publishedCost(a, side) !== publishedCost(b, side)) {
        return publishedCost(a, side) < publishedCost(b, side) ? -1 : 1;
      }
    }
    return smolModelLabel(a.model).localeCompare(smolModelLabel(b.model));
  })[0];
}

/**
 * Resolve a background-work model: an explicit ref is honoured or errors
 * loudly; otherwise the role follows the chat model's provider (Claude Code
 * names its own Sonnet and Fable; a pi provider offers its small tier); then
 * the advisor preference list or the cheapest usable model; a genuinely empty
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

  if (options.chatProvider === CLAUDE_CODE_DRIVER_PROVIDER) {
    return {
      model: {
        provider: CLAUDE_CODE_DRIVER_PROVIDER,
        id: role === ADVISOR_MODEL_ROLE ? CLAUDE_CODE_ADVISOR_MODEL_ID : CLAUDE_CODE_SMOL_MODEL_ID,
      },
      via: "driver",
    };
  }

  if (role === ADVISOR_MODEL_ROLE) {
    const preferred = preferredRoleModel(
      "advisor",
      catalog.usable().map((candidate) => candidate.model),
    );
    if (!preferred) {
      throw new SmolModelUnavailableError(
        "This ghost has no usable preferred advisor model. Configure roles.advisor_model "
        + "in models.json or authenticate a supported advisor provider.",
        "none_available",
      );
    }
    return { model: preferred, via: "preferred" };
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
/** A catalogue with nothing in it, for a ghost whose background work never touches pi. */
export const EMPTY_SMOL_CATALOG: SmolModelCatalog = {
  usable: () => [],
  find: () => undefined,
  hasCredentials: () => false,
};

/** One Claude Code completion for a background role: the prompt text in, the reply text out. */
export type ClaudeSmolCompleter = (
  input: { modelId: string; role: HookModelRole; prompt: string; signal?: AbortSignal },
) => Promise<string>;

/** Flatten a pi completion context into the one user message a Claude Code query takes. */
export function contextPrompt(context: Context): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(context.systemPrompt);
  for (const message of context.messages) {
    const content = typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("");
    parts.push(content);
  }
  return parts.join("\n\n");
}

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
