import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { GhostRegistry } from "./ghosts.js";
import {
  encodePiWorkerLine,
  parsePiWorkerEvent,
  parsePiWorkerLine,
  PI_WORKER_MAX_LINE_BYTES,
  PI_WORKER_PROTOCOL_VERSION,
  type PiWorkerEvent,
} from "./pi-worker-protocol.js";
import {
  WorkerStoppedError,
  type WorkerAdapter,
  type WorkerTaskController,
  type WorkerTaskRequest,
} from "./tasks.js";

const CANCEL_PROTOCOL_GRACE_MS = 3_000;
const TERM_GRACE_MS = 5_000;
const RESULT_EXIT_GRACE_MS = 2_000;
const MAX_STDERR_LENGTH = 4_000;

export interface GhostdInvocation {
  command: string;
  args: string[];
}

type SpawnWorker = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface PiWorkerAdapterOptions {
  registry: GhostRegistry;
  offline?: boolean;
  assertContext(input: { root: string; cwd: string }): Promise<{ root: string; cwd: string }>;
  invocation?: () => GhostdInvocation;
  spawnWorker?: SpawnWorker;
  timings?: Partial<PiWorkerAdapterTimings>;
}

export interface PiWorkerAdapterTimings {
  cancelProtocolGraceMs: number;
  resultExitGraceMs: number;
  termGraceMs: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

export function ghostdWorkerInvocation(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): GhostdInvocation {
  const currentScript = argv[1];
  const virtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !virtualScript && existsSync(currentScript)) {
    return { command: execPath, args: [currentScript, "worker-pi"] };
  }
  const executable = basename(execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/u.test(executable)) {
    return { command: execPath, args: ["worker-pi"] };
  }
  throw new Error("Cannot locate the current ghostd program for pi-worker.");
}

function sameContext(
  expected: Pick<WorkerTaskRequest, "root" | "cwd">,
  actual: { root: string; cwd: string },
): boolean {
  return expected.root === actual.root && expected.cwd === actual.cwd;
}

function workerError(message: string, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(detail ? `${message} ${detail}` : message);
}

/** The bundled Pi adapter: one captured child process per durable worker task. */
export class PiWorkerAdapter implements WorkerAdapter {
  readonly id = "pi-worker" as const;
  private readonly registry: GhostRegistry;
  private readonly offline: boolean;
  private readonly assertContext: PiWorkerAdapterOptions["assertContext"];
  private readonly invocation: NonNullable<PiWorkerAdapterOptions["invocation"]>;
  private readonly spawnWorker: SpawnWorker;
  private readonly timings: PiWorkerAdapterTimings;

