import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileLintRules,
  loadLintRules,
  MAX_LINT_EXCERPT_CODE_POINTS,
  MAX_LINT_FINDINGS,
  MAX_LINT_FINDINGS_PER_RULE,
  MAX_LINT_INPUT_BYTES,
  runLint,
  withoutLintRules,
  type LintRule,
} from "../src/lint.js";
import { BUILTIN_LINT_RULE_IDS, BUILTIN_LINT_RULES } from "../src/lint-rules.js";
import { tempDir, useCleanups } from "./helpers/fixtures.js";

const cleanups = useCleanups();
const builtins = compileLintRules(BUILTIN_LINT_RULES);

function fixture(): { ghostHome: string; project: string; cwd: string } {
  const temp = tempDir("ghost-lint-");
  cleanups.push(temp.cleanup);
  const ghostHome = join(temp.path, "ghost");
  const project = join(temp.path, "project");
  const cwd = join(project, "src");
  mkdirSync(ghostHome, { recursive: true });
  mkdirSync(join(project, ".ghost"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { ghostHome, project, cwd };
}

function lintProse(prose: string) {
  return runLint([builtins], { prose });
}

describe("built-in lint rules", () => {
  const fixtures: ReadonlyArray<[ruleId: string, severity: "nit" | "concern", text: string]> = [
    ["ai-vocabulary", "nit", "We delve into the data."],
    ["binary-contrast", "concern", "It's not just a tool, but a platform."],
    ["chatbot-phrase", "concern", "I'd be happy to help with that."],
    ["colon-reveal", "concern", "The best part: it works."],
    ["dramatic-fragment", "concern", "That's it. That's the tweet."],
    ["em-dash-density", "nit", "One two three four five six seven eight nine ten eleven twelve thirteen fourteen — fifteen."],
    ["emoji-bullets", "concern", "✨ Fast startup\n🔥 Simple config"],
    ["essay-connective", "concern", "Moreover, the cache warms itself."],
    ["faux-insight", "concern", "Here's what nobody tells you about pricing."],
    ["filler-phrase", "nit", "In order to win, we must try."],
    ["hedging-ratio", "nit", "Perhaps the team will ship the new build tomorrow if the tests pass and the review lands on time early."],
    ["inflated-verb", "nit", "The tool serves as a bridge."],
    ["ing-explainer", "concern", "Sales rose, highlighting strong demand."],
    ["landscape-cliche", "concern", "We navigate the complex world of tech."],
    ["puffery", "concern", "This marks a pivotal moment for the team."],
    ["recap-ending", "concern", "In conclusion, we win."],
    ["rhetorical-setup", "concern", "What if I told you it scales?"],
    ["throat-clearing", "concern", "Here's the thing about pricing."],
    ["triad-adjectives", "nit", "The design is elegant, minimal, and useful."],
    ["uniform-sentences", "nit", "The team shipped the release on Monday before lunch. The users tested the build on Tuesday after breakfast. The board reviewed the numbers on Wednesday before dinner. The devs planned the sprint on Thursday after standup."],
    ["vague-attribution", "concern", "Experts believe this is fine."],
  ];

  it("reports nothing on plain prose", () => {
    expect(lintProse("The build passed on the second try. Ship it today.")).toEqual([]);
  });

  it.each(fixtures)("flags %s as %s", (ruleId, severity, text) => {
    const finding = lintProse(text).find((candidate) => candidate.ruleId === ruleId);
    expect(finding, `expected a ${ruleId} finding`).toBeDefined();
    expect(finding?.severity).toBe(severity);
    expect(finding?.fix).toBeTruthy();
  });

  it("covers all 21 inherited rule ids", () => {
    expect(fixtures.map(([id]) => id).toSorted()).toEqual(BUILTIN_LINT_RULE_IDS.toSorted());
  });

  it("never assigns blocker severity to built-in prose rules", () => {
    expect(BUILTIN_LINT_RULES.some((rule) => rule.severity === "blocker")).toBe(false);
  });

  it("preserves messages, fixes, and code-point-safe excerpts", () => {
    const [finding] = lintProse("I'd be happy to help.").filter((item) =>
      item.ruleId === "chatbot-phrase"
    );
    expect(finding?.message).toBe('"I\'d be happy to" — Assistant-speak.');
    expect(finding?.fix).toBe("Remove canned assistant phrasing.");
    const astral = runLint([compileLintRules([{
      id: "astral",
      target: "prose",
      kind: "pattern",
      pattern: "😀+",
      flags: "u",
      severity: "nit",
      message: "Long match.",
    }])], { prose: "😀".repeat(100) })[0];
    expect([...(astral?.excerpt ?? "")]).toHaveLength(MAX_LINT_EXCERPT_CODE_POINTS);
    expect(astral?.excerpt.endsWith("…")).toBe(true);
  });

  it("skips fenced prose and treats an unclosed fence as running to the end", () => {
    expect(lintProse("Plain.\n```js\nI'd be happy to leverage this\n```\nStill plain.")).toEqual([]);
    expect(lintProse("Plain.\n```\nGreat question! moreover")).toEqual([]);
  });

  it("runs all three named statistical checks", () => {
    const ids = lintProse(
      "Perhaps the team shipped the release — before lunch today. "
      + "Perhaps the users tested the build — after breakfast today. "
      + "Perhaps the board reviewed the numbers — before dinner today. "
      + "Perhaps the devs planned the sprint — after standup today.",
    ).map((finding) => finding.ruleId);
    expect(ids).toContain("em-dash-density");
    expect(ids).toContain("hedging-ratio");
    expect(ids).toContain("uniform-sentences");
  });

  it("analyzes roughly 100KB within the bounded stop-hook budget", () => {
    const paragraph = "The vibrant tapestry of results underscores its significance — experts believe "
      + "we must leverage robust, seamless, transformative synergy in order to unlock the full potential. ";
    const prose = paragraph.repeat(Math.ceil(100_000 / paragraph.length));
    const started = performance.now();
    expect(lintProse(prose).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("lint engine bounds", () => {
  it("caps findings per rule and overall", () => {
    const repeated = compileLintRules([{
      id: "repeat",
      target: "prose",
      kind: "pattern",
      pattern: "x",
      severity: "nit",
      message: "x",
    }]);
    expect(runLint([repeated], { prose: "x".repeat(1_000) })).toHaveLength(MAX_LINT_FINDINGS_PER_RULE);

    const many: LintRule[] = Array.from({ length: MAX_LINT_FINDINGS + 20 }, (_, index) => ({
      id: `rule-${index}`,
      target: "prose",
      kind: "pattern",
      pattern: "x",
      severity: "nit",
      message: `finding ${index}`,
    }));
    expect(runLint([compileLintRules(many)], { prose: "x" })).toHaveLength(MAX_LINT_FINDINGS);
  });

  it("caps the combined prose, command, and path input bytes", () => {
    const rules = compileLintRules([{
      id: "late",
      target: "command",
      kind: "pattern",
      pattern: "unsafe",
      severity: "blocker",
      message: "unsafe command",
    }]);
    expect(runLint([rules], {
      prose: "x".repeat(MAX_LINT_INPUT_BYTES),
      commands: ["unsafe"],
    })).toEqual([]);
  });

  it("rejects a pathological regex once instead of executing it", () => {
    const warnings: string[] = [];
    const rule: LintRule = {
      id: "pathological",
      target: "prose",
      kind: "pattern",
      pattern: "(a+)+$",
      severity: "blocker",
      message: "bad",
    };
    const first = compileLintRules([rule], { source: "test-pack", warn: (message) => warnings.push(message) });
    const second = compileLintRules([rule], { source: "test-pack", warn: (message) => warnings.push(message) });
    expect(first.rules).toEqual([]);
    expect(second.rules).toEqual([]);
    expect(warnings).toHaveLength(1);
    const started = performance.now();
    expect(runLint([first], { prose: `${"a".repeat(100_000)}!` })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("LINT.yml loading", () => {
  it("skips a malformed file with one warning", async () => {
    const { ghostHome, cwd } = fixture();
    writeFileSync(join(ghostHome, "LINT.yml"), "rules: [not: valid", "utf8");
    const warnings: string[] = [];
    await expect(loadLintRules(cwd, ghostHome, { warn: (path) => warnings.push(path) }))
      .resolves.toMatchObject({ rules: [] });
    await loadLintRules(cwd, ghostHome, { warn: (path) => warnings.push(path) });
    expect(warnings).toEqual([join(ghostHome, "LINT.yml")]);
  });

  it("loads command and path rules from the owner file", async () => {
    const { ghostHome, cwd } = fixture();
    writeFileSync(join(ghostHome, "LINT.yml"), [
      "rules:",
      "  - id: unsafe-command",
      "    target: command",
      "    kind: pattern",
      "    pattern: 'rm\\s+-rf'",
      "    severity: blocker",
      "    message: Destructive command.",
      "  - id: secret-path",
      "    target: path",
      "    kind: pattern",
      "    pattern: '^/etc/'",
      "    severity: concern",
      "    message: System path.",
    ].join("\n"), "utf8");
    const loaded = await loadLintRules(cwd, ghostHome);
    const findings = runLint([builtins, loaded], {
      prose: "Plain.",
      commands: ["rm -rf build"],
      paths: ["/etc/passwd"],
    });
    expect(findings.map(({ ruleId, severity }) => [ruleId, severity])).toEqual([
      ["unsafe-command", "blocker"],
      ["secret-path", "concern"],
    ]);
  });

  it("honors disable lists only for built-ins", async () => {
    const { ghostHome, cwd } = fixture();
    writeFileSync(join(ghostHome, "LINT.yml"), [
      "disable: [chatbot-phrase]",
      "rules:",
      "  - id: chatbot-phrase",
      "    target: prose",
      "    kind: pattern",
      "    pattern: 'ship it'",
      "    flags: i",
      "    severity: concern",
      "    message: Owner rule still active.",
    ].join("\n"), "utf8");
    const loaded = await loadLintRules(cwd, ghostHome);
    const findings = runLint([withoutLintRules(builtins, loaded.disabledBuiltinRuleIds), loaded], {
      prose: "Great question. Ship it.",
    });
    expect(findings).toEqual([expect.objectContaining({
      ruleId: "chatbot-phrase",
      message: "Owner rule still active.",
    })]);
  });

  it("orders owner and trusted project files like WATCHDOG.md", async () => {
    const { ghostHome, project, cwd } = fixture();
    const ruleFile = (id: string) => [
      "rules:",
      `  - id: ${id}`,
      "    target: path",
      "    kind: pattern",
      `    pattern: '${id}'`,
      "    severity: nit",
      `    message: ${id}`,
    ].join("\n");
    mkdirSync(join(cwd, ".ghost"), { recursive: true });
    writeFileSync(join(ghostHome, "LINT.yml"), ruleFile("owner"), "utf8");
    writeFileSync(join(project, ".ghost", "LINT.yml"), ruleFile("root-dot"), "utf8");
    writeFileSync(join(project, "LINT.yml"), ruleFile("root"), "utf8");
    writeFileSync(join(cwd, ".ghost", "LINT.yml"), ruleFile("leaf-dot"), "utf8");
    writeFileSync(join(cwd, "LINT.yml"), ruleFile("leaf"), "utf8");

    const loaded = await loadLintRules(cwd, ghostHome, { trustedProjectRoot: project });
    expect(loaded.rules.map((rule) => rule.id)).toEqual([
      "owner",
      "root-dot",
      "root",
      "leaf-dot",
      "leaf",
    ]);
  });

  it("ignores project files without a trusted project root", async () => {
    const { ghostHome, project, cwd } = fixture();
    writeFileSync(join(project, ".ghost", "LINT.yml"), [
      "rules:",
      "  - id: project-only",
      "    target: path",
      "    kind: pattern",
      "    pattern: 'generated'",
      "    severity: nit",
      "    message: Generated path.",
    ].join("\n"), "utf8");
    expect((await loadLintRules(cwd, ghostHome)).rules).toEqual([]);
  });
});
