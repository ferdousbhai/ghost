import type { ModelManagerOptions } from "../model-manager.js";
import type { FetchImpl } from "../types.js";
export interface OllamaCloudModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
}
/**
 * Output-token ceiling that Ollama Cloud enforces for the DeepSeek V4 Pro/Flash
 * deployments: `/api/chat` rejects `num_predict` above it with HTTP 400
 * (`max_tokens (...) exceeds model's maximum output tokens (65536)`) even though
 * the model pages advertise a 1M context / 384K output. Ollama's `/api/show`
 * never reports this cap, so the catalog pins it for the affected models
 * (ollama/ollama#16890, #7266). The wire layer clamps `num_predict` to the same
 * value (`OLLAMA_CLOUD_NUM_PREDICT_CAP` in `packages/ai/src/providers/ollama.ts`,
 * #3392/#3394).
 */
export declare const OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65536;
/** Whether an Ollama Cloud model id (tagged or not) enforces the 65536 output cap. */
export declare function isOllamaCloudOutputCapped(id: string): boolean;
export declare function normalizeOllamaCloudBaseUrl(baseUrl?: string): string;
export declare function ollamaCloudModelManagerOptions(config?: OllamaCloudModelManagerConfig): ModelManagerOptions<"ollama-chat">;
