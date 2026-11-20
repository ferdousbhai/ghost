import { describe, expect, it } from "vitest";
import { HELP_TOPICS } from "../src/help-topics.js";
import { GHOST_POLICY, renderOwnerContextPolicy } from "../src/prompt-policy.js";

describe("owner context policy", () => {
  it("names the owner's documents directory and keeps skill paths out of the policy", () => {
    const policy = renderOwnerContextPolicy("/home/owner/Documents");
    expect(policy).toContain('"/home/owner/Documents"');
    expect(policy).not.toContain("SKILL.md");
    expect(policy).not.toContain(".agents/skills");
  });
});

describe("the Ghost section", () => {
  it("keeps asking the owner in the prompt", () => {
    const policy = GHOST_POLICY;
    expect(policy).toContain("`ghost ask");
    expect(policy).toContain("then end your turn");
  });

  it("indexes every `ghost help` topic by name, so the CLI is the documentation", () => {
    const policy = GHOST_POLICY;
    expect(policy).toContain("`ghost help <topic>`");
    expect(HELP_TOPICS.filter((topic) => !new RegExp(`\\b${topic}\\b`, "u").test(policy))).toEqual([]);
  });
});
