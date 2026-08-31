import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WorkerStoppedError, type WorkerAdapter, type WorkerTaskController, type WorkerTaskRequest } from "./tasks.js";
import { CODEX_BINARY_ENV, resolveHarnessExecutable } from "./harness-executable.js";

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
const MAX_PROTOCOL_LINE_BYTES = 8 * 1_048_576;
const MAX_STDERR_LENGTH = 4_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TTL_MS = 5_000;
const TERMINAL_EXIT_GRACE_MS = 2_000;
const INTERRUPT_GRACE_MS = 3_000;
const TERM_GRACE_MS = 5_000;
const MAX_TRUST_APPROVAL_POLICY = "never";
const MAX_TRUST_SANDBOX = "danger-full-access";

type SpawnWorker = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

const defaultSpawnWorker: SpawnWorker = (command, args, options) =>
  spawn(command, [...args], options);

type RpcId = string | number;
type JsonObject = Record<string, unknown>;

interface RpcResponse {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface CodexAppServerOptions {
  onNotification?(method: string, params: unknown): void | Promise<void>;
  onServerRequest?(method: string, params: unknown): unknown | Promise<unknown>;
  onFatal?(error: Error): void;
}

export interface CodexWorkerAdapterTimings {
  interruptGraceMs: number;
  terminalExitGraceMs: number;
  termGraceMs: number;
}

export interface CodexWorkerAdapterOptions {
  env?: NodeJS.ProcessEnv;
  assertContext(input: { root: string; cwd: string }): Promise<{ root: string; cwd: string }>;
  resolveExecutable?: (configured: string) => Promise<string>;
  spawnWorker?: SpawnWorker;
  timings?: Partial<CodexWorkerAdapterTimings>;
}

export interface CodexAccountStatus {
  accountPresent: boolean;
  requiresOpenaiAuth: boolean;
}

export interface CodexProbeResult {
  binaryPath: string;
  account: CodexAccountStatus;
}

export interface CodexProbeOptions {
  env?: NodeJS.ProcessEnv;
  binaryPath?: string;
  ttlMs?: number;
  now?: () => number;
  resolveExecutable?: (configured: string) => Promise<string>;
  readAccount?: (binaryPath: string, env: NodeJS.ProcessEnv) => Promise<CodexAccountStatus>;
}

export class CodexProcessError extends Error {
  override readonly name: string = "CodexProcessError";
}

export class CodexMissingError extends CodexProcessError {
  override readonly name = "CodexMissingError";
}

class UnsupportedCodexRequestError extends CodexProcessError {
  override readonly name = "UnsupportedCodexRequestError";
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function rpcId(value: unknown): RpcId | null {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : null;
}

function errorMessage(value: unknown, fallback: string): string {
  const record = objectValue(value);
  return typeof record?.message === "string" && record.message.trim()
    ? record.message
    : fallback;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function appendStderr(stderr: string, chunk: Buffer | string): string {
  return `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
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

function childError(message: string, stderr: string): Error {
  const detail = stderr.trim();
  return new CodexProcessError(detail ? `${message} ${detail}` : message);
}

class CodexAppServer {
  private readonly pending = new Map<RpcId, RpcResponse>();
  private readonly decoder = new StringDecoder("utf8");
  private stdout = "";
  private nextId = 1;
  private failed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: CodexAppServerOptions = {},
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stdout.once("end", () => {
      const tail = this.stdout + this.decoder.end();
      this.stdout = "";
      if (tail.trim()) this.consumeLine(tail);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(new CodexProcessError("Codex app server is unavailable."));
    const id = this.nextId;
    this.nextId += 1;
    const response = Promise.withResolvers<unknown>();
    this.pending.set(id, { resolve: response.resolve, reject: response.reject });
    try {
      this.write({ method, id, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.pending.delete(id);
      response.reject(error);
    }
    return response.promise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  initialize(): Promise<unknown> {
    return this.request("initialize", {
      clientInfo: { name: "ghost", title: "Ghost", version: "0.0.1" },
      capabilities: null,
    }).then((result) => {
      this.notify("initialized");
      return result;
    });
  }

  close(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    for (const response of this.pending.values()) response.reject(error);
    this.pending.clear();
  }

  private write(value: JsonObject): void {
    if (this.failed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new CodexProcessError("Codex app server is no longer accepting messages.");
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consume(chunk: Buffer): void {
    if (this.failed) return;
    this.stdout += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdout) > MAX_PROTOCOL_LINE_BYTES && !this.stdout.includes("\n")) {
      this.fatal(new CodexProcessError("Codex app server emitted an oversized protocol line."));
      return;
    }
    let newline = this.stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      this.consumeLine(line);
      if (this.failed) return;
      newline = this.stdout.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    if (!line.trim() || this.failed) return;
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      this.fatal(new CodexProcessError("Codex app server emitted an oversized protocol line."));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fatal(new CodexProcessError("Codex app server emitted invalid JSON."));
      return;
    }
    const message = objectValue(parsed);
    if (!message) {
      this.fatal(new CodexProcessError("Codex app server emitted an invalid protocol message."));
      return;
    }
    const id = rpcId(message.id);
    if (id !== null && typeof message.method !== "string") {
      const response = this.pending.get(id);
      if (!response) return;
      this.pending.delete(id);
      if ("error" in message) {
        response.reject(new CodexProcessError(errorMessage(message.error, "Codex request failed.")));
      } else if ("result" in message) {
        response.resolve(message.result);
      } else {
        response.reject(new CodexProcessError("Codex returned a malformed response."));
      }
      return;
    }
    if (typeof message.method !== "string") {
      this.fatal(new CodexProcessError("Codex app server emitted an invalid protocol message."));
      return;
    }
    if (id === null) {
      void Promise.resolve().then(
        () => this.options.onNotification?.(message.method as string, message.params),
      ).catch(
        (error) => this.fatal(asError(error)),
      );
      return;
    }
    void Promise.resolve().then(
      () => this.options.onServerRequest?.(message.method as string, message.params),
    ).then(
      (result) => this.write({ id, result: result ?? {} }),
      (error) => {
        const failure = asError(error);
        try {
          this.write({ id, error: { code: -32601, message: failure.message } });
        } finally {
          if (failure instanceof UnsupportedCodexRequestError) this.fatal(failure);
        }
      },
    ).catch((error) => this.fatal(asError(error)));
  }

  private fatal(error: Error): void {
    if (this.failed) return;
    this.close(error);
    this.options.onFatal?.(error);
  }
}

function accountStatus(value: unknown): CodexAccountStatus {
  const result = objectValue(value);
  if (!result || typeof result.requiresOpenaiAuth !== "boolean"
    || !(result.account === null || objectValue(result.account))) {
    throw new CodexProcessError("Codex `account/read` returned an incompatible response.");
  }
  return {
    accountPresent: result.account !== null,
    requiresOpenaiAuth: result.requiresOpenaiAuth,
  };
}

export async function readCodexAccount(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  spawnWorker: SpawnWorker = defaultSpawnWorker,
): Promise<CodexAccountStatus> {
  const child = spawnWorker(binaryPath, APP_SERVER_ARGS, {
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  let stderr = "";
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = appendStderr(stderr, chunk);
  });
  child.once("error", (error) => failed.reject(error));
  child.once("close", () => exited.resolve());
  const app = new CodexAppServer(child, { onFatal: failed.reject });
  try {
    const result = await Promise.race([
      app.initialize().then(() => app.request("account/read", { refreshToken: false })),
      failed.promise,
      delay(PROBE_TIMEOUT_MS).then(() => {
        throw new CodexProcessError("Codex account probe timed out.");
      }),
    ]);
    return accountStatus(result);
  } catch (error) {
    throw childError(
      error instanceof Error ? error.message : "Codex account probe failed.",
      stderr,
    );
  } finally {
    app.close(new CodexProcessError("Codex account probe closed."));
    child.stdin.end();
    if (!await Promise.race([exited.promise.then(() => true), delay(250).then(() => false)])) {
      child.kill("SIGTERM");
      if (!await Promise.race([exited.promise.then(() => true), delay(250).then(() => false)])) {
        child.kill("SIGKILL");
        await exited.promise;
      }
    }
  }
}

/** Short-lived structured installation and account snapshot for the harness catalogue. */
export class CodexProbe {
  private readonly env: NodeJS.ProcessEnv;
  private readonly binaryPath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly resolveExecutable: NonNullable<CodexProbeOptions["resolveExecutable"]>;
  private readonly readAccount: NonNullable<CodexProbeOptions["readAccount"]>;
  private cached?: { expiresAt: number; result: Promise<CodexProbeResult> };

  constructor(options: CodexProbeOptions = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.binaryPath = options.binaryPath ?? (this.env[CODEX_BINARY_ENV]?.trim() || "codex");
    this.ttlMs = options.ttlMs ?? PROBE_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) throw new RangeError("Codex probe ttlMs is invalid.");
    this.now = options.now ?? Date.now;
    this.resolveExecutable = options.resolveExecutable
      ?? ((configured) => resolveHarnessExecutable(configured, this.env));
    this.readAccount = options.readAccount ?? readCodexAccount;
  }

  read(): Promise<CodexProbeResult> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) return this.cached.result;
    const result = this.probe();
    this.cached = { expiresAt: now + this.ttlMs, result };
    return result;
  }

  private async probe(): Promise<CodexProbeResult> {
    let binaryPath: string;
    try {
      binaryPath = await this.resolveExecutable(this.binaryPath);
    } catch (cause) {
      throw new CodexMissingError("The configured Codex executable is unavailable.", { cause });
    }
    return { binaryPath, account: await this.readAccount(binaryPath, this.env) };
  }
}

function threadStartResult(value: unknown, expectedCwd: string): { threadId: string; notice: string } {
  const result = objectValue(value);
  const thread = objectValue(result?.thread);
  const sandbox = objectValue(result?.sandbox);
  if (!result || !thread || typeof thread.id !== "string" || !thread.id
    || result.cwd !== expectedCwd || thread.cwd !== expectedCwd
    || result.approvalPolicy !== MAX_TRUST_APPROVAL_POLICY
    || sandbox?.type !== "dangerFullAccess") {
    throw new CodexProcessError(
      "Codex `thread/start` returned incompatible project or maximum-trust execution state.",
    );
  }
  const sources = Array.isArray(result.instructionSources) ? result.instructionSources.length : 0;
  const model = typeof result.model === "string" ? result.model : "native default";
  return {
    threadId: thread.id,
    notice: `Codex started with native configuration and maximum trust (${model}; ${sources} instruction source${sources === 1 ? "" : "s"}).`,
  };
}

function turnStartResult(value: unknown): string {
  const result = objectValue(value);
  const turn = objectValue(result?.turn);
  if (!turn || typeof turn.id !== "string" || !turn.id) {
    throw new CodexProcessError("Codex `turn/start` returned no turn id.");
  }
  return turn.id;
}

function finalAgentMessage(params: unknown): string | null {
  const turn = objectValue(objectValue(params)?.turn);
  if (!turn || !Array.isArray(turn.items)) return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = objectValue(turn.items[index]);
    if (item?.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return null;
}

function completedAgentMessage(params: unknown): string | null {
  const item = objectValue(objectValue(params)?.item);
  return item?.type === "agentMessage" && typeof item.text === "string" ? item.text : null;
}

function turnTerminal(params: unknown): { threadId: string; turnId: string; status: string; error: string | null } | null {
  const record = objectValue(params);
  const turn = objectValue(record?.turn);
  if (typeof record?.threadId !== "string" || !turn || typeof turn.id !== "string"
    || !["completed", "interrupted", "failed"].includes(String(turn.status))) return null;
  return {
    threadId: record.threadId,
    turnId: turn.id,
    status: String(turn.status),
    error: turn.error === null ? null : errorMessage(turn.error, "Codex turn failed."),
  };
}

/** One native Codex app-server process per durable delegated task. */
export class CodexWorkerAdapter implements WorkerAdapter {
  readonly id = "codex" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly binary: string;
  private readonly assertContext: CodexWorkerAdapterOptions["assertContext"];
  private readonly resolveExecutable: NonNullable<CodexWorkerAdapterOptions["resolveExecutable"]>;
  private readonly spawnWorker: SpawnWorker;
  private readonly timings: CodexWorkerAdapterTimings;

  constructor(options: CodexWorkerAdapterOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.binary = this.env[CODEX_BINARY_ENV]?.trim() || "codex";
    this.assertContext = options.assertContext;
    this.resolveExecutable = options.resolveExecutable
      ?? ((configured) => resolveHarnessExecutable(configured, this.env));
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
    const child = this.spawnWorker(executable, APP_SERVER_ARGS, {
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
      throw new CodexProcessError("The task project identity changed before Codex could start.");
    }
  }

  private async control(
    child: ChildProcessWithoutNullStreams,
    request: WorkerTaskRequest,
    context: Parameters<WorkerAdapter["start"]>[1],
  ): Promise<WorkerTaskController> {
    const result = Promise.withResolvers<{ text: string; nativeSessionId?: string }>();
    const exited = Promise.withResolvers<void>();
    let stderr = "";
    let closed = false;
    let terminal: ReturnType<typeof turnTerminal>;
    let terminalError: Error | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let lastMessage = "";
    let termination: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let eventChain = Promise.resolve();

    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendStderr(stderr, chunk);
    });
    void result.promise.catch(() => {});

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
    const emit = (event: Parameters<typeof context.emit>[0]) => {
      const deliver = () => context.emit(event);
      eventChain = eventChain.then(deliver, deliver);
    };
    const fail = (error: Error) => {
      terminalError ??= error;
      child.stdin.end();
      void terminate(0);
    };
    const handleServerRequest = (method: string): unknown => {
      switch (method) {
        case "mcpServer/elicitation/request":
          emit({ type: "notice", text: "Codex requested MCP input; the headless harness task declined it." });
          return { action: "decline", content: null, _meta: null };
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "item/permissions/requestApproval":
        case "applyPatchApproval":
        case "execCommandApproval":
          throw new UnsupportedCodexRequestError(
            `Codex requested ${method} after accepting maximum-trust execution.`,
          );
        default:
          throw new UnsupportedCodexRequestError(`Unsupported Codex client request: ${method}.`);
      }
    };

    const app = new CodexAppServer(child, {
      onFatal: fail,
      onServerRequest: (method) => {
        if (method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1_000) };
        return handleServerRequest(method);
      },
      onNotification: (method, params) => {
        if (method === "item/completed") {
          const message = completedAgentMessage(params);
          if (message !== null) {
            lastMessage = message;
            emit({ type: "output", text: message });
          }
          return;
        }
        if (method === "item/started") {
          const item = objectValue(objectValue(params)?.item);
          if (item?.type === "commandExecution") emit({ type: "notice", text: "Codex started a command." });
          else if (item?.type === "fileChange") emit({ type: "notice", text: "Codex started a file change." });
          else if (item?.type === "mcpToolCall") emit({ type: "notice", text: "Codex started an MCP tool call." });
          return;
        }
        if (method !== "turn/completed") return;
        const completed = turnTerminal(params);
        if (!completed || completed.threadId !== threadId || completed.turnId !== turnId) return;
        terminal = completed;
        lastMessage = finalAgentMessage(params) ?? lastMessage;
        child.stdin.end();
        void terminate(this.timings.terminalExitGraceMs);
      },
    });

    context.registerForce(() => {
      if (!closed) child.kill("SIGKILL");
    });
    child.once("error", (error) => fail(new CodexProcessError(error.message)));
    child.once("close", (code, signal) => {
      closed = true;
      exited.resolve();
      const stopped = terminalError ?? childError(
        `Codex worker exited${signal ? ` on ${signal}` : ` with code ${code ?? "unknown"}`}.`,
        stderr,
      );
      app.close(stopped);
      const settle = () => {
        if (terminalError) result.reject(childError(terminalError.message, stderr));
        else if (terminal?.status === "completed") {
          result.resolve({ text: lastMessage, ...(threadId ? { nativeSessionId: threadId } : {}) });
        } else if (terminal?.status === "failed") {
          result.reject(childError(terminal.error ?? "Codex turn failed.", stderr));
        } else if (terminal?.status === "interrupted") {
          result.reject(new CodexProcessError("Codex task was interrupted."));
        } else result.reject(stopped);
      };
      void eventChain.then(settle, settle);
    });

    const cancel = (): Promise<void> => {
      cancellation ??= (async () => {
        if (!closed && threadId && turnId && !terminal && !terminalError) {
          try {
            await app.request("turn/interrupt", { threadId, turnId });
          } catch {
            // Captured-process teardown remains the cancellation confirmation.
          }
        }
        child.stdin.end();
        await terminate(this.timings.interruptGraceMs);
        if (terminal?.status === "failed" || terminalError) {
          throw new WorkerStoppedError(
            terminalError?.message ?? terminal?.error ?? "Codex failed while stopping.",
          );
        }
        try {
          await result.promise;
        } catch {
          // Interrupted/terminated is the expected cancellation result.
        }
      })();
      return cancellation;
    };
    const cancelFromSignal = () => void cancel().catch(() => {});
    context.signal.addEventListener("abort", cancelFromSignal, { once: true });
    if (context.signal.aborted) cancelFromSignal();

    try {
      await app.initialize();
      const started = threadStartResult(await app.request("thread/start", {
        cwd: request.cwd,
        approvalPolicy: MAX_TRUST_APPROVAL_POLICY,
        sandbox: MAX_TRUST_SANDBOX,
      }), request.cwd);
      threadId = started.threadId;
      emit({ type: "notice", text: started.notice });
      turnId = turnStartResult(await app.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.task, text_elements: [] }],
      }));
    } catch (error) {
      fail(asError(error));
      await exited.promise;
      throw terminalError;
    }

    const send = async (text: string) => {
      if (!threadId || !turnId || terminal || terminalError || closed) {
        throw new CodexProcessError("Codex is not accepting steering.");
      }
      const response = objectValue(await app.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text, text_elements: [] }],
      }));
      if (response?.turnId !== turnId) throw new CodexProcessError("Codex rejected the active turn id.");
    };

    return { nativeSessionId: threadId, result: result.promise, send, cancel };
  }
}
