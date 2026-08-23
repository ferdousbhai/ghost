/**
 * Conversation titles: how a new chat gets a short human-readable name.
 *
 * After the first turn of a conversation completes, the daemon generates a
 * 3-6 word title from the first user message with a single, cheap completion
 * (see `SessionHost.startBackgroundTitle`). This module is the reusable core:
 * it resolves WHICH model writes the title and turns one completion into a
 * clean title string. It is pure and runtime-injectable, so the resolution
 * rules can be tested against a fixture catalogue with no real model.
 *
 * ## The title_model role and its resolution
 *
 * This is the daemon analog of `@ghost/extensions`' vision resolver
 * (`vision.ts`), with one deliberate difference: cost is **subscription-aware**
 * (issue #484). A title is a throwaway nicety, so the cheapest EFFECTIVE cost
 * wins — and a capable model on an already-authenticated subscription (OAuth or
 * an included plan) has zero marginal cost, so it is preferred over a cheaper
 * metered model. "Cheapest effective cost, subscription = free."
 *
 *   1. `roles.title_model` — the creator's explicit choice. If it names a model
 *      that is missing or uncredentialed, that is a loud error, not a reason to
 *      quietly pick something else.
 *   2. otherwise the cheapest USABLE model by effective cost (subscription
 *      models rank as zero), ranked stably so the choice does not flap.
 *   3. otherwise a loud error naming `roles.title_model` — but only when there
 *      is genuinely no usable model at all.
 *
 * The claude-code runtime is never a title candidate: it is not reachable
 * through a plain `complete()` call, and `getModels()` never lists it.
 */
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";

/** The role name in `<home>/.pi/models.json`. Mirrors `GhostModelRole`. */
export const TITLE_MODEL_ROLE = "title_model";

/**
 * The provider-neutral instruction. No provider-specific tokens or formatting,
 * because a ghost may run on any model. The first user message is appended.
 */
export const TITLE_PROMPT =
  "Write a 3-6 word title for a conversation that starts with this message. "
  + "Title only, no quotes.";

/** Longest first-message slice fed to the title model. */
export const MAX_TITLE_PROMPT_INPUT = 2_000;

