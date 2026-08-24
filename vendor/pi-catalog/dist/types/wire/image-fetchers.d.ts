/**
 * Identification of provider-side image fetchers.
 *
 * A request may carry an image either inline (base64) or as a URL. With a URL,
 * the provider's backend performs its own server-side GET against that URL, so
 * a local blob server sees an inbound request from vendor infrastructure rather
 * than from the client. This module names those fetchers, letting a blob server
 * attribute an inbound GET to the vendor that issued it — which is how a caller
 * learns where a request actually landed when a router sits between them and
 * the model.
 *
 * NOT an authentication mechanism. Every value here is a request header chosen
 * by the caller and is trivially forged. Authorize blob reads with an
 * unguessable URL (single-use capability token, short TTL) and treat a fetcher
 * match as attribution/telemetry only.
 *
 * Each entry was captured from a live fetch triggered by handing that vendor's
 * API a URL-sourced image.
 */
/** Vendor whose infrastructure performed an inbound fetch. */
export type ImageFetcherVendor = "openai" | "anthropic" | "xai" | "google";
/** Registry key for a known fetcher. */
export type ImageFetcherId = "openai-file-downloader" | "anthropic-claude-user" | "anthropic-claude-user-preview" | "xai-image-api-fetch" | "google";
/** Request signature of one provider-side fetcher. */
export interface ImageFetcherIdentity {
    vendor: ImageFetcherVendor;
    /** Human-readable name for logs and UI. */
    label: string;
    /**
     * `User-Agent` contract: an exact string for fetchers that send a fixed
     * value, or a pattern for those embedding a client version.
     */
    userAgent: string | RegExp;
    /**
     * Vendor-proprietary headers observed alongside the agent, used to
     * corroborate a `User-Agent` claim. Generic infrastructure headers
     * (`traceparent`, `x-cloud-trace-context`) are deliberately excluded: they
     * are emitted by unrelated infrastructure and corroborate nothing. Empty
     * means the agent string is the only available signal, so
     * {@link ImageFetcherMatch.corroborated} can never be true for that entry.
     */
    markerHeaders: readonly string[];
    /** API surface the capture came from. */
    observedVia: string;
    /** Operational caveats a blob server should account for. */
    note?: string;
}
/**
 * Known provider-side fetchers.
 *
 * Agent contracts do not overlap — exact strings never collide with the
 * versioned patterns — so lookup order carries no meaning.
 */
export declare const IMAGE_FETCHERS: Readonly<Record<ImageFetcherId, ImageFetcherIdentity>>;
/** Attribution outcome for one inbound request. */
export interface ImageFetcherMatch {
    id: ImageFetcherId;
    identity: ImageFetcherIdentity;
    /**
     * Whether every proprietary marker header for the matched identity is
     * present. Always false for identities declaring no markers — absence of
     * corroboration is not evidence against the match.
     */
    corroborated: boolean;
}
/** Inbound header bag, as exposed by either `fetch` or a Node-style server. */
export type InboundHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;
/**
 * Attribute an inbound blob request to a known provider-side fetcher, or
 * `null` when the agent matches none.
 *
 * Matches on `User-Agent` alone and reports marker-header corroboration
 * separately; callers MUST NOT treat either as proof of origin. Gate access on
 * the unguessable URL.
 */
export declare function identifyImageFetcher(headers: InboundHeaders): ImageFetcherMatch | null;
