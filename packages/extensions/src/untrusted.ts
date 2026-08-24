import { randomBytes } from "node:crypto";

/** A value returned immediately or by a future asynchronous detector. */
export type MaybePromise<T> = T | Promise<T>;

export interface InjectionDetection {
  readonly flagged: boolean;
  readonly score: number;
  readonly reasons: string[];
}

/**
 * The seam for prompt-injection detection. Increment 1 is synchronous and
 * heuristic-only; a later local classifier can return a promise here without
 * changing tool callers.
 */
export interface InjectionDetector {
  detect(
    content: string,
    ctx?: { source?: string },
  ): MaybePromise<InjectionDetection>;
}

export const INJECTION_REASONS = {
  imperativeAiInstruction: "imperative-ai-instruction",
  roleMarkerSpoofing: "role-marker-spoofing",
  toolCallShapedText: "tool-call-shaped-text",
  invisibleOrBidiUnicode: "invisible-or-bidi-unicode",
  largeEncodedBlob: "large-encoded-blob",
} as const;

const IMPERATIVE_AI_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your)\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?|commands?)\b/i,
  /\b(?:ignore|disregard|override)\s+(?:(?:all|any|the|your)\s+)?(?:instructions?|system message|developer message|safety rules?)\b/i,
  /\byou\s+are\s+now\s+(?:(?:an?|the)\s+)?(?:ai|assistant|agent|system|developer|administrator|admin|root|dan|chatgpt|bot)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|administrator|admin|debug|sudo|unrestricted)\s+mode\b/i,
  /\b(?:important\s+)?(?:here\s+are\s+)?(?:your\s+)?new\s+instructions?\s*:/i,
  /\b(?:reveal|show|print|repeat|output|leak|expose|return|send|provide)\s+(?:(?:me|us)\s+)?(?:(?:your|the)\s+)?system\s+prompt\b/i,
  /\b(?:your|the)\s+system\s+prompt\s+(?:is|has\s+been|must|should)\b/i,
  /(?:^|[\r\n])\s*system\s+prompt\s*:/im,
] as const;

const ROLE_MARKER_PATTERNS = [
  /(?:^|[\r\n])\s*(?:system|assistant|developer|tool)\s*:/im,
  /<\|[A-Za-z0-9_:-]{1,64}\|>/,
  /\[(?:system|assistant|developer|tool)\s*(?:message)?\]/i,
] as const;

const TOOL_CALL_PATTERNS = [
  /<\/?(?:tool_call|function_call|invoke)(?:\s|>)/i,
  /["'](?:tool|tool_name|function|function_name|name)["']\s*:\s*["'][\w.-]+["'][\s\S]{0,240}["'](?:arguments|args|parameters)["']\s*:/i,
  /["']type["']\s*:\s*["']tool_use["']/i,
  /(?:^|[\r\n])\s*(?:assistant\s+)?(?:to|recipient)\s*=\s*(?:functions?|tools?)[.\w-]*/im,
  /(?:^|[.!?\r\n])\s*(?:please\s+)?(?:call|invoke|execute|run|use)\s+(?:the\s+)?[\w.-]+\s+(?:function|tool)\b/im,
  /(?:^|[.!?\r\n])\s*(?:please\s+)?(?:call|invoke|execute|run|use)\s+(?:the\s+)?(?:function|tool)\s+[\w.-]+\b/im,
] as const;

// Formatting controls that can hide/reorder instructions. Newline and the
// ordinary LTR/RTL letters themselves are intentionally not included.
const SINGLE_INVISIBLE_CODE_POINTS = new Set([
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0xfeff,
]);

function hasInvisibleOrBidiUnicode(content: string): boolean {
  for (const character of content) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (SINGLE_INVISIBLE_CODE_POINTS.has(codePoint)) return true;
    if (codePoint >= 0x200b && codePoint <= 0x200f) return true;
    if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
    if (codePoint >= 0x2060 && codePoint <= 0x206f) return true;
  }
  return false;
}

function hasLargeEncodedBlob(content: string): boolean {
  // Long hex strings are also syntactically base64, so test them first and name
  // the shared reason only once.
  if (/(?:^|[^0-9a-f])[0-9a-f]{128,}(?:$|[^0-9a-f])/i.test(content)) return true;

  for (const match of content.matchAll(/[A-Za-z0-9+/]{160,}={0,2}/g)) {
    const token = match[0];
    if (token.length % 4 !== 0) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) continue;
    return true;
  }
  return false;
}

function matchesAny(content: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

/** Deterministic, no-I/O detector for clear prompt-injection indicators. */
export class HeuristicInjectionDetector implements InjectionDetector {
  detect(content: string, _ctx?: { source?: string }): InjectionDetection {
    const reasons: string[] = [];
    let score = 0;

    if (matchesAny(content, IMPERATIVE_AI_PATTERNS)) {
      reasons.push(INJECTION_REASONS.imperativeAiInstruction);
      score += 0.75;
    }
    if (matchesAny(content, ROLE_MARKER_PATTERNS)) {
      reasons.push(INJECTION_REASONS.roleMarkerSpoofing);
      score += 0.8;
    }
    if (matchesAny(content, TOOL_CALL_PATTERNS)) {
      reasons.push(INJECTION_REASONS.toolCallShapedText);
      score += 0.8;
    }
    if (hasInvisibleOrBidiUnicode(content)) {
      reasons.push(INJECTION_REASONS.invisibleOrBidiUnicode);
      score += 0.7;
    }
    if (hasLargeEncodedBlob(content)) {
      reasons.push(INJECTION_REASONS.largeEncodedBlob);
      score += 0.6;
    }

    return {
      flagged: reasons.length > 0,
      score: Math.min(1, score),
      reasons,
    };
  }
}

/** The increment-1 detector used by tools unless a later implementation replaces it. */
export const defaultInjectionDetector: InjectionDetector =
  new HeuristicInjectionDetector();

/** Detect prompt injection with the default detector. */
export function detectInjection(
  content: string,
  ctx?: { source?: string },
): MaybePromise<InjectionDetection> {
  return defaultInjectionDetector.detect(content, ctx);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Delimit untrusted content with a fresh identifier in both tags. An exact
 * close marker already present in the payload is escaped before wrapping, so
 * even a deterministic test nonce cannot manufacture an early close.
 */
export function fenceUntrusted(
  content: string,
  opts: { source: string; nonce?: string },
): string {
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
    throw new TypeError("The untrusted-content nonce must contain only letters, digits, _ or -.");
  }

  const closeTag = `</untrusted id="${nonce}">`;
  const neutralized = content.replaceAll(closeTag, `&lt;/untrusted id="${nonce}">`);
  if (neutralized.includes(closeTag)) {
    throw new Error("Failed to neutralize an untrusted-content close marker.");
  }

  return `<untrusted source="${escapeAttribute(opts.source)}" id="${nonce}">\n`
    + `${neutralized}\n${closeTag}`;
}
