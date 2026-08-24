import type { TokenCost } from "./types.js";
/** Standard GPT-5.6 Sol rates used by the Daybreak Blue aliases. */
export declare const OPENAI_GPT_56_SOL_STANDARD_COST: {
    readonly input: 5;
    readonly output: 30;
    readonly cacheRead: 0.5;
    readonly cacheWrite: 6.25;
};
/** Standard GPT-5.6 Cyber rates used by the Daybreak Red aliases. */
export declare const OPENAI_GPT_56_CYBER_STANDARD_COST: {
    readonly input: 12.5;
    readonly output: 75;
    readonly cacheRead: 1.25;
    readonly cacheWrite: 15.625;
};
/** Resolve standard rates for Codex-prefixed Daybreak aliases. */
export declare function resolveOpenAIDaybreakStandardCost(modelId: string): TokenCost | undefined;
