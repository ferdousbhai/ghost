import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  query,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SpawnOptions as ClaudeSpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_CODE_BINARY_ENV,
  resolveClaudeCodeExecutable,
} from "./claude-code.js";
import {
  WorkerStoppedError,
  type WorkerAdapter,
  type WorkerTaskController,
  type WorkerTaskRequest,
} from "./tasks.js";

const INTERRUPT_GRACE_MS = 3_000;
const TERM_GRACE_MS = 5_000;
const TERMINAL_EXIT_GRACE_MS = 2_000;
const MAX_NATIVE_SESSION_ID_LENGTH = 2_000;
const MAX_STDERR_LENGTH = 4_000;

type SpawnWorker = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

const defaultSpawnWorker: SpawnWorker = (command, args, options) =>
  spawn(command, [...args], options);

export interface ClaudeWorkerAdapterTimings {
  interruptGraceMs: number;
  terminalExitGraceMs: number;
  termGraceMs: number;
}

export interface ClaudeWorkerQueryInput {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}

export type ClaudeWorkerQueryFactory = (input: ClaudeWorkerQueryInput) => Query;

export interface ClaudeWorkerAdapterOptions {
  env?: NodeJS.ProcessEnv;
  assertContext(input: { root: string; cwd: string }): Promise<{ root: string; cwd: string }>;
  resolveExecutable?: (configured: string) => Promise<string>;
  createQuery?: ClaudeWorkerQueryFactory;
  spawnWorker?: SpawnWorker;
  timings?: Partial<ClaudeWorkerAdapterTimings>;
}

export class ClaudeWorkerProcessError extends Error {
  override readonly name = "ClaudeWorkerProcessError";
}

interface PendingInput {
  id: string;
  message: SDKUserMessage;
  accepted: Deferred<void>;
}

interface CapturedClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  closed: boolean;
  stderr: string;
}

type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

