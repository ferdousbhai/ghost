import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
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
    runtime: "pi",
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

  it("rejects unsupported configured events instead of silently ignoring them", () => {
    const directory = temporaryDirectory();
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({ hooks: { agent_end: [] } }));
    expect(() => GhostHookRunner.fromConfig(config)).toThrow(/unsupported hook event/);
  });
});
