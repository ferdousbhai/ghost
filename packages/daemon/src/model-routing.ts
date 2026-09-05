/**
 * Ghost's own model routing over official pi's catalog: which model a role
 * binding names, which model a session starts on, and the order the model
 * switcher lists a catalog in. Roles and fallback chains are Ghost policy from
 * `models.json`; pi supplies the models and their availability.
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

export type AutomaticModelRole = "advisor";

interface ModelPreference {
  provider?: string;
  id: RegExp;
}

/**
 * Ghost's own default for the advisor role: a strong reasoner.
 */
const ROLE_PREFERENCES: Record<AutomaticModelRole, readonly ModelPreference[]> = {
  advisor: [
    { provider: "openai-codex", id: /^gpt-5/i },
    { provider: "openai", id: /^gpt-5/i },
    { provider: "anthropic", id: /opus/i },
    { provider: "anthropic", id: /sonnet/i },
    { id: /gemini-.*-pro/i },
  ],
};

export function preferredRoleModel<T extends { provider: string; id: string; priority?: number }>(
  role: AutomaticModelRole,
  available: readonly T[],
): T | undefined {
  const ranked = sortCatalogModels([...available]);
  for (const preference of ROLE_PREFERENCES[role]) {
    const match = ranked.find((model) =>
      (preference.provider === undefined || model.provider === preference.provider)
      && preference.id.test(model.id));
    if (match) return match;
  }
  return undefined;
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
