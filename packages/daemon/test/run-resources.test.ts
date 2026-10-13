import { describe, expect, it } from "vitest";
import { handoffContext, logState, transcriptMessages, type LogEntry } from "../src/conversation-log.js";
import { codexSkillNames, resourceNames, resourceSummary, unreportedResources } from "../src/run-resources.js";

describe("run resources", () => {
  it("distinguishes unknown from none, bounds names, and rejects control characters", () => {
    expect(resourceNames(undefined)).toBeNull();
    expect(resourceNames([])).toEqual([]);
    expect(resourceNames(["mail", "mail"])).toEqual(["mail"]);
    for (const invalid of [[""], ["\nsecret"], ["a".repeat(257)], Array(257).fill("mail"), [{}]]) {
      expect(resourceNames(invalid)).toBeNull();
    }
    expect(resourceSummary("pi", unreportedResources())).toContain("Skills: not reported");
    expect(resourceSummary("claude", { skills: [], extensions: ["review"], mcpServers: [] }))
      .toContain("Skills: none\nExtensions/plugins: review\nConnected MCP servers: none");
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
    expect(transcriptMessages(entries)[1]).toMatchObject({ role: "resources", content: [{ type: "text", text: "inventory" }] });
  });
});
