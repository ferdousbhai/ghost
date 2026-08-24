/**
 * Model-family id predicates: the shared vocabulary for "is this id a member
 * of family X" checks that gate wire-level behavior across hosts (a Kimi or
 * DeepSeek model keeps its quirks no matter which OpenAI-compatible proxy
 * serves it). Looser per-feature heuristics (e.g. stream-markup healing)
 * deliberately keep their own patterns — only provably-shared matchers live
 * here.
 */
/** Kimi family ids in any namespace form (`moonshotai/kimi-*`, `kimi-k2.6`, `vendor/kimi.x`). */
export declare const isKimiModelId: (modelId: string) => boolean;
/** Kimi K2.6 specifically, including router ids that spell the version `k2p6`. */
export declare const isKimiK26ModelId: (modelId: string) => boolean;
/**
 * Kimi K3 in any namespace form (`kimi-k3`, `kimi-k3.1`, `kimi-k3-turbo`,
 * `moonshotai/kimi-k3`). K3 always reasons and drives thinking via OpenAI-style
 * `reasoning_effort: "max"`, not the K2.x binary `thinking: { type }` block —
 * see the moonshot discovery mapper and `buildOpenAICompat`.
 */
export declare const isKimiK3ModelId: (modelId: string) => boolean;
/**
 * Claude ids in any namespace form: bare (`claude-*`), path-namespaced
 * (`anthropic/claude.x`), or dot-prefixed (`us.anthropic.claude-…`,
 * `global.anthropic.claude-…`, `au.anthropic.claude-…` — Bedrock cross-region
 * inference profiles). Necessary because {@link parseAnthropicModel} only
 * classifies kinds enumerated in its regex, so any dotted profile whose kind
 * (e.g. `haiku`) is not enumerated would otherwise slip past this fallback.
 */
export declare const isClaudeModelId: (modelId: string) => boolean;
/** `anthropic/`-namespaced ids (aggregator catalogs like OpenRouter). */
export declare const isAnthropicNamespacedModelId: (modelId: string) => boolean;
/** Qwen family ids (substring match — Qwen SKUs have no stable prefix shape). */
export declare const isQwenModelId: (modelId: string) => boolean;
/**
 * Open-weight Qwen 3.8+ releases (`qwen3.8-27b`, `qwen3.8-2.4t-a95b`, GGUF
 * names like `Qwen3.8-27B-UD-Q6_K_XL`) whose chat template steers thinking
 * depth through a `reasoning_effort` template kwarg (`low`/`medium`/`xhigh`,
 * template default `xhigh`; thinking itself cannot be disabled). Compared
 * component-wise so `qwen3.10` sorts after `qwen3.8`. API-only `-max` SKUs are
 * excluded — Dashscope drives them through OpenAI-style `reasoning_effort`
 * with curated compat. The trailing guard rejects parameter-count lookalikes
 * (`qwen-3.8b`) without breaking `qwen3.8-27b`.
 */
export declare const isQwen38PlusTemplateEffortModelId: (modelId: string) => boolean;
/** Gemma open-weights family (`gemma-3-27b-it`, `google/gemma-4-E2B-it`, `gemma2-9b`). */
export declare const isGemmaModelId: (modelId: string) => boolean;
/** DeepSeek family by id or display name (proxies often rename the id but keep the name). */
export declare const isDeepseekModelIdOrName: (modelId: string) => boolean;
/**
 * DeepSeek V4 Flash SKU in any host/namespace form (`deepseek-v4-flash`, dated
 * `deepseek-v4-flash-0731`, `deepseek-ai/DeepSeek-V4-Flash`). Both V4 SKUs
 * (Flash and Pro) accept the `low` reasoning_effort tier; this predicate keeps
 * Flash distinguishable from Pro where a host quirk splits them (e.g.
 * OpenRouter exposes `low` on Flash but only `high` on non-Flash V4).
 * See https://api-docs.deepseek.com/api/create-chat-completion.
 */
