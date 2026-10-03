import { describe, expect, it } from "vitest";
import { renderOwnerContextPolicy } from "../src/prompt-policy.js";

describe("owner context policy", () => {
  it("names the owner's documents directory and keeps skill paths out of the policy", () => {
    const policy = renderOwnerContextPolicy("/home/owner/Documents");
    expect(policy).toContain('"/home/owner/Documents"');
    expect(policy).toContain("shared by every ghost on this machine");
    expect(policy).not.toContain("SKILL.md");
    expect(policy).not.toContain(".agents/skills");
  });
});
