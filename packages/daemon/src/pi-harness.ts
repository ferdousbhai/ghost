import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  WorkerStoppedError,
  type WorkerAdapter,
  type WorkerTaskController,
  type WorkerTaskRequest,
} from "./tasks.js";
import { PI_BINARY_ENV, resolveHarnessExecutable } from "./harness-executable.js";

const INTERRUPT_GRACE_MS = 3_000;
const TERM_GRACE_MS = 5_000;
const TERMINAL_EXIT_GRACE_MS = 2_000;
const MAX_STDERR_LENGTH = 4_000;
const MAX_RPC_LINE_BYTES = 1024 * 1024;

type SpawnHarness = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;

interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiHarnessAdapterTimings {
  interruptGraceMs: number;
  terminalExitGraceMs: number;
  termGraceMs: number;
}

export interface PiHarnessAdapterOptions {
  env?: NodeJS.ProcessEnv;
  assertContext(input: { root: string; cwd: string }): Promise<{ root: string; cwd: string }>;
  resolveExecutable?: (configured: string) => Promise<string>;
  spawnHarness?: SpawnHarness;
  timings?: Partial<PiHarnessAdapterTimings>;
}

export class PiHarnessProcessError extends Error {
  override readonly name = "PiHarnessProcessError";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

function sameContext(
  expected: Pick<WorkerTaskRequest, "root" | "cwd">,
  actual: { root: string; cwd: string },
): boolean {
  return expected.root === actual.root && expected.cwd === actual.cwd;
}

function appendStderr(stderr: string, chunk: Buffer | string): string {
  return `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
}

function processError(message: string, stderr: string): PiHarnessProcessError {
  const detail = stderr.trim();
  return new PiHarnessProcessError(detail ? `${message} ${detail}` : message);
}

function response(value: unknown): RpcResponse | null {
  const record = asObject(value);
  if (record?.type !== "response" || typeof record.command !== "string"
    || typeof record.success !== "boolean"
    || (record.id !== undefined && typeof record.id !== "string")) return null;
  return record as unknown as RpcResponse;
}

function assistantText(value: unknown): string | null {
  const message = asObject(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = message.content.flatMap((part) => {
    const block = asObject(part);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("");
  return text || null;
}

function assistantFailure(value: unknown): string | null {
  const message = asObject(value);
  if (message?.role !== "assistant") return null;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return null;
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage
    : `Pi request ${String(message.stopReason)}.`;
}

/** One owner-installed Pi RPC process per durable delegated task. */
export class PiHarnessAdapter implements WorkerAdapter {
  readonly id = "pi" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly binary: string;
  private readonly assertContext: PiHarnessAdapterOptions["assertContext"];
  private readonly resolveExecutable: NonNullable<PiHarnessAdapterOptions["resolveExecutable"]>;
  private readonly spawnHarness: SpawnHarness;
  private readonly timings: PiHarnessAdapterTimings;

  constructor(options: PiHarnessAdapterOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.binary = this.env[PI_BINARY_ENV]?.trim() || "pi";
    this.assertContext = options.assertContext;
    this.resolveExecutable = options.resolveExecutable
      ?? ((configured) => resolveHarnessExecutable(configured, this.env));
    this.spawnHarness = options.spawnHarness ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions));
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
    const child = this.spawnHarness(executable, [
      "--mode",
      "rpc",
      "--approve",
      "--name",
      request.taskId,
    ], {
      cwd: request.cwd,
      env: this.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return this.control(child, request, context);
  }

  private async requireTaskContext(request: WorkerTaskRequest): Promise<void> {
    const source = { root: request.sourceRoot, cwd: request.sourceCwd };
    const validated = await this.assertContext(source);
    if (!sameContext(source, validated)) {
      throw new PiHarnessProcessError("The task project identity changed before Pi could start.");
    }
  }

  private async control(
    child: ChildProcessWithoutNullStreams,
    request: WorkerTaskRequest,
    context: Parameters<WorkerAdapter["start"]>[1],
  ): Promise<WorkerTaskController> {
    const result = Promise.withResolvers<{ text: string; nativeSessionId?: string }>();
    const exited = Promise.withResolvers<void>();
    const pending = new Map<string, Deferred<RpcResponse>>();
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let closed = false;
    let settled = false;
    let cancelled = false;
    let nativeSessionId: string | undefined;
    let lastMessage = "";
    let lastFailure: string | null = null;
    let terminalError: Error | undefined;
    let termination: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let eventChain = Promise.resolve();

    void result.promise.catch(() => {});
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendStderr(stderr, chunk);
    });

    const emit = (event: Parameters<typeof context.emit>[0]) => {
      const deliver = () => context.emit(event);
      eventChain = eventChain.then(deliver, deliver);
    };
    const waitForExitOr = async (milliseconds: number): Promise<boolean> => {
      if (closed) return true;
      return Promise.race([exited.promise.then(() => true), delay(milliseconds).then(() => false)]);
    };
    const terminate = (graceMs: number): Promise<void> => {
      termination ??= (async () => {
        if (closed || (graceMs > 0 && await waitForExitOr(graceMs))) return;
        child.kill("SIGTERM");
        if (await waitForExitOr(this.timings.termGraceMs)) return;
        child.kill("SIGKILL");
        await exited.promise;
      })();
      return termination;
    };
    const fail = (error: Error) => {
      terminalError ??= error;
      child.stdin.end();
      void terminate(0);
    };
    const sendRaw = (command: Record<string, unknown>): void => {
      if (closed || child.stdin.destroyed) throw new PiHarnessProcessError("Pi RPC is closed.");
      const line = `${JSON.stringify(command)}\n`;
      if (Buffer.byteLength(line) > MAX_RPC_LINE_BYTES) {
        throw new PiHarnessProcessError("Pi RPC command exceeded its line limit.");
      }
      child.stdin.write(line);
    };
    const call = (command: Record<string, unknown>): Promise<RpcResponse> => {
      const id = randomUUID();
      const deferred = Promise.withResolvers<RpcResponse>();
      pending.set(id, deferred);
      try {
        sendRaw({ ...command, id });
      } catch (error) {
        pending.delete(id);
        deferred.reject(error);
      }
      return deferred.promise;
    };
    const accept = async (command: Record<string, unknown>): Promise<RpcResponse> => {
      const reply = await call(command);
      if (!reply.success) {
        throw new PiHarnessProcessError(reply.error || `Pi rejected ${reply.command}.`);
      }
      return reply;
    };
    const handle = (value: unknown) => {
      const reply = response(value);
      if (reply) {
        if (!reply.id) return;
        const deferred = pending.get(reply.id);
        pending.delete(reply.id);
        deferred?.resolve(reply);
        return;
      }
      const event = asObject(value);
      if (!event || typeof event.type !== "string") {
        throw new PiHarnessProcessError("Pi emitted an invalid RPC event.");
      }
      if (event.type === "message_end") {
        const text = assistantText(event.message);
        if (text !== null) {
          lastMessage = text;
          emit({ type: "output", text });
        }
        lastFailure = assistantFailure(event.message);
        return;
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        emit({ type: "notice", text: `Pi started ${event.toolName}.` });
        return;
      }
      if (event.type === "auto_retry_start") {
        emit({ type: "notice", text: "Pi is retrying the provider request." });
        return;
      }
      if (event.type === "extension_error") {
        const message = typeof event.error === "string" ? event.error : "A Pi extension failed.";
        emit({ type: "notice", text: message });
        return;
      }
      if (event.type === "extension_ui_request" && typeof event.id === "string") {
        if (["select", "confirm", "input", "editor"].includes(String(event.method))) {
          sendRaw({ type: "extension_ui_response", id: event.id, cancelled: true });
        } else if (typeof event.message === "string") {
          emit({ type: "notice", text: event.message });
        }
        return;
      }
      if (event.type !== "agent_settled") return;
      settled = true;
      child.stdin.end();
      void terminate(this.timings.terminalExitGraceMs);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (terminalError) return;
      try {
        stdout += typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (Buffer.byteLength(stdout) > MAX_RPC_LINE_BYTES) {
          throw new PiHarnessProcessError("Pi RPC output exceeded its line limit.");
        }
        while (true) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          let line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line) handle(JSON.parse(line) as unknown);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdout.on("end", () => {
      if (terminalError) return;
      try {
        stdout += decoder.end();
        if (stdout.endsWith("\r")) stdout = stdout.slice(0, -1);
        if (stdout) handle(JSON.parse(stdout) as unknown);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    context.registerForce(() => {
      if (!closed) child.kill("SIGKILL");
    });
    child.once("error", (error) => fail(new PiHarnessProcessError(error.message)));
    child.once("close", (code, signal) => {
      closed = true;
      exited.resolve();
      const stopped = terminalError ?? processError(
        `Pi exited${signal ? ` on ${signal}` : ` with code ${code ?? "unknown"}`}.`,
        stderr,
      );
      for (const deferred of pending.values()) deferred.reject(stopped);
      pending.clear();
      const finish = () => {
        if (terminalError) result.reject(processError(terminalError.message, stderr));
        else if (cancelled && !settled) result.reject(new PiHarnessProcessError("Pi was interrupted."));
        else if (!settled) result.reject(stopped);
        else if (lastFailure !== null) result.reject(processError(lastFailure, stderr));
        else result.resolve({
          text: lastMessage,
          ...(nativeSessionId ? { nativeSessionId } : {}),
        });
      };
      void eventChain.then(finish, finish);
    });

    const cancel = (): Promise<void> => {
      cancellation ??= (async () => {
        cancelled = true;
        let abortAcknowledged = false;
        if (!closed && !settled) {
          try {
            abortAcknowledged = await Promise.race([
              accept({ type: "abort" }).then(() => true),
              delay(this.timings.interruptGraceMs).then(() => false),
            ]);
          } catch {
            // Captured-process teardown remains the cancellation confirmation.
          }
        }
        child.stdin.end();
        await terminate(abortAcknowledged ? this.timings.interruptGraceMs : 0);
        if (terminalError) throw new WorkerStoppedError(terminalError.message);
        try {
          await result.promise;
        } catch {
          // Native abort/termination is the expected cancellation outcome.
        }
      })();
      return cancellation;
    };
    const cancelFromSignal = () => void cancel().catch(() => {});
    context.signal.addEventListener("abort", cancelFromSignal, { once: true });
    if (context.signal.aborted) cancelFromSignal();

    try {
      const state = await accept({ type: "get_state" });
      const data = asObject(state.data);
      if (!data || typeof data.sessionId !== "string" || !data.sessionId) {
        throw new PiHarnessProcessError("Pi `get_state` returned no session id.");
      }
      nativeSessionId = data.sessionId;
      emit({ type: "notice", text: "Pi started with native configuration and maximum project trust." });
      await accept({
        type: "prompt",
        message: request.task,
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      await exited.promise;
      throw terminalError;
    }

    return {
      nativeSessionId,
      result: result.promise,
      send: (text) => accept({ type: "steer", message: text }).then(() => undefined),
      cancel,
    };
  }
}