export declare const isDeepseekV4FlashModelId: (modelId: string) => boolean;
/** Xiaomi MiMo family by id or display name. */
export declare const isMimoModelIdOrName: (modelId: string) => boolean;
/** StepFun Step 3.7 Flash SKU in any namespace form (`kilo/stepfun/step-3.7-flash:free`). */
export declare const isStep37FlashModelId: (modelId: string) => boolean;
/** Gemini family ids in any namespace form (`gemini-*`, `google/gemini-*`, `openrouter/google/gemini-…`). */
export declare const isGeminiModelId: (modelId: string) => boolean;
/** Grok family ids across namespace and delimiter forms (`grok-*`, `cursor-grok-*`, `xai/grok-*`). */
export declare const isGrokModelId: (modelId: string) => boolean;
/**
 * Grok SKUs that expose the wire `reasoning.effort` dial. Other Grok reasoners
 * (e.g. `grok-build`, `grok-4.20-0309-reasoning`) think natively but reject the
 * param, so callers must omit reasoning effort for them. `grok-4.6` accepts
 * `low`/`medium`/`high`/`xhigh` and 400s on `max`.
 */
export declare const isGrokReasoningEffortCapable: (modelId: string) => boolean;
/**
 * `grok-4.20-multi-agent*` uses `reasoning.effort` to pick agent count
 * (`xhigh` is the 16-agent mode). Other first-party Grok effort SKUs stay on
 * `low|medium|high` unless {@link isGrokXHighEffortCapable} (currently
 * `grok-4.6*` plus multi-agent).
 * https://docs.x.ai/developers/model-capabilities/text/reasoning
 */
export declare const isGrokMultiAgentModelId: (modelId: string) => boolean;
/**
 * First-party Grok SKUs whose Responses wire accepts `reasoning.effort: "xhigh"`.
 * `grok-4.6*` documents xhigh as a reasoning depth; multi-agent uses it as
 * 16-agent mode. `grok-4.5` / `grok-4.3` / `grok-3-mini` do not.
 */
export declare const isGrokXHighEffortCapable: (modelId: string) => boolean;
/**
 * MiniMax M2-generation family (M2, M2.1, M2.5, M2.7, including `-highspeed`/
 * `-lightning`/`-her`/`-turbo` variants, dotless aliases like `minimax-m21`,
 * and short `minimax/m2-…` ids on aggregator hosts). Underlying model accepts
 * only `low|medium|high` for `reasoning_effort` and 400s on `minimal`,
 * `xhigh`, or `none` — so hosts whose default effort map otherwise lowers
 * `minimal` to `none` (Fireworks) or expects the full 5-tier scale must
 * clamp instead. Excludes M1, M3, MiniMax-Text-01, music, hailuo, voice ids.
 */
export declare const isMinimaxM2FamilyModelId: (modelId: string) => boolean;
/** MiniMax M3 family ids in bundled/default and aggregator namespace forms. */
export declare const isMinimaxM3FamilyModelId: (modelId: string) => boolean;
/**
 * OpenAI gpt-oss family (`gpt-oss-20b`, `gpt-oss-120b`, `gpt-oss:120b`,
 * `vendor/gpt-oss-…`). The Harmony reasoning format only accepts
 * `low|medium|high` for `reasoning_effort` and rejects `minimal`, `xhigh`,
 * and `none`.
 */
export declare const isOpenAIGptOssModelId: (modelId: string) => boolean;
/**
 * Meta Muse Spark ids (`muse-spark-1.1`, `muse-spark-1.2`,
 * `muse-spark-1.2-contributor`, `meta/muse-spark-1.2`). The Responses
 * `reasoning.effort` wire accepts `none` (thinking-off) plus
 * `minimal`/`low`/`medium`/`high`/`xhigh`.
 */
