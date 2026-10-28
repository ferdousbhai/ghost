import { describe, expect, it } from "vitest";
import { isHelpTopic } from "../src/help-topics.js";
import { renderOwnerContextPolicy } from "../src/prompt-policy.js";

describe("owner context policy", () => {
  it("names the owner's documents directory and keeps skill paths out of the policy", () => {
    const policy = renderOwnerContextPolicy("/home/owner/Documents");
    expect(policy).toContain('"/home/owner/Documents"');
    expect(policy).toContain("shared by every ghost on this machine");
    expect(policy).not.toContain("SKILL.md");
    expect(policy).not.toContain(".agents/skills");
  });

  it("names Recall's search only when it is installed", () => {
    expect(renderOwnerContextPolicy("/home/owner/Documents")).not.toContain("recall");
    const policy = renderOwnerContextPolicy("/home/owner/Documents", true);
    expect(policy).toContain('`recall search "<meaning>"`');
    expect(policy).toContain("`--code`");
  });

  it("points at a lookup recipe `ghost help` prints", () => {
    const pointer = /`ghost help (\w+)`/u.exec(renderOwnerContextPolicy("/home/owner/Documents"))?.[1];
    expect(pointer).toBe("memory");
    expect(isHelpTopic(pointer ?? "")).toBe(true);
  });
});
