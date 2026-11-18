import { describe, expect, it } from "vitest";
import {
  ghostSessionStopContinuation, parseCommandResult, parseHooksDocument,
  runSessionStopHooks,
  type CommandResult, type GhostSessionStopEvent,
} from "../src/hook-policy.js";

const path = "/owner/hooks.json";
const config = {
  hooks: {
    turn_end: [{ hooks: [
      { type: "command", command: "first" },
      { type: "command", command: "second", name: "Named notice", timeout: 0.5 },
    ] }],
    session_stop: [{ hooks: [
      { type: "command", command: "accept" },
      { type: "command", command: "continue" },
      { type: "command", command: "unreached" },
    ] }],
  },
};
const result = (fields: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false, overflowed: false, executionFailed: false, ...fields,
});
const base = {
  session_id: "session-1", session_file: "/owner/casper/sessions/conversation-1/.conversation.jsonl",
  ghost_name: "casper", ghost_home: "/owner/casper", cwd: "/owner", conversation_id: "conversation-1",
  signal: new AbortController().signal,
};

describe("shared hook policy", () => {
  it("keeps local admission, defaults, source order and public status", () => {
    const commands = parseHooksDocument(config, path);
    expect(commands.map((hook) => [hook.eventName, hook.command, hook.timeoutMs])).toEqual([
      ["session_stop", "accept", 30000], ["session_stop", "continue", 30000],
      ["session_stop", "unreached", 30000],
      ["turn_end", "first", 30000], ["turn_end", "second", 500],
    ]);
    expect(commands[4]?.name).toBe("Named notice");
    for (const invalid of [
      { hooks: { other: [] } },
      { hooks: { before_prompt: [] } },
      { hooks: { session_stop: [{ hooks: [{ type: "command", command: "a\0b" }] }] } },
    ]) expect(() => parseHooksDocument(invalid, path)).toThrow();
  });

  it("stops at the first real continuation", async () => {
    const commands = parseHooksDocument(config, path);
    const called: string[] = [];
    const stop: GhostSessionStopEvent = { ...base, type: "session_stop", owner_prompt: "Continue", messages: [], last_assistant_message: null, transcript_path: base.session_file, turn_id: "turn-1", stop_hook_active: false };
    expect(await runSessionStopHooks(commands, stop, async (hook) => {
      called.push(hook.command);
      return hook.command === "continue" ? { decision: "block", reason: "Revise" } : { continue: true };
    })).toEqual({ decision: "block", reason: "Revise" });
    expect(called).toEqual(["accept", "continue"]);
  });

  it("preserves exit-code, invalid-output and fail-open interpretation", () => {
    const commands = parseHooksDocument(config, path);
    const stop = commands[0], notice = commands[3];
    if (!notice || !stop) throw new Error("fixture hooks missing");
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(parseCommandResult(notice, result({ exitCode: 2, stderr: "Blocked" }), warn)).toBeUndefined();
    expect(parseCommandResult(stop, result({ exitCode: 2, stderr: "Blocked" }), warn)).toEqual({ decision: "block", reason: "Blocked" });
    expect(parseCommandResult(stop, result({ stdout: "{bad" }), warn)).toBeUndefined();
    expect(parseCommandResult(stop, result({ timedOut: true }), warn)).toBeUndefined();
    expect(parseCommandResult(stop, result({ overflowed: true, exitCode: 2, stderr: "partial" }), warn)).toBeUndefined();
    expect(parseCommandResult(stop, result({ executionFailed: true }), warn)).toBeUndefined();
    expect(warnings).toHaveLength(5);
    expect(warnings).toContain("session_stop hook wrote more than 1 MB");
    expect(ghostSessionStopContinuation({ continue: true })).toBeUndefined();
    expect(ghostSessionStopContinuation({ continue: true, additionalContext: "Revise" })).toBe("Revise");
  });
});
