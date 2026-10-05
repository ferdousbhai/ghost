/** Titles extracted from first owner messages, shaped like the owner's real ones. */
import { describe, expect, it } from "vitest";
import { derivedTitle, logState, type LogEntry } from "../src/conversation-log.js";

describe("derivedTitle", () => {
  it.each([
    ["can you recommend a good grocery store on the way home from here", "Recommend a good grocery store"],
    ["hey what is the latest on tsla", "What is the latest on tsla"],
    ["let's try setting up whatsapp", "Try setting up whatsapp"],
    ['Create a doc called "Tool Approval Test Feb 26" with some placeholder content', "Tool Approval Test Feb 26"],
    ["Weekly delegation check. Run `bun scripts/handoff-report.ts`.", "Weekly delegation check"],
    ["[Attachment: profile_picture.jpg]\nwhat do you see", "What do you see"],
    ["Find the latest Grok 4.5 release notes online and summarize them", "Find the latest Grok 4.5 release notes"],
  ])("%s", (text, title) => {
    expect(derivedTitle(text)).toBe(title);
  });

  it("gives nothing for a bare greeting", () => {
    expect(derivedTitle("hey")).toBeNull();
    expect(derivedTitle("Hello!")).toBeNull();
  });
});

describe("logState title", () => {
  const at = "2026-10-05T00:00:00.000Z";
  const opened: LogEntry[] = [{ type: "user", at, text: "can you find cafes near the station" }];

  it("derives one until the owner names the conversation, and again once they clear it", () => {
    expect(logState(opened).title).toBe("Find cafes near the station");
    expect(logState([...opened, { type: "title", at, title: "Coffee" }]).title).toBe("Coffee");
    expect(logState([...opened, { type: "title", at, title: "Coffee" }, { type: "title", at, title: null }]).title)
      .toBe("Find cafes near the station");
  });

  it("ignores messages the owner did not type", () => {
    expect(logState([{ type: "user", at, text: "Scheduled check now", origin: "follow_up" }]).title).toBeNull();
  });
});
