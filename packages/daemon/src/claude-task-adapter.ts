import type { ChildProcess } from "node:child_process";
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "./claude-agent-sdk-loader.js";
import { captureNativeHarnessEnvironment } from "./env-scrub.js";
import type { NativeHarnessProbeResult } from "./native-harness-catalog.js";
import { NativeTaskProcessError } from "./native-task-jsonl.js";
import type {
  TaskAdapter,
  TaskAdapterContext,
  TaskAdapterHandle,
  TaskBindingReceipt,
} from "./tasks.js";

const MAX_CLAUDE_INPUT_QUEUE = 32;
const MAX_CLAUDE_SESSION_ID_BYTES = 2_048;

interface ClaudeStartCatalog {
  readForStart(id: "claude-code", signal: AbortSignal): Promise<NativeHarnessProbeResult>;
}

export interface ClaudeTaskAdapterOptions {
  catalog: ClaudeStartCatalog;
  sdkLoader: ClaudeAgentSdkLoader;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

interface PendingInput {
  message: SDKUserMessage;
  delivered: ReturnType<typeof deferred<void>>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function failure(): NativeTaskProcessError {
  return new NativeTaskProcessError("Claude delegated task failed.");
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value) <= MAX_CLAUDE_SESSION_ID_BYTES;
}

class ClaudeTaskInput implements AsyncIterable<SDKUserMessage> {
  private readonly queued: PendingInput[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(text: string): Promise<void> {
    if (this.closed || this.queued.length >= MAX_CLAUDE_INPUT_QUEUE) {
      return Promise.reject(failure());
    }
    const delivered = deferred<void>();
    const pending: PendingInput = {
      delivered,
      message: {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        priority: "now",
      },
    };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      delivered.resolve();
      waiter({ done: false, value: pending.message });
    } else {
      this.queued.push(pending);
    }
    return delivered.promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = failure();
    for (const pending of this.queued.splice(0)) pending.delivered.reject(error);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const pending = this.queued.shift();
        if (pending) {
          pending.delivered.resolve();
          return Promise.resolve({ done: false, value: pending.message });
        }
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          if (this.waiter) throw failure();
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

class ClaudeTaskLifecycle {
  readonly signal: AbortSignal;
  readonly quiescence: Promise<void>;
  readonly spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => SpawnedProcess;
  readonly abortController = new AbortController();

  private readonly quiet = deferred<void>();
  private readonly cwd: string;
  private readonly input: ClaudeTaskInput;
  private readonly scope: TaskAdapterContext["scope"];
  private executable: string | undefined;
  private query: Query | undefined;
  private child: ChildProcess | undefined;
  private teardown: Promise<void> | undefined;
  private spawned = false;
  private forceRequested = false;

  constructor(
    context: TaskAdapterContext,
    input: ClaudeTaskInput,
    cwd: string,
  ) {
    this.input = input;
    this.cwd = cwd;
    this.scope = context.scope;
    this.signal = this.abortController.signal;
    this.quiescence = this.quiet.promise;
    this.spawnClaudeCodeProcess = (options) => this.spawn(options);
    context.register({ force: () => this.force(), quiescence: this.quiescence });
    const abort = () => { void this.force().catch(() => undefined); };
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    void this.quiescence.then(
      () => context.signal.removeEventListener("abort", abort),
      () => context.signal.removeEventListener("abort", abort),
    );
  }

  bindExecutable(executable: string): void {
    if (this.executable || this.signal.aborted) throw failure();
    this.executable = executable;
  }

  assertActive(): void {
    if (this.signal.aborted) throw failure();
  }

  attach(query: Query): void {
    if (this.query || this.signal.aborted) throw failure();
    this.query = query;
  }

  force(): Promise<void> {
    if (!this.forceRequested) {
      this.forceRequested = true;
      this.input.close();
      if (this.query) {
        void this.query.interrupt().catch(() => undefined);
      }
      this.abortController.abort();
      if (this.query) {
        try { this.query.close(); } catch { /* exact scope teardown remains authoritative */ }
      }
    }
    return this.stop();
  }

  finish(): Promise<void> {
    this.input.close();
    if (this.query) {
      try { this.query.close(); } catch { /* exact scope teardown remains authoritative */ }
    }
    return this.stop();
  }

  private spawn(options: ClaudeSpawnOptions): SpawnedProcess {
    if (this.spawned
      || this.signal.aborted
      || this.executable === undefined
      || options.command !== this.executable
      || options.cwd !== this.cwd
      || process.platform !== "linux") {
      throw failure();
    }
    this.spawned = true;
    let child: ChildProcess;
    try {
      child = this.scope.spawn({
        executable: options.command,
        args: options.args,
        cwd: options.cwd,
        environment: options.env,
        signal: options.signal,
        stderr: "ignore",
      });
    } catch {
      throw failure();
    }
    this.child = child;
    child.stdin?.on("error", () => undefined);
    child.once("error", () => { void this.stop().catch(() => undefined); });
    child.once("exit", () => { void this.stop().catch(() => undefined); });
    return child as SpawnedProcess;
  }

  private stop(): Promise<void> {
    if (this.teardown) return this.teardown;
    const child = this.child;
    this.teardown = (async () => {
      try {
        await this.scope.stopAndConfirm();
      } catch {
        throw failure();
      } finally {
        child?.stdin?.destroy();
        child?.stdout?.destroy();
      }
    })();
    void this.teardown.then(this.quiet.resolve, (error) => this.quiet.reject(error));
    return this.teardown;
  }
}

export class ClaudeTaskAdapter implements TaskAdapter {
  private readonly catalog: ClaudeStartCatalog;
  private readonly sdkLoader: ClaudeAgentSdkLoader;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(options: ClaudeTaskAdapterOptions) {
    if (!options?.catalog) throw new TypeError("Claude task adapter requires a native catalogue.");
    if (!(options.sdkLoader instanceof ClaudeAgentSdkLoader)) {
      throw new TypeError("Claude task adapter requires the principal SDK loader.");
    }
    this.catalog = options.catalog;
    this.sdkLoader = options.sdkLoader;
    this.environment = captureNativeHarnessEnvironment(
      "claude-native",
      options.environment ?? process.env,
    );
  }

  start(
    input: Readonly<{
      id: string;
      task: string;
      agent?: string | null;
      cwd: string;
      binding: TaskBindingReceipt;
    }>,
    context: TaskAdapterContext,
  ): Promise<TaskAdapterHandle> {
    const channel = new ClaudeTaskInput();
    const lifecycle = new ClaudeTaskLifecycle(
      context,
      channel,
      input.cwd,
    );
    return this.startRegistered(input, lifecycle, channel);
  }

  private async startRegistered(
    input: Readonly<{ task: string; agent?: string | null; cwd: string }>,
    lifecycle: ClaudeTaskLifecycle,
    channel: ClaudeTaskInput,
  ): Promise<TaskAdapterHandle> {
    try {
      const admitted = await this.catalog.readForStart("claude-code", lifecycle.signal);
      if (admitted.id !== "claude-code") throw failure();
      lifecycle.bindExecutable(admitted.executable.path);
      const sdk = await this.sdkLoader.load(lifecycle.signal);
      lifecycle.assertActive();
      return await this.openQuery(input, admitted, sdk, lifecycle, channel);
    } catch {
      channel.close();
      await lifecycle.force().catch(() => undefined);
      throw failure();
    }
  }

  private async openQuery(
    input: Readonly<{ task: string; agent?: string | null; cwd: string }>,
    admitted: NativeHarnessProbeResult,
    sdk: ClaudeAgentSdkModule,
    lifecycle: ClaudeTaskLifecycle,
    channel: ClaudeTaskInput,
  ): Promise<TaskAdapterHandle> {
    // The lifecycle must bind the exact admitted path before query() can call
    // its synchronous process-spawn callback.
    lifecycle.assertActive();
    const initial = channel.push(input.task);
    void initial.catch(() => undefined);
    let query: Query | undefined;
    try {
      const options: ClaudeQueryOptions = {
        cwd: input.cwd,
        pathToClaudeCodeExecutable: admitted.executable.path,
        env: this.environment,
        abortController: lifecycle.abortController,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        spawnClaudeCodeProcess: lifecycle.spawnClaudeCodeProcess,
        ...(input.agent ? { agent: input.agent } : {}),
      };
      query = sdk.query({ prompt: channel, options });
      lifecycle.attach(query);
    } catch {
      try { query?.close(); } catch { /* exact scope teardown remains authoritative */ }
      channel.close();
      await lifecycle.force().catch(() => undefined);
      throw failure();
    }

    const initialized = deferred<void>();
    void initialized.promise.catch(() => undefined);
    let terminal = false;
    const result = (async () => {
      let sessionId: string | undefined;
      try {
        for await (const message of query as AsyncIterable<SDKMessage>) {
          if (message.type === "system" && message.subtype === "init") {
            if (sessionId
              || message.cwd !== input.cwd
              || message.permissionMode !== "bypassPermissions"
              || !validSessionId(message.session_id)) {
              throw failure();
            }
            sessionId = message.session_id;
            initialized.resolve();
            continue;
          }
          if (message.type !== "result") continue;
          if (terminal
            || !sessionId
            || message.session_id !== sessionId
            || message.subtype !== "success"
            || message.is_error
            || typeof message.result !== "string") {
            throw failure();
          }
          terminal = true;
          channel.close();
          await lifecycle.finish();
          return message.result;
        }
        throw failure();
      } catch {
        initialized.reject(failure());
        channel.close();
        await lifecycle.force().catch(() => undefined);
        throw failure();
      }
    })();
    void result.catch(() => undefined);
    await initialized.promise;
    await initial;
    return {
      result,
      async followUp(message: string): Promise<void> {
        if (terminal) throw failure();
        await channel.push(message);
      },
    };
  }
}
