import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GhostHookRunner,
  ghostSessionStopContinuation,
  type GhostBeforePromptEvent,
  type GhostSessionStopEvent,
} from "../src/hooks.js";
import { recordingLogger } from "./helpers/recording-logger.js";

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
    runtime: "pi",
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
    runtime: "pi",
    conversation_id: "session-1",
    conversation_runtime: "pi",
    ...overrides,
  };
}

// A killed descendant is reparented to init, and only init can reap it. Under a
// non-reaping PID 1 -- the CI container's `tail -f /dev/null` entrypoint -- it stays
// an unreaped zombie forever, and `process.kill(pid, 0)` reports a zombie as alive.
// A zombie has already exited and dropped its inherited stdout/stderr pipes, so it is
// not a survivor; only a process that can still run and hold those pipes is.
function isAlive(pid: number): boolean {
  try {
    // "<pid> (<comm>) <state> ...", and comm can hold spaces and parens, so end it at the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    // No procfs (non-Linux), or the entry vanished; fall back to signal probing.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

  it("replaces the command configuration live and leaves in-process handlers alone", async () => {
    const directory = temporaryDirectory();
    const config = join(directory, "nested", "hooks.json");
    const runner = GhostHookRunner.fromConfig(config);
    expect(runner.config()).toEqual({ path: config, document: {} });
    expect(runner.hasHandlers("session_stop")).toBe(false);

    await runner.register((api) => {
      api.on("before_prompt", () => {}, { name: "Builtin context" });
    });

    const first = {
      hooks: {
        session_stop: [{ hooks: [{
          type: "command",
          command: "echo '{\"decision\":\"block\",\"reason\":\"Revise.\"}'",
          name: "Reviewer",
        }] }],
      },
    };
    await expect(runner.replaceConfig(first)).resolves.toEqual({ path: config, document: first });
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(first);
    expect(runner.hasHandlers("session_stop")).toBe(true);
    expect(ghostSessionStopContinuation(await runner.emitSessionStop(event()))).toBe("Revise.");
    expect(runner.status().hooks.map(({ source, name }) => `${source}:${name}`))
      .toEqual(["builtin:Builtin context", "config:Reviewer"]);

    const invalid = { hooks: { session_stop: [{ hooks: [{ type: "command", command: "" }] }] } };
    await expect(runner.replaceConfig(invalid)).rejects.toThrow(/non-empty NUL-free command/u);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(first);
    expect(runner.hasHandlers("session_stop")).toBe(true);

    const second = { hooks: {} };
    await runner.replaceConfig(second);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(second);
    expect(runner.hasHandlers("session_stop")).toBe(false);
    expect(runner.hasHandlers("before_prompt")).toBe(true);
  });

  it("refuses every builtin key and still names a code-registered hook on status", async () => {
    const directory = temporaryDirectory();
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({ hooks: {}, builtin: {} }));
    const runner = GhostHookRunner.fromConfig(config);

    await runner.register((api) => {
      api.on("session_stop", () => {}, { name: "Review" });
    });
    expect(runner.status().hooks).toEqual([{
      event: "session_stop",
      source: "builtin",
      name: "Review",
      description: "Runs after the assistant pass and may continue it.",
    }]);

    for (const [document, message] of [
      [{ hooks: {}, builtin: [] }, /"builtin" must be an object/u],
      [{ hooks: {}, builtin: { "Bad-Key": {} } }, /must match \[a-z\]/u],
      [{ hooks: {}, builtin: { memory_upkeep: {} } }, /unsupported builtin key/u],
      [{ hooks: {}, builtin: { review: {} } }, /unsupported builtin key/u],
    ] as const) {
      await expect(runner.replaceConfig(document)).rejects.toThrow(message);
    }
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ hooks: {}, builtin: {} });
  });

  it("has no configuration to replace when built without a file", async () => {
    const runner = new GhostHookRunner();
    expect(runner.config()).toBeUndefined();
    await expect(runner.replaceConfig({ hooks: {} })).rejects.toThrow(/no configuration file/u);
  });

  it("loads Claude-style command groups and passes the Ghost hook payload", async () => {
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
      await vi.waitFor(() => expect(existsSync(pidsPath)).toBe(true), { timeout: 5_000 });
      const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
      if (mode === "abort") controller.abort(new Error("owner moved on"));
      await running;
      await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 5_000 });
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
      hooks: Object.fromEntries(["before_prompt", "session_stop"].map((name) => [
        name,
        [{ hooks: [{ type: "command", command: "/bin/true" }] }],
      ])),
    }));
    const logger = recordingLogger("warn");
    const runner = GhostHookRunner.fromConfig(config, {
      commandRunner: async () => { throw new Error("must-not-leak execution sentinel"); },
      logger,
    });
    await expect(runner.emitBeforePrompt(beforePromptEvent())).resolves.toBeUndefined();
    await expect(runner.emitSessionStop(event())).resolves.toBeUndefined();
    expect(logger.records.map(({ message }) => message)).toEqual([
      "before_prompt hook failed open",
      "session_stop hook failed open",
    ]);
    expect(JSON.stringify(logger.records)).not.toContain("must-not-leak");
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
        child() { return this; },
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
      hooks: Object.fromEntries(["before_prompt", "session_stop"].map((name) => [
        name,
        [{ hooks: [{ type: "command", command: "/bin/true" }] }],
      ])),
    }));
    const missingCwd = join(directory, "missing-cwd");
    const runner = GhostHookRunner.fromConfig(config);
    await expect(runner.emitBeforePrompt(beforePromptEvent({ cwd: missingCwd }))).resolves.toBeUndefined();
    await expect(runner.emitSessionStop(event({ cwd: missingCwd }))).resolves.toBeUndefined();
  });

  it("rejects unsupported configured events instead of silently ignoring them", () => {
    const directory = temporaryDirectory();
    const config = join(directory, "hooks.json");
    writeFileSync(config, JSON.stringify({ hooks: { conversation_idle: [] } }));
    expect(() => GhostHookRunner.fromConfig(config)).toThrow(/unsupported hook event/);
  });
});
