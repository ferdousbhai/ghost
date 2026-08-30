import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  CodexProbe,
  CodexWorkerAdapter,
  readCodexAccount,
} from "../src/codex-worker.js";
import { conversationIdentity } from "../src/conversation-identity.js";
import type { WorkerAdapterEvent, WorkerTaskRequest } from "../src/tasks.js";

const NO_RESPONSE = Symbol("no-response");
type Message = Record<string, unknown>;
type Responder = (message: Message) => unknown | typeof NO_RESPONSE;

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Message[] = [];
  readonly kills: NodeJS.Signals[] = [];
  readonly responders = new Map<string, Responder>();
  private closed = false;

  constructor(readonly closeOnInputEnd = true) {
    super();
    const lines = createInterface({ input: this.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Message;
      this.messages.push(message);
      if (typeof message.method !== "string" || message.id === undefined) return;
      const responder = this.responders.get(message.method);
      const result = responder?.(message);
      if (result !== NO_RESPONSE) this.respond(message.id, result ?? {});
    });
    this.stdin.once("finish", () => {
      if (this.closeOnInputEnd) queueMicrotask(() => this.close(0, null));
    });
  }

  respond(id: unknown, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  request(id: string | number, method: string, params: unknown = {}): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    queueMicrotask(() => this.close(null, signal));
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
}

const task: WorkerTaskRequest = {
  taskId: "task-12345678-1234-4123-8123-123456789abc",
  ghostName: "casper",
  parent: conversationIdentity("pi", "conversation-1"),
  task: "Implement the focused change.",
  sourceRoot: "/trusted/source",
  sourceCwd: "/trusted/source/app",
  root: "/project",
  cwd: "/project/app",
};

