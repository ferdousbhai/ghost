/**
 * Built-in prose lint rules, ported from ferdousbhai/slop-detector
 * (`extension/engine.js`, MIT, commit 6e27337). Pattern sources credited
 * upstream: dmmulroy/anti-slop (architecture), the cursor/plugins unslop
 * skill, and petergyang/no-ai-slop (pattern lists). Rule ids, severities,
 * messages, and per-rule fix instructions are the findings contract; change
 * them only with the upstream engine. Rules are inert data consumed by lint.ts.
 */
import type { LintPatternRule, LintRule, LintSeverity } from "./lint.js";

const FIXES = Object.freeze({
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
} as const);

export const BUILTIN_LINT_RULE_IDS = Object.freeze(Object.keys(FIXES));

interface PatternSource {
  id: keyof typeof FIXES;
  severity: LintSeverity;
  pattern: string;
  flags?: string;
  message: string;
}

function patternRules(sources: readonly PatternSource[]): LintPatternRule[] {
  return sources.map((source) => ({
    kind: "pattern",
    target: "prose",
    fix: FIXES[source.id],
    ...source,
  }));
}

const CATALOG = patternRules([
  { id: "chatbot-phrase", severity: "blocker", pattern: "i hope this (?:message|email|note)? ?finds you well", flags: "i", message: "\"{match}\" — Canonical AI opener." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bi'?d be happy to\\b", flags: "i", message: "\"{match}\" — Assistant-speak." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\blet me know if you have any (?:questions|thoughts)\\b", flags: "i", message: "\"{match}\" — Assistant-speak closer." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bfeel free to\\b", flags: "i", message: "\"{match}\" — Assistant-speak." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bgreat question\\b", flags: "i", message: "\"{match}\" — Sycophantic opener." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\byou'?re absolutely right\\b", flags: "i", message: "\"{match}\" — Sycophantic tone." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bcertainly!", flags: "i", message: "\"{match}\" — Assistant-speak." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bof course!", flags: "i", message: "\"{match}\" — Assistant-speak." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bas an ai\\b", flags: "i", message: "\"{match}\" — Literal AI disclosure." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bi appreciate your patience\\b", flags: "i", message: "\"{match}\" — Support-bot phrasing." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bplease don'?t hesitate to\\b", flags: "i", message: "\"{match}\" — Support-bot phrasing." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\b(?:hope (?:this|that) helps|let me know if (?:you need|there'?s) anything else|happy to (?:help|assist|clarify) (?:further|more|with anything else))\\b[!.]*", flags: "i", message: "\"{match}\" — Assistant-style closing offer." },
  { id: "chatbot-phrase", severity: "blocker", pattern: "\\bfound the smoking gun\\b", flags: "i", message: "\"{match}\" — Agent-speak (unslop #20)." },

  { id: "puffery", severity: "blocker", pattern: "\\b(?:marks?|marking) a pivotal moment\\b", flags: "i", message: "\"{match}\" — Importance puffery — state what happened." },
  { id: "puffery", severity: "blocker", pattern: "\\b(?:stands? as|is) a testament to\\b", flags: "i", message: "\"{match}\" — Importance puffery." },
  { id: "puffery", severity: "blocker", pattern: "\\bevolving landscape\\b", flags: "i", message: "\"{match}\" — Stock AI framing." },
  { id: "puffery", severity: "blocker", pattern: "\\bsetting the stage for\\b", flags: "i", message: "\"{match}\" — Puffery (unslop #1)." },
  { id: "puffery", severity: "blocker", pattern: "\\bindelible mark\\b", flags: "i", message: "\"{match}\" — Puffery (unslop #1)." },
  { id: "puffery", severity: "blocker", pattern: "\\bdeeply rooted\\b", flags: "i", message: "\"{match}\" — Puffery (unslop #1)." },
  { id: "puffery", severity: "blocker", pattern: "\\bplays? a vital role\\b", flags: "i", message: "\"{match}\" — Importance puffery." },
  { id: "puffery", severity: "blocker", pattern: "\\bsolidif(?:y|ies|ying) (?:its|their|his|her) position\\b", flags: "i", message: "\"{match}\" — Importance puffery." },
  { id: "puffery", severity: "blocker", pattern: "\\bunderscor(?:es?|ing) (?:its|the) (?:significance|importance|commitment)\\b", flags: "i", message: "\"{match}\" — Importance puffery." },
  { id: "puffery", severity: "blocker", pattern: "\\b(?:rich|vibrant) tapestry\\b", flags: "i", message: "\"{match}\" — AI-favored metaphor." },
  { id: "puffery", severity: "blocker", pattern: "\\bin today'?s fast-paced (?:world|environment)\\b", flags: "i", message: "\"{match}\" — Stock AI framing." },
  { id: "puffery", severity: "blocker", pattern: "\\bdespite (?:these |the |its )?challenges[^.!?\\n]{0,60}(?:continues? to thrive|remains?)\\b", flags: "i", message: "\"{match}\" — Formulaic challenges (unslop #6)." },
  { id: "puffery", severity: "blocker", pattern: "\\bunlock (?:the|your) (?:full )?potential\\b", flags: "i", message: "\"{match}\" — Stock AI hype." },
  { id: "puffery", severity: "blocker", pattern: "\\bthe future looks bright\\b", flags: "i", message: "\"{match}\" — Generic conclusion (unslop #25)." },

  { id: "vague-attribution", severity: "blocker", pattern: "\\bexperts (?:believe|agree|say|suggest)\\b", flags: "i", message: "\"{match}\" — Weasel attribution — name the source." },
  { id: "vague-attribution", severity: "blocker", pattern: "\\bindustry reports? suggests?\\b", flags: "i", message: "\"{match}\" — Weasel attribution." },
  { id: "vague-attribution", severity: "blocker", pattern: "\\bstudies (?:show|suggest|indicate)\\b", flags: "i", message: "\"{match}\" — Weasel attribution." },
  { id: "vague-attribution", severity: "blocker", pattern: "\\bwidely regarded as\\b", flags: "i", message: "\"{match}\" — Weasel attribution." },
  { id: "vague-attribution", severity: "blocker", pattern: "\\b(?:some|many) (?:critics|people|would) argue\\b", flags: "i", message: "\"{match}\" — Weasel attribution." },

  { id: "throat-clearing", severity: "blocker", pattern: "\\bhere'?s the thing\\b", flags: "i", message: "\"{match}\" — Throat-clearing opener." },
  { id: "throat-clearing", severity: "blocker", pattern: "\\blet me be clear\\b", flags: "i", message: "\"{match}\" — Throat-clearing opener." },
  { id: "throat-clearing", severity: "blocker", pattern: "\\bthe (?:uncomfortable|hard|simple) truth is\\b", flags: "i", message: "\"{match}\" — Throat-clearing opener." },
  { id: "throat-clearing", severity: "blocker", pattern: "\\blet'?s dive in\\b", flags: "i", message: "\"{match}\" — Empty phrase (no-ai-slop)." },
  { id: "faux-insight", severity: "blocker", pattern: "\\bwhat most people (?:get wrong|miss|don'?t (?:know|realize|understand))\\b", flags: "i", message: "\"{match}\" — Faux-insight setup." },
  { id: "faux-insight", severity: "blocker", pattern: "\\bhere'?s what nobody tells you\\b", flags: "i", message: "\"{match}\" — Faux-insight setup." },
  { id: "faux-insight", severity: "blocker", pattern: "\\bthe part everyone misses\\b", flags: "i", message: "\"{match}\" — Faux-insight setup." },
  { id: "faux-insight", severity: "blocker", pattern: "\\bthis is the part most people skip\\b", flags: "i", message: "\"{match}\" — Faux-insight setup." },

  { id: "rhetorical-setup", severity: "blocker", pattern: "\\bwhat if i told you\\b", flags: "i", message: "\"{match}\" — Rhetorical setup." },
  { id: "rhetorical-setup", severity: "blocker", pattern: "\\bthink about it:", flags: "i", message: "\"{match}\" — Rhetorical setup." },
  { id: "rhetorical-setup", severity: "blocker", pattern: "\\bplot twist:", flags: "i", message: "\"{match}\" — Rhetorical setup." },
  { id: "colon-reveal", severity: "blocker", pattern: "\\b(?:the best part|the kicker|the catch|the twist|the result):\\s", flags: "i", message: "\"{match}\" — Colon reveal — fake drama (no-ai-slop)." },
  { id: "dramatic-fragment", severity: "blocker", pattern: "\\bthat'?s it\\.\\s+that'?s\\b", flags: "i", message: "\"{match}\" — “That's it. That's the whole thing.” fragment drama." },

  { id: "essay-connective", severity: "blocker", pattern: "\\bmoreover\\b", flags: "i", message: "\"{match}\" — Essay connective — rare in real chat." },
  { id: "essay-connective", severity: "blocker", pattern: "\\bfurthermore\\b", flags: "i", message: "\"{match}\" — Essay connective — rare in real chat." },
  { id: "essay-connective", severity: "blocker", pattern: "\\badditionally,", flags: "i", message: "\"{match}\" — Essay connective — rare in real chat." },
  { id: "recap-ending", severity: "blocker", pattern: "(?:^|(?<=[.!?]\\s))(?:in conclusion|in summary|to sum up|overall,|ultimately,)", flags: "im", message: "\"{match}\" — Summary-recap ending — the reader was just there." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bit(?:'?s| is) (?:worth noting|important to note)\\b", flags: "i", message: "\"{match}\" — Filler — delete it." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bdue to the fact that\\b", flags: "i", message: "\"{match}\" — → “because”." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bin order to\\b", flags: "i", message: "\"{match}\" — → “to”." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bat the end of the day\\b", flags: "i", message: "\"{match}\" — Stock filler." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bwhen it comes to\\b", flags: "i", message: "\"{match}\" — Often-empty phrase." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bat its core\\b", flags: "i", message: "\"{match}\" — Often-empty phrase." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bin (?:today'?s|the) (?:world|age of)\\b", flags: "i", message: "\"{match}\" — Often-empty phrase." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bthe (?:reality|truth) is\\b", flags: "i", message: "\"{match}\" — Often-empty phrase." },
  { id: "filler-phrase", severity: "nit", pattern: "\\bgoing forward\\b", flags: "i", message: "\"{match}\" — Often-empty phrase." },

  { id: "inflated-verb", severity: "nit", pattern: "\\bserves? as\\b", flags: "i", message: "\"{match}\" — → just say “is”." },
  { id: "inflated-verb", severity: "nit", pattern: "\\bstands? as\\b", flags: "i", message: "\"{match}\" — → just say “is”." },
  { id: "inflated-verb", severity: "nit", pattern: "\\bboasts?\\b", flags: "i", message: "\"{match}\" — → “has”." },
  { id: "landscape-cliche", severity: "blocker", pattern: "\\bnavigat(?:e|ing) (?:the|this|these|today's) (?:complex|challenging|evolving|landscape)", flags: "i", message: "\"{match}\" — “Navigating the X landscape” cliché." },
]);

