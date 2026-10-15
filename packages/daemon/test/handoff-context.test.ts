import { describe, expect, it } from "vitest";
import { HANDOFF_CONTEXT_CHARS, handoffContext, type LogEntry } from "../src/conversation-log.js";

const user = (text: string): LogEntry => ({ type: "user", at: "now", text });

describe("handoff context", () => {
  it("preserves chronological labels and skips display-only and excluded entries", () => {
    expect(handoffContext([
      user("hello"),
      { type: "user", at: "now", text: "continue", origin: "hook" },
      { type: "user", at: "now", text: "old auto turn", origin: "auto" },
      { type: "assistant", at: "now", harness: "pi", content: [{ type: "text", text: " answer " }, { type: "toolCall", id: "1", name: "read", arguments: {} }] },
      { type: "title", at: "now", title: "ignored" },
      { type: "command", at: "now", command: "pwd", output: "/tmp", exitCode: 0, excluded: false },
      { type: "command", at: "now", command: "secret", output: "ignored", exitCode: 0, excluded: true },
    ])).toBe("Owner: hello\n\nHook: continue\n\nGhost: old auto turn\n\nYou: answer \n[ran read]\n\nOwner ran `pwd`:\n/tmp");
    expect(handoffContext([])).toBeNull();
  });

  it("matches the exact suffix across the context boundary", () => {
    for (const length of [HANDOFF_CONTEXT_CHARS - 7, HANDOFF_CONTEXT_CHARS - 6, HANDOFF_CONTEXT_CHARS, HANDOFF_CONTEXT_CHARS + 1]) {
      const text = "x".repeat(length);
      const full = `Owner: first\n\nOwner: ${text}`;
      expect(handoffContext([user("first"), user(text)])).toBe(`…${full.slice(-HANDOFF_CONTEXT_CHARS)}`);
      const single = `Owner: ${text}`;
      expect(handoffContext([user(text)])).toBe(single.length > HANDOFF_CONTEXT_CHARS ? `…${single.slice(-HANDOFF_CONTEXT_CHARS)}` : single);
    }
  });

  it("does not format old messages once the newest context is full", () => {
    const old = user("old");
    Object.defineProperty(old, "text", { get: () => { throw new Error("old history formatted"); } });
    expect(handoffContext([old, user("x".repeat(HANDOFF_CONTEXT_CHARS))])).toBe(`…${"x".repeat(HANDOFF_CONTEXT_CHARS)}`);
  });
});
