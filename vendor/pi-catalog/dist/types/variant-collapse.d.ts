import { Effort } from "./effort.js";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "./types.js";
/**
 * Structural bound for collapse inputs: both raw `ModelSpec`s and built
 * `Model`s qualify. (`Model.compat` is the resolved record, not the sparse
 * config, so the two are not mutually assignable — collapsing never touches
 * `compat`.)
 */
export type VariantSpecLike = Omit<ModelSpec<Api>, "compat"> & {
    compat?: unknown;
};
/** One collapsed family: logical id + member wire ids + per-effort routing. */
export interface EffortVariantFamily {
    /** Collapsed logical id (may equal a member id — e.g. bare/thinking pairs). */
    id: string;
    /** Final display name, no tier marker. */
    name: string;
    /**
     * Member wire ids in priority order. The first member present in the input
     * becomes the collapsed spec's default wire id (`requestModelId`; omitted
     * when it equals the logical id).
     */
    members: readonly string[];
    /**
     * Wire ids upstream no longer serves (e.g. a deployment killed while
     * discovery still advertises it). Fresh collapsing never routes to them,
     * and stale collapsed snapshots (bundled catalog, cache rows,
     * previous-generation fallbacks) get routing/`requestModelId` entries that
     * target them re-pointed through `routing`. Keep retired ids in `members`
     * so the raw upstream spec is still consumed and aliased.
     */
    retiredMembers?: readonly string[];
    /**
     * Per-effort upstream wire id; `"off"` applies when thinking is disabled.
     * Entries whose target member is absent from the input are dropped — those
     * efforts fall back to `requestModelId ?? id`.
     */
    routing: Readonly<Partial<Record<Effort | "off", string>>>;
    /** Explicit capability surface for the collapsed spec — no inference. */
    thinking: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;
    /** Thinking-off requests must explicitly suppress thinking on the wire. */
    suppressWhenOff?: boolean;
    /**
     * Preserve non-off effort routes even when discovery omits the backing member.
     * Used for Cloud Code Assist `X`/`X-thinking` pairs where upstream accepts
     * the `-thinking` wire id but the model-list endpoint may advertise only the
     * bare id.
     */
    preserveAbsentEffortRoutes?: boolean;
    /** Retired/recycled selector ids that alias to this family without being members. */
    extraAliases?: readonly string[];
}
export interface VariantCollapseTable {
    families: readonly EffortVariantFamily[];
}
/** `google-antigravity` Gemini families, using each generation's native transport. */
export declare const ANTIGRAVITY_VARIANT_COLLAPSE_TABLE: VariantCollapseTable;
/** `google-gemini-cli` Gemini families on the official CLI's level transport. */
export declare const GEMINI_CLI_VARIANT_COLLAPSE_TABLE: VariantCollapseTable;
export declare const DEVIN_VARIANT_COLLAPSE_TABLE: VariantCollapseTable;
/** `cursor` per-effort sibling families collapsed per service-tier lane: Grok 4.5/4.6 plus GPT-5.6 Luna/Sol/Terra. */
export declare const CURSOR_VARIANT_COLLAPSE_TABLE: VariantCollapseTable;
/** Provider id → hand collapse table. The CCA providers diverge on thinking transport. */
export declare const VARIANT_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>>;
/**
 * The global automatic rule: derive an `X` + `X-thinking` family for every
 * pair where both ids are live in `specs` (trailing or infix token). Gates:
 * - both members share the same `api`,
 * - known pricing must match — all-zero cost rows count as unknown
 *   (aggregators routinely ship them), but twins that BOTH carry real,
 *   differing prices are distinct SKUs and never merge,
 * - ids claimed by the provider's hand `table` are skipped (curation wins).
 * The capability surface prefers the thinking member's metadata, then the
 * bare member's, then the canonical deriver (aggregators often ship
 * `reasoning: false` and no thinking config on the twin), then a budget
 * default. `off` routes to the bare id; every supported effort routes to the
 * thinking id.
 */
export declare function deriveThinkingPairFamilies<TSpec extends VariantSpecLike>(specs: readonly TSpec[], table?: VariantCollapseTable): EffortVariantFamily[];
/**
 * True when `spec` is the output of collapsing rather than a raw upstream
 * member. `thinking.effortRouting` is written only by collapsing; the
 * `requestModelId` arm is scoped to the provider's hand-table family ids so
 * unrelated carriers (GitHub Copilot `-1m` context variants) never match.
 */
export declare function isVariantCollapsedSpec(spec: VariantSpecLike): boolean;
/**
 * Collapse every family in `table` found in `specs`. Non-member specs pass
 * through verbatim (by reference), order preserved; the collapsed spec
 * replaces the first occurrence of its family.
 */
export declare function collapseEffortVariants<TSpec extends VariantSpecLike>(specs: readonly TSpec[], table: VariantCollapseTable): TSpec[];
/**
 * Collapse a full mixed-provider list: per provider, the hand table, Cursor's
 * conservative live effort-sibling rule, and the automatic `X`/`X-thinking`
 * pair rule. Used by the catalog generator; the runtime equivalent lives at
 * the model-manager merge point. Output is regrouped by provider — callers
 * re-sort.
 */
export declare function collapseEffortVariantsAcrossProviders<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): TSpec[];
/**
 * Runtime entry point for already-built `Model` lists (the model-manager
 * merge point, coding-agent registry custom providers): collapses hand
 * tables plus derived pairs, then re-runs `buildModel` on freshly created
 * logical specs so thinking wire defaults stay resolved. Untouched entries
 * pass through by reference.
 */
export declare function collapseBuiltModelVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[];
/**
 * Resolve a retired effort-tier variant id (collapsed member, recycled id) to
 * its replacement model id for `provider` via hand-table or registered live
 * aliases. Returns `undefined` when the id is not a known alias; derived
 * `X-thinking` members also resolve through `stripThinkingVariantToken`.
 * Callers must try an exact model lookup first — a live model always wins over
 * an alias.
 */
export declare function resolveVariantAlias(provider: Provider, modelId: string): string | undefined;
/** Bare-id alias hit: replacement id plus the providers declaring it. */
export interface BareVariantAliasHit {
    id: string;
    /** Providers declaring the alias — candidates from these win ties. */
    providers: readonly Provider[];
}
/**
 * Provider-agnostic alias lookup for bare-id selectors. Returns the declaring
 * providers so callers can prefer their models when the replacement id exists
 * on unrelated providers too (e.g. a retired Cursor tier id must not resolve
 * to `openai/gpt-5.4`).
 */
export declare function resolveBareVariantAlias(modelId: string): BareVariantAliasHit | undefined;
/**
 * Reverse alias lookup: the retired ids that resolve to `modelId` for
 * `provider` via hand-table or registered live aliases. Used to re-key config
 * keyed by raw member ids (models.yml `modelOverrides`, suppressed selectors)
 * onto the collapsed model.
 */
export declare function getVariantAliasSources(provider: Provider, modelId: string): readonly string[];
