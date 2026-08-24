import type { FetchImpl } from "@oh-my-pi/pi-utils";
/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export declare function getGeminiCliUserAgent(modelId?: string): string;
export declare const getGeminiCliHeaders: (modelId?: string) => {
    "User-Agent": string;
    "Client-Metadata": string;
};
/**
 * Antigravity / Cloud Code Assist user agent. Lives in its own file so discovery
 * and usage code can read it without pulling the heavy google-gemini-cli provider
 * (and its @google/genai → google-auth-library dependency chain) into the startup
 * parse graph.
 *
 * Format captured from the real 2.8.0 `antigravity/hub` client:
 * `antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`.
 * The backend gates newer models (e.g. gemini-3.7-flash) on the client version,
 * so the version tracks the latest Antigravity release via the update manifest
 * (see {@link ensureAntigravityVersion}) with `DEFAULT_ANTIGRAVITY_VERSION` as
 * the offline fallback. os_type/arch are pinned to the darwin/arm64 reference
 * client the version and manifest are captured from, independent of the host
 * platform. Overrides: PI_AI_ANTIGRAVITY_VERSION / _CL / _OS / _ARCH.
 */
export declare const DEFAULT_ANTIGRAVITY_VERSION = "2.8.0";
/** Current Antigravity client version: env override → manifest-discovered → pinned fallback. */
export declare function getAntigravityVersion(): string;
/**
 * Extracts the client version from an electron-builder update manifest.
 * Returns null when no well-formed `version:` line is present.
 */
export declare function parseAntigravityManifestVersion(yamlText: string): string | null;
/**
 * Resolves the latest Antigravity release from the official update manifest.
 * Success is cached for the process lifetime; failures are silent (the pinned
 * fallback stays valid) and clear the in-flight cache so a later call retries.
 * Skipped entirely when PI_AI_ANTIGRAVITY_VERSION is set.
 */
export declare function ensureAntigravityVersion(fetcher?: FetchImpl, signal?: AbortSignal): Promise<void>;
/** Antigravity `User-Agent` header value; rebuilt when the discovered version changes. */
export declare function getAntigravityUserAgent(): string;
/**
 * Per-wire-id Antigravity Cloud Code Assist request constants, captured from the
 * real `antigravity/hub` client against `daily-cloudcode-pa`. `modelEnum` is the
 * opaque `labels.model_enum` token the client tags each request with — optional
 * because Anthropic-backed wire ids (e.g. `claude-sonnet-4-6`,
 * `claude-opus-4-6-thinking`) are accepted without one; the label is purely
 * telemetry. `maxOutputTokens` is the fixed `generationConfig.maxOutputTokens`
 * the backend enforces regardless of the thinking budget (Claude caps at
 * 64000, Gemini accepts the discovered cap). Keyed by the routed upstream wire
 * id (post effort-routing), not the collapsed logical id. Checkpoint-only ids
 * (e.g. `gemini-3.1-flash-lite`) are intentionally absent — this provider only
 * emits agent requests.
 */
export interface AntigravityModelWireProfile {
    modelEnum?: string;
    maxOutputTokens: number;
}
export declare const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityModelWireProfile>>;
export declare function getAntigravityModelWireProfile(wireModelId: string): AntigravityModelWireProfile | undefined;
