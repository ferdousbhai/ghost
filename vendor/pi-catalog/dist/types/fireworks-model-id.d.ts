export declare function toFireworksPublicModelId(modelId: string): string;
export declare function toFireworksWireModelId(modelId: string): string;
/**
 * Fire Pass exposes its Kimi K2.6 Turbo subscription through a dedicated router
 * endpoint at `accounts/fireworks/routers/<id>` rather than the `models/` namespace.
 * We keep a friendly public id (e.g. `kimi-k2.6-turbo`) in the catalog and translate
 * to the wire form (`accounts/fireworks/routers/kimi-k2p6-turbo`) at request time.
 */
export declare function toFirepassPublicModelId(modelId: string): string;
export declare function toFirepassWireModelId(modelId: string): string;
/**
 * Public-id suffix marking a Fireworks "Fast" serving-path variant. Fast is a
 * higher-throughput route (100+ tok/s) exposed under a dedicated router id
 * (`accounts/fireworks/routers/<id>-fast`), not a separate model — same weights,
 * higher price, no Priority tier. We keep a friendly `<id>-fast` public id and
 * translate it to the router wire form at request time (compat
 * `wireModelIdMode: "firepass"`). See https://docs.fireworks.ai/serverless/serving-paths.
 */
export declare const FIREWORKS_FAST_SUFFIX = "-fast";
/** True for a Fireworks public model id that selects the Fast serving path. */
export declare function isFireworksFastModelId(modelId: string): boolean;
/** Strip the Fast suffix to recover the base (Standard-tier) model id. */
export declare function toFireworksBaseModelId(modelId: string): string;
