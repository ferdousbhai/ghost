import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GHOST_SESSION_STOP_CONTINUATION_CAP,
  GhostHookRunner,
  ghostSessionStopContinuation,
  type GhostBeforePromptEvent,
  type GhostConversationIdleEvent,
  type GhostConversationIdleRegistration,
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
    ghost_home: process.cwd(),
    cwd: process.cwd(),
    runtime: "omp",
    conversation_id: "session-1",
    conversation_runtime: "pi",
    ...overrides,
  };
}

function event(overrides: Partial<GhostSessionStopEvent> = {}): GhostSessionStopEvent {
  return {
    type: "session_stop",
    owner_prompt: "Continue",
    messages: [],
    turn_id: 1,
    session_id: "session-1",
    stop_hook_active: false,
    signal: new AbortController().signal,
    ghost_name: "casper",
    ghost_home: process.cwd(),
    cwd: process.cwd(),
    runtime: "omp",
    conversation_id: "session-1",
    conversation_runtime: "pi",
    ...overrides,
  };
}

function idleEvent(overrides: Partial<GhostConversationIdleEvent> = {}): GhostConversationIdleEvent {
  return {
    type: "conversation_idle",
    session_id: "session-1",
    signal: new AbortController().signal,
    ghost_name: "casper",
    ghost_home: process.cwd(),
    cwd: process.cwd(),
    runtime: "omp",
    conversation_id: "session-1",
    conversation_runtime: "pi",
    conversation_incarnation: "68c7477b-c759-4a4e-a747-c908159080c2",
    sequence: 4,
    source_revision: "pi-leaf:leaf-4",
    idle_for_ms: 60_000,
    last_turn_outcome: "completed",
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
    expect(GHOST_SESSION_STOP_CONTINUATION_CAP).toBe(10);
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

  it("acknowledges only handlers whose context was actually returned", async () => {
    const runner = new GhostHookRunner();
    const acknowledgements: string[] = [];
    await runner.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Delivered.",
        acknowledge: () => { acknowledgements.push("delivered"); },
      }));
      api.on("before_prompt", () => ({
        acknowledge: () => { acknowledgements.push("not-delivered"); },
      }));
    });
    const result = await runner.emitBeforePrompt(beforePromptEvent());
    expect(acknowledgements).toEqual([]);
    await result?.acknowledge?.();
    expect(acknowledgements).toEqual(["delivered"]);
  });

  it("emits conversation_idle metadata and exposes only redacted hook status", async () => {
    const runner = new GhostHookRunner();
    const observed: GhostConversationIdleEvent[] = [];
    await runner.register((api) => {
      api.on("conversation_idle", (input) => { observed.push(input); }, {
        name: "Memory upkeep",
        description: "One memory write after idle.",
        idleSeconds: 60,
      });
    });
    await runner.emitConversationIdle(idleEvent());
    expect(observed[0]).toMatchObject({
      ghost_home: process.cwd(),
      conversation_runtime: "pi",
      sequence: 4,
      source_revision: "pi-leaf:leaf-4",
      last_turn_outcome: "completed",
    });
    expect(runner.status()).toEqual({
      active: true,
      total: 1,
      events: [{ event: "conversation_idle", count: 1 }],
      hooks: [{
        event: "conversation_idle",
        name: "Memory upkeep",
        description: "One memory write after idle.",
        idleSeconds: 60,
      }],
      sessionStopContinuationCap: GHOST_SESSION_STOP_CONTINUATION_CAP,
    });
    expect(JSON.stringify(runner.status())).not.toMatch(/command|path|prompt|context|error/iu);
  });

  it("dispatches only idle registrations due at an exact deadline", async () => {
    const runner = new GhostHookRunner();
    const observed: string[] = [];
    await runner.register((api) => {
      api.on("conversation_idle", () => { observed.push("ten"); }, { idleSeconds: 10 });
      api.on("conversation_idle", () => { observed.push("twenty"); }, { idleSeconds: 20 });
    });
    expect(runner.conversationIdleDelaysMs()).toEqual([10_000, 20_000]);
    await runner.emitConversationIdle(idleEvent({ idle_for_ms: 10_000 }), [10_000]);
    expect(observed).toEqual(["ten"]);
    await runner.emitConversationIdle(idleEvent({ idle_for_ms: 20_000 }), [20_000]);
    expect(observed).toEqual(["ten", "twenty"]);
  });

  it("can retry one exact idle registration without dispatching its delay peers", async () => {
    const runner = new GhostHookRunner();
    const observed: string[] = [];
    let exact!: GhostConversationIdleRegistration;
    await runner.register((api) => {
      exact = api.on("conversation_idle", () => { observed.push("exact"); }, { idleSeconds: 60 });
      api.on("conversation_idle", () => { observed.push("peer"); }, { idleSeconds: 60 });
    });
    await runner.emitConversationIdleRegistration(idleEvent(), exact);
    expect(observed).toEqual(["exact"]);
  });

  it("derives stable semantic idle identities and honors an explicit identity", async () => {
    const register = async (runner: GhostHookRunner) => {
      let derived!: GhostConversationIdleRegistration;
      let explicit!: GhostConversationIdleRegistration;
      await runner.register((api) => {
        derived = api.on("conversation_idle", () => {}, {
          name: "Stable observer",
          description: "Semantic identity fixture.",
          idleSeconds: 17,
        });
        explicit = api.on("conversation_idle", () => {}, {
          name: "Built in",
          description: "Explicit identity fixture.",
          idleSeconds: 60,
          registrationId: "ghost.test.explicit.v1",
        });
      });
      return { derived, explicit };
    };
    const first = await register(new GhostHookRunner());
    const second = await register(new GhostHookRunner());
    expect(second.derived).toEqual(first.derived);
    expect(first.explicit).toEqual({ id: "ghost.test.explicit.v1", idleMs: 60_000 });
    expect(second.explicit).toEqual(first.explicit);

    const directory = temporaryDirectory();
    const config = join(directory, "stable-command-hooks.json");
    writeFileSync(config, JSON.stringify({
      hooks: {
        conversation_idle: [{
          hooks: [{
            type: "command",
            command: "/bin/true",
            idleSeconds: 23,
            name: "Stable command",
          }],
        }],
      },
    }));
    expect(GhostHookRunner.fromConfig(config).conversationIdleRegistrations())
      .toEqual(GhostHookRunner.fromConfig(config).conversationIdleRegistrations());
  });

  it("rejects fractional, zero, and out-of-range conversation idle delays", async () => {
    for (const idleSeconds of [0, 1.5, 86_401, Number.NaN]) {
      const runner = new GhostHookRunner();
      await expect(runner.register((api) => {
        api.on("conversation_idle", () => {}, { idleSeconds });
      })).rejects.toThrow(/integer in \[1, 86400\]/u);
    }
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
      ghost_home: process.cwd(),
      cwd: process.cwd(),
      owner_prompt: "Continue",
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

  it("kills the owned command process tree and drains descendant-held pipes on timeout and abort", async () => {
    if (process.platform === "win32") return;
    for (const mode of ["timeout", "abort"] as const) {
      const directory = temporaryDirectory();
      const script = join(directory, `${mode}.mjs`);
      const pidsPath = join(directory, `${mode}-pids.json`);
      const grandchild = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFileSync(script, `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid]));
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `);
      const config = join(directory, `${mode}-hooks.json`);
      writeFileSync(config, JSON.stringify({
        hooks: {
          session_stop: [{
            hooks: [{
              type: "command",
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
              timeout: mode === "timeout" ? 0.2 : 5,
            }],
          }],
        },
      }));
      const runner = GhostHookRunner.fromConfig(config);
      const controller = new AbortController();
      const running = runner.emitSessionStop(event({ signal: controller.signal }));
      await vi.waitFor(() => expect(existsSync(pidsPath)).toBe(true));
      const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
      if (mode === "abort") controller.abort(new Error("owner moved on"));
      await running;
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 5_000 });
    }
  }, 15_000);

  it("rejects NUL commands and fails every command event open on execution rejection", async () => {
    const directory = temporaryDirectory();
    const nulConfig = join(directory, "nul-hooks.json");
    writeFileSync(nulConfig, JSON.stringify({
      hooks: {
        before_prompt: [{ hooks: [{ type: "command", command: "echo before\0after" }] }],
      },
    }));
    expect(() => GhostHookRunner.fromConfig(nulConfig)).toThrow(/NUL-free command/u);

    const config = join(directory, "throwing-hooks.json");
    writeFileSync(config, JSON.stringify({
      hooks: Object.fromEntries(["before_prompt", "session_stop", "conversation_idle"].map((name) => [
        name,
        [{ hooks: [{ type: "command", command: "/bin/true", idleSeconds: 60 }] }],
      ])),
    }));
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const runner = GhostHookRunner.fromConfig(config, {
      commandRunner: async () => { throw new Error("must-not-leak execution sentinel"); },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, fields) => { warnings.push({ message, fields }); },
        error: () => {},
      },
    });
    await expect(runner.emitBeforePrompt(beforePromptEvent())).resolves.toBeUndefined();
    await expect(runner.emitSessionStop(event())).resolves.toBeUndefined();
    await expect(runner.emitConversationIdle(idleEvent())).resolves.toBeUndefined();
    expect(warnings.map(({ message }) => message)).toEqual([
      "before_prompt hook failed open",
      "session_stop hook failed open",
      "conversation_idle hook failed open",
    ]);
    expect(JSON.stringify(warnings)).not.toContain("must-not-leak");
  });

  it("logs categorical command failures without stdout or stderr detail", async () => {
    const directory = temporaryDirectory();
    const config = join(directory, "redacted-command-hooks.json");
    writeFileSync(config, JSON.stringify({
      hooks: {
        before_prompt: [{
          hooks: [
            { type: "command", command: "/bin/false" },
            { type: "command", command: "/bin/true" },
          ],
        }],
      },
    }));
    const stdoutSentinel = "HOOK_STDOUT_SECRET_SENTINEL";
    const stderrSentinel = "HOOK_STDERR_SECRET_SENTINEL";
    const commandRunner = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 17,
        stdout: stdoutSentinel,
        stderr: stderrSentinel,
        aborted: false,
        timedOut: false,
        executionFailed: false,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `{${stdoutSentinel}`,
        stderr: stderrSentinel,
        aborted: false,
        timedOut: false,
        executionFailed: false,
      });
    const logs: Array<{
      level: "debug" | "info" | "warn" | "error";
      message: string;
      fields?: Record<string, unknown>;
    }> = [];
    const record = (level: "debug" | "info" | "warn" | "error") =>
      (message: string, fields?: Record<string, unknown>) => {
        logs.push({ level, message, fields });
      };
    const runner = GhostHookRunner.fromConfig(config, {
      commandRunner,
      logger: {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
    });

    await expect(runner.emitBeforePrompt(beforePromptEvent())).resolves.toBeUndefined();

    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([
      {
        level: "warn",
        message: "before_prompt hook failed open",
        fields: {
          source: `${config}#hooks.before_prompt[0].hooks[0]`,
          exitCode: 17,
        },
      },
      {
        level: "warn",
        message: "before_prompt hook returned invalid JSON",
        fields: {
          source: `${config}#hooks.before_prompt[0].hooks[1]`,
          error: "invalid hook output",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(stdoutSentinel);
    expect(JSON.stringify(logs)).not.toContain(stderrSentinel);
  });

  it("fails process-startup errors open for every command event", async () => {
    const directory = temporaryDirectory();
    const config = join(directory, "startup-hooks.json");
    writeFileSync(config, JSON.stringify({
      hooks: Object.fromEntries(["before_prompt", "session_stop", "conversation_idle"].map((name) => [
        name,
        [{ hooks: [{ type: "command", command: "/bin/true", idleSeconds: 60 }] }],
      ])),
    }));
    const missingCwd = join(directory, "missing-cwd");
    const runner = GhostHookRunner.fromConfig(config);
    await expect(runner.emitBeforePrompt(beforePromptEvent({ cwd: missingCwd }))).resolves.toBeUndefined();
    await expect(runner.emitSessionStop(event({ cwd: missingCwd }))).resolves.toBeUndefined();
    await expect(runner.emitConversationIdle(idleEvent({ cwd: missingCwd }))).resolves.toBeUndefined();
  });

  it("rejects unsupported configured events instead of silently ignoring them", () => {
    const directory = temporaryDirectory();
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({ hooks: { agent_end: [] } }));
    expect(() => GhostHookRunner.fromConfig(config)).toThrow(/unsupported hook event/);
  });
});
