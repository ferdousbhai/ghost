import type { DevinModelDiscoveryOptions } from "../discovery/devin.js";
import type { ModelManagerOptions } from "../model-manager.js";
import type { FetchImpl } from "../types.js";
/** One Codex OAuth account to fetch a catalog for. */
export interface OpenAICodexAccount {
    /** OAuth access token used for `Authorization: Bearer ...`. */
    accessToken: string;
    /** ChatGPT account id sent as the `chatgpt-account-id` header. */
    accountId?: string;
}
export interface OpenAICodexModelManagerConfig {
    /**
     * Resolves every configured Codex OAuth account at discovery time. Codex
     * discovery is account-scoped — a model can be available to one account and
     * absent from another — so each account's `/models` endpoint is fetched
     * independently and the results unioned by id. Without this, discovery would
     * surface only the account it happened to resolve and, being authoritative,
     * prune every model the other accounts expose (#6265).
     *
     * Returns `null` to abort discovery entirely (e.g. an account's credential
     * failed to refresh): a partial account set would be cached as the complete
     * authoritative catalog and hide the missing account's models, so the caller
     * keeps the previous/bundled catalog instead.
     */
    resolveAccounts?: () => Promise<readonly OpenAICodexAccount[] | null>;
    clientVersion?: string;
    fetch?: FetchImpl;
}
export declare function openaiCodexModelManagerOptions(config?: OpenAICodexModelManagerConfig): ModelManagerOptions<"openai-codex-responses">;
export interface CursorModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    clientVersion?: string;
}
export declare function cursorModelManagerOptions(config?: CursorModelManagerConfig): ModelManagerOptions<"cursor-agent">;
export interface GitLabDuoWorkflowModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: FetchImpl;
    namespaceId?: string;
    projectId?: string;
    cwd?: string;
}
export declare function gitLabDuoWorkflowModelManagerOptions(config?: GitLabDuoWorkflowModelManagerConfig): ModelManagerOptions<"gitlab-duo-agent">;
export interface DevinModelManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    fetch?: DevinModelDiscoveryOptions["fetch"];
}
export declare function devinModelManagerOptions(config?: DevinModelManagerConfig): ModelManagerOptions<"devin-agent">;
export interface ZaiModelManagerConfig {
}
export declare function zaiModelManagerOptions(_config?: ZaiModelManagerConfig): ModelManagerOptions<"anthropic-messages">;
