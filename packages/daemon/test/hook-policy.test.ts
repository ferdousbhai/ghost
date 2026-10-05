import { describe, expect, it } from "vitest";
import {
  ghostSessionStopContinuation, hookStatus, parseCommandResult, parseHooksDocument,
  runBeforePromptHooks, runSessionStopHooks,
  type CommandResult, type GhostBeforePromptEvent, type GhostSessionStopEvent,
} from "../src/hook-policy.js";

const path = "/owner/hooks.json";
const config = {
  hooks: {
    before_prompt: [{ hooks: [
      { type: "command", command: "first" },
      { type: "command", command: "second", name: "Named context", timeout: 0.5 },
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
  session_id: "session-1", ghost_name: "casper", ghost_home: "/owner/casper", cwd: "/owner",
  runtime: "pi" as const, conversation_id: "conversation-1", conversation_runtime: "pi" as const,
  signal: new AbortController().signal,
};

describe("shared hook policy", () => {
  it("keeps local admission, defaults, source order and public status", () => {
    const commands = parseHooksDocument(config, path);
    expect(commands.map((hook) => [hook.eventName, hook.command, hook.timeoutMs])).toEqual([
      ["before_prompt", "first", 30000], ["before_prompt", "second", 500],
      ["session_stop", "accept", 30000], ["session_stop", "continue", 30000],
      ["session_stop", "unreached", 30000],
    ]);
    expect(hookStatus(commands)).toMatchObject({ active: true, total: 5, events: [
      { event: "before_prompt", count: 2 }, { event: "session_stop", count: 3 },
    ] });
    expect(hookStatus(commands).hooks[1]?.name).toBe("Named context");
    for (const invalid of [
      { hooks: { other: [] } }, { builtin: { memory_upkeep: {} } },
      { hooks: { before_prompt: [{ hooks: [{ type: "command", command: "a\0b" }] }] } },
    ]) expect(() => parseHooksDocument(invalid, path)).toThrow();
  });

  it("combines before-prompt contexts and stops at the first real continuation", async () => {
    const commands = parseHooksDocument(config, path);
    const before: GhostBeforePromptEvent = { ...base, type: "before_prompt", prompt: "Continue", turn_id: "turn-1" };
    const called: string[] = [];
    expect(await runBeforePromptHooks(commands, before, async (hook) => {
      called.push(hook.command);
      return { additionalContext: hook.command };
    })).toEqual({ additionalContext: "first\n\nsecond" });
    expect(called).toEqual(["first", "second"]);
    const stop: GhostSessionStopEvent = { ...base, type: "session_stop", owner_prompt: "Continue", messages: [], turn_id: "turn-1", stop_hook_active: false };
    called.length = 0;
    expect(await runSessionStopHooks(commands, stop, async (hook) => {
      called.push(hook.command);
      return hook.command === "continue" ? { decision: "block", reason: "Revise" } : { continue: true };
    })).toEqual({ decision: "block", reason: "Revise" });
    expect(called).toEqual(["accept", "continue"]);
  });

  it("preserves exit-code, invalid-output and fail-open interpretation", () => {
    const [before, , stop] = parseHooksDocument(config, path);
    if (!before || !stop) throw new Error("fixture hooks missing");
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(parseCommandResult(before, result({ exitCode: 2, stderr: "Blocked" }), warn)).toBeUndefined();
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
