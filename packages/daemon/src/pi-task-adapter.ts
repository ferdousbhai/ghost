import { captureNativeHarnessEnvironment } from "./env-scrub.js";
import type { NativeHarnessProbeResult } from "./native-harness-catalog.js";
import {
  NativeTaskJsonlProcess,
  NativeTaskProcessError,
} from "./native-task-jsonl.js";
import type {
  TaskAdapter,
  TaskAdapterContext,
  TaskAdapterHandle,
  TaskBindingReceipt,
} from "./tasks.js";

const MAX_PENDING_PI_COMMANDS = 32;

interface PiStartCatalog {
  readForStart(id: "pi", signal: AbortSignal): Promise<NativeHarnessProbeResult>;
}

export interface PiTaskAdapterOptions {
  catalog: PiStartCatalog;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

interface PendingCommand {
  command: string;
  resolve(frame: Record<string, unknown>): void;
  reject(error: NativeTaskProcessError): void;
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
  return new NativeTaskProcessError("Pi delegated task failed.");
}

export class PiTaskAdapter implements TaskAdapter {
  private readonly catalog: PiStartCatalog;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(options: PiTaskAdapterOptions) {
    if (!options?.catalog) throw new TypeError("Pi task adapter requires a native catalogue.");
    this.catalog = options.catalog;
    this.environment = captureNativeHarnessEnvironment(
      "pi-native",
      options.environment ?? process.env,
    );
  }

  start(
    input: Readonly<{
      id: string;
      task: string;
      cwd: string;
      binding: TaskBindingReceipt;
    }>,
    context: TaskAdapterContext,
  ): Promise<TaskAdapterHandle> {
    const pending = new Map<string, PendingCommand>();
    const settled = deferred<void>();
    void settled.promise.catch(() => undefined);
    let sequence = 0;
    let promptAccepted = false;
    let settleObserved = false;
    let didSettle = false;
    let processBoundary!: NativeTaskJsonlProcess;
    processBoundary = new NativeTaskJsonlProcess(context, {
      beforeForce: () => {
        processBoundary.send({ id: `ghost-abort-${++sequence}`, type: "abort" });
      },
    });

    const rejectAll = () => {
      const error = failure();
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      settled.reject(error);
    };
    const request = (command: string, body: Record<string, unknown>) => {
      if (pending.size >= MAX_PENDING_PI_COMMANDS) return Promise.reject(failure());
      const id = `ghost-${command}-${++sequence}`;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { command, resolve, reject });
        try {
          processBoundary.send({ id, type: command, ...body });
        } catch {
          pending.delete(id);
          reject(failure());
        }
      });
    };
    const readFrames = async () => {
      for (;;) {
        const frame = await processBoundary.receive();
        if (frame.type === "response") {
          if (typeof frame.id !== "string") throw failure();
          const command = pending.get(frame.id);
          if (!command || frame.command !== command.command || typeof frame.success !== "boolean") {
            throw failure();
          }
          pending.delete(frame.id);
          if (frame.success) command.resolve(frame);
          else command.reject(failure());
          continue;
        }
        if (frame.type === "agent_settled") {
          settleObserved = true;
          if (promptAccepted && !didSettle) {
            didSettle = true;
            settled.resolve();
          }
          continue;
        }
        // Native progress, tool, extension, and provider frames are deliberately
        // not projected into Ghost's durable task record.
      }
    };
    void readFrames().catch(() => {
      rejectAll();
      void processBoundary.force().catch(() => undefined);
    });

    return (async (): Promise<TaskAdapterHandle> => {
      try {
        const admitted = await this.catalog.readForStart("pi", processBoundary.signal);
        if (admitted.id !== "pi") throw failure();
        processBoundary.start({
          executable: admitted.executable.path,
          args: ["--mode", "rpc", "--approve"],
          cwd: input.cwd,
          environment: this.environment,
        });
        await request("prompt", { message: input.task });
        promptAccepted = true;
        if (settleObserved && !didSettle) {
          didSettle = true;
          settled.resolve();
        }
        const result = (async () => {
          try {
            await settled.promise;
            const response = await request("get_last_assistant_text", {});
            const data = response.data;
            if (data === null || typeof data !== "object" || Array.isArray(data)) throw failure();
            const text = (data as Record<string, unknown>).text;
            if (text !== null && typeof text !== "string") throw failure();
            await processBoundary.finish();
            return text ?? "";
          } catch {
            await processBoundary.force().catch(() => undefined);
            throw failure();
          }
        })();
        return {
          result,
          async followUp(message: string): Promise<void> {
            if (didSettle) throw failure();
            await request("steer", { message });
          },
        };
      } catch {
        rejectAll();
        await processBoundary.force().catch(() => undefined);
        throw failure();
      }
    })();
  }
}
