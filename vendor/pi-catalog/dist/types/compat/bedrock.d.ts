import type { ModelSpec, ResolvedBedrockCompat } from "../types.js";
/** Resolve Bedrock Converse prompt-cache and stream-watchdog compat once per model. */
export declare function buildBedrockCompat(spec: ModelSpec<"bedrock-converse-stream">): ResolvedBedrockCompat;
