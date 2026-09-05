import type { Context, Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";
import {
  CLAUDE_CODE_DRIVER_PROVIDER,
  type ClaudeSmolCompleter,
  EMPTY_SMOL_CATALOG,
  SMOL_MODEL_ROLE,
  SmolModelUnavailableError,
  type SmolRuntime,
  assistantText,
  contextPrompt,
  resolveSmolModel,
  smolCatalogFromRuntime,
  smolModelLabel,
} from "./smol.js";

/**
 * The provider-neutral instruction. No provider-specific tokens or formatting,
 * because a ghost may run on any model. The first user message is appended.
 */
export const TITLE_PROMPT =
  "Write a 3-6 word title for a conversation that starts with this message. "
  + "Title only, no quotes.";

export const MAX_TITLE_PROMPT_INPUT = 2_000;

export const MAX_TITLE_WORDS = 10;
export const MAX_TITLE_CHARS = 80;


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

export interface GenerateTitleInput {
  /** Absent when the ghost's background work never touches pi (a Claude Code driver). */
  readonly runtime?: SmolRuntime;
  readonly firstPrompt: string;
  readonly ref?: GhostModelRoleBinding | null;
  /** The chat model's provider; an unset smol role follows it. */
  readonly chatProvider?: string | null;
  /** Answers a `claude-code/<model>` resolution. */
  readonly claude?: ClaudeSmolCompleter;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve the smol model, run one completion, and return a clean title.
 *
 * Throws on any failure (no usable model, a provider error, an empty response),
 * so the fire-and-forget caller can log-and-forget. Never mutates a session.
 */
export async function generateTitle(input: GenerateTitleInput): Promise<string> {
  const catalog = input.runtime ? smolCatalogFromRuntime(input.runtime) : EMPTY_SMOL_CATALOG;
  const resolved = resolveSmolModel(catalog, input.ref, SMOL_MODEL_ROLE, {
    chatProvider: input.chatProvider ?? null,
  });
  if (resolved.model.provider === CLAUDE_CODE_DRIVER_PROVIDER) {
    if (!input.claude) {
      throw new SmolModelUnavailableError(
        `${smolModelLabel(resolved.model)} has no Claude Code completer here.`,
        "unknown_model",
      );
    }
    const title = cleanTitle(await input.claude({
      modelId: resolved.model.id,
      role: SMOL_MODEL_ROLE,
      prompt: contextPrompt(buildTitleContext(input.firstPrompt)),
      ...(input.signal ? { signal: input.signal } : {}),
    }));
    if (!title) {
      throw new SmolModelUnavailableError(
        `${smolModelLabel(resolved.model)} returned no usable title text.`,
        "empty_response",
      );
    }
    return title;
  }
  const model = input.runtime?.getModel(resolved.model.provider, resolved.model.id);
  if (!model || !input.runtime) {
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