function appendStderr(stderr: string, chunk: Buffer | string): string {
  return `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
}

function withStderr(error: Error, stderr: string): Error {
  const detail = stderr.trim();
  return detail
    ? new ClaudeWorkerProcessError(`${error.message} ${detail}`, { cause: error })
    : error;
}

function sameContext(
  expected: Pick<WorkerTaskRequest, "root" | "cwd">,
  actual: { root: string; cwd: string },
): boolean {
  return expected.root === actual.root && expected.cwd === actual.cwd;
}

function userMessage(text: string, id: ReturnType<typeof randomUUID>): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    priority: "now",
    uuid: id,
  };
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NATIVE_SESSION_ID_LENGTH;
}

function assistantText(message: SDKMessage): string | null {
  if (message.type !== "assistant" || message.parent_tool_use_id !== null) return null;
  const text = message.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text || null;
}

function resultError(result: SDKResultMessage): Error {
  const detail = result.subtype === "success"
    ? ""
    : result.errors.map((error) => error.trim()).filter(Boolean).join(" ");
  return new ClaudeWorkerProcessError(
    detail || `Claude Code ended with ${result.subtype.replaceAll("_", " ")}.`,
  );
}

/** Async input accepted by the SDK transport, with a priority close for cancellation. */
class ClaudeWorkerInput implements AsyncIterable<SDKUserMessage> {
  private readonly queued: PendingInput[] = [];
  private readonly awaitingReplay = new Map<string, Deferred<void>>();
  private waiter?: (value: IteratorResult<SDKUserMessage>) => void;
  private sealed = false;
  private failure?: Error;

  send(text: string): Promise<void> {
    if (this.sealed) {
      return Promise.reject(this.failure ?? new ClaudeWorkerProcessError(
        "Claude Code is not accepting task messages.",
      ));
    }
    const id = randomUUID();
    const pending: PendingInput = {
      id,
      message: userMessage(text, id),
      accepted: Promise.withResolvers<void>(),
    };
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      this.awaitingReplay.set(pending.id, pending.accepted);
      waiter({ done: false, value: pending.message });
    } else this.queued.push(pending);
    return pending.accepted.promise;
  }

  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.finishIfDrained();
  }

  abort(error: Error): void {
    if (this.sealed && this.failure) return;
    this.sealed = true;
    this.failure = error;
    for (const pending of this.queued.splice(0)) pending.accepted.reject(error);
    for (const accepted of this.awaitingReplay.values()) accepted.reject(error);
    this.awaitingReplay.clear();
    this.finishIfDrained();
  }

  acknowledge(id: string): void {
    const accepted = this.awaitingReplay.get(id);
    if (!accepted) return;
    this.awaitingReplay.delete(id);
    accepted.resolve(undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const pending = this.queued.shift();
        if (pending) {
          this.awaitingReplay.set(pending.id, pending.accepted);
          this.finishIfDrained();
          return Promise.resolve({ done: false, value: pending.message });
        }
        if (this.sealed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKUserMessage>>((resolvePromise) => {
          this.waiter = resolvePromise;
        });
      },
      return: async () => {
        this.seal();
        return { done: true, value: undefined };
      },
    };
  }

  private finishIfDrained(): void {
    if (!this.sealed || this.queued.length > 0 || !this.waiter) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter({ done: true, value: undefined });
  }
}

/** One installed, native Claude Code query per durable delegated task. */
export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly id = "claude-code" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly binary: string;
  private readonly assertContext: ClaudeWorkerAdapterOptions["assertContext"];
  private readonly resolveExecutable: NonNullable<ClaudeWorkerAdapterOptions["resolveExecutable"]>;
  private readonly createQuery: ClaudeWorkerQueryFactory;
  private readonly spawnWorker: SpawnWorker;
  private readonly timings: ClaudeWorkerAdapterTimings;

  constructor(options: ClaudeWorkerAdapterOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.binary = this.env[CLAUDE_CODE_BINARY_ENV]?.trim() || "claude";
    this.assertContext = options.assertContext;
    this.resolveExecutable = options.resolveExecutable
      ?? ((configured) => resolveClaudeCodeExecutable(configured, this.env));
    this.createQuery = options.createQuery
      ?? ((input) => query({ prompt: input.prompt, options: input.options }));
    this.spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    this.timings = {
      interruptGraceMs: options.timings?.interruptGraceMs ?? INTERRUPT_GRACE_MS,
      terminalExitGraceMs: options.timings?.terminalExitGraceMs ?? TERMINAL_EXIT_GRACE_MS,
      termGraceMs: options.timings?.termGraceMs ?? TERM_GRACE_MS,
    };
  }

  async start(
    request: WorkerTaskRequest,
    context: Parameters<WorkerAdapter["start"]>[1],
  ): Promise<WorkerTaskController> {
    await this.requireTaskContext(request);
    const executable = await this.resolveExecutable(this.binary);
    await this.requireTaskContext(request);
    const input = new ClaudeWorkerInput();
    void input.send(request.task).catch(() => {});
    let captured: CapturedClaudeProcess | undefined;
    let forceRequested = false;
    const spawnClaudeCodeProcess = (options: ClaudeSpawnOptions): SpawnedProcess => {
      if (captured) {
        throw new ClaudeWorkerProcessError("Claude Code attempted to spawn a second task process.");
      }
      const child = this.spawnWorker(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = Promise.withResolvers<void>();
      const capture: CapturedClaudeProcess = {
        child,
        exited: exited.promise,
        closed: false,
        stderr: "",
      };
      captured = capture;
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer | string) => {
        capture.stderr = appendStderr(capture.stderr, chunk);
      });
      child.once("close", () => {
        capture.closed = true;
        exited.resolve();
      });
      if (forceRequested) child.kill("SIGKILL");
      return child;
    };

    let runtime: Query;
    try {
      runtime = this.createQuery({
        prompt: input,
        options: {
          cwd: request.cwd,
          ...(request.agent === null ? {} : { agent: request.agent }),
          pathToClaudeCodeExecutable: executable,
          env: this.env,
          extraArgs: { "replay-user-messages": null },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          canUseTool: async (_toolName, toolInput) => ({
            behavior: "allow",
            updatedInput: toolInput,
          }),
          onElicitation: async () => ({ action: "decline" }),
          spawnClaudeCodeProcess,
        },
      });
    } catch (cause) {
      const error = new ClaudeWorkerProcessError("Failed to start the Claude Code task.", {
        cause,
      });
      input.abort(error);
      throw error;
    }
    return this.control(
      runtime,
      input,
      request,
      context,
      () => captured,
      () => {
        forceRequested = true;
        captured?.child.kill("SIGKILL");
      },
    );
  }

  private async control(
    runtime: Query,
    input: ClaudeWorkerInput,
    request: WorkerTaskRequest,
    context: Parameters<WorkerAdapter["start"]>[1],
    capturedProcess: () => CapturedClaudeProcess | undefined,
    forceCapturedProcess: () => void,
  ): Promise<WorkerTaskController> {
    const initialized = Promise.withResolvers<string>();
    const result = Promise.withResolvers<{ text: string; nativeSessionId?: string }>();
    let nativeSessionId: string | undefined;
    let terminal: SDKResultMessage | undefined;
    let nativeFailure: Error | undefined;
    let stopReason: "cancelled" | "forced" | undefined;
    let accepting = true;
    let consumeSettled = false;
    let cancellation: Promise<void> | undefined;
    let termination: Promise<void> | undefined;
    let eventChain = Promise.resolve();

    void initialized.promise.catch(() => {});
    void result.promise.catch(() => {});
    const emit = (event: Parameters<typeof context.emit>[0]) => {
      const deliver = () => context.emit(event);
      eventChain = eventChain.then(deliver, deliver);
    };
    const stopError = () => new ClaudeWorkerProcessError(
      stopReason === "forced"
        ? "Claude Code task was force-closed."
        : "Claude Code task was interrupted.",
    );
    const waitForExitOr = async (milliseconds: number): Promise<boolean> => {
      const captured = capturedProcess();
      if (!captured || captured.closed) return true;
      return Promise.race([
        captured.exited.then(() => true),
        delay(milliseconds).then(() => false),
      ]);
    };
    const terminate = (graceMs: number): Promise<void> => {
      termination ??= (async () => {
        runtime.close();
        const captured = capturedProcess();
        if (!captured || await waitForExitOr(graceMs)) return;
        captured.child.kill("SIGTERM");
        if (await waitForExitOr(this.timings.termGraceMs)) return;
        captured.child.kill("SIGKILL");
        await captured.exited;
      })();
      return termination;
    };
    const force = () => {
      if (consumeSettled) return;
      stopReason = "forced";
      accepting = false;
      input.abort(stopError());
      runtime.close();
      forceCapturedProcess();
    };
    context.registerForce(force);

    const consume = (async () => {
      try {
        for await (const message of runtime) {
          if (message.type === "system" && message.subtype === "init") {
            if (nativeSessionId) {
              throw new ClaudeWorkerProcessError("Claude Code initialized more than once.");
            }
            if (!capturedProcess()) {
              throw new ClaudeWorkerProcessError(
                "Claude Code initialized without a captured task process.",
              );
            }
            nativeSessionId = this.acceptInitialization(message, request, emit);
            initialized.resolve(nativeSessionId);
            continue;
          }
          const output = assistantText(message);
          if (output !== null) emit({ type: "output", text: output });
          if (message.type === "user" && "isReplay" in message
            && message.isReplay === true && message.uuid) {
            input.acknowledge(message.uuid);
          }
          if (message.type === "system" && message.subtype === "permission_denied") {
            emit({
              type: "notice",
              text: `Claude Code denied a ${message.tool_name} request under a native hook or safety policy despite maximum trust.`,
            });
          }
          if (message.type === "tool_use_summary" && message.summary.trim()) {
            emit({ type: "notice", text: message.summary });
          }
          if (message.type !== "result") continue;
          if (terminal) {
            throw new ClaudeWorkerProcessError("Claude Code returned more than one terminal result.");
          }
          if (!nativeSessionId || message.session_id !== nativeSessionId) {
            throw new ClaudeWorkerProcessError(
              "Claude Code returned a terminal result for a different native session.",
            );
          }
          terminal = message;
          accepting = false;
          input.abort(new ClaudeWorkerProcessError(
            "Claude Code ended before accepting this task message.",
          ));
          break;
        }
        if (!nativeSessionId) {
          throw new ClaudeWorkerProcessError("Claude Code ended before native initialization.");
        }
        if (!terminal && !stopReason) {
          throw new ClaudeWorkerProcessError("Claude Code ended without a terminal result.");
        }
      } catch (error) {
        if (!stopReason) nativeFailure = asError(error);
        initialized.reject(nativeFailure ?? stopError());
      } finally {
        accepting = false;
        input.abort(nativeFailure ?? new ClaudeWorkerProcessError(
          "Claude Code is no longer accepting task messages.",
        ));
        await terminate(this.timings.terminalExitGraceMs);
        consumeSettled = true;
        await eventChain.catch(() => {});

        if (terminal?.subtype === "success" && !terminal.is_error) {
          result.resolve({ text: terminal.result, nativeSessionId: terminal.session_id });
        } else if (terminal) {
          result.reject(withStderr(resultError(terminal), capturedProcess()?.stderr ?? ""));
        } else {
          result.reject(withStderr(nativeFailure ?? stopError(), capturedProcess()?.stderr ?? ""));
        }
      }
    })();
    void consume.catch(() => {});

    const cancel = (): Promise<void> => {
      cancellation ??= (async () => {
        if (!consumeSettled && !terminal) {
          stopReason = "cancelled";
          accepting = false;
          input.abort(stopError());
          try {
            await runtime.interrupt();
          } catch {
            // Closing the exact captured query remains the stop confirmation.
          }
          if (!consumeSettled) {
            await Promise.race([consume, delay(this.timings.interruptGraceMs)]);
          }
          if (!consumeSettled) await terminate(0);
        }
        await consume;
        if (terminal && (terminal.subtype !== "success" || terminal.is_error)) {
          throw new WorkerStoppedError(withStderr(
            resultError(terminal),
            capturedProcess()?.stderr ?? "",
          ).message);
        }
        if (nativeFailure && !stopReason) throw new WorkerStoppedError(nativeFailure.message);
        try {
          await result.promise;
        } catch {
          // Interrupted/closed is the expected cancellation result.
        }
      })();
      return cancellation;
    };
    const cancelFromSignal = () => void cancel().catch(() => {});
    context.signal.addEventListener("abort", cancelFromSignal, { once: true });
    if (context.signal.aborted) cancelFromSignal();

    try {
      nativeSessionId = await initialized.promise;
    } catch (error) {
      await consume;
      throw error;
    }

    const send = async (text: string) => {
      if (!accepting || terminal || nativeFailure || stopReason) {
        throw new ClaudeWorkerProcessError("Claude Code is not accepting task messages.");
      }
      await input.send(text);
    };

    return { nativeSessionId, result: result.promise, send, cancel };
  }

  private async requireTaskContext(request: WorkerTaskRequest): Promise<void> {
    const source = { root: request.sourceRoot, cwd: request.sourceCwd };
    const validated = await this.assertContext(source);
    if (!sameContext(source, validated)) {
      throw new ClaudeWorkerProcessError(
        "The task project identity changed before Claude Code could start.",
      );
    }
  }

  private acceptInitialization(
    message: SDKSystemMessage,
    request: WorkerTaskRequest,
    emit: (event: Parameters<Parameters<WorkerAdapter["start"]>[1]["emit"]>[0]) => void,
  ): string {
    if (message.cwd !== request.cwd || !validSessionId(message.session_id)
      || message.permissionMode !== "bypassPermissions") {
      throw new ClaudeWorkerProcessError(
        "Claude Code initialized with incompatible project or maximum-trust execution state.",
      );
    }
    const skills = message.skills?.length ?? 0;
    const plugins = message.plugins?.length ?? 0;
    const mcp = message.mcp_servers?.length ?? 0;
    emit({
      type: "notice",
      text: `Claude Code started with native configuration and maximum trust (${message.model}; ${skills} skills; ${plugins} plugins; ${mcp} MCP servers).`,
    });
    if (request.agent !== null) {
      emit({
        type: "notice",
        text: `Claude Code selected native agent ${JSON.stringify(request.agent)} through its Agent SDK.`,
      });
    }
    return message.session_id;
  }
}
