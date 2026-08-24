/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend
 */
export declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
/**
 * Pinned OpenAI Codex client version (corresponds to @openai/codex package version).
 */
export declare const CODEX_CLIENT_VERSION = "0.144.1";
export declare const OPENAI_HEADERS: {
    readonly BETA: "OpenAI-Beta";
    /** Codex feature-negotiation header; values identify opt-in wire protocols. */
    readonly CODEX_BETA_FEATURES: "x-codex-beta-features";
    readonly ACCOUNT_ID: "chatgpt-account-id";
    readonly ORIGINATOR: "originator";
    readonly VERSION: "version";
    readonly SESSION_ID: "session_id";
    readonly CONVERSATION_ID: "conversation_id";
    readonly SCOPED_SESSION_ID: "session-id";
    readonly THREAD_ID: "thread-id";
    readonly INSTALLATION_ID: "x-codex-installation-id";
    readonly WINDOW_ID: "x-codex-window-id";
    readonly TURN_METADATA: "x-codex-turn-metadata";
    readonly PARENT_THREAD_ID: "x-codex-parent-thread-id";
    readonly SUBAGENT: "x-openai-subagent";
    /** Responses Lite transport marker (codex-rs `add_responses_lite_header`); value is always `"true"`. */
    readonly RESPONSES_LITE: "x-openai-internal-codex-responses-lite";
    /** DeviceCheck attestation envelope (codex-rs `X_OAI_ATTESTATION_HEADER`); sent on ChatGPT-OAuth requests. */
    readonly ATTESTATION: "x-oai-attestation";
    /** Client-declared data residency for region-pinned enterprise workspaces. */
    readonly RESIDENCY: "x-openai-internal-codex-residency";
};
export declare const OPENAI_HEADER_VALUES: {
    readonly BETA_RESPONSES: "responses=experimental";
    readonly BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06";
    readonly REMOTE_COMPACTION_V2: "remote_compaction_v2";
    readonly ORIGINATOR_CODEX: "pi";
};
export declare const URL_PATHS: {
    readonly RESPONSES: "/responses";
    readonly CODEX_RESPONSES: "/codex/responses";
};
export declare const JWT_CLAIM_PATH: "https://api.openai.com/auth";
/**
 * Extract account ID from a Codex JWT access token.
 * Returns undefined if the token is not a valid Codex JWT.
 */
export declare function getCodexAccountId(accessToken: string): string | undefined;
/**
 * Extract the account's data residency from a Codex JWT access token.
 *
 * Enterprise ChatGPT workspaces can be pinned to a region. Such a workspace
 * rejects a Codex request whose egress does not match it — HTTP 401
 * `Workspace is not authorized in this region.` — unless the client declares
 * the residency itself. The token already carries it, so no configuration is
 * needed: `chatgpt_data_residency` is the authoritative claim, with
 * `chatgpt_compute_residency` as the fallback for tokens that only carry that.
 *
 * Returns undefined for a non-JWT token, or for the (common) accounts whose
 * claims omit residency entirely — those workspaces are not region-pinned.
 */
export declare function getCodexResidency(accessToken: string): string | undefined;
/**
 * Adds the token's workspace residency to Codex request headers without
 * replacing a caller-supplied value.
 */
export declare function applyCodexResidencyHeader(headers: Headers | Record<string, string>, accessToken: string): void;