/** Hard caps on a generated title, applied after cleaning. */
export const MAX_TITLE_WORDS = 10;
export const MAX_TITLE_CHARS = 80;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The subset of a model the resolver ranks. `Model<Api>` is assignable. */
export interface TitleModel {
  provider: string;
  id: string;
  name?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A candidate model plus the one fact ranking needs beyond cost. */
export interface TitleCandidate {
  readonly model: TitleModel;
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
export interface TitleModelCatalog {
  /** Every model the ghost can use right now (its provider is credentialed). */
  usable(): readonly TitleCandidate[];
  /** One model by ref (whether or not credentialed), or undefined. */
  find(provider: string, modelId: string): TitleCandidate | undefined;
  /** Whether the ghost has a working credential for a candidate's provider. */
  hasCredentials(candidate: TitleCandidate): boolean;
}

export interface ResolvedTitleModel {
  readonly model: TitleModel;
  /** `role` when `roles.title_model` named it, `cheapest` when ranked. */
  readonly via: "role" | "cheapest";
}

/**
 * No model can write a title, and the caller (a fire-and-forget generator)
 * should log why. Carries a `code` so it reads like the daemon's other
 * structured errors even though it never reaches an HTTP response.
 */
export class TitleModelUnavailableError extends Error {
  readonly code = "title_model_unavailable";
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "TitleModelUnavailableError";
    this.reason = reason;
  }
}

function modelLabel(model: TitleModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Effective per-input-token cost: zero for a subscription model, otherwise the
 * published `cost.input` (infinite when unknown, so a priced model always beats
 * a costless-unknown one).
 */
export function effectiveInputCost(candidate: TitleCandidate): number {
  if (candidate.subscription) return 0;
  const cost = candidate.model.cost?.input;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

function outputCost(candidate: TitleCandidate): number {
  const cost = candidate.model.cost?.output;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
}

/**
 * Every usable model, cheapest EFFECTIVE cost first. Ties break on output cost
 * and then `provider/id`, so the choice is stable across runs — a conversation
 * whose title model silently changed between restarts would be hard to reason
 * about.
 */
export function rankTitleModels(catalog: TitleModelCatalog): readonly TitleCandidate[] {
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
      return modelLabel(a.model).localeCompare(modelLabel(b.model));
    });
}

/**
 * Resolve the title model. Mirrors the vision resolver's structure: an explicit
 * ref is honoured or errors loudly; otherwise the cheapest usable model; a
 * genuinely empty catalogue is a loud error.
 */
export function resolveTitleModel(
  catalog: TitleModelCatalog,
  ref?: GhostModelRoleBinding | null,
): ResolvedTitleModel {
  if (ref?.provider && ref.modelId) {
    const candidate = catalog.find(ref.provider, ref.modelId);
    if (!candidate) {
      throw new TitleModelUnavailableError(
        `This ghost's ${TITLE_MODEL_ROLE} role names ${ref.provider}/${ref.modelId}, `
        + "which is not in its model catalogue. Fix roles.title_model in "
        + ".pi/models.json, or declare that provider and model there.",
        "unknown_model",
      );
    }
    if (!catalog.hasCredentials(candidate)) {
      throw new TitleModelUnavailableError(
        `This ghost's ${TITLE_MODEL_ROLE} role names ${modelLabel(candidate.model)}, but `
        + `there are no credentials for "${candidate.model.provider}". Sign that provider `
        + "in, or point roles.title_model at one that is authenticated.",
        "no_credentials",
      );
    }
    return { model: candidate.model, via: "role" };
  }

  const cheapest = rankTitleModels(catalog)[0];
  if (!cheapest) {
    throw new TitleModelUnavailableError(
      "This ghost has no usable model to name a conversation with: no provider in its "
      + "catalogue is authenticated. Sign a provider in, or set roles.title_model in "
      + ".pi/models.json.",
      "none_available",
    );
  }
  return { model: cheapest.model, via: "cheapest" };
}

// ---------------------------------------------------------------------------
// Runtime adapter
// ---------------------------------------------------------------------------

/**
 * The slice of pi's `ModelRuntime` this module drives. A real `ModelRuntime`
 * satisfies it structurally; a test passes a fake. `getModels`/`getModel` read
 * the static catalogue synchronously (no availability network call), and the
 * subscription/OAuth/credential predicates are the ones `ModelCatalog` reads.
 */
export interface TitleRuntime {
  getModels(providerId?: string): readonly Model<never>[] | readonly TitleModel[];
  getModel(providerId: string, modelId: string): TitleModel | undefined;
  hasConfiguredAuth(providerId: string): boolean;
  isUsingSubscription(providerId: string): boolean;
  isUsingOAuth(providerId: string): boolean;
  complete(
    model: Model<never>,
    context: Context,
    options?: { signal?: AbortSignal },
  ): Promise<AssistantMessage>;
}

/** Whether a provider's credential is a zero-marginal-cost subscription. */
function isSubscriptionProvider(runtime: TitleRuntime, provider: string): boolean {
  return runtime.isUsingSubscription(provider) || runtime.isUsingOAuth(provider);
}

function toCandidate(runtime: TitleRuntime, model: TitleModel): TitleCandidate {
  return { model, subscription: isSubscriptionProvider(runtime, model.provider) };
}

/**
 * Build a `TitleModelCatalog` over a `ModelRuntime`. "Usable" is a model whose
 * provider has a configured credential — the same credential-based notion of
 * usability the model switcher reports, computed synchronously so a background
 * title never blocks on an availability probe.
 */
export function titleCatalogFromRuntime(runtime: TitleRuntime): TitleModelCatalog {
  return {
    usable: () =>
      (runtime.getModels() as readonly TitleModel[])
        .filter((model) => runtime.hasConfiguredAuth(model.provider))
        .map((model) => toCandidate(runtime, model)),
    find: (provider, modelId) => {
      const model = runtime.getModel(provider, modelId);
      return model ? toCandidate(runtime, model) : undefined;
    },
    hasCredentials: (candidate) => runtime.hasConfiguredAuth(candidate.model.provider),
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** The single-message context for a title completion. */
export function buildTitleContext(firstPrompt: string): Context {
  const message = firstPrompt.slice(0, MAX_TITLE_PROMPT_INPUT);
  return {
    messages: [
      {
        role: "user",
        content: `${TITLE_PROMPT}\n\nMessage:\n${message}`,
        timestamp: Date.now(),
      },
    ],
  };
}

/**
 * Normalise a model's raw output into a title, or "" when there is nothing
 * usable. Takes the first non-empty line, strips surrounding quotes and a
 * trailing period, collapses whitespace, and clamps length and word count so a
 * model that ignores "3-6 words" cannot produce a paragraph.
 */
export function cleanTitle(raw: string): string {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  let title = firstLine
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’`]+/, "")
    .replace(/["'“”‘’`]+$/, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!title) return "";
  const words = title.split(" ");
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trim();
  return title;
}

function textOf(assistant: AssistantMessage): string {
  return assistant.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export interface GenerateTitleInput {
  readonly runtime: TitleRuntime;
  readonly firstPrompt: string;
  readonly ref?: GhostModelRoleBinding | null;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve the title model, run one completion, and return a clean title.
 *
 * Throws on any failure (no usable model, a provider error, an empty response),
 * so the fire-and-forget caller can log-and-forget. Never mutates a session.
 */
export async function generateTitle(input: GenerateTitleInput): Promise<string> {
  const catalog = titleCatalogFromRuntime(input.runtime);
  const resolved = resolveTitleModel(catalog, input.ref);
  const model = input.runtime.getModel(resolved.model.provider, resolved.model.id);
  if (!model) {
    throw new TitleModelUnavailableError(
      `The resolved title model ${modelLabel(resolved.model)} vanished from the catalogue.`,
      "unknown_model",
    );
  }
  const response = await input.runtime.complete(
    model as Model<never>,
    buildTitleContext(input.firstPrompt),
    input.signal ? { signal: input.signal } : {},
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new TitleModelUnavailableError(
      `${modelLabel(resolved.model)} failed to write a title: `
      + (response.errorMessage ?? response.stopReason),
      "provider_error",
    );
  }
  const title = cleanTitle(textOf(response));
  if (!title) {
    throw new TitleModelUnavailableError(
      `${modelLabel(resolved.model)} returned no usable title text.`,
      "empty_response",
    );
  }
  return title;
}
