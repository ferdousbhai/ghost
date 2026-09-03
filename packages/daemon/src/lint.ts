import { parse as parseYaml } from "yaml";
import * as z from "zod";
import {
  collectLintPackCandidates,
  type ConfigCandidate,
  type WatchdogDiscoveryOptions,
} from "./watchdog-files.js";

export type LintTarget = "prose" | "command" | "path";
export type LintSeverity = "nit" | "concern" | "blocker";
export type LintStatCheck = "em-dash-density" | "hedging-ratio" | "sentence-uniformity";

interface LintRuleBase {
  id: string;
  target: LintTarget;
  severity: LintSeverity;
  message: string;
  fix?: string;
}

export interface LintPatternRule extends LintRuleBase {
  kind: "pattern";
  pattern: string;
  flags?: string;
}

export interface LintStatRule extends LintRuleBase {
  kind: "stat";
  check: LintStatCheck;
  threshold?: number;
}

export type LintRule = LintPatternRule | LintStatRule;

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  fix?: string;
  excerpt: string;
}

export interface LintInputs {
  prose?: string;
  commands?: readonly string[];
  paths?: readonly string[];
}

export interface CompiledLintRuleSet {
  readonly rules: readonly CompiledLintRule[];
}

export interface LoadedLintRules extends CompiledLintRuleSet {
  readonly disabledBuiltinRuleIds: ReadonlySet<string>;
}

interface CompiledPatternRule extends LintPatternRule {
  regex: RegExp;
}

type CompiledLintRule = CompiledPatternRule | LintStatRule;

interface IndexedFinding extends LintFinding {
  start: number;
  sequence: number;
}

interface Span {
  start: number;
  end: number;
}

interface CompiledLintPack {
  disable: readonly string[];
  rules: readonly CompiledLintRule[];
}

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FLAGS = /^[imsu]*$/u;
const MAX_RULES_PER_PACK = 256;
const MAX_OWNER_RULES = 512;
const MAX_PATTERN_CHARS = 4_096;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_FIX_CHARS = 4_000;
export const MAX_LINT_INPUT_BYTES = 128 * 1024;
export const MAX_LINT_FINDINGS_PER_RULE = 8;
export const MAX_LINT_FINDINGS = 64;
export const MAX_LINT_EXCERPT_CODE_POINTS = 80;

const baseRuleSchema = {
  id: z.string().min(1).max(128).regex(RULE_ID),
  target: z.enum(["prose", "command", "path"]),
  severity: z.enum(["nit", "concern", "blocker"]),
  message: z.string().min(1).max(MAX_MESSAGE_CHARS),
  fix: z.string().min(1).max(MAX_FIX_CHARS).optional(),
};

const lintRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    ...baseRuleSchema,
    kind: z.literal("pattern"),
    pattern: z.string().min(1).max(MAX_PATTERN_CHARS),
    flags: z.string().regex(FLAGS).optional(),
  }).strict(),
  z.object({
    ...baseRuleSchema,
    kind: z.literal("stat"),
    check: z.enum(["em-dash-density", "hedging-ratio", "sentence-uniformity"]),
    threshold: z.number().finite().nonnegative().optional(),
  }).strict(),
]);

const lintPackSchema = z.object({
  disable: z.array(z.string().min(1).max(128).regex(RULE_ID)).max(MAX_RULES_PER_PACK).default([]),
  rules: z.array(lintRuleSchema).max(MAX_RULES_PER_PACK).default([]),
}).strict();

const warnedRules = new Set<string>();
const MAX_WARNED_RULES = 512;
const packCache = new Map<string, CompiledLintPack | null>();
const MAX_PACK_CACHE_ENTRIES = 128;

function warnRuleOnce(
  key: string,
  warn: ((message: string) => void) | undefined,
  message: string,
): void {
  if (warnedRules.has(key)) return;
  if (warnedRules.size >= MAX_WARNED_RULES) {
    const oldest = warnedRules.values().next().value;
    if (oldest !== undefined) warnedRules.delete(oldest);
  }
  warnedRules.add(key);
  warn?.(message);
}

/**
 * Reject the common exponential regex shapes before JavaScript's synchronous
 * engine sees owner-authored input. This deliberately errs toward refusing a
 * rule: a skipped lint rule is safer than blocking the awaited stop boundary.
 */
function unsafePatternReason(pattern: string): string | undefined {
  if (/\\[1-9]/u.test(pattern)) return "backreferences are not supported";
  const repeatedGroup = String.raw`\((?:\?(?:[:=!]|<[=!]))?(?:\\.|[^()])*(?:[*+]|\{\d*,\})(?:\\.|[^()])*\)(?:[*+]|\{\d*,\})`;
  if (new RegExp(repeatedGroup, "u").test(pattern)) return "nested unbounded repetition is not supported";
  const repeatedAlternation = String.raw`\((?:\?(?:[:=!]|<[=!]))?(?:\\.|[^()])*\|(?:\\.|[^()])*\)(?:[*+]|\{\d*,\})`;
  if (new RegExp(repeatedAlternation, "u").test(pattern)) return "repeated alternation is not supported";
  return undefined;
}

