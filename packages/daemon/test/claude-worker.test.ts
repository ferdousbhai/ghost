import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeWorkerAdapter,
  type ClaudeWorkerAdapterTimings,
  type ClaudeWorkerQueryInput,
} from "../src/claude-worker.js";
import { conversationIdentity } from "../src/conversation-identity.js";
import {
  TaskManager,
  type WorkerAdapterEvent,
  type WorkerTaskRequest,
} from "../src/tasks.js";
import { makeTempGhosts, seedGhost } from "./helpers/fixtures.js";

class FakeClaudeQuery {
  readonly closeCalls: number[] = [];
  readonly interruptCalls: number[] = [];
  onInterrupt?: () => void;
  private readonly queued: SDKMessage[] = [];
  private waiter?: (value: IteratorResult<SDKMessage>) => void;
  private ended = false;

  push(message: SDKMessage): void {
    if (this.ended) throw new Error("fake query already ended");
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: message });
    } else this.queued.push(message);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter({ done: true, value: undefined });
  }

  async interrupt(): Promise<void> {
    this.interruptCalls.push(Date.now());
    this.onInterrupt?.();
  }

  close(): void {
    this.closeCalls.push(Date.now());
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.queued.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKMessage>>((resolvePromise) => {
          this.waiter = resolvePromise;
        });
      },
    };
  }

  asQuery(): Query {
    return this as unknown as Query;
  }
}

class FakeClaudeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: NodeJS.Signals[] = [];
  killed = false;
  exitCode: number | null = null;
  private closed = false;

  constructor(private readonly closeOnKill = true) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.killed = true;
    if (this.closeOnKill) queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.exitCode = code;
    this.emit("exit", code, signal);
    this.close(code, signal);
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

function initMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    claude_code_version: "2.1.251",
    cwd: task.cwd,
    tools: ["Bash", "Read", "Edit"],
    mcp_servers: [{ name: "project", status: "connected" }],
    model: "owner-model",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: ["project-skill"],
    plugins: [{ name: "owner-plugin", path: "/private/plugin" }],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "native-claude-session",
    ...overrides,
  } as unknown as SDKMessage;
}

function assistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: "native-claude-session",
  } as unknown as SDKMessage;
}

function resultMessage(
  subtype: "success" | "error_during_execution" = "success",
  text = "Implemented.",
): SDKMessage {
  const common = {
    type: "result",
    subtype,
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: subtype !== "success",
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: "native-claude-session",
  };
  return (subtype === "success"
    ? { ...common, result: text }
    : { ...common, errors: [text] }) as unknown as SDKMessage;
}

function replay(message: SDKUserMessage): SDKMessage {
  return {
    ...message,
    isReplay: true,
    session_id: "native-claude-session",
  } as SDKMessage;
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition was not reached");
}

async function untilAsync(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition was not reached");
}

function adapterHarness(
  query: FakeClaudeQuery,
  options: {
    spawnWorker?: () => ChildProcessWithoutNullStreams;
    spawnOnCreate?: boolean;
    timings?: Partial<ClaudeWorkerAdapterTimings>;
  } = {},
) {
  const events: WorkerAdapterEvent[] = [];
  const inputs: SDKUserMessage[] = [];
  let queryInput: ClaudeWorkerQueryInput | undefined;
  let force: (() => void) | undefined;
  const child = new FakeClaudeChild();
  const spawnWorker = options.spawnWorker ?? (() => child.asChild());
  const createQuery = vi.fn((input: ClaudeWorkerQueryInput) => {
    queryInput = input;
    if (options.spawnOnCreate !== false) {
      input.options.spawnClaudeCodeProcess?.({
        command: "/usr/bin/node",
        args: ["/owner/bin/claude", "--permission-mode", "bypassPermissions"],
        cwd: task.cwd,
        env: {},
        signal: new AbortController().signal,
      });
    }
    void (async () => {
      for await (const message of input.prompt) inputs.push(message);
    })();
    return query.asQuery();
  });
  const adapter = new ClaudeWorkerAdapter({
    env: {
      PATH: "/owner/bin",
      OWNER_SETTING: "preserved",
      GHOST_CLAUDE_BINARY: "claude",
    },
    assertContext: async ({ root, cwd }) => ({ root, cwd }),
    resolveExecutable: async (configured) => {
      expect(configured).toBe("claude");
      return "/owner/bin/claude";
    },
    createQuery,
    spawnWorker,
    timings: {
      interruptGraceMs: 0,
      terminalExitGraceMs: 0,
      termGraceMs: 0,
      ...options.timings,
    },
  });
  const context = {
    signal: new AbortController().signal,
    emit: async (event: WorkerAdapterEvent) => { events.push(event); },
    registerForce: (registered: () => void) => { force = registered; },
  };
  return {
    adapter,
    context,
    createQuery,
    events,
    inputs,
    getQueryInput: () => queryInput,
    getForce: () => force,
  };
}

