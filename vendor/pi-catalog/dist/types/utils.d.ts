import { type FetchImpl } from "@oh-my-pi/pi-utils";
export { isRecord } from "@oh-my-pi/pi-utils";
/**
 * Fetch implementation for catalog discovery probes: the caller's override
 * when given, otherwise global fetch wrapped for `NODE_EXTRA_CA_CERTS`.
 */
export declare function discoveryFetch(override?: FetchImpl): FetchImpl;
export declare function toNumber(value: unknown): number | undefined;
export declare function toPositiveNumber(value: unknown, fallback: number): number;
export declare function toPositiveNumber(value: unknown, fallback: number | null): number | null;
/** Positive finite number, or `null` when the value is missing/non-positive. */
export declare function toPositiveNumberOrNull(value: unknown): number | null;
export declare function toBoolean(value: unknown): boolean | undefined;
export declare function isAnthropicOAuthToken(key: string): boolean;
/**
 * Normalize a model display name: drop the gateway author prefix and
 * model-extrinsic decorations. Returns the input verbatim when nothing
 * matches (or when stripping would leave an empty name).
 */
export declare function cleanModelName(name: string): string;