  constructor(options: PiWorkerAdapterOptions) {
    this.registry = options.registry;
    this.offline = options.offline ?? false;
    this.assertContext = options.assertContext;
    this.invocation = options.invocation ?? ghostdWorkerInvocation;
    this.spawnWorker = options.spawnWorker ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions));
    this.timings = {
      cancelProtocolGraceMs: options.timings?.cancelProtocolGraceMs ?? CANCEL_PROTOCOL_GRACE_MS,
      resultExitGraceMs: options.timings?.resultExitGraceMs ?? RESULT_EXIT_GRACE_MS,
      termGraceMs: options.timings?.termGraceMs ?? TERM_GRACE_MS,
    };
  }

  async start(
    request: WorkerTaskRequest,
    context: Parameters<WorkerAdapter["start"]>[1],
  ): Promise<WorkerTaskController> {
    const validated = await this.assertContext({ root: request.root, cwd: request.cwd });
    if (!sameContext(request, validated)) {
      throw new Error("The task project identity changed before pi-worker could start.");
    }
    const ghost = this.registry.get(request.ghostName);
    const invocation = this.invocation();
    const child = this.spawnWorker(invocation.command, invocation.args, {
      cwd: request.cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const controlled = this.controlChild(child, request, ghost.dir, context);
    const nativeSessionId = await controlled.ready;
    return { ...controlled.controller, nativeSessionId };
  }

  private controlChild(
    child: ChildProcessWithoutNullStreams,
    request: WorkerTaskRequest,
    ghostHome: string,
    context: Parameters<WorkerAdapter["start"]>[1],
  ): { controller: WorkerTaskController; ready: Promise<string> } {
    const result = Promise.withResolvers<{ text: string; nativeSessionId?: string }>();
    const started = Promise.withResolvers<string>();
    const exited = Promise.withResolvers<void>();
    const acknowledgements = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    let terminal: Extract<PiWorkerEvent, { type: "result" | "cancelled" | "error" }> | undefined;
    let stderr = "";
    let closed = false;
    let termination: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let eventChain = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    let stdout = "";

    const appendStderr = (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
    };
    child.stderr.on("data", appendStderr);

    const failAcknowledgements = (error: Error) => {
      for (const pending of acknowledgements.values()) pending.reject(error);
      acknowledgements.clear();
    };
    void started.promise.catch(() => {});
    void result.promise.catch(() => {});

    const waitForExitOr = async (milliseconds: number): Promise<boolean> => {
      if (closed) return true;
      return Promise.race([
        exited.promise.then(() => true),
        delay(milliseconds).then(() => false),
      ]);
    };

    const terminateCapturedChild = (protocolGraceMs: number): Promise<void> => {
      termination ??= (async () => {
        if (closed || (protocolGraceMs > 0 && await waitForExitOr(protocolGraceMs))) return;
        child.kill("SIGTERM");
        if (await waitForExitOr(this.timings.termGraceMs)) return;
        child.kill("SIGKILL");
        await exited.promise;
      })();
      return termination;
    };

    const queueEvent = (type: "output" | "notice", text: string) => {
      const emit = () => context.emit({ type, text });
      eventChain = eventChain.then(emit, emit);
    };

    const onEvent = (event: PiWorkerEvent) => {
      if (terminal) return;
      switch (event.type) {
        case "started":
          started.resolve(event.sessionId);
          break;
        case "output":
        case "notice":
          queueEvent(event.type, event.text);
          break;
        case "ack": {
          const pending = acknowledgements.get(event.requestId);
          acknowledgements.delete(event.requestId);
          pending?.resolve();
          break;
        }
        case "error": {
          if (event.requestId) {
            const pending = acknowledgements.get(event.requestId);
            acknowledgements.delete(event.requestId);
            pending?.reject(new Error(event.message));
          } else {
            terminal = event;
            child.stdin.end();
            void terminateCapturedChild(this.timings.resultExitGraceMs);
          }
          break;
        }
        case "result":
        case "cancelled":
          terminal = event;
          child.stdin.end();
          void terminateCapturedChild(this.timings.resultExitGraceMs);
          break;
      }
    };

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      let event: PiWorkerEvent | null = null;
      try {
        event = parsePiWorkerEvent(parsePiWorkerLine(line));
      } catch {
        queueEvent("notice", line.slice(0, 4_000));
        return;
      }
      if (event) onEvent(event);
      else if (!terminal) queueEvent("notice", line.slice(0, 4_000));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += decoder.write(chunk);
      if (Buffer.byteLength(stdout) > PI_WORKER_MAX_LINE_BYTES && !stdout.includes("\n")) {
        terminal = {
          protocol: PI_WORKER_PROTOCOL_VERSION,
          type: "error",
          message: "Pi worker emitted an oversized protocol line.",
        };
        stdout = "";
        child.stdout.pause();
        child.stdin.end();
        void terminateCapturedChild(0);
        return;
      }
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        consumeLine(line);
        newline = stdout.indexOf("\n");
      }
    });

    child.once("error", (error) => {
      terminal ??= {
        protocol: PI_WORKER_PROTOCOL_VERSION,
        type: "error",
        message: error.message,
      };
      void terminateCapturedChild(0);
    });
    child.once("close", (code, signal) => {
      closed = true;
      exited.resolve();
      const tail = stdout + decoder.end();
      stdout = "";
      if (tail.trim()) consumeLine(tail);
      const stopped = workerError(
        `Pi worker exited${signal ? ` on ${signal}` : ` with code ${code ?? "unknown"}`}.`,
        stderr,
      );
      const startupFailure = terminal?.type === "error"
        ? new WorkerStoppedError(workerError(terminal.message, stderr).message)
        : stopped;
      failAcknowledgements(stopped);
      const settle = () => {
        started.reject(startupFailure);
        if (terminal?.type === "result") {
          result.resolve({ text: terminal.text, nativeSessionId: terminal.sessionId });
        } else if (terminal?.type === "error") {
          result.reject(workerError(terminal.message, stderr));
        } else if (terminal?.type === "cancelled") {
          result.reject(new Error("Pi worker was cancelled."));
        } else {
          result.reject(stopped);
        }
      };
      void eventChain.then(settle, settle);
    });

    child.stdin.on("error", () => {});
    child.stdin.write(encodePiWorkerLine({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "start",
      ghostHome,
      taskId: request.taskId,
      root: request.root,
      cwd: request.cwd,
      task: request.task,
      offline: this.offline,
    }));

    const writeRequest = (value: Parameters<typeof encodePiWorkerLine>[0]) => {
      if (closed || child.stdin.destroyed || !child.stdin.writable) {
        throw workerError("Pi worker is no longer accepting commands.", stderr);
      }
      child.stdin.write(encodePiWorkerLine(value));
    };

    const send = async (text: string) => {
      await started.promise;
      const requestId = randomUUID();
      const accepted = Promise.withResolvers<void>();
      acknowledgements.set(requestId, accepted);
      try {
        writeRequest({
          protocol: PI_WORKER_PROTOCOL_VERSION,
          type: "message",
          requestId,
          text,
        });
        await accepted.promise;
      } finally {
        acknowledgements.delete(requestId);
      }
    };

    const cancel = (): Promise<void> => {
      cancellation ??= (async () => {
        if (!termination && !closed) {
          const requestId = randomUUID();
          try {
            writeRequest({
              protocol: PI_WORKER_PROTOCOL_VERSION,
              type: "cancel",
              requestId,
            });
          } catch {
            // The close path below is still the cancellation confirmation.
          }
        }
        await terminateCapturedChild(this.timings.cancelProtocolGraceMs);
        try {
          await result.promise;
        } catch (error) {
          if (terminal?.type === "error") {
            throw new WorkerStoppedError(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      return cancellation;
    };

    context.registerForce(() => {
      if (!closed) child.kill("SIGKILL");
    });
    context.signal.addEventListener("abort", () => void cancel(), { once: true });
    if (context.signal.aborted) void cancel();

    return {
      controller: { result: result.promise, send, cancel },
      ready: started.promise,
    };
  }
}
