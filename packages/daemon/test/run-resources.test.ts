import { describe, expect, it } from "vitest";
import { handoffContext, logState, transcriptPage, latestRunResources, type LogEntry } from "../src/conversation-log.js";
import { codexSkillNames, resourceNames, resourceSummary, unreportedResources } from "../src/run-resources.js";

describe("run resources", () => {
  it("distinguishes unknown from none, bounds names, and rejects control characters", () => {
    expect(resourceNames(undefined)).toBeNull();
    expect(resourceNames([])).toEqual([]);
    expect(resourceNames(["mail", "mail"])).toEqual(["mail"]);
    for (const invalid of [[""], ["\nsecret"], ["a".repeat(257)], Array(257).fill("mail"), [{}]]) {
      expect(resourceNames(invalid)).toBeNull();
    }
    expect(resourceSummary("pi", unreportedResources())).toBe("");
    expect(resourceSummary("pi", { skills: [], extensions: [], mcpServers: [] })).toBe("");
    expect(resourceSummary("claude", { skills: [], extensions: ["review"], mcpServers: [] }))
      .toBe("claude · Run resources\nExtensions/plugins: review");
  });

  it("extracts only names in Codex's rendered catalog section", () => {
    expect(codexSkillNames("### Available skills\n- plugin:skill: Description. (file: r0/skill/SKILL.md)\n### Instructions\n- excluded: Other text\n"))
      .toEqual(["plugin:skill"]);
    expect(codexSkillNames("### Available skills\n")).toEqual([]);
    expect(codexSkillNames("<recommended_plugins>\n- Not installed\n</recommended_plugins>")).toBeNull();
    expect(codexSkillNames("### Available skills\nUnknown format")).toBeNull();
    expect(codexSkillNames("### Available skills\n- valid: Description. (file: r0/skill/SKILL.md)\n- malformed row\n")).toBeNull();
    expect(codexSkillNames(undefined)).toBeNull();
  });

  it("is display-only, not conversation activity or prompt context", () => {
    const entries: LogEntry[] = [
      { type: "user", at: "before", text: "hello" },
      { type: "resources", at: "after", run: "r1", harness: "pi", resources: unreportedResources(), summary: "inventory" },
    ];
    expect(logState(entries)).toMatchObject({ activeAt: "before", messageCount: 1 });
    expect(handoffContext(entries)).toBe("Owner: hello");
    expect(transcriptPage(entries).messages).toHaveLength(1);
    entries.push({ type: "resources", at: "later", run: "r2", harness: "codex", resources: { skills: ["mail"], extensions: null, mcpServers: [] }, summary: "old noisy summary" });
    expect(transcriptPage(entries).messages).toHaveLength(1);
  });
});

describe("latest run resource snapshot", () => {
  const time = (second: number) => `2026-10-13T12:00:${String(second).padStart(2, "0")}.000Z`;
  const reply = (second = 1, error?: string): Extract<LogEntry, { type: "assistant" }> => ({ type: "assistant", at: time(second), harness: "codex", content: [], ...(error ? { error } : {}) });
  const inventory = (skills: string[] | null, second = 0, current = false): Extract<LogEntry, { type: "resources" }> => ({ type: "resources", at: time(second), run: "r", harness: "codex",
    resources: { skills, extensions: null, mcpServers: null }, summary: "old summary",
    ...(current ? { supplied: { instructions: [], mcpServers: [] } } : {}) });

  it("reads legacy pre-reply records without exposing them as messages", () => {
    const entries = [inventory(["mail"]), reply()];
    expect(latestRunResources(entries)?.resources.skills).toEqual(["mail"]);
    expect(transcriptPage(entries).messages.map(message => message.role)).toEqual(["assistant"]);
    expect(latestRunResources([inventory(["mail"]), { ...reply(), harness: "pi" }])).toBeNull();
  });

  it("reads intermediate post-reply records using their run-start timestamp", () => {
    expect(latestRunResources([reply(), inventory(["mail"])])?.resources.skills).toEqual(["mail"]);
  });

  it("does not attribute a failed legacy handoff to the preceding successful reply", () => {
    const entries: LogEntry[] = [inventory(["good"]), reply(), inventory(["failed"], 2),
      { type: "handoff", at: time(3), harness: "codex", text: "", error: "failed handoff" }];
    expect(latestRunResources(entries)?.resources.skills).toEqual(["good"]);
    expect(latestRunResources([inventory(["first"]), reply(), inventory(["second"], 2), reply(3)])?.resources.skills).toEqual(["second"]);
  });

  it.each([time(1), "invalid"])("omits ambiguous adjacent legacy timestamps: %s", at => {
    const ambiguous = { ...inventory(["ambiguous"]), at };
    const entries = [inventory(["trusted"]), reply(), ambiguous];
    expect(latestRunResources(entries)?.resources.skills).toEqual(["trusted"]);
    expect(latestRunResources([...entries, reply(3, "failed")])?.resources.skills).toEqual(["trusted"]);
    expect(latestRunResources([...entries, reply(3)])).toBeNull();
  });

  it("clears stale evidence on success, but retains dated evidence after failure", () => {
    const entries = [reply(), inventory(["mail"], 1, true)];
    expect(latestRunResources([...entries, reply(2, "not signed in")])?.resources.skills).toEqual(["mail"]);
    expect(latestRunResources([...entries, reply(2), inventory(null, 2, true)])?.resources.skills).toBeNull();
    expect(latestRunResources([...entries, reply(2)])).toBeNull();
    expect(latestRunResources([inventory(["future"], 4), reply(3)])).toBeNull();
  });
});
