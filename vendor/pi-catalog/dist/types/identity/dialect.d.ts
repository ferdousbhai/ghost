export type Dialect = "glm" | "hermes" | "kimi" | "xml" | "anthropic" | "deepseek" | "harmony" | "qwen3" | "gemini" | "gemma" | "minimax";
export declare const FALLBACK_DIALECT: Dialect;
export declare function preferredDialect(modelId: string): Dialect;
