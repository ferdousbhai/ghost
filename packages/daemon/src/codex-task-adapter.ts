import { captureNativeHarnessEnvironment } from "./env-scrub.js";
import type { NativeHarnessProbeResult } from "./native-harness-catalog.js";
import {
  deferred,
  NativeTaskJsonlProcess,
  NativeTaskProcessError,
} from "./native-task-jsonl.js";
import type {
  TaskAdapter,
  TaskAdapterContext,
  TaskAdapterHandle,
  TaskBindingReceipt,
} from "./tasks.js";

const MAX_PENDING_CODEX_REQUESTS = 32;
const MAX_CODEX_NATIVE_ID = 256;

interface CodexStartCatalog {
  readForStart(id: "codex", signal: AbortSignal): Promise<NativeHarnessProbeResult>;
}

export interface CodexTaskAdapterOptions {
  catalog: CodexStartCatalog;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

interface PendingRequest {
  method: string;
  resolve(result: unknown): void;
  reject(error: NativeTaskProcessError): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function failure(): NativeTaskProcessError {
  return new NativeTaskProcessError("Codex delegated task failed.");
}

function textInput(text: string): Array<Record<string, unknown>> {
  return [{ type: "text", text, text_elements: [] }];
}

function completedTurn(
  params: Record<string, unknown>,
  expectedThread: string,
): { id: string; status: string; text?: string } {
  if (params.threadId !== expectedThread) throw failure();
  const turn = record(params.turn);
  if (!turn || typeof turn.id !== "string" || turn.id.length < 1
    || turn.id.length > MAX_CODEX_NATIVE_ID
    || typeof turn.status !== "string" || turn.status.length < 1
    || turn.status.length > 64) throw failure();
  let text: string | undefined;
  if (Array.isArray(turn.items)) {
    for (const value of turn.items) {
      const item = record(value);
      if (item?.type === "agentMessage" && typeof item.text === "string") text = item.text;
    }
  }
  return { id: turn.id, status: turn.status, ...(text === undefined ? {} : { text }) };
}

export class CodexTaskAdapter implements TaskAdapter {
  private readonly catalog: CodexStartCatalog;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(options: CodexTaskAdapterOptions) {
    if (!options?.catalog) throw new TypeError("Codex task adapter requires a native catalogue.");
    this.catalog = options.catalog;
    this.environment = captureNativeHarnessEnvironment(
      "codex-native",
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
    const pending = new Map<string, PendingRequest>();
    const settled = deferred<void>();
    void settled.promise.catch(() => undefined);
    let earlyCompletion: { id: string; status: string; text?: string } | undefined;
    let acceptingEarlyCompletion = false;
    let sequence = 0;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finalText = "";
    let didSettle = false;
    let processBoundary!: NativeTaskJsonlProcess;
    processBoundary = new NativeTaskJsonlProcess(context, {
      beforeForce: () => {
        if (!threadId || !turnId) return;
        processBoundary.send({
          id: `ghost-interrupt-${++sequence}`,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
      },
    });

    const rejectAll = () => {
      const error = failure();
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      settled.reject(error);
    };
    const request = (method: string, params: Record<string, unknown>) => {
      if (pending.size >= MAX_PENDING_CODEX_REQUESTS) return Promise.reject(failure());
      const id = `ghost-${++sequence}`;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        try {
          processBoundary.send({ id, method, params });
        } catch {
          pending.delete(id);
          reject(failure());
        }
      });
    };
    const settleTurn = (completion: { id: string; status: string; text?: string }) => {
      if (!turnId) {
        if (!acceptingEarlyCompletion || earlyCompletion) throw failure();
        earlyCompletion = completion;
        return;
      }
      if (completion.id !== turnId || didSettle) throw failure();
      if (completion.status !== "completed") {
        didSettle = true;
        settled.reject(failure());
        return;
      }
      if (completion.text !== undefined) finalText = completion.text;
      didSettle = true;
      settled.resolve();
    };
    const notification = (method: string, paramsValue: unknown) => {
      const params = record(paramsValue);
      if (!params) throw failure();
      if (method === "item/completed") {
        if (params.threadId !== threadId) throw failure();
        if (!turnId) return;
        if (params.turnId !== turnId) throw failure();
        const item = record(params.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          finalText = item.text;
        }
      } else if (method === "turn/completed") {
        if (!threadId) throw failure();
        settleTurn(completedTurn(params, threadId));
      }
      // All other progress and tool notifications remain native-only.
    };
    const readFrames = async () => {
      for (;;) {
        const frame = await processBoundary.receive();
        if ("id" in frame) {
          if (typeof frame.method === "string" || typeof frame.id !== "string") throw failure();
          const response = pending.get(frame.id);
          if (!response) throw failure();
          pending.delete(frame.id);
          if ("error" in frame || !("result" in frame)) response.reject(failure());
          else response.resolve(frame.result);
          continue;
        }
        if (typeof frame.method !== "string") throw failure();
        notification(frame.method, frame.params);
      }
    };
    void readFrames().catch(() => {
      rejectAll();
      void processBoundary.force().catch(() => undefined);
    });

    return (async (): Promise<TaskAdapterHandle> => {
      try {
        const admitted = await this.catalog.readForStart("codex", processBoundary.signal);
        if (admitted.id !== "codex") throw failure();
        await processBoundary.start({
          executable: admitted.executable.path,
          executableEvidence: [admitted.executable],
          args: ["app-server", "--listen", "stdio://"],
          cwd: input.cwd,
          environment: this.environment,
        });
        const initialized = record(await request("initialize", {
          clientInfo: { name: "ghostd", title: "Ghost delegated task", version: "0.0.1" },
          capabilities: null,
        }));
        if (!initialized) throw failure();
        processBoundary.send({ method: "initialized" });
        const started = record(await request("thread/start", {
          cwd: input.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        }));
        const thread = record(started?.thread);
        const sandbox = record(started?.sandbox);
        if (!started
          || !thread
          || typeof thread.id !== "string" || thread.id.length < 1
          || thread.id.length > MAX_CODEX_NATIVE_ID
          || thread.cwd !== input.cwd
          || started.cwd !== input.cwd
          || started.approvalPolicy !== "never"
          || sandbox?.type !== "dangerFullAccess") {
          throw failure();
        }
        threadId = thread.id;
        acceptingEarlyCompletion = true;
        let turnStarted: Record<string, unknown> | undefined;
        try {
          turnStarted = record(await request("turn/start", {
            threadId,
            input: textInput(input.task),
          }));
        } finally {
          acceptingEarlyCompletion = false;
        }
        const turn = record(turnStarted?.turn);
        if (!turn || typeof turn.id !== "string" || turn.id.length < 1
          || turn.id.length > MAX_CODEX_NATIVE_ID || turn.status !== "inProgress") {
          throw failure();
        }
        turnId = turn.id;
        if (earlyCompletion) {
          if (earlyCompletion.id !== turnId) throw failure();
          settleTurn(earlyCompletion);
          earlyCompletion = undefined;
        }

        const result = (async () => {
          try {
            await settled.promise;
            await processBoundary.finish();
            return finalText;
          } catch {
            await processBoundary.force().catch(() => undefined);
            throw failure();
          }
        })();
        return {
          result,
          async followUp(message: string): Promise<void> {
            if (!threadId || !turnId || didSettle) throw failure();
            await request("turn/steer", {
              threadId,
              expectedTurnId: turnId,
              input: textInput(message),
            });
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