export function compileLintRules(
  rules: readonly LintRule[],
  options: { source?: string; warn?: (message: string) => void } = {},
): CompiledLintRuleSet {
  const compiled: CompiledLintRule[] = [];
  const source = options.source ?? "lint rules";
  for (const rule of rules) {
    if (rule.kind === "stat") {
      compiled.push(Object.freeze({ ...rule }));
      continue;
    }
    const unsafe = unsafePatternReason(rule.pattern);
    if (unsafe) {
      warnRuleOnce(`${source}\0${rule.id}\0${rule.pattern}`, options.warn,
        `${source}: skipped lint rule ${JSON.stringify(rule.id)}: ${unsafe}`);
      continue;
    }
    try {
      const flags = [...new Set(`${rule.flags ?? ""}g`)].join("");
      compiled.push(Object.freeze({ ...rule, regex: new RegExp(rule.pattern, flags) }));
    } catch {
      warnRuleOnce(`${source}\0${rule.id}\0${rule.pattern}`, options.warn,
        `${source}: skipped lint rule ${JSON.stringify(rule.id)}: invalid regular expression`);
    }
  }
  return Object.freeze({ rules: Object.freeze(compiled) });
}

function parsePack(candidate: ConfigCandidate, warn?: (path: string) => void): CompiledLintPack | null {
  const cacheKey = `${candidate.path}\0${candidate.content}`;
  const cached = packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let pack: CompiledLintPack | null = null;
  try {
    const parsed = lintPackSchema.parse(parseYaml(candidate.content));
    pack = Object.freeze({
      disable: Object.freeze(parsed.disable),
      rules: compileLintRules(parsed.rules, {
        source: candidate.path,
        warn: () => warn?.(candidate.path),
      }).rules,
    });
  } catch {
    warn?.(candidate.path);
  }
  packCache.set(cacheKey, pack);
  if (packCache.size > MAX_PACK_CACHE_ENTRIES) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  return pack;
}

export async function loadLintRules(
  cwd: string,
  ghostHome: string,
  options: WatchdogDiscoveryOptions & { warn?: (path: string) => void } = {},
): Promise<LoadedLintRules> {
  const candidates = await collectLintPackCandidates(cwd, ghostHome, options);
  const disabledBuiltinRuleIds = new Set<string>();
  const rules: CompiledLintRule[] = [];
  for (const candidate of candidates) {
    const pack = parsePack(candidate, options.warn);
    if (!pack) continue;
    for (const id of pack.disable) disabledBuiltinRuleIds.add(id);
    rules.push(...pack.rules.slice(0, MAX_OWNER_RULES - rules.length));
  }
  return Object.freeze({
    disabledBuiltinRuleIds,
    rules: Object.freeze(rules),
  });
}

export function withoutLintRules(
  ruleSet: CompiledLintRuleSet,
  disabledRuleIds: ReadonlySet<string>,
): CompiledLintRuleSet {
  if (disabledRuleIds.size === 0) return ruleSet;
  return Object.freeze({
    rules: Object.freeze(ruleSet.rules.filter((rule) => !disabledRuleIds.has(rule.id))),
  });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const candidate = value.length > maximumBytes ? value.slice(0, maximumBytes) : value;
  const bytes = Buffer.from(candidate, "utf8");
  if (bytes.length <= maximumBytes) return candidate;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, maximumBytes));
}

function excerpt(value: string): string {
  const chars = [...value.replace(/\s+/gu, " ").trim()];
  return chars.length > MAX_LINT_EXCERPT_CODE_POINTS
    ? `${chars.slice(0, MAX_LINT_EXCERPT_CODE_POINTS - 1).join("")}…`
    : chars.join("");
}

