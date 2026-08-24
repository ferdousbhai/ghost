/**
 * The single Model constructor. Resolution order is a dependency chain, each
 * step materialized exactly once per spec:
 *
 *   1. compat   — URL/provider/id detection resolved into a complete record;
 *   2. thinking — derived from identity + resolved compat (or trusted verbatim
 *                 when the spec carries explicit metadata);
 *
 * Request handlers read fields — they never detect, parse ids, or allocate
 * compat per request.
 */
import type { Api, CompatOf, Model, ModelSpec } from "./types.js";
/**
 * Build one model from an authored spec. Bundled models.json rows are fully
 * materialized by the generator and consumed directly (see `models.ts`), so
 * this only runs for discovered/custom/override specs.
 */
export declare function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi>;
export declare function buildCompat(spec: ModelSpec<Api>): CompatOf<Api>;
