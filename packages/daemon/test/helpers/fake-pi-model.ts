import type { Api, Model } from "@earendil-works/pi-ai";

/** A pi model row with just enough shape for routing and login tests. */
export function fakePiModel(model: {
  provider: string;
  id: string;
  name?: string;
  input?: string[];
  cost?: { input: number; output: number };
  reasoning?: boolean;
  contextWindow?: number;
}): Model<Api> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "google-generative-ai",
    provider: model.provider,
    baseUrl: "https://models.invalid",
    reasoning: model.reasoning ?? false,
    input: [...(model.input ?? ["text"])],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: 8_192,
  } as Model<Api>;
}
