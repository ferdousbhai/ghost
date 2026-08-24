import type { ModelManagerOptions } from "../model-manager.js";
import type { FetchImpl } from "../types.js";
export interface GoogleModelManagerConfig {
    apiKey?: string;
    fetch?: FetchImpl;
}
export interface GoogleVertexModelManagerConfig {
    apiKey?: string;
    project?: string;
    location?: string;
    signal?: AbortSignal;
    fetch?: FetchImpl;
}
export interface GoogleAntigravityModelManagerConfig {
    oauthToken?: string;
    endpoint?: string;
    fetch?: FetchImpl;
}
export interface GoogleGeminiCliModelManagerConfig {
    oauthToken?: string;
    /** GCP project id required by Workspace/Standard credentials for quota discovery. */
    projectId?: string;
    endpoint?: string;
    fetch?: FetchImpl;
}
export declare function googleModelManagerOptions(config?: GoogleModelManagerConfig): ModelManagerOptions<"google-generative-ai">;
export declare function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions;
export declare function googleAntigravityModelManagerOptions(config?: GoogleAntigravityModelManagerConfig): ModelManagerOptions<"google-gemini-cli">;
export declare function googleGeminiCliModelManagerOptions(config?: GoogleGeminiCliModelManagerConfig): ModelManagerOptions<"google-gemini-cli">;
