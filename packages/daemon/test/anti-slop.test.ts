import { describe, expect, it } from "vitest";
import {
  analyzeSlop,
  analyzeSlopProse,
  renderAntiSlopPromptSection,
  SLOP_RULE_IDS,
  slopRuleInstruction,
  type SlopFinding,
} from "../src/anti-slop.js";

describe("analyzeSlop", () => {
  it("reports nothing on plain prose", () => {
    expect(analyzeSlop("The build passed on the second try. Ship it today.")).toEqual([]);
  });

  const fixtures: ReadonlyArray<[ruleId: string, severity: "minor" | "major", text: string]> = [
    ["ai-vocabulary", "minor", "We delve into the data."],
    ["binary-contrast", "major", "It's not just a tool, but a platform."],
    ["chatbot-phrase", "major", "I'd be happy to help with that."],
    ["colon-reveal", "major", "The best part: it works."],
    ["dramatic-fragment", "major", "That's it. That's the tweet."],
    [
      "em-dash-density",
      "minor",
      "One two three four five six seven eight nine ten eleven twelve thirteen fourteen — fifteen.",
    ],
    ["emoji-bullets", "major", "✨ Fast startup\n🔥 Simple config"],
    ["essay-connective", "major", "Moreover, the cache warms itself."],
    ["faux-insight", "major", "Here's what nobody tells you about pricing."],
    ["filler-phrase", "minor", "In order to win, we must try."],
    [
      "hedging-ratio",
      "minor",
      "Perhaps the team will ship the new build tomorrow if the tests pass and the review lands on time early.",
    ],
    ["inflated-verb", "minor", "The tool serves as a bridge."],
    ["ing-explainer", "major", "Sales rose, highlighting strong demand."],
    ["landscape-cliche", "major", "We navigate the complex world of tech."],
    ["puffery", "major", "This marks a pivotal moment for the team."],
    ["recap-ending", "major", "In conclusion, we win."],
    ["rhetorical-setup", "major", "What if I told you it scales?"],
    ["throat-clearing", "major", "Here's the thing about pricing."],
    ["triad-adjectives", "minor", "The design is elegant, minimal, and useful."],
    [
      "uniform-sentences",
      "minor",
      "The team shipped the release on Monday before lunch. The users tested the build on Tuesday after breakfast. "
      + "The board reviewed the numbers on Wednesday before dinner. The devs planned the sprint on Thursday after standup.",
    ],
    ["vague-attribution", "major", "Experts believe this is fine."],
  ];

  it.each(fixtures)("flags %s as %s", (ruleId, severity, text) => {
    const findings = analyzeSlop(text);
    const hit = findings.find((f) => f.ruleId === ruleId);
    expect(hit, `expected a ${ruleId} finding`).toBeDefined();
    expect(hit?.severity).toBe(severity);
    expect(hit?.instruction).toBe(slopRuleInstruction(ruleId));
  });

  it("covers every rule id with a fixture", () => {
    expect([...fixtures.map(([ruleId]) => ruleId)].sort()).toEqual([...SLOP_RULE_IDS].sort());
  });

  it("reports offsets that slice the flagged text", () => {
    const text = "Sure. I'd be happy to explain.";
    const [hit] = analyzeSlop(text).filter((f) => f.ruleId === "chatbot-phrase");
    expect(hit).toBeDefined();
    const flagged = text.slice(hit!.start, hit!.end);
    expect(flagged.toLowerCase()).toBe("i'd be happy to");
    expect(hit!.message).toContain(flagged);
  });

  it("sorts findings by start offset", () => {
    const findings = analyzeSlop("Great question! Experts believe we should leverage synergy. Moreover, it scales.");
    expect(findings.length).toBeGreaterThan(2);
    const starts = findings.map((f) => f.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("honors disabledRules and ignores unknown ids", () => {
    const text = "I'd be happy to leverage this.";
    const all = analyzeSlop(text);
    expect(all.map((f) => f.ruleId)).toContain("chatbot-phrase");
    const filtered = analyzeSlop(text, { disabledRules: ["chatbot-phrase", "no-such-rule"] });
    expect(filtered.map((f) => f.ruleId)).not.toContain("chatbot-phrase");
    expect(filtered.map((f) => f.ruleId)).toContain("ai-vocabulary");
  });

  it("analyzes roughly 100KB well under a second", () => {
    const paragraph = "The vibrant tapestry of results underscores its significance — experts believe "
      + "we must leverage robust, seamless, transformative synergy in order to unlock the full potential. ";
    const text = paragraph.repeat(Math.ceil(100_000 / paragraph.length));
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    const startedAt = performance.now();
    const findings = analyzeSlopProse(text);
    const elapsed = performance.now() - startedAt;
    expect(findings.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("renderAntiSlopPromptSection", () => {
  it("digests every rule id into one bounded section", () => {
    const section = renderAntiSlopPromptSection();
    expect(section).toContain("## Style contract");
    for (const ruleId of SLOP_RULE_IDS) expect(section).toContain(ruleId);
    expect(section.length).toBeLessThan(2_000);
  });

  it("drops disabled rule ids and whole groups", () => {
    const section = renderAntiSlopPromptSection(["chatbot-phrase", "em-dash-density"]);
    expect(section).not.toContain("chatbot-phrase");
    expect(section).not.toContain("canned assistant phrasing");
    expect(section).not.toContain("em-dash-density");
    expect(section).toContain("hedging-ratio");
  });

  it("renders nothing when every rule is disabled", () => {
    expect(renderAntiSlopPromptSection(SLOP_RULE_IDS)).toBe("");
  });
});

describe("analyzeSlopProse", () => {
  it("skips fenced code blocks", () => {
    const text = "Plain prose here.\n```js\n// I'd be happy to leverage this in code\nconst x = 1; // moreover\n```\nStill plain.";
    expect(analyzeSlopProse(text)).toEqual([]);
  });

  it("maps prose offsets after a fence back into the original text", () => {
    const text = "Before.\n```\ncode();\n```\nGreat question! Done.";
    const findings = analyzeSlopProse(text);
    const hit = findings.find((f: SlopFinding) => f.ruleId === "chatbot-phrase");
    expect(hit).toBeDefined();
    expect(text.slice(hit!.start, hit!.end).toLowerCase()).toBe("great question");
  });

  it("treats an unclosed fence as running to the end", () => {
    expect(analyzeSlopProse("Fine so far.\n```\nGreat question! moreover")).toEqual([]);
  });

  it("matches analyzeSlop when there are no fences", () => {
    const text = "Experts believe this is fine.";
    expect(analyzeSlopProse(text)).toEqual(analyzeSlop(text));
  });
});
