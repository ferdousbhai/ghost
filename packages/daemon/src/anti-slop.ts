/**
 * Deterministic anti-slop prose engine, ported from ferdousbhai/slop-detector
 * (`extension/engine.js`, MIT, commit 6e27337). Pattern sources credited
 * upstream: dmmulroy/anti-slop (architecture), the cursor/plugins unslop
 * skill, and petergyang/no-ai-slop (pattern lists). Rule ids, severities,
 * messages, offsets, and per-rule fix instructions are the findings contract;
 * change them only with the upstream engine. Pure text analysis: no I/O.
 */

export type SlopSeverity = "minor" | "major";

export interface SlopFinding {
  ruleId: string;
  severity: SlopSeverity;
  message: string;
  /** The per-rule fix instruction a rewrite pass applies. */
  instruction: string;
  /** UTF-16 offsets into the analyzed text; `[0, 0)` for whole-text findings. */
  start: number;
  end: number;
}

const MINOR: SlopSeverity = "minor";
const MAJOR: SlopSeverity = "major";

const INSTRUCTIONS: Readonly<Record<string, string>> = Object.freeze({
  "ai-vocabulary": "Use plain, specific wording.",
  "binary-contrast": "State the positive claim directly.",
  "chatbot-phrase": "Remove canned assistant phrasing.",
  "colon-reveal": "Remove the staged reveal.",
  "dramatic-fragment": "Rewrite as a direct sentence.",
  "em-dash-density": "Use no em dashes.",
  "emoji-bullets": "Use plain list bullets.",
  "essay-connective": "Remove formal transition filler.",
  "faux-insight": "State the point directly.",
  "filler-phrase": "Delete or shorten the filler.",
  "hedging-ratio": "Keep only necessary uncertainty.",
  "inflated-verb": "Use a plain verb.",
  "ing-explainer": "Delete the trailing explanation or state a concrete fact.",
  "landscape-cliche": "Replace the cliche with a concrete description.",
  "puffery": "State the fact without hype.",
  "recap-ending": "Remove the unnecessary recap.",
  "rhetorical-setup": "State the point directly.",
  "throat-clearing": "Start with the substantive point.",
  "triad-adjectives": "Use only necessary modifiers.",
  "uniform-sentences": "Vary sentence lengths.",
  "vague-attribution": "Name the source or remove the attribution.",
});

export const SLOP_RULE_IDS: readonly string[] = Object.freeze(Object.keys(INSTRUCTIONS));

