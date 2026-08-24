/**
 * Model-id classification: parse a model id into its family (gemini / anthropic /
 * openai), kind/variant, and version. This is the shared layer both catalog
 * policy rules (`model-thinking.ts`) and downstream consumers build on —
 * classification lives here, the rules that consume it stay with their domain.
 */
export type SemVer = {
    major: number;
    minor: number;
    patch: number;
};
export type GeminiKind = "pro" | "flash";
export type AnthropicKind = "opus" | "sonnet" | "fable" | "mythos";
export type OpenAIVariant = "base" | "codex" | "codex-max" | "codex-mini" | "codex-spark" | "mini" | "max" | "nano";
export type GlmVariant = "base" | "air" | "turbo" | "flash" | "flashx" | "preview";
export interface GeminiModel {
    family: "gemini";
    kind: GeminiKind;
    version: SemVer;
}
export interface AnthropicModel {
    family: "anthropic";
    kind: AnthropicKind;
    version: SemVer;
}
export interface OpenAIModel {
    family: "openai";
    variant: OpenAIVariant;
    version: SemVer;
}
export interface GlmModel {
    family: "glm";
    /** Suffix variant (`-air`, `-turbo`, `-flash`, `-flashx`, `-preview`); `base` when none. */
    variant: GlmVariant;
    /** Vision SKU — the `v` that attaches directly to the version (`glm-4v`, `glm-4.5v`). */
    vision: boolean;
    version: SemVer;
}
export interface UnknownModel {
    family: "unknown";
    id: string;
}
export type ParsedModel = GeminiModel | AnthropicModel | OpenAIModel | UnknownModel;
export declare function bareModelId(modelId: string): string;
export declare function parseKnownModel(modelId: string): ParsedModel;
export declare const parseGeminiModel: (modelId: string) => GeminiModel | null;
export declare const parseAnthropicModel: (modelId: string) => AnthropicModel | null;
export declare const parseOpenAIModel: (modelId: string) => OpenAIModel | null;
/**
 * Parse a GLM (Zhipu / Z.AI) model id into family + variant + vision + version.
 * Shape: `glm-<version>[v][-<variant>]` — e.g. `glm-4.5`, `glm-4.5-air`,
 * `glm-5-turbo`, `glm-4.5v`, `glm-5-preview`. The `v` (vision) attaches to the
 * version; other variants are `-` suffixes. Standalone like `parseAnthropicModel`
 * is used in family.ts — GLM needs no global thinking policy, so it stays out of
 * `parseKnownModel`.
 */
export declare const parseGlmModel: (modelId: string) => GlmModel | null;
export declare function isFableOrMythos(kind: AnthropicKind): boolean;
/**
 * Returns true if the parsed Anthropic model is part of the adaptive-thinking
 * Claude generation at or above a specific capability threshold.
 * - Opus has a configurable minimum version floor (e.g. "4.6", "4.7", "4.8").
 * - Sonnet, Fable, and Mythos all require version 5 or higher.
 */
export declare function isAnthropicAdaptiveGenAtLeast(parsed: AnthropicModel, opusMin: "4.6" | "4.7" | "4.8"): boolean;
export declare function parseSemVer(version: string): SemVer | null;
export declare function semverGte(left: SemVer | string, right: SemVer | string): boolean;
export declare function semverEqual(left: SemVer | string, right: SemVer | string): boolean;
export declare function compareSemVer(left: SemVer | string | null, right: SemVer | string | null): number;