function configureStartup(child: FakeCodexChild): void {
  child.responders.set("initialize", () => ({ userAgent: "codex-test" }));
  child.responders.set("thread/start", (message) => {
    expect(message.params).toEqual({
      cwd: task.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    return {
      thread: { id: "thread-native-1", cwd: task.cwd },
      cwd: task.cwd,
      model: "owner-model",
      instructionSources: ["/project/AGENTS.md"],
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    };
  });
  child.responders.set("turn/start", (message) => {
    expect(message.params).toEqual({
      threadId: "thread-native-1",
      input: [{ type: "text", text: task.task, text_elements: [] }],
    });
    return { turn: { id: "turn-1", status: "inProgress" } };
  });
}

function complete(child: FakeCodexChild, text = "Implemented."): void {
  const item = { type: "agentMessage", id: "item-1", text };
  child.notify("item/completed", { threadId: "thread-native-1", turnId: "turn-1", item });
  child.notify("turn/completed", {
    threadId: "thread-native-1",
    turn: { id: "turn-1", status: "completed", error: null, items: [item] },
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition was not reached");
}

function adapterHarness(child: FakeCodexChild) {
  const events: WorkerAdapterEvent[] = [];
  let force: (() => void) | undefined;
  const spawnWorker = vi.fn((command, args, options) => {
    expect(command).toBe("/owner/bin/codex");
    expect(args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(options).toMatchObject({ cwd: task.cwd, shell: false });
    expect(options.env).toMatchObject({ OWNER_SETTING: "preserved" });
    return child.asChild();
  });
  const adapter = new CodexWorkerAdapter({
    env: { PATH: "/owner/bin", OWNER_SETTING: "preserved", GHOST_CODEX_BINARY: "codex" },
    assertContext: async ({ root, cwd }) => ({ root, cwd }),
    resolveExecutable: async (configured) => {
      expect(configured).toBe("codex");
      return "/owner/bin/codex";
    },
    spawnWorker,
    timings: { interruptGraceMs: 0, terminalExitGraceMs: 0, termGraceMs: 0 },
  });
  const context = {
    signal: new AbortController().signal,
    emit: async (event: WorkerAdapterEvent) => { events.push(event); },
    registerForce: (registered: () => void) => { force = registered; },
  };
  return { adapter, context, events, spawnWorker, getForce: () => force };
}

describe("Codex native worker", () => {
  it("uses native app-server settings with maximum trust, validates cwd, and settles after exit", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    const harness = adapterHarness(child);

    const controller = await harness.adapter.start(task, harness.context);

    expect(controller.nativeSessionId).toBe("thread-native-1");
    expect(child.messages[0]).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "ghost", title: "Ghost", version: "0.0.1" },
        capabilities: null,
      },
    });
    expect(child.messages.some((message) => message.method === "initialized")).toBe(true);
    complete(child);
    await expect(controller.result).resolves.toEqual({
      text: "Implemented.",
      nativeSessionId: "thread-native-1",
    });
    expect(harness.events).toContainEqual({ type: "output", text: "Implemented." });
    expect(harness.events).toContainEqual({
      type: "notice",
      text: "Codex started with native configuration and maximum trust (owner-model; 1 instruction source).",
    });
  });

  it("acknowledges native turn steering before accepting a task message", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    child.responders.set("turn/steer", (message) => {
      expect(message.params).toEqual({
        threadId: "thread-native-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Focus on the regression.", text_elements: [] }],
      });
      return { turnId: "turn-1" };
    });
    const harness = adapterHarness(child);
    const controller = await harness.adapter.start(task, harness.context);

    await expect(controller.send?.("Focus on the regression.")).resolves.toBeUndefined();
    complete(child);
    await controller.result;
  });

  it("fails if Codex requests an approval after accepting maximum-trust execution", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    const harness = adapterHarness(child);
    const controller = await harness.adapter.start(task, harness.context);

    child.request("approval-1", "item/commandExecution/requestApproval", { command: "dangerous" });
    await expect(controller.result).rejects.toThrow(
      "after accepting maximum-trust execution",
    );
    expect(child.messages.find((message) => message.id === "approval-1")).toMatchObject({
      id: "approval-1",
      error: { code: -32601 },
    });
  });

  it("declines MCP elicitation because maximum trust cannot invent requested input", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    const harness = adapterHarness(child);
    const controller = await harness.adapter.start(task, harness.context);

    child.request("elicitation-1", "mcpServer/elicitation/request", { mode: "form" });
    await until(() => child.messages.some((message) => message.id === "elicitation-1"));
    expect(child.messages.find((message) => message.id === "elicitation-1")).toEqual({
      id: "elicitation-1",
      result: { action: "decline", content: null, _meta: null },
    });
    expect(harness.events).toContainEqual({
      type: "notice",
      text: "Codex requested MCP input; the headless worker declined it.",
    });
    complete(child);
    await controller.result;
  });

  it("fails visibly on an unsupported blocking client request", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    const harness = adapterHarness(child);
    const controller = await harness.adapter.start(task, harness.context);

    child.request("question-1", "item/tool/requestUserInput", { questions: [] });

    await expect(controller.result).rejects.toThrow("Unsupported Codex client request");
    expect(child.kills).toContain("SIGTERM");
    expect(child.messages.find((message) => message.id === "question-1")).toMatchObject({
      id: "question-1",
      error: { code: -32601 },
    });
  });

  it("interrupts the active turn and confirms cancellation after the child exits", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    child.responders.set("turn/interrupt", (message) => {
      expect(message.params).toEqual({ threadId: "thread-native-1", turnId: "turn-1" });
      queueMicrotask(() => child.notify("turn/completed", {
        threadId: "thread-native-1",
        turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
      }));
      return {};
    });
    const harness = adapterHarness(child);
    const controller = await harness.adapter.start(task, harness.context);

    await expect(controller.cancel()).resolves.toBeUndefined();
    await expect(controller.result).rejects.toThrow("interrupted");
  });

  it("registers a captured force action during native initialization", async () => {
    const child = new FakeCodexChild(false);
    child.responders.set("initialize", () => NO_RESPONSE);
    const harness = adapterHarness(child);
    const starting = harness.adapter.start(task, harness.context);
    await until(() => harness.getForce() !== undefined);

    harness.getForce()?.();

    await expect(starting).rejects.toThrow("SIGKILL");
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("stops the captured child when task cancellation arrives during initialization", async () => {
    const child = new FakeCodexChild(false);
    child.responders.set("initialize", () => NO_RESPONSE);
    const harness = adapterHarness(child);
    const abort = new AbortController();
    const starting = harness.adapter.start(task, { ...harness.context, signal: abort.signal });
    await until(() => child.messages.some((message) => message.method === "initialize"));

    abort.abort();

    await expect(starting).rejects.toThrow("SIGTERM");
    expect(child.kills).toContain("SIGTERM");
  });

  it("revalidates the project identity before resolving or spawning Codex", async () => {
    const child = new FakeCodexChild();
    const spawnWorker = vi.fn(() => child.asChild());
    const adapter = new CodexWorkerAdapter({
      assertContext: async () => ({ root: task.sourceRoot, cwd: "/trusted/source/elsewhere" }),
      resolveExecutable: async () => "/owner/bin/codex",
      spawnWorker,
    });

    await expect(adapter.start(task, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    })).rejects.toThrow("project identity changed");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("revalidates the project identity again after executable resolution", async () => {
    const child = new FakeCodexChild();
    const spawnWorker = vi.fn(() => child.asChild());
    let validations = 0;
    const adapter = new CodexWorkerAdapter({
      assertContext: async () => {
        validations += 1;
        return validations === 1
          ? { root: task.sourceRoot, cwd: task.sourceCwd }
          : { root: task.sourceRoot, cwd: "/trusted/source/elsewhere" };
      },
      resolveExecutable: async () => "/owner/bin/codex",
      spawnWorker,
    });

    await expect(adapter.start(task, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    })).rejects.toThrow("project identity changed");
    expect(validations).toBe(2);
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("rejects a thread that does not confirm maximum-trust execution", async () => {
    const child = new FakeCodexChild();
    configureStartup(child);
    child.responders.set("thread/start", () => ({
      thread: { id: "thread-native-1", cwd: task.cwd },
      cwd: task.cwd,
      model: "owner-model",
      instructionSources: [],
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    }));
    const harness = adapterHarness(child);

    await expect(harness.adapter.start(task, harness.context))
      .rejects.toThrow("maximum-trust execution state");
  });
});

describe("Codex structured account probe", () => {
  it("reads account state over app-server without configuration overrides", async () => {
    const child = new FakeCodexChild();
    child.responders.set("initialize", () => ({ userAgent: "codex-test" }));
    child.responders.set("account/read", (message) => {
      expect(message.params).toEqual({ refreshToken: false });
      return { account: { type: "chatgpt", email: "private@example.test" }, requiresOpenaiAuth: true };
    });

    await expect(readCodexAccount(
      "/owner/bin/codex",
      { OWNER_SETTING: "preserved" },
      (_command, args, options) => {
        expect(args).toEqual(["app-server", "--listen", "stdio://"]);
        expect(options.env).toEqual({ OWNER_SETTING: "preserved" });
        return child.asChild();
      },
    )).resolves.toEqual({ accountPresent: true, requiresOpenaiAuth: true });
  });

  it("caches the structured result and classifies resolver failures as missing", async () => {
    const resolveExecutable = vi.fn(async () => "/owner/bin/codex");
    const readAccount = vi.fn(async () => ({ accountPresent: false, requiresOpenaiAuth: true }));
    const probe = new CodexProbe({
      env: { PATH: "/owner/bin" },
      now: () => 1_000,
      ttlMs: 5_000,
      resolveExecutable,
      readAccount,
    });

    await expect(Promise.all([probe.read(), probe.read()])).resolves.toEqual([
      {
        binaryPath: "/owner/bin/codex",
        account: { accountPresent: false, requiresOpenaiAuth: true },
      },
      {
        binaryPath: "/owner/bin/codex",
        account: { accountPresent: false, requiresOpenaiAuth: true },
      },
    ]);
    expect(resolveExecutable).toHaveBeenCalledTimes(1);
    expect(readAccount).toHaveBeenCalledTimes(1);

    const missing = new CodexProbe({ resolveExecutable: async () => { throw new Error("missing"); } });
    await expect(missing.read()).rejects.toMatchObject({ name: "CodexMissingError" });
  });
});
