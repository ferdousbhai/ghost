import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
  type GhostBeforePromptEvent,
  type GhostSessionStopEvent,
} from "../src/hooks.js";

const directories: string[] = [];
afterEach(() => {
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
    expect(GHOST_SESSION_STOP_CONTINUATION_CAP).toBe(8);
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
          hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, timeout: 5 }],
        }],
      },
    }));

    const runner = GhostHookRunner.fromConfig(config);
    const result = await runner.emitSessionStop(event({
      last_assistant_message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
      stop_hook_active: true,
    }));

    expect(ghostSessionStopContinuation(result)).toBe("Fix the final answer.");
    expect(JSON.parse(readFileSync(observed, "utf8"))).toMatchObject({
      type: "session_stop",
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
