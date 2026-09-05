import { describe, expect, it } from "vitest";
import {
  buildAutoHandoff,
  CONTEXT_WINDOW_POLICY,
  currentWindowId,
  MAX_HANDOFF_CHARS,
  REMINDER_TYPE,
  windowEntries,
  type EntryLike,
} from "../src/context-windows.js";

let sequence = 0;
function entry(overrides: Partial<EntryLike> & { type: string }): EntryLike {
  sequence += 1;
  return {
    id: `e${sequence}`,
    parentId: sequence > 1 ? `e${sequence - 1}` : null,
    timestamp: `2026-09-05T10:00:${String(sequence).padStart(2, "0")}Z`,
    ...overrides,
  };
}
const user = (text: string) => entry({ type: "message", message: { role: "user", content: text } });
const assistant = (content: unknown, stopReason = "toolUse") =>
  entry({ type: "message", message: { role: "assistant", content, stopReason } });
const toolResult = (toolName: string, toolCallId: string, text: string) =>
  entry({ type: "message", message: { role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }] } });
const compaction = (summary: string) => entry({ type: "compaction", summary });

describe("buildAutoHandoff", () => {
  it("keeps the first and latest owner inputs and says what it preserves", () => {
    const entries = [user("Build the report"), assistant("working", "stop"), user("Use metric units")];
    const handoff = buildAutoHandoff(entries, MAX_HANDOFF_CHARS);
    expect(handoff.startsWith("Automatic context rollover recovery record.")).toBe(true);
    expect(handoff).toContain("This record preserves inputs, not current progress.");
    expect(handoff).toContain("[owner input | ");
    expect(handoff).toContain("Build the report");
    expect(handoff).toContain("Use metric units");
    expect(handoff).not.toContain("working");
  });

  it("carries the tool batch no model has consumed, with its call arguments", () => {
    const call = assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }]);
    const entries = [user("List the files"), call, toolResult("bash", "call-1", "a.txt\nb.txt")];
    const handoff = buildAutoHandoff(entries, MAX_HANDOFF_CHARS);
    expect(handoff).toContain(`Tool-call entry ${call.id}`);
    expect(handoff).toContain("a.txt\nb.txt");
    expect(handoff).toContain('Call arguments: {"command":"ls"}');
  });

  it("starts at the last window boundary and names the prior checkpoint", () => {
    const entries = [
      user("Old request"),
      compaction("Owner wants the report in metric units; drafts live in ~/Documents/report."),
      user("Now add the appendix"),
    ];
    const handoff = buildAutoHandoff(entries, MAX_HANDOFF_CHARS);
    expect(handoff).not.toContain("Old request");
    expect(handoff).toContain("Now add the appendix");
    expect(handoff).toContain("[older checkpoint; possibly stale");
    expect(handoff).toContain("drafts live in ~/Documents/report");
  });

  it("does not nest an earlier automatic record and points at history instead", () => {
    const prior = compaction("Automatic context rollover recovery record.\nlots of inputs");
    const handoff = buildAutoHandoff([prior, user("continue")], MAX_HANDOFF_CHARS);
    expect(handoff).not.toContain("lots of inputs");
    expect(handoff).toContain(`Use history read with entry ${prior.id}`);
  });

  it("stays within the limit and reports what it omitted", () => {
    const entries = Array.from({ length: 40 }, (_, i) => user(`request ${i} ${"x".repeat(600)}`));
    const handoff = buildAutoHandoff(entries, 6_000);
    expect(handoff.length).toBeLessThanOrEqual(6_000);
    expect(handoff).toMatch(/Omitted \d+ current-window input\(s\)/u);
    expect(handoff).toContain("request 0 ");
    expect(handoff).toContain("request 39 ");
  });

  it("treats a visible coordination message as input but not as owner intent", () => {
    const entries = [
      user("Owner said this"),
      entry({ type: "custom_message", customType: "ask-result", display: true, content: "a hook said this" }),
      entry({ type: "custom_message", customType: REMINDER_TYPE, display: true, content: "checkpoint now" }),
    ];
    const handoff = buildAutoHandoff(entries, MAX_HANDOFF_CHARS);
    expect(handoff).toContain("coordination input (not direct owner input)");
    expect(handoff).toContain("a hook said this");
    expect(handoff).not.toContain("checkpoint now");
  });
});

describe("windows", () => {
  it("names the window by the latest compaction entry", () => {
    const first = user("a");
    const boundary = compaction("handoff");
    const entries = [first, boundary, user("b")];
    expect(currentWindowId([user("only")])).toBe("initial");
    expect(currentWindowId(entries)).toBe(boundary.id);
    const items = [...windowEntries(entries)];
    expect(items.map((item) => item.windowId)).toEqual(["initial", boundary.id, boundary.id]);
    expect(items[1]?.text).toContain("[context window] Handoff: handoff");
  });

  it("keeps the prompt section short and names both tools", () => {
    expect(CONTEXT_WINDOW_POLICY.startsWith("## Context windows")).toBe(true);
    expect(CONTEXT_WINDOW_POLICY).toContain("`history`");
    expect(CONTEXT_WINDOW_POLICY).toContain("`new_context`");
  });
});
