import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reconstructAdvisorTurnDelta,
} from "../src/advisor-transcript.js";
import type { GhostSessionStopEvent } from "../src/hooks.js";
import { tempDir, useCleanups } from "./helpers/fixtures.js";

const cleanups = useCleanups();

function stopEvent(
  transcript: string,
  runtime: GhostSessionStopEvent["runtime"],
  overrides: Partial<GhostSessionStopEvent> = {},
): GhostSessionStopEvent {
  const message = { role: "assistant", content: [{ type: "text", text: "Fallback answer." }] };
  return {
    type: "session_stop",
    owner_prompt: "Fix it.",
    messages: [message],
    turn_id: 2,
    last_assistant_message: message,
    session_id: "session-1",
    transcript_path: transcript,
    stop_hook_active: false,
    signal: new AbortController().signal,
    ghost_name: "casper",
    ghost_home: join(transcript, ".."),
    cwd: join(transcript, ".."),
    runtime,
    conversation_id: "session-1",
    conversation_runtime: runtime,
    ...overrides,
  };
}

function writeJsonl(lines: readonly unknown[]): string {
  const temp = tempDir("ghost-advisor-transcript-");
  cleanups.push(temp.cleanup);
  const path = join(temp.path, "session.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

describe("advisor turn-delta reconstruction", () => {
  it("reconstructs the active Pi turn with reasoning, tool calls, and results", async () => {
    const path = writeJsonl([
      { type: "session", id: "session-1" },
      { type: "message", id: "a", parentId: null, message: { role: "user", content: "Old turn." } },
      { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "Old answer." }] } },
      { type: "message", id: "c", parentId: "b", message: { role: "user", content: "Fix it." } },
      { type: "message", id: "d", parentId: "c", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Need inspect." },
        { type: "toolCall", name: "bash", arguments: { command: "test -f result" } },
      ] } },
      { type: "message", id: "e", parentId: "d", message: { role: "toolResult", content: [
        { type: "text", text: "token=super-secret-value" },
      ] } },
      { type: "message", id: "f", parentId: "e", message: { role: "assistant", content: [
        { type: "text", text: "Fixed and tested." },
      ] } },
    ]);
    const result = await reconstructAdvisorTurnDelta(stopEvent(path, "pi"));
    expect(result.source).toBe("transcript");
    expect(result.text).toContain("Need inspect.");
    expect(result.text).toContain("test -f result");
    expect(result.text).toContain("Fixed and tested.");
    expect(result.text).not.toContain("Old answer.");
    expect(result.text).not.toContain("super-secret-value");
    expect(result.text).toContain("[REDACTED_SECRET]");
    expect(result.commands).toEqual(["test -f result"]);
    expect(result.paths).toEqual([]);
  });

  it("reconstructs the active Claude SDK parentUuid chain", async () => {
    const path = writeJsonl([
      { type: "user", uuid: "a", parentUuid: null, message: { role: "user", content: "Old turn." } },
      { type: "assistant", uuid: "b", parentUuid: "a", message: { role: "assistant", content: [{ type: "text", text: "Old answer." }] } },
      { type: "user", uuid: "c", parentUuid: "b", message: { role: "user", content: "Fix it." } },
      { type: "assistant", uuid: "d", parentUuid: "c", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Check behavior." },
        { type: "tool_use", name: "Read", input: { file_path: "source.ts" } },
      ] } },
      { type: "user", uuid: "e", parentUuid: "d", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "source text" },
      ] } },
      { type: "assistant", uuid: "f", parentUuid: "e", message: { role: "assistant", content: [
        { type: "text", text: "Fixed." },
      ] } },
    ]);
    const result = await reconstructAdvisorTurnDelta(stopEvent(path, "claude-code"));
    expect(result.source).toBe("transcript");
    expect(result.text).toContain("Check behavior.");
    expect(result.text).toContain("file_path");
    expect(result.text).toContain("source text");
    expect(result.text).not.toContain("Old answer.");
    expect(result.commands).toEqual([]);
    expect(result.paths).toEqual(["source.ts"]);
  });

  it("falls back to final assistant text when any JSONL line is malformed", async () => {
    const temp = tempDir("ghost-advisor-transcript-");
    cleanups.push(temp.cleanup);
    const path = join(temp.path, "broken.jsonl");
    writeFileSync(path, '{"type":"session"}\nnot-json\n', "utf8");
    const result = await reconstructAdvisorTurnDelta(stopEvent(path, "pi"));
    expect(result).toMatchObject({ source: "assistant-fallback", fallbackReason: "parse" });
    expect(result.commands).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.text).toContain("Fallback answer.");
    expect(result.text).not.toContain("not-json");
  });

  it("uses only complete lines from a bounded tail", async () => {
    const path = writeJsonl([
      { type: "session", id: "session-1", padding: "x".repeat(400) },
      { type: "message", id: "c", parentId: null, message: { role: "user", content: "Fix it." } },
      { type: "message", id: "d", parentId: "c", message: { role: "assistant", content: [{ type: "text", text: "Tail answer." }] } },
    ]);
    const result = await reconstructAdvisorTurnDelta(stopEvent(path, "pi"), { maxBytes: 300 });
    expect(result).toMatchObject({ source: "transcript" });
    expect(result.text).toContain("Tail answer.");
  });
});
