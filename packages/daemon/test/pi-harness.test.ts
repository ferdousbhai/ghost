import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import {
  PiHarnessAdapter,
  piTaskPrompt,
} from "../src/pi-harness.js";
import type { WorkerTaskRequest } from "../src/tasks.js";

class FakePiChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: Array<Record<string, unknown>> = [];
  readonly kills: NodeJS.Signals[] = [];
  readonly ignoredCommands = new Set<string>();
  closed = false;
  private input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.input += chunk.toString();
      while (true) {
        const newline = this.input.indexOf("\n");
        if (newline < 0) break;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const command = JSON.parse(line) as Record<string, unknown>;
        this.commands.push(command);
        this.reply(command);
      }
    });
    this.stdin.on("finish", () => this.close(0, null));
  }

  push(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.close(null, signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  private reply(command: Record<string, unknown>): void {
    const id = command.id;
    if (typeof id !== "string") return;
    if (typeof command.type === "string" && this.ignoredCommands.has(command.type)) return;
    if (command.type === "get_state") {
      this.push({
        type: "response",
        id,
        command: "get_state",
        success: true,
        data: { sessionId: "pi-native-session" },
      });
      return;
    }
    this.push({ type: "response", id, command: command.type, success: true });
  }
}

const task: WorkerTaskRequest = {
  taskId: "task-12345678-1234-4123-8123-123456789abc",
  ghostName: "casper",
  parent: conversationIdentity("pi", "conversation-1"),
  agent: null,
  task: "Implement the focused change.",
  sourceRoot: "/trusted/source",
  sourceCwd: "/trusted/source/app",
  root: "/project",
  cwd: "/project/app",
};

function harness(child: FakePiChild, overrides: Partial<ConstructorParameters<typeof PiHarnessAdapter>[0]> = {}) {
  const spawnHarness = vi.fn(() => child.asChild());
  const adapter = new PiHarnessAdapter({
    env: { PATH: "/owner/bin", GHOST_PI_BINARY: "owner-pi" },
    assertContext: async () => ({ root: task.sourceRoot, cwd: task.sourceCwd }),
    resolveExecutable: async () => "/owner/bin/pi",
    spawnHarness,
    timings: { interruptGraceMs: 0, terminalExitGraceMs: 0, termGraceMs: 0 },
    ...overrides,
  });
  return { adapter, spawnHarness };
}

function context() {
  const notices: Array<{ type: string; text?: string }> = [];
  let force: (() => void) | undefined;
  return {
    notices,
    get force() { return force; },
    value: {
      signal: new AbortController().signal,
      emit: async (event: { type: "output" | "notice" | "waiting_for_owner" | "resumed"; text?: string }) => {
        notices.push(event);
      },
      registerForce: (callback: () => void) => { force = callback; },
    },
  };
}

describe("PiHarnessAdapter", () => {
  it("runs the installed Pi RPC harness with native config and returns its settled result", async () => {
    const child = new FakePiChild();
    const { adapter, spawnHarness } = harness(child);
    const events = context();

    const controller = await adapter.start(task, events.value);
    expect(spawnHarness).toHaveBeenCalledWith(
      "/owner/bin/pi",
      ["--mode", "rpc", "--approve", "--name", task.taskId],
      expect.objectContaining({ cwd: task.cwd, env: expect.objectContaining({ GHOST_PI_BINARY: "owner-pi" }) }),
    );
    expect(child.commands).toEqual([
      expect.objectContaining({ type: "get_state" }),
      expect.objectContaining({ type: "prompt", message: task.task }),
    ]);
    expect(controller.nativeSessionId).toBe("pi-native-session");

    child.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Implemented." }], stopReason: "stop" },
    });
    child.push({ type: "agent_settled" });

    await expect(controller.result).resolves.toEqual({
      text: "Implemented.",
      nativeSessionId: "pi-native-session",
    });
    expect(events.notices).toContainEqual({ type: "output", text: "Implemented." });
  });

  it("asks Pi itself to resolve and invoke an optional native agent", async () => {
    const child = new FakePiChild();
    const { adapter } = harness(child);
    const events = context();
    const controller = await adapter.start({ ...task, agent: "reviewer" }, events.value);
    const prompt = child.commands.find((command) => command.type === "prompt")?.message;

    expect(prompt).toBe(piTaskPrompt(task.task, "reviewer"));
    expect(String(prompt)).toContain('"reviewer"');
    expect(String(prompt)).toContain("Do not perform the assignment in this parent agent");
    expect(events.notices).toContainEqual({
      type: "notice",
      text: 'Pi\'s root agent was asked to delegate to requested native agent "reviewer"; Ghost cannot verify that native delegation occurred.',
    });

    child.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Reviewed." }], stopReason: "stop" },
    });
    child.push({ type: "agent_settled" });
    await expect(controller.result).resolves.toMatchObject({ text: "Reviewed." });
  });

  it("acknowledges steering and cancels only the captured Pi process", async () => {
    const child = new FakePiChild();
    const { adapter } = harness(child);
    const events = context();
    const controller = await adapter.start(task, events.value);

    await expect(controller.send?.("Check the edge case.")).resolves.toBeUndefined();
    expect(child.commands).toContainEqual(expect.objectContaining({
      type: "steer",
      message: "Check the edge case.",
    }));

    await expect(controller.cancel()).resolves.toBeUndefined();
    expect(child.commands).toContainEqual(expect.objectContaining({ type: "abort" }));
    expect(child.closed).toBe(true);
  });

  it("tears down the captured process when Pi does not acknowledge abort", async () => {
    const child = new FakePiChild();
    child.ignoredCommands.add("abort");
    const { adapter } = harness(child, {
      timings: { interruptGraceMs: 1, terminalExitGraceMs: 0, termGraceMs: 0 },
    });
    const controller = await adapter.start(task, context().value);

    await expect(controller.cancel()).resolves.toBeUndefined();

    expect(child.commands).toContainEqual(expect.objectContaining({ type: "abort" }));
    expect(child.kills).toContain("SIGTERM");
    expect(child.closed).toBe(true);
  });

  it("revalidates the trusted source context before spawning", async () => {
    const child = new FakePiChild();
    const { adapter, spawnHarness } = harness(child, {
      assertContext: async () => ({ root: task.sourceRoot, cwd: `${task.sourceCwd}/changed` }),
    });

    await expect(adapter.start(task, context().value)).rejects.toThrow(
      "project identity changed",
    );
    expect(spawnHarness).not.toHaveBeenCalled();
  });
});