function interpolate(message: string, values: Readonly<Record<string, string>>): string {
  let rendered = message;
  for (const [name, value] of Object.entries(values)) rendered = rendered.replaceAll(`{${name}}`, value);
  const chars = [...rendered];
  return chars.length > MAX_MESSAGE_CHARS
    ? `${chars.slice(0, MAX_MESSAGE_CHARS - 1).join("")}…`
    : rendered;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function findAll(text: string, regex: RegExp, limit: number): Span[] {
  const spans: Span[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match !== null && spans.length < limit; match = regex.exec(text)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return spans;
}

function statFindings(rule: LintStatRule, text: string, limit: number): IndexedFinding[] {
  const make = (span: Span, values: Readonly<Record<string, string>> = {}): IndexedFinding => ({
    ruleId: rule.id,
    severity: rule.severity,
    message: interpolate(rule.message, values),
    ...(rule.fix === undefined ? {} : { fix: rule.fix }),
    excerpt: excerpt(text.slice(span.start, span.end)),
    start: span.start,
    sequence: 0,
  });
  if (rule.check === "em-dash-density") {
    const wordCount = words(text).length;
    if (wordCount < 15) return [];
    const spans = findAll(text, /—/gu, text.length);
    const per100 = (spans.length / wordCount) * 100;
    if (per100 < (rule.threshold ?? 2.5)) return [];
    return spans.slice(0, limit).map((span) => make(span, { per100: per100.toFixed(1) }));
  }
  if (rule.check === "hedging-ratio") {
    const wordCount = words(text).length;
    if (wordCount < 20) return [];
    const spans = findAll(
      text,
      /\b(?:perhaps|arguably|generally|typically|often|likely|potentially|essentially|ultimately|overall|in many ways)\b/giu,
      text.length,
    );
    if ((spans.length / wordCount) * 100 < (rule.threshold ?? 3)) return [];
    return spans.slice(0, limit).map((span) => make(span));
  }
  const sentenceList = sentences(text);
  if (sentenceList.length < 4) return [];
  const lengths = sentenceList.map((sentence) => words(sentence).length);
  const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  if (mean < 8) return [];
  const deviation = Math.sqrt(
    lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0) / lengths.length,
  );
  if (deviation / mean > (rule.threshold ?? 0.3)) return [];
  return [make({ start: 0, end: 0 }, { lengths: lengths.join(", ") })];
}

interface ProseSegment {
  text: string;
  offset: number;
}

function proseSegments(text: string): ProseSegment[] {
  const segments: ProseSegment[] = [];
  const flush = (start: number, end: number) => {
    if (end > start) segments.push({ text: text.slice(start, end), offset: start });
  };
  let fence: string | undefined;
  let segmentStart = 0;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence === undefined) {
      if (marker) {
        flush(segmentStart, lineStart);
        fence = marker;
      }
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = undefined;
      segmentStart = Math.min(lineEnd + 1, text.length);
    }
    lineStart = lineEnd + 1;
  }
  if (fence === undefined) flush(segmentStart, text.length);
  return segments;
}

function boundedInputs(inputs: LintInputs): Array<{ target: LintTarget; text: string; offset: number }> {
  const values: Array<{ target: LintTarget; text: string }> = [
    ...(inputs.prose === undefined ? [] : [{ target: "prose" as const, text: inputs.prose }]),
    ...(inputs.commands ?? []).map((text) => ({ target: "command" as const, text })),
    ...(inputs.paths ?? []).map((text) => ({ target: "path" as const, text })),
  ];
  const bounded: Array<{ target: LintTarget; text: string; offset: number }> = [];
  let remaining = MAX_LINT_INPUT_BYTES;
  let offset = 0;
  for (const value of values) {
    if (remaining <= 0) break;
    const text = truncateUtf8(value.text, remaining);
    remaining -= Buffer.byteLength(text, "utf8");
    bounded.push({ ...value, text, offset });
    offset += value.text.length + 1;
  }
  return bounded;
}

export function runLint(
  ruleSets: readonly CompiledLintRuleSet[],
  inputs: LintInputs,
): LintFinding[] {
  const findings: IndexedFinding[] = [];
  const perRule = new Map<string, number>();
  let sequence = 0;
  const rules = ruleSets.flatMap((set) => set.rules);
  for (const input of boundedInputs(inputs)) {
    const segments = input.target === "prose" ? proseSegments(input.text) : [{ text: input.text, offset: 0 }];
    for (const segment of segments) {
      for (const rule of rules) {
        if (findings.length >= MAX_LINT_FINDINGS) break;
        if (rule.target !== input.target) continue;
        const used = perRule.get(rule.id) ?? 0;
        const available = MAX_LINT_FINDINGS_PER_RULE - used;
        if (available <= 0) continue;
        const next = rule.kind === "stat"
          ? statFindings(rule, segment.text, available)
          : findAll(segment.text, rule.regex, available).map((span): IndexedFinding => ({
              ruleId: rule.id,
              severity: rule.severity,
              message: interpolate(rule.message, { match: segment.text.slice(span.start, span.end) }),
              ...(rule.fix === undefined ? {} : { fix: rule.fix }),
              excerpt: excerpt(segment.text.slice(span.start, span.end)),
              start: span.start,
              sequence: 0,
            }));
        for (const finding of next) {
          if (findings.length >= MAX_LINT_FINDINGS) break;
          findings.push({
            ...finding,
            start: input.offset + segment.offset + finding.start,
            sequence: sequence++,
          });
          perRule.set(rule.id, (perRule.get(rule.id) ?? 0) + 1);
        }
      }
    }
  }
  findings.sort((left, right) => left.start - right.start || left.sequence - right.sequence);
  return findings.map(({ start: _start, sequence: _sequence, ...finding }) => finding);
}