export function slopRuleInstruction(ruleId: string): string {
  return INSTRUCTIONS[ruleId] ?? "Remove the flagged pattern.";
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface Span {
  start: number;
  end: number;
}

/** One global-flagged clone per source pattern; the analysis is synchronous, so sharing is safe. */
const globalised = new WeakMap<RegExp, RegExp>();

function findAll(text: string, regex: RegExp): Span[] {
  const out: Span[] = [];
  let re = globalised.get(regex);
  if (!re) {
    re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    globalised.set(regex, re);
  }
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

interface CatalogEntry {
  id: string;
  sev: SlopSeverity;
  p: RegExp;
  why: string;
}

const AI_VOCABULARY: ReadonlyArray<readonly [string, string]> = [
  ["delve", "Top AI tell."], ["tapestry", "AI metaphor noun."], ["foster(?:s|ing|ed)?", "AI vocabulary."],
  ["leverag(?:e|es|ing|ed)", "→ “use”."], ["utiliz(?:e|es|ing|ed)", "→ “use”."],
  ["facilitat(?:e|es|ing|ed)", "→ “help”."], ["empower(?:s|ing|ed)?", "AI vocabulary."],
  ["streamlin(?:e|es|ing|ed)", "AI vocabulary."], ["robust", "AI vocabulary."],
  ["cutting-edge", "Hype word."], ["game-?changer", "Hype word."], ["groundbreaking", "Promotional word."],
  ["seamless(?:ly)?", "Marketing filler."], ["transformative", "Hype word."], ["paradigm shift", "Hype phrase."],
  ["realm", "AI vocabulary."], ["beacon", "AI vocabulary."], ["multifaceted", "AI vocabulary."],
  ["meticulous(?:ly)?", "AI vocabulary."], ["intricate", "AI vocabulary."], ["paramount", "AI vocabulary."],
  ["elevate(?:s|d)?", "Marketing filler."], ["embark(?:s|ing|ed)?", "AI vocabulary."],
  ["supercharge(?:s|d)?", "Hype word."], ["harness(?:es|ing|ed)?", "AI metaphor verb."],
  ["ever-evolving", "AI vocabulary."], ["crucial(?:ly)?", "AI vocabulary."], ["enduring", "AI vocabulary."],
  ["enhanc(?:e|es|ing|ed)", "AI vocabulary."], ["garner(?:s|ed|ing)?", "AI vocabulary."],
  ["interplay", "AI vocabulary."], ["pivotal", "AI vocabulary."], ["showcas(?:e|es|ing|ed)", "AI vocabulary."],
  ["testament", "AI vocabulary."], ["underscor(?:e|es|ing|ed)", "AI vocabulary."],
  ["nestled", "Promotional word."], ["breathtaking", "Promotional word."], ["renowned", "Promotional word."],
  ["stunning", "Promotional word."], ["must-visit", "Promotional word."],
  ["dive (?:deep(?:er)? )?into", "AI-favored verb."],
];

const CATALOG: readonly CatalogEntry[] = [
  // --- canonical openers / assistant-speak (major) ---
  { id: "chatbot-phrase", sev: MAJOR, p: /i hope this (?:message|email|note)? ?finds you well/i, why: "Canonical AI opener." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bi'?d be happy to\b/i, why: "Assistant-speak." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\blet me know if you have any (?:questions|thoughts)\b/i, why: "Assistant-speak closer." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bfeel free to\b/i, why: "Assistant-speak." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bgreat question\b/i, why: "Sycophantic opener." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\byou'?re absolutely right\b/i, why: "Sycophantic tone." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bcertainly!/i, why: "Assistant-speak." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bof course!/i, why: "Assistant-speak." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bas an ai\b/i, why: "Literal AI disclosure." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bi appreciate your patience\b/i, why: "Support-bot phrasing." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bplease don'?t hesitate to\b/i, why: "Support-bot phrasing." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\b(?:hope (?:this|that) helps|let me know if (?:you need|there'?s) anything else|happy to (?:help|assist|clarify) (?:further|more|with anything else))\b[!.]*/i, why: "Assistant-style closing offer." },
  { id: "chatbot-phrase", sev: MAJOR, p: /\bfound the smoking gun\b/i, why: "Agent-speak (unslop #20)." },

  // --- puffery / importance inflation (major) ---
  { id: "puffery", sev: MAJOR, p: /\b(?:marks?|marking) a pivotal moment\b/i, why: "Importance puffery — state what happened." },
  { id: "puffery", sev: MAJOR, p: /\b(?:stands? as|is) a testament to\b/i, why: "Importance puffery." },
  { id: "puffery", sev: MAJOR, p: /\bevolving landscape\b/i, why: "Stock AI framing." },
  { id: "puffery", sev: MAJOR, p: /\bsetting the stage for\b/i, why: "Puffery (unslop #1)." },
  { id: "puffery", sev: MAJOR, p: /\bindelible mark\b/i, why: "Puffery (unslop #1)." },
  { id: "puffery", sev: MAJOR, p: /\bdeeply rooted\b/i, why: "Puffery (unslop #1)." },
  { id: "puffery", sev: MAJOR, p: /\bplays? a vital role\b/i, why: "Importance puffery." },
  { id: "puffery", sev: MAJOR, p: /\bsolidif(?:y|ies|ying) (?:its|their|his|her) position\b/i, why: "Importance puffery." },
  { id: "puffery", sev: MAJOR, p: /\bunderscor(?:es?|ing) (?:its|the) (?:significance|importance|commitment)\b/i, why: "Importance puffery." },
  { id: "puffery", sev: MAJOR, p: /\b(?:rich|vibrant) tapestry\b/i, why: "AI-favored metaphor." },
  { id: "puffery", sev: MAJOR, p: /\bin today'?s fast-paced (?:world|environment)\b/i, why: "Stock AI framing." },
  { id: "puffery", sev: MAJOR, p: /\bdespite (?:these |the |its )?challenges[^.!?\n]{0,60}(?:continues? to thrive|remains?)\b/i, why: "Formulaic challenges (unslop #6)." },
  { id: "puffery", sev: MAJOR, p: /\bunlock (?:the|your) (?:full )?potential\b/i, why: "Stock AI hype." },
  { id: "puffery", sev: MAJOR, p: /\bthe future looks bright\b/i, why: "Generic conclusion (unslop #25)." },

  // --- vague attribution (major) ---
  { id: "vague-attribution", sev: MAJOR, p: /\bexperts (?:believe|agree|say|suggest)\b/i, why: "Weasel attribution — name the source." },
  { id: "vague-attribution", sev: MAJOR, p: /\bindustry reports? suggests?\b/i, why: "Weasel attribution." },
  { id: "vague-attribution", sev: MAJOR, p: /\bstudies (?:show|suggest|indicate)\b/i, why: "Weasel attribution." },
  { id: "vague-attribution", sev: MAJOR, p: /\bwidely regarded as\b/i, why: "Weasel attribution." },
  { id: "vague-attribution", sev: MAJOR, p: /\b(?:some|many) (?:critics|people|would) argue\b/i, why: "Weasel attribution." },

  // --- throat-clearing & faux insight (major) ---
  { id: "throat-clearing", sev: MAJOR, p: /\bhere'?s the thing\b/i, why: "Throat-clearing opener." },
  { id: "throat-clearing", sev: MAJOR, p: /\blet me be clear\b/i, why: "Throat-clearing opener." },
  { id: "throat-clearing", sev: MAJOR, p: /\bthe (?:uncomfortable|hard|simple) truth is\b/i, why: "Throat-clearing opener." },
  { id: "throat-clearing", sev: MAJOR, p: /\blet'?s dive in\b/i, why: "Empty phrase (no-ai-slop)." },
  { id: "faux-insight", sev: MAJOR, p: /\bwhat most people (?:get wrong|miss|don'?t (?:know|realize|understand))\b/i, why: "Faux-insight setup." },
  { id: "faux-insight", sev: MAJOR, p: /\bhere'?s what nobody tells you\b/i, why: "Faux-insight setup." },
  { id: "faux-insight", sev: MAJOR, p: /\bthe part everyone misses\b/i, why: "Faux-insight setup." },
  { id: "faux-insight", sev: MAJOR, p: /\bthis is the part most people skip\b/i, why: "Faux-insight setup." },

  // --- rhetorical setups & drama (major) ---
  { id: "rhetorical-setup", sev: MAJOR, p: /\bwhat if i told you\b/i, why: "Rhetorical setup." },
  { id: "rhetorical-setup", sev: MAJOR, p: /\bthink about it:/i, why: "Rhetorical setup." },
  { id: "rhetorical-setup", sev: MAJOR, p: /\bplot twist:/i, why: "Rhetorical setup." },
  { id: "colon-reveal", sev: MAJOR, p: /\b(?:the best part|the kicker|the catch|the twist|the result):\s/i, why: "Colon reveal — fake drama (no-ai-slop)." },
  { id: "dramatic-fragment", sev: MAJOR, p: /\bthat'?s it\.\s+that'?s\b/i, why: "“That's it. That's the whole thing.” fragment drama." },

  // --- essay connectives & filler (major-ish) ---
  { id: "essay-connective", sev: MAJOR, p: /\bmoreover\b/i, why: "Essay connective — rare in real chat." },
  { id: "essay-connective", sev: MAJOR, p: /\bfurthermore\b/i, why: "Essay connective — rare in real chat." },
  { id: "essay-connective", sev: MAJOR, p: /\badditionally,/i, why: "Essay connective — rare in real chat." },
  { id: "recap-ending", sev: MAJOR, p: /(?:^|(?<=[.!?]\s))(?:in conclusion|in summary|to sum up|overall,|ultimately,)/im, why: "Summary-recap ending — the reader was just there." },
  { id: "filler-phrase", sev: MINOR, p: /\bit(?:'?s| is) (?:worth noting|important to note)\b/i, why: "Filler — delete it." },
  { id: "filler-phrase", sev: MINOR, p: /\bdue to the fact that\b/i, why: "→ “because”." },
  { id: "filler-phrase", sev: MINOR, p: /\bin order to\b/i, why: "→ “to”." },
  { id: "filler-phrase", sev: MINOR, p: /\bat the end of the day\b/i, why: "Stock filler." },
  { id: "filler-phrase", sev: MINOR, p: /\bwhen it comes to\b/i, why: "Often-empty phrase." },
  { id: "filler-phrase", sev: MINOR, p: /\bat its core\b/i, why: "Often-empty phrase." },
  { id: "filler-phrase", sev: MINOR, p: /\bin (?:today'?s|the) (?:world|age of)\b/i, why: "Often-empty phrase." },
  { id: "filler-phrase", sev: MINOR, p: /\bthe (?:reality|truth) is\b/i, why: "Often-empty phrase." },
  { id: "filler-phrase", sev: MINOR, p: /\bgoing forward\b/i, why: "Often-empty phrase." },

  // --- fancy ways to say "is" (minor) ---
  { id: "inflated-verb", sev: MINOR, p: /\bserves? as\b/i, why: "→ just say “is”." },
  { id: "inflated-verb", sev: MINOR, p: /\bstands? as\b/i, why: "→ just say “is”." },
  { id: "inflated-verb", sev: MINOR, p: /\bboasts?\b/i, why: "→ “has”." },

  // --- landscape cliche (major) + AI vocabulary, single words (minor) ---
  { id: "landscape-cliche", sev: MAJOR, p: /\bnavigat(?:e|ing) (?:the|this|these|today's) (?:complex|challenging|evolving|landscape)/i, why: "“Navigating the X landscape” cliché." },
  ...AI_VOCABULARY.map(([w, why]): CatalogEntry => ({
    id: "ai-vocabulary",
    sev: MINOR,
    p: new RegExp(`\\b${w}\\b`, "i"),
    why,
  })),
];

type Rule = (text: string) => SlopFinding[];

function finding(
  ruleId: string,
  severity: SlopSeverity,
  span: Span,
  message: string,
): SlopFinding {
  return { ruleId, severity, message, instruction: slopRuleInstruction(ruleId), ...span };
}

const rules: readonly Rule[] = [
  function catalog(text) {
    const out: SlopFinding[] = [];
    for (const { id, sev, p, why } of CATALOG) {
      for (const span of findAll(text, p)) {
        out.push(finding(id, sev, span, `"${text.slice(span.start, span.end)}" — ${why}`));
      }
    }
    return out;
  },
  function binaryContrast(text) {
    const out: SlopFinding[] = [];
    // "not just X, but Y" / "not just X, it's Y"
    for (const span of findAll(
      text,
      /\b(?:it'?s|this is|that'?s|they'?re|is)? ?not (?:just|only|merely|simply) [^.!?\n]{2,60}?[,;—-]? ?(?:it'?s|but(?: also)?|but rather)\b/gi,
    )) {
      out.push(finding("binary-contrast", MAJOR, span,
        "“Not just X, but Y” — signature AI cadence. State Y directly."));
    }
    // "This isn't X. It's Y." / "The question isn't X, it's Y."
    for (const span of findAll(
      text,
      /\b(?:this |that |the \w+ )?(?:isn'?t|is not|wasn'?t)(?: about)? [^.!?\n]{2,50}[.,;]\s*it'?s\b/gi,
    )) {
      out.push(finding("binary-contrast", MAJOR, span,
        "Binary contrast (“It isn't X. It's Y.”) — state Y directly."));
    }
    // Negative listing: "Not a X. Not a Y."
    for (const span of findAll(text, /\bnot an? [^.!?\n]{2,40}\.\s+not an?\b/gi)) {
      out.push(finding("binary-contrast", MAJOR, span,
        "Negative listing (“Not a X. Not a Y. A Z.”) — just say Z."));
    }
    return out;
  },
  function ingExplainer(text) {
    return findAll(
      text,
      /,\s+(?:highlighting|underscoring|reflecting|showcasing|fostering|ensuring|emphasizing|demonstrating|signaling|cementing)\b[^.!?\n]{0,60}/gi,
    ).map((span) => finding("ing-explainer", MAJOR, span,
      "Trailing “-ing” clause pretending to explain meaning — delete or replace with a concrete fact."));
  },
  function emDashDensity(text) {
    const w = words(text).length;
    if (w < 15) return [];
    const dashes = findAll(text, /—/g);
    const per100 = (dashes.length / w) * 100;
    if (per100 < 2.5) return [];
    return dashes.map((span) => finding("em-dash-density", MINOR, span,
      `Em-dash density is ${per100.toFixed(1)} per 100 words — models lean on these hard.`));
  },
  function hedgingRatio(text) {
    const w = words(text).length;
    if (w < 20) return [];
    const hedges = findAll(
      text,
      /\b(?:perhaps|arguably|generally|typically|often|likely|potentially|essentially|ultimately|overall|in many ways)\b/gi,
    );
    if ((hedges.length / w) * 100 < 3) return [];
    return hedges.map((span) => finding("hedging-ratio", MINOR, span,
      "Heavy hedging — models soften every claim."));
  },
  function triadAdjectives(text) {
    return findAll(
      text,
      /\b\w+(?:ive|ing|ed|ful|ous|able|ant|ent|al|ic|y),\s+\w+(?:ive|ing|ed|ful|ous|able|ant|ent|al|ic|y),\s+and\s+\w+(?:ive|ing|ed|ful|ous|able|ant|ent|al|ic|y)\b/gi,
    ).map((span) => finding("triad-adjectives", MINOR, span,
      "Rule-of-three adjective triad — use the natural number of items."));
  },
  function uniformSentences(text) {
    const ss = sentences(text);
    if (ss.length < 4) return [];
    const lens = ss.map((s) => words(s).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (mean < 8) return [];
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (sd / mean > 0.3) return [];
    return [finding("uniform-sentences", MINOR, { start: 0, end: 0 },
      `Sentences are eerily uniform (${lens.join(", ")} words each). Humans vary rhythm more.`)];
  },
  function emojiBullets(text) {
    const hits = findAll(text, /^\s*(?:[✀-➿☀-⛿]|\p{Extended_Pictographic})\s+\S/gmu);
    if (hits.length < 2) return [];
    return hits.map((span) => finding("emoji-bullets", MAJOR, span,
      "Emoji used as list bullets — a strong AI formatting tell."));
  },
];

export interface AnalyzeSlopOptions {
  /** Rule ids whose findings are dropped; unknown ids are ignored. */
  disabledRules?: Iterable<string>;
}

/** Analyze raw text. Findings are sorted by start offset. */
export function analyzeSlop(text: string, options: AnalyzeSlopOptions = {}): SlopFinding[] {
  const disabled = new Set(options.disabledRules ?? []);
  const findings: SlopFinding[] = [];
  for (const rule of rules) {
    for (const f of rule(text)) if (!disabled.has(f.ruleId)) findings.push(f);
  }
  findings.sort((a, b) => a.start - b.start);
  return findings;
}

interface ProseSegment {
  text: string;
  offset: number;
}

/**
 * The prose runs of a Markdown-ish text: everything outside ``` / ~~~ fenced
 * code blocks, each with its offset in the original string. An unclosed fence
 * runs to the end of the text, as in CommonMark.
 */
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
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
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

/**
 * Analyze only the prose of a Markdown-ish text, skipping fenced code blocks.
 * Offsets index into the original `text`. Statistical rules run per prose run,
 * so a code block never dilutes or inflates a density threshold.
 */
export function analyzeSlopProse(text: string, options: AnalyzeSlopOptions = {}): SlopFinding[] {
  const findings: SlopFinding[] = [];
  for (const segment of proseSegments(text)) {
    for (const f of analyzeSlop(segment.text, options)) {
      findings.push({ ...f, start: f.start + segment.offset, end: f.end + segment.offset });
    }
  }
  return findings;
}