export declare const isMuseSparkModelId: (modelId: string) => boolean;
/** OpenAI model ids (gpt-*, chatgpt-*, o1/o3/o4 SKUs, codex-*, or openai/*). */
export declare const isOpenAIModelId: (modelId: string) => boolean;
/**
 * OpenAI Codex models that honor `reasoning.context: "all_turns"` (full
 * cross-turn reasoning replay). The `reasoning.context` field itself exists for
 * the whole gpt-5/o-series family, but the `all_turns` value is only accepted
 * from gpt-5.4 onward; earlier ids (`gpt-5.1-codex`, `gpt-5.3-codex`, and
 * `gpt-5.3-codex-spark`) reject it with
 * `Unsupported value: 'all_turns' is not supported with this model`. Version
 * floor (not an allowlist) so 5.6/6.x inherit support automatically. Callers
 * fall back to omitting `context`, letting the server default to `current_turn`.
 */
export declare const supportsAllTurnsReasoningContext: (modelId: string) => boolean;
/**
 * OpenAI Codex models that accept `reasoning.summary`. Shares the gpt-5.4 wire
 * floor with {@link supportsAllTurnsReasoningContext}: earlier Codex ids
 * (`gpt-5.1-codex`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) reject the field
 * with `Unsupported parameter: 'reasoning.summary' is not supported with this
 * model`. Callers omit `summary` for unsupported ids, letting the server skip
 * the human-readable summary stream.
 */
export declare const supportsCodexReasoningSummary: (modelId: string) => boolean;
/**
 * OpenAI proprietary models whose serving path rejects explicit sampling
 * parameters (`temperature`, `top_p`, `top_k`, …) with
 * `400 Unsupported parameter: 'temperature' is not supported with this model`.
 * Covers the o-series and the entire gpt-5+ generation — base, `mini`, `nano`,
 * `codex*`, the `luna`/`sol`/`terra` SKUs, and the `-chat-latest` variants,
 * since even the non-reasoning gpt-5 chat models reject sampling params (see
 * litellm#13781). Holds regardless of which OpenAI-serving host proxies the
 * model (official, Azure, GitHub Copilot). Version floor (not an allowlist) so
 * 6.x inherits automatically. Issue #5606.
 */
export declare const isOpenAISamplingRestrictedModelId: (modelId: string) => boolean;
/**
 * Reasoning-capable GLM coding SKUs: glm-4.5 and up on the base / `-air` /
 * `-turbo` lines. Excludes the vision (`…v`) shape, the non-reasoning
 * `-flash`/`-flashx`/`-preview` variants, and pre-4.5 ids. Matching the family
 * keeps newly-bumped integers (`glm-5.3`, `glm-6`, …) covered without a per-id
 * allowlist.
 */
export declare const isReasoningGlmModelId: (modelId: string) => boolean;
/** GLM-5.2+ coding SKUs accept `reasoning_effort` in addition to binary thinking. */
export declare const isGlm52ReasoningEffortModelId: (modelId: string) => boolean;
/**
 * GLM-5.3+ coding SKUs. Unlike GLM-5.2 (whose reasoning_effort dialect is
 * host-specific), GLM-5.3+ exposes a uniform wire-exact `low`/`high`/`max`
 * ladder on every host, and thinking can no longer be disabled —
 * `thinking.type` must always be `enabled`. Matching the family keeps future
 * bumps (`glm-5.4`, `glm-6`, …) covered while excluding the vision (`…v`)
 * shape and the non-reasoning `-flash`/`-flashx`/`-preview` variants.
 */
