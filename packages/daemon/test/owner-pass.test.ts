import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ASK_REANSWER_OWNER_MESSAGE_TYPE, persistedOwnerPassBoundary, type PendingOwnerPass } from "@ghost/runtime/owner-pass";

const entry = (value: Record<string, unknown>) => value as unknown as SessionEntry;
const user = (id: string, text: string, attribution?: string) => entry({ id, type: "message", message: { role: "user", content: text, ...(attribution ? { attribution } : {}) } });
const assistant = (id: string, stopReason: string) => entry({ id, type: "message", message: { role: "assistant", content: [], stopReason } });
const custom = (id: string, customType: string, text: string, attribution?: string) => entry({ id, type: "custom_message", customType, content: text, details: attribution ? { attribution } : undefined });
const pass = (kind: PendingOwnerPass["kind"], ownerPrompt: string, priorEntryIds: string[] = []): PendingOwnerPass => ({ kind, ownerPrompt, priorEntryIds: new Set(priorEntryIds) });

describe("persisted Pi owner-pass boundary", () => {
  it("matches an owner-attributed skill custom entry to a direct pass without comparing the expanded prompt", () => {
    const branch = [
      user("agent", "agent text", "agent"),
      custom("skill", "skill-prompt", "<skill>expanded content</skill>", "user"),
      assistant("answer", "stop"),
    ];
    const pending = pass("direct", "/skill:review short");
    expect(persistedOwnerPassBoundary(branch, pending, new Set())).toMatchObject({ assistantEntry: { id: "answer" } });
    expect(pending.ownerEntryId).toBe("skill");
  });

  it("excludes the prior branch and claims equal-text steering and follow-ups once each", () => {
    const branch = [user("old", "same"), assistant("old-answer", "stop"), user("first", "same"), assistant("first-answer", "stop"), user("second", "same"), assistant("second-answer", "stop")];
    const claimed = new Set<string>();
    const first = pass("steer", "same", ["old", "old-answer"]);
    const second = pass("followUp", "same", ["old", "old-answer"]);
    expect(persistedOwnerPassBoundary(branch, first, claimed)).toMatchObject({ assistantEntry: { id: "first-answer" } });
    expect(persistedOwnerPassBoundary(branch, second, claimed)).toMatchObject({ assistantEntry: { id: "second-answer" } });
    expect([first.ownerEntryId, second.ownerEntryId]).toEqual(["first", "second"]);
    expect([...claimed]).toEqual(["first", "second"]);
  });

  it("ignores tool-use assistants until a terminal assistant and identifies supersession", () => {
    const pending = pass("direct", "owner");
    const branch = [user("owner", "owner"), assistant("tools", "toolUse")];
    expect(persistedOwnerPassBoundary(branch, pending, new Set())).toBeNull();
    expect(persistedOwnerPassBoundary([...branch, assistant("done", "stop")], pending, new Set())).toMatchObject({ assistantEntry: { id: "done" } });
    expect(persistedOwnerPassBoundary([...branch, user("next", "later")], pending, new Set())).toBe("superseded");
    expect(persistedOwnerPassBoundary([user("owner", "owner"), assistant("done", "stop"), user("next", "later")], pending, new Set())).toMatchObject({ assistantEntry: { id: "done" } });
  });

  it("distinguishes owner re-answer entries from agent-attributed custom messages", () => {
    const branch = [custom("agent", "internal", "same", "agent"), custom("answer", ASK_REANSWER_OWNER_MESSAGE_TYPE, "same", "user"), assistant("done", "stop")];
    const pending = pass("reanswer", "same");
    expect(persistedOwnerPassBoundary(branch, pending, new Set())).toMatchObject({ assistantEntry: { id: "done" } });
    expect(pending.ownerEntryId).toBe("answer");
  });
});
