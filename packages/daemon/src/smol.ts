import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { GhostPiRuntime } from "./pi-runtime.js";
import type { SmolCandidate, SmolModel, SmolModelCatalog } from "@ghost/runtime/smol";

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