export declare const isGlm53ReasoningEffortModelId: (modelId: string) => boolean;
/** GLM vision SKUs — the `v` that attaches to the version (`glm-4v`, `glm-4.5v`). */
export declare const isGlmVisionModelId: (modelId: string) => boolean;
/**
 * Coarse vendor-lineage token for "are two models the same family?" checks
 * (e.g. picking a cross-family reviewer). All Claude point releases share a token,
 * Claude and GPT differ; namespace prefixes and aggregator mirrors fold onto the
 * lineage via {@link parseKnownModel}'s `bareModelId` normalization. Opaque and
 * comparison-only — not a stable key to persist, since the vocabulary tracks new
 * releases. Returns `""` for ids it cannot classify; callers fall back to the provider.
 *
 * Vendor-only by design: a model's kind/variant (opus vs sonnet, codex vs base) is
 * collapsed onto the single vendor token; use {@link parseKnownModel} for finer breakdowns.
 */
export declare const modelFamilyToken: (modelId: string) => string;
/**
 * True for Claude generations that support extended thinking: Sonnet/Opus 3.7+,
 * every 4.x/5+ Opus/Sonnet, and the Fable/Mythos generation. Pre-thinking
 * models (Claude 3.5 and older) are excluded so no thinking effort dial is
 * fabricated for a model that rejects thinking parameters. Classifier-based, so
 * dotted and dashed version forms both match; ids the classifier does not parse
 * (e.g. Haiku, bare dated ids) return false.
 */
export declare const anthropicModelSupportsThinking: (modelId: string) => boolean;
/**
 * Adaptive thinking `display` is supported starting with Claude Opus 4.7+,
 * Sonnet 5+, and the Claude Fable/Mythos 5 generation. Older adaptive-thinking
 * models (Opus 4.6, Sonnet 4.6) reject the field. Classifier-based, so dotted
 * and dashed version forms both match while bare dated ids
 * (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
 */
export declare const supportsAdaptiveThinkingDisplay: (modelId: string) => boolean;
/**
 * Returns true for Anthropic models with Opus 4.7+, Sonnet 5+, and Fable/Mythos 5+
 * API restrictions:
 * - Sampling parameters (temperature/top_p/top_k) return 400 error
 * - Thinking content is omitted by default (needs display: "summarized")
 */
export declare const hasOpus47ApiRestrictions: (modelId: string) => boolean;
/**
 * Mid-conversation `role: "system"` messages (system instructions appended at
 * non-first positions in the `messages` array) are supported starting with
 * Claude Opus 4.8+, Sonnet 5+, and the Claude Fable/Mythos 5 generation.
 * Earlier Claude models reject the role.
 * @see https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
export declare const supportsMidConversationSystemMessages: (modelId: string) => boolean;
/**
 * Models that reliably follow the hashline line-anchored edit dialect
 * (`[path#TAG]` headers plus 1-indexed anchors). Kimi, MiMo, DeepSeek V4
 * Flash, and Step 3.7 Flash miscount anchors or drop the tag header often
 * enough that hosts fall back to the sloppy edit format for
 * them.
 */
export declare const supportsHashlineEdits: (modelId: string) => boolean;
export declare const isAnthropicFableOrMythosModel: (modelId: string) => boolean;
/** Thinking-variant token location inside a model id. */
export interface ThinkingVariantToken {
    index: number;
    length: number;
}
/**
 * Locates the first thinking-variant token (`-thinking`, `-reasoner`,
 * `-reasoning`; trailing or infix) in a model id. The token ends at the id
 * end or any non-alphanumeric boundary, and negated forms (`non-thinking`,
 * `no-thinking`) never match — those name the NON-thinking SKU.
 */
export declare function findThinkingVariantToken(modelId: string): ThinkingVariantToken | undefined;
/**
 * Removes the located thinking-variant token: `kimi-k2-thinking` → `kimi-k2`,
 * `mimo-v2-flash-thinking-original` → `mimo-v2-flash-original`,
 * `grok-4.1-fast-reasoning` → `grok-4.1-fast`. Returns `undefined` when no
 * token exists or nothing would remain. Callers MUST verify the result names
 * a live model.
 */
export declare const stripThinkingVariantToken: (modelId: string) => string | undefined;
