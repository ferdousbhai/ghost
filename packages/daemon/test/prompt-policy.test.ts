import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP_TOPICS, isHelpTopic } from "../src/help-topics.js";
import { renderGhostPolicy, renderOwnerContextPolicy } from "../src/prompt-policy.js";

const SKILL = readFileSync(new URL("../../../skills/ghost/SKILL.md", import.meta.url), "utf8");

describe("owner context policy", () => {
  it("names the owner's documents directory and keeps skill paths out of the policy", () => {
    const policy = renderOwnerContextPolicy("/home/owner/Documents");
    expect(policy).toContain('"/home/owner/Documents"');
    expect(policy).toContain("shared by every ghost on this machine");
    expect(policy).not.toContain("SKILL.md");
    expect(policy).not.toContain(".agents/skills");
  });
});

describe("the Ghost section", () => {
  it("keeps asking the owner in the prompt and sends the rest of the CLI to the ghost skill", () => {
    const policy = renderGhostPolicy();
    expect(policy).toContain("`ghost ask");
    expect(policy).toContain("then end your turn");
    expect(policy).toContain("Load the `ghost` skill");
    expect(policy).not.toContain("ghost help");
  });

  it("warns, only when it is near, that the Tailscale key will cut the peers off", () => {
    expect(renderGhostPolicy("2027-04-11")).toContain("Tailscale key expires 2027-04-11");
    expect(renderGhostPolicy()).not.toContain("expires");
  });
});

describe("the ghost skill", () => {
  it("lists every help topic, and every topic it names is one `ghost help` prints", () => {
    const named = [...SKILL.matchAll(/`ghost help (\w+)`/gu)].map((match) => match[1] as string);
    expect(named.filter((topic) => !isHelpTopic(topic))).toEqual([]);
    expect(HELP_TOPICS.filter((topic) => !named.includes(topic))).toEqual([]);
  });
});
