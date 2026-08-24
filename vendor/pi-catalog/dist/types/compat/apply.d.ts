/**
 * Assign defined override values onto a freshly-built resolved compat record,
 * in place. Keys the record doesn't declare are ignored (loosely-typed config
 * may carry junk). `buildModel` is the only intended caller — the record being
 * mutated is the single per-model allocation; nothing here runs per request.
 */
export declare function applyCompatOverrides(compat: object, overrides: object | undefined): void;