async function startInitialized(query: FakeClaudeQuery, harness = adapterHarness(query)) {
  const starting = harness.adapter.start(task, harness.context);
  await until(() => harness.createQuery.mock.calls.length === 1);
  query.push(initMessage());
  return { harness, controller: await starting };
}

describe("Claude Code native worker", () => {
  it("preserves native configuration and reports the installed harness identity", async () => {
    const query = new FakeClaudeQuery();
    const { harness, controller } = await startInitialized(query);
    const options = harness.getQueryInput()?.options;

    expect(controller.nativeSessionId).toBe("native-claude-session");
    expect(options).toMatchObject({
      cwd: task.cwd,
      pathToClaudeCodeExecutable: "/owner/bin/claude",
      env: { OWNER_SETTING: "preserved" },
      extraArgs: { "replay-user-messages": null },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(options).not.toHaveProperty("settingSources");
    expect(options).not.toHaveProperty("systemPrompt");
    expect(options).not.toHaveProperty("model");
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("skills");
    expect(options).not.toHaveProperty("plugins");
    expect(options).not.toHaveProperty("hooks");
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("supportedDialogKinds");
    expect(options).not.toHaveProperty("onUserDialog");
    await expect(options?.canUseTool?.("Bash", { command: "rm something" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
    })).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "rm something" },
    });
    await expect(options?.onElicitation?.({} as never, {} as never))
      .resolves.toEqual({ action: "decline" });
    expect(harness.events).toContainEqual({
      type: "notice",
      text: "Claude Code started with native configuration and maximum trust (owner-model; 1 skills; 1 plugins; 1 MCP servers).",
    });

    query.push(assistantMessage("Implemented."));
    query.push(resultMessage());
    query.end();
    await expect(controller.result).resolves.toEqual({
      text: "Implemented.",
      nativeSessionId: "native-claude-session",
    });
    expect(harness.events).toContainEqual({ type: "output", text: "Implemented." });
    expect(query.closeCalls).toHaveLength(1);
  });

  it("passes the explicit unattended SDK arguments through and captures the process", async () => {
    const query = new FakeClaudeQuery();
    const child = new FakeClaudeChild();
    const spawnWorker = vi.fn(() => child.asChild());
    let options: ClaudeQueryOptions | undefined;
    const adapter = new ClaudeWorkerAdapter({
      env: { PATH: "/owner/bin", OWNER_SETTING: "preserved" },
      assertContext: async ({ root, cwd }) => ({ root, cwd }),
      resolveExecutable: async () => "/owner/bin/claude",
      createQuery: (input) => {
        options = input.options;
        void (async () => {
          for await (const _message of input.prompt) { /* drain native input */ }
        })();
        return query.asQuery();
      },
      spawnWorker,
      timings: { interruptGraceMs: 0, terminalExitGraceMs: 0, termGraceMs: 0 },
    });
    const starting = adapter.start(task, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    });
    await until(() => options !== undefined);
    const spawned = options?.spawnClaudeCodeProcess?.({
      command: "/usr/bin/node",
      args: [
        "/owner/bin/claude",
        "--output-format", "stream-json",
        "--permission-mode", "bypassPermissions",
        "--allow-dangerously-skip-permissions",
        "--verbose",
      ],
      cwd: task.cwd,
      env: { OWNER_SETTING: "preserved" },
      signal: new AbortController().signal,
    });
    expect(spawned).toBe(child.asChild());
    expect(spawnWorker).toHaveBeenCalledWith(
      "/usr/bin/node",
      [
        "/owner/bin/claude",
        "--output-format", "stream-json",
        "--permission-mode", "bypassPermissions",
        "--allow-dangerously-skip-permissions",
        "--verbose",
      ],
      expect.objectContaining({
        cwd: task.cwd,
        env: { OWNER_SETTING: "preserved" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    query.push(initMessage());
    const controller = await starting;
    query.push(resultMessage());
    query.end();
    await expect(controller.result).resolves.toMatchObject({ text: "Implemented." });
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("constructs the real Agent SDK query with explicit unattended permission flags", async () => {
    const child = new FakeClaudeChild();
    const spawnWorker = vi.fn((_command: string, _args: readonly string[]) => child.asChild());
    let force: (() => void) | undefined;
    const adapter = new ClaudeWorkerAdapter({
      env: { PATH: "/owner/bin", OWNER_SETTING: "preserved" },
      assertContext: async ({ root, cwd }) => ({ root, cwd }),
      resolveExecutable: async () => "/owner/bin/claude",
      spawnWorker,
      timings: { interruptGraceMs: 0, terminalExitGraceMs: 0, termGraceMs: 0 },
    });
    const starting = adapter.start(task, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: (registered) => { force = registered; },
    });
    await until(() => spawnWorker.mock.calls.length === 1 && force !== undefined);

    const args = spawnWorker.mock.calls[0]?.[1] ?? [];
    const permissionMode = args.indexOf("--permission-mode");
    expect(args.slice(permissionMode, permissionMode + 2))
      .toEqual(["--permission-mode", "bypassPermissions"]);
    expect(args).toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("default");

    force?.();
    await expect(starting).rejects.toThrow("force-closed");
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("waits for captured stdio close instead of settling on process exit", async () => {
    const query = new FakeClaudeQuery();
    const child = new FakeClaudeChild(false);
    const harness = adapterHarness(query, {
      spawnWorker: () => child.asChild(),
      timings: { termGraceMs: 100 },
    });
    const starting = harness.adapter.start(task, harness.context);
    await until(() => harness.getQueryInput() !== undefined);
    query.push(initMessage());
    const controller = await starting;
    query.push(resultMessage());
    query.end();
    await until(() => child.kills.includes("SIGTERM"));
    let settled = false;
    void controller.result.finally(() => { settled = true; });

    child.emit("exit", 0, null);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(settled).toBe(false);

    child.close(0, null);
    await expect(controller.result).resolves.toMatchObject({ text: "Implemented." });
  });

  it("persists task messages only after Claude replays their native user frame", async () => {
    const query = new FakeClaudeQuery();
    const { harness, controller } = await startInitialized(query);
    await until(() => harness.inputs.length === 1);
    query.push(replay(harness.inputs[0]!));

    let accepted = false;
    const sending = Promise.resolve(controller.send?.("Focus on the regression.")).then(() => {
      accepted = true;
    });
    await until(() => harness.inputs.length === 2);
    expect(accepted).toBe(false);
    expect(harness.inputs[1]?.priority).toBe("now");
    query.push(replay(harness.inputs[1]!));
    await sending;
    expect(accepted).toBe(true);

    query.push(resultMessage());
    query.end();
    await controller.result;
  });

  it("rejects a task message whose replay loses the terminal-result race", async () => {
    const query = new FakeClaudeQuery();
    const { harness, controller } = await startInitialized(query);
    await until(() => harness.inputs.length === 1);
    query.push(replay(harness.inputs[0]!));

    const sending = Promise.resolve(controller.send?.("Make one more change."));
    await until(() => harness.inputs.length === 2);
    query.push(resultMessage());
    query.push(replay(harness.inputs[1]!));

    await expect(sending).rejects.toThrow("ended before accepting");
    await expect(controller.result).resolves.toMatchObject({ text: "Implemented." });
  });

  it("surfaces headless permission denials without exposing tool input", async () => {
    const query = new FakeClaudeQuery();
    const { harness, controller } = await startInitialized(query);
    query.push({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      decision_reason: "private command",
      message: "private details",
      uuid: "00000000-0000-4000-8000-000000000004",
      session_id: "native-claude-session",
    } as SDKMessage);
    query.push(resultMessage());
    query.end();
    await controller.result;

    expect(harness.events).toContainEqual({
      type: "notice",
      text: "Claude Code denied a Bash request under a native hook or safety policy despite maximum trust.",
    });
    expect(JSON.stringify(harness.events)).not.toContain("private command");
  });

  it("interrupts the active native query and confirms cancellation after it ends", async () => {
    const query = new FakeClaudeQuery();
    query.onInterrupt = () => query.end();
    const { controller } = await startInitialized(query);

    await expect(controller.cancel()).resolves.toBeUndefined();
    await expect(controller.result).rejects.toThrow("interrupted");
    expect(query.interruptCalls).toHaveLength(1);
    expect(query.closeCalls).toHaveLength(1);
  });

  it("force-closes the captured query during initialization", async () => {
    const query = new FakeClaudeQuery();
    const child = new FakeClaudeChild();
    const harness = adapterHarness(query, {
      spawnWorker: () => child.asChild(),
      spawnOnCreate: false,
    });
    const starting = harness.adapter.start(task, harness.context);
    await until(() => harness.getForce() !== undefined);

    harness.getForce()?.();
    harness.getQueryInput()?.options.spawnClaudeCodeProcess?.({
      command: "/usr/bin/node",
      args: ["/owner/bin/claude", "--permission-mode", "bypassPermissions"],
      cwd: task.cwd,
      env: {},
      signal: new AbortController().signal,
    });

    await expect(starting).rejects.toThrow("force-closed");
    expect(query.closeCalls).toHaveLength(2);
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("rejects a native cwd that differs from the trusted task context", async () => {
    const query = new FakeClaudeQuery();
    const harness = adapterHarness(query);
    const starting = harness.adapter.start(task, harness.context);
    await until(() => harness.createQuery.mock.calls.length === 1);
    query.push(initMessage({ cwd: "/project/elsewhere" }));

    await expect(starting).rejects.toThrow("incompatible project or maximum-trust");
  });

  it("rejects a query that does not confirm maximum-trust execution", async () => {
    const query = new FakeClaudeQuery();
    const harness = adapterHarness(query);
    const starting = harness.adapter.start(task, harness.context);
    await until(() => harness.createQuery.mock.calls.length === 1);
    query.push(initMessage({ permissionMode: "default" }));

    await expect(starting).rejects.toThrow("maximum-trust execution state");
  });

  it("rejects native initialization when the SDK did not use the captured process seam", async () => {
    const query = new FakeClaudeQuery();
    const harness = adapterHarness(query, { spawnOnCreate: false });
    const starting = harness.adapter.start(task, harness.context);
    await until(() => harness.createQuery.mock.calls.length === 1);
    query.push(initMessage());

    await expect(starting).rejects.toThrow("without a captured task process");
  });

  it("revalidates project identity before resolving or starting Claude Code", async () => {
    const createQuery = vi.fn(() => new FakeClaudeQuery().asQuery());
    const adapter = new ClaudeWorkerAdapter({
      assertContext: async () => ({ root: task.sourceRoot, cwd: "/trusted/source/elsewhere" }),
      resolveExecutable: async () => "/owner/bin/claude",
      createQuery,
    });

    await expect(adapter.start(task, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    })).rejects.toThrow("project identity changed");
    expect(createQuery).not.toHaveBeenCalled();
  });

  it("revalidates project identity again after executable resolution", async () => {
    let validations = 0;
    const createQuery = vi.fn(() => new FakeClaudeQuery().asQuery());
    const adapter = new ClaudeWorkerAdapter({
      assertContext: async () => {
        validations += 1;
        return validations === 1
          ? { root: task.sourceRoot, cwd: task.sourceCwd }
          : { root: task.sourceRoot, cwd: "/trusted/source/elsewhere" };
      },
      resolveExecutable: async () => "/owner/bin/claude",
      createQuery,
    });

    await expect(adapter.start(task, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    })).rejects.toThrow("project identity changed");
    expect(validations).toBe(2);
    expect(createQuery).not.toHaveBeenCalled();
  });

  it("preserves a native terminal failure when TaskManager cancellation races it", async () => {
    const temp = makeTempGhosts();
    try {
      temp.registry.ensureRoot();
      seedGhost(temp.root, { name: "casper" });
      const root = join(temp.root, "project");
      const cwd = join(root, "app");
      mkdirSync(cwd, { recursive: true });
      const query = new FakeClaudeQuery();
      const child = new FakeClaudeChild();
      query.onInterrupt = () => {
        query.push(resultMessage("error_during_execution", "native shutdown failed"));
        query.end();
      };
      const adapter = new ClaudeWorkerAdapter({
        assertContext: async ({ root: expectedRoot, cwd: expectedCwd }) => ({
          root: expectedRoot,
          cwd: expectedCwd,
        }),
        resolveExecutable: async () => "/owner/bin/claude",
        spawnWorker: () => child.asChild(),
        createQuery: (input) => {
          input.options.spawnClaudeCodeProcess?.({
            command: "/usr/bin/node",
            args: ["/owner/bin/claude", "--permission-mode", "bypassPermissions"],
            cwd,
            env: {},
            signal: new AbortController().signal,
          });
          void (async () => {
            for await (const _message of input.prompt) { /* drain native input */ }
          })();
          return query.asQuery();
        },
        timings: { interruptGraceMs: 0, terminalExitGraceMs: 0, termGraceMs: 0 },
      });
      const manager = new TaskManager({
        registry: temp.registry,
        adapters: [adapter],
        resolveContext: async () => ({ root, cwd }),
      });
      const created = await manager.create({
        ghostName: "casper",
        parent: conversationIdentity("pi", "conversation-1"),
        agent: "claude-code",
        task: "Implement the focused change.",
      });
      query.push(initMessage({ cwd }));
      await untilAsync(async () => (await manager.get("casper", created.id)).state === "running");

      await expect(manager.cancel("casper", created.id)).resolves.toMatchObject({
        outcome: "already_settled",
        task: {
          state: "failed",
          error: { code: "worker_failed", message: "native shutdown failed" },
        },
      });
    } finally {
      temp.cleanup();
    }
  });
});
