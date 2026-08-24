export declare function getModelLikeIdSegments(modelId: string): string[];
export declare function getLongestModelLikeIdSegment(modelId: string): string | undefined;
/**
 * Strip reseller / wrapper tags that are injected as bracketed affixes around an
 * upstream model id, e.g.
 *   "[Kiro] claude-opus-4-8"                -> "claude-opus-4-8"
 *   "[gcli转] gemini-3.1-pro-preview [假流]" -> "gemini-3.1-pro-preview"
 *
 * Candidates are returned most-stripped first: both ends, then leading-only, then trailing-only.
 */
export declare function getBracketStrippedModelIdCandidates(modelId: string): string[];
export declare function stripBracketedModelIdAffixes(modelId: string): string | undefined;
