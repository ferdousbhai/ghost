import type { Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";
import {
  SMOL_MODEL_ROLE,
  SmolModelUnavailableError,
  type SmolRuntime,
  assistantText,
  resolveSmolModel,
  smolCatalogFromRuntime,
  smolModelLabel,
} from "./smol.js";
import { buildTitleContext, cleanTitle } from "@ghost/runtime/title";

export { cleanTitle };

export interface GenerateTitleInput {
  readonly runtime: SmolRuntime;
  readonly firstPrompt: string;
  readonly ref?: GhostModelRoleBinding | null;
  /** The chat model's provider; an unset smol role follows it. */
  readonly chatProvider?: string | null;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve the smol model, run one completion, and return a clean title.
 *
 * Throws on any failure (no usable model, a provider error, an empty response),
 * so the fire-and-forget caller can log-and-forget. Never mutates a session.
 */
export async function generateTitle(input: GenerateTitleInput): Promise<string> {
  const resolved = resolveSmolModel(smolCatalogFromRuntime(input.runtime), input.ref, SMOL_MODEL_ROLE, {
    chatProvider: input.chatProvider ?? null,
  });
  const model = input.runtime.getModel(resolved.model.provider, resolved.model.id);
  if (!model) {
    throw new SmolModelUnavailableError(
      `The resolved smol model ${smolModelLabel(resolved.model)} vanished from the catalogue.`,
      "unknown_model",
    );
  }
  const response = await input.runtime.complete(
    model as Model<never>,
    buildTitleContext(input.firstPrompt),
    input.signal ? { signal: input.signal } : {},
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new SmolModelUnavailableError(
      `${smolModelLabel(resolved.model)} failed to write a title: `
      + (response.errorMessage ?? response.stopReason),
      "provider_error",
    );
  }
  const title = cleanTitle(assistantText(response));
  if (!title) {
    throw new SmolModelUnavailableError(
      `${smolModelLabel(resolved.model)} returned no usable title text.`,
      "empty_response",
    );
  }
  return title;
}
