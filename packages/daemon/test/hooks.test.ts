import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
  type GhostBeforePromptEvent,
  type GhostSessionStopEvent,
} from "../src/hooks.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ghost-hooks-"));
  directories.push(directory);
  return directory;
}

function beforePromptEvent(overrides: Partial<GhostBeforePromptEvent> = {}): GhostBeforePromptEvent {
  return {
    type: "before_prompt",
    prompt: "Continue",
    turn_id: 2,
    session_id: "session-1",
    signal: new AbortController().signal,
    ghost_name: "casper",
    cwd: process.cwd(),
    runtime: "omp",
    ...overrides,
  };
}

function event(overrides: Partial<GhostSessionStopEvent> = {}): GhostSessionStopEvent {
  return {
    type: "session_stop",
    owner_prompt: "Finish the current request.",
    messages: [],
    turn_id: 1,
    session_id: "session-1",
    stop_hook_active: false,
    signal: new AbortController().signal,
    ghost_name: "casper",
    cwd: process.cwd(),
    runtime: "omp",
    ...overrides,
  };
}

describe("GhostHookRunner", () => {
  it("runs in-process handlers sequentially and returns the first continuation", async () => {
    const runner = new GhostHookRunner();
    const calls: string[] = [];
    await runner.register((api) => {
      api.on("session_stop", () => {
        calls.push("first");
        return { continue: true }; // Empty continuation is intentionally ignored.
      });
      api.on("session_stop", () => {
        calls.push("second");
        return { decision: "block", reason: "Revise this answer." };
      });
      api.on("session_stop", () => {
        calls.push("third");
      });
    });

    const result = await runner.emitSessionStop(event());
    expect(calls).toEqual(["first", "second"]);
    expect(ghostSessionStopContinuation(result)).toBe("Revise this answer.");
    expect(GHOST_SESSION_STOP_CONTINUATION_CAP).toBe(6);
    expect(runner.status()).toEqual({
      active: true,
      total: 3,
      events: [{ event: "session_stop", count: 3 }],
      hooks: [
        {
          event: "session_stop",
          name: "Session-stop extension hook",
          description: "Reviews the current assistant pass and may continue it.",
        },
        {
          event: "session_stop",
          name: "Session-stop extension hook",
          description: "Reviews the current assistant pass and may continue it.",
        },
        {
          event: "session_stop",
          name: "Session-stop extension hook",
          description: "Reviews the current assistant pass and may continue it.",
        },
      ],
      session_stop_continuation_cap: 6,
    });
  });

  it("combines nonblocking before_prompt context without starting a continuation", async () => {
    const runner = new GhostHookRunner();
    const calls: string[] = [];
    await runner.register((api) => {
      api.on("before_prompt", (input) => {
        calls.push(input.prompt);
        return { additionalContext: "First advisory." };
      });
      api.on("before_prompt", () => ({ additionalContext: "Second advisory." }));
    });

    const result = await runner.emitBeforePrompt(beforePromptEvent());
    expect(calls).toEqual(["Continue"]);
    expect(result?.additionalContext).toBe("First advisory.\n\nSecond advisory.");
    expect(runner.status()).toMatchObject({
      active: true,
      total: 2,
      events: [{ event: "before_prompt", count: 2 }],
    });
  });

  it("fires conversation_idle once after a resettable inactivity delay", async () => {
    vi.useFakeTimers();
    const runner = new GhostHookRunner();
    const observed: Array<{ idleFor: number; outcome: string }> = [];
    await runner.register((api) => {
      api.on("conversation_idle", (input) => {
        observed.push({ idleFor: input.idle_for_ms, outcome: input.last_turn_outcome });
      });
    });
    const idleEvent = {
      conversation_id: "conversation-1",
      turn_id: 4,
      session_id: "session-1",
      last_turn_outcome: "completed" as const,
      ghost_name: "casper",
      cwd: process.cwd(),
      runtime: "omp" as const,
    };

    runner.scheduleConversationIdle("casper/conversation-1", idleEvent);
    await vi.advanceTimersByTimeAsync(30_000);
    runner.scheduleConversationIdle("casper/conversation-1", idleEvent);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed).toEqual([{ idleFor: 60_000, outcome: "completed" }]);
    expect(runner.status()).toMatchObject({
      total: 1,
      events: [{ event: "conversation_idle", count: 1 }],
      hooks: [{ event: "conversation_idle", name: "Conversation-idle extension hook" }],
    });
  });

  it("keeps an independent configured delay for each conversation_idle hook", async () => {
    vi.useFakeTimers();
    const runner = new GhostHookRunner();
    const observed: string[] = [];
    await runner.register((api) => {
      api.on("conversation_idle", () => { observed.push("fast"); }, { idleSeconds: 60 });
      api.on("conversation_idle", () => { observed.push("slow"); }, { idleSeconds: 600 });
    });
    runner.scheduleConversationIdle("casper/conversation-1", {
      conversation_id: "conversation-1",
      turn_id: 1,
      session_id: "session-1",
      last_turn_outcome: "completed",
      ghost_name: "casper",
      cwd: process.cwd(),
      runtime: "omp",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(observed).toEqual(["fast"]);
    await vi.advanceTimersByTimeAsync(540_000);
    expect(observed).toEqual(["fast", "slow"]);
    expect(runner.status().hooks).toMatchObject([
      { event: "conversation_idle", idle_seconds: 60 },
      { event: "conversation_idle", idle_seconds: 600 },
    ]);
  });

  it("loads Claude-style command groups and passes the OMP-compatible payload", async () => {
    const directory = temporaryDirectory();
    const script = join(directory, "hook.mjs");
    const observed = join(directory, "observed.json");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      const event = JSON.parse(input);
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify(event));
      process.stdout.write(JSON.stringify({ decision: "block", reason: "Fix the final answer." }));
    `);
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({
      hooks: {
        session_stop: [{
          hooks: [{
            type: "command",
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
            name: "Completion review",
            description: "Checks whether the current request is complete.",
            timeout: 5,
          }],
        }],
      },
    }));

    const runner = GhostHookRunner.fromConfig(config);
    expect(runner.status()).toMatchObject({
      active: true,
      total: 1,
      events: [{ event: "session_stop", count: 1 }],
      hooks: [{
        event: "session_stop",
        name: "Completion review",
        description: "Checks whether the current request is complete.",
      }],
    });
    const result = await runner.emitSessionStop(event({
      last_assistant_message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
      stop_hook_active: true,
    }));

    expect(ghostSessionStopContinuation(result)).toBe("Fix the final answer.");
    expect(JSON.parse(readFileSync(observed, "utf8"))).toMatchObject({
      type: "session_stop",
      owner_prompt: "Finish the current request.",
      ghost_name: "casper",
      stop_hook_active: true,
    });
  });

  it("runs configured before_prompt hooks and returns advisory context", async () => {
    const directory = temporaryDirectory();
    const script = join(directory, "before-prompt.mjs");
    const observed = join(directory, "before-prompt.json");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      writeFileSync(${JSON.stringify(observed)}, input);
      process.stdout.write(JSON.stringify({ additionalContext: "Avoid the prior warning." }));
    `);
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({
      hooks: {
        before_prompt: [{
          hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }],
        }],
      },
    }));

    const runner = GhostHookRunner.fromConfig(config);
    const result = await runner.emitBeforePrompt(beforePromptEvent());
    expect(result?.additionalContext).toBe("Avoid the prior warning.");
    expect(JSON.parse(readFileSync(observed, "utf8"))).toMatchObject({
      type: "before_prompt",
      session_id: "session-1",
      prompt: "Continue",
    });
  });

  it("rejects unsupported configured events instead of silently ignoring them", () => {
    const directory = temporaryDirectory();
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({ hooks: { agent_end: [] } }));
    expect(() => GhostHookRunner.fromConfig(config)).toThrow(/unsupported hook event/);
  });
});
