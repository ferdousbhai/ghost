import type { FetchImpl } from "../types.js";
/**
 * GitHub Copilot wire metadata: API-key envelope parsing and endpoint
 * derivation shared by catalog discovery and the pi-ai OAuth flow. The device
 * login / token refresh flow lives in `@oh-my-pi/pi-ai`'s registry.
 */
export declare const COPILOT_USER_AGENT: "opencode/1.3.15";
export declare const OPENCODE_HEADERS: {
    readonly "User-Agent": "opencode/1.3.15";
};
/**
 * Copilot API version sent on `api.githubcopilot.com` requests (`/models`,
 * chat endpoints). Newer versions unlock tiered context metadata: `/models`
 * reports the full long-context window in `capabilities.limits` plus per-tier
 * boundaries/prices under `billing.token_prices.{default,long_context}`.
 * Without it the endpoint serves default-tier limits only (e.g. 264k instead
 * of 1M for Claude Opus). Never send this to `api.github.com` REST endpoints —
 * they validate `X-GitHub-Api-Version` against the REST version vocabulary.
 */
export declare const COPILOT_API_VERSION: "2026-06-01";
/** Headers for `api.githubcopilot.com` (capi) requests: discovery, chat, policy. */
export declare const COPILOT_API_HEADERS: {
    readonly "User-Agent": "opencode/1.3.15";
    readonly "X-GitHub-Api-Version": "2026-06-01";
};
export type ParsedGitHubCopilotApiKey = {
    accessToken: string;
    enterpriseUrl?: string;
    apiEndpoint?: string;
};
export declare function isPublicGitHubHost(host: string): boolean;
/** Canonical personal-Copilot API host. */
export declare const PERSONAL_GITHUB_COPILOT_BASE_URL: "https://api.githubcopilot.com";
/** `true` when the resolved base URL is the canonical personal-Copilot host. */
export declare function isPersonalGitHubCopilotBaseUrl(baseUrl: string | undefined): boolean;
export declare function normalizeGitHubCopilotEnterpriseDomain(input: string | undefined): string | undefined;
export declare function normalizeGitHubCopilotApiEndpoint(input: string | undefined): string | undefined;
/**
 * Resolve the plan-specific Copilot API endpoint advertised for a GitHub token.
 * Login and raw environment-token discovery share this best-effort probe. Pass
 * a `signal` to bound it against the same discovery deadline as `/models`; a
 * stalled probe otherwise blocks discovery indefinitely.
 */
export declare function discoverGitHubCopilotApiEndpoint(token: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<string | undefined>;
export declare function parseGitHubCopilotApiKey(apiKeyRaw: string): ParsedGitHubCopilotApiKey;
export declare function normalizeDomain(input: string): string | null;
export declare function getGitHubCopilotBaseUrl(enterpriseDomain?: string): string;