const AI_VOCABULARY = patternRules([
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
].map(([source, why]) => ({
  id: "ai-vocabulary" as const,
  severity: "nit" as const,
  pattern: `\\b${source}\\b`,
  flags: "i",
  message: `"{match}" — ${why}`,
})));

export const BUILTIN_LINT_RULES: readonly LintRule[] = Object.freeze([
  ...CATALOG,
  ...AI_VOCABULARY,
  ...patternRules([
    {
      id: "binary-contrast",
      severity: "blocker",
      pattern: "\\b(?:it'?s|this is|that'?s|they'?re|is)? ?not (?:just|only|merely|simply) [^.!?\\n]{2,60}?[,;—-]? ?(?:it'?s|but(?: also)?|but rather)\\b",
      flags: "i",
      message: "“Not just X, but Y” — signature AI cadence. State Y directly.",
    },
    {
      id: "binary-contrast",
      severity: "blocker",
      pattern: "\\b(?:this |that |the \\w+ )?(?:isn'?t|is not|wasn'?t)(?: about)? [^.!?\\n]{2,50}[.,;]\\s*it'?s\\b",
      flags: "i",
      message: "Binary contrast (“It isn't X. It's Y.”) — state Y directly.",
    },
    {
      id: "binary-contrast",
      severity: "blocker",
      pattern: "\\bnot an? [^.!?\\n]{2,40}\\.\\s+not an?\\b",
      flags: "i",
      message: "Negative listing (“Not a X. Not a Y. A Z.”) — just say Z.",
    },
    {
      id: "ing-explainer",
      severity: "blocker",
      pattern: ",\\s+(?:highlighting|underscoring|reflecting|showcasing|fostering|ensuring|emphasizing|demonstrating|signaling|cementing)\\b[^.!?\\n]{0,60}",
      flags: "i",
      message: "Trailing “-ing” clause pretending to explain meaning — delete or replace with a concrete fact.",
    },
    {
      id: "triad-adjectives",
      severity: "nit",
      pattern: "\\b\\w+(?:ive|ing|ed|ful|ous|able|ant|ent|al|ic|y),\\s+\\w+(?:ive|ing|ed|ful|ous|able|ant|ent|al|ic|y),\\s+and\\s+\\w+(?:ive|ing|ed|ful|ous|able|ant|ent|al|ic|y)\\b",
      flags: "i",
      message: "Rule-of-three adjective triad — use the natural number of items.",
    },
    {
      id: "emoji-bullets",
      severity: "blocker",
      pattern: "^\\s*(?:[✀-➿☀-⛿]|\\p{Extended_Pictographic})\\s+\\S[^\\n]*(?:\\n|$)(?:(?!^\\s*(?:[✀-➿☀-⛿]|\\p{Extended_Pictographic})\\s+\\S)[\\s\\S])*?^\\s*(?:[✀-➿☀-⛿]|\\p{Extended_Pictographic})\\s+\\S",
      flags: "mu",
      message: "Emoji used as list bullets — a strong AI formatting tell.",
    },
  ]),
  {
    id: "em-dash-density",
    target: "prose",
    kind: "stat",
    check: "em-dash-density",
    threshold: 2.5,
    severity: "nit",
    message: "Em-dash density is {per100} per 100 words — models lean on these hard.",
    fix: FIXES["em-dash-density"],
  },
  {
    id: "hedging-ratio",
    target: "prose",
    kind: "stat",
    check: "hedging-ratio",
    threshold: 3,
    severity: "nit",
    message: "Heavy hedging — models soften every claim.",
    fix: FIXES["hedging-ratio"],
  },
  {
    id: "uniform-sentences",
    target: "prose",
    kind: "stat",
    check: "sentence-uniformity",
    threshold: 0.3,
    severity: "nit",
    message: "Sentences are eerily uniform ({lengths} words each). Humans vary rhythm more.",
    fix: FIXES["uniform-sentences"],
  },
]);
