import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { TaskAdapterContext } from "./tasks.js";

export const NATIVE_TASK_JSONL_MAX_FRAME_BYTES = 256 * 1024;
export const NATIVE_TASK_JSONL_MAX_QUEUED_FRAMES = 128;

type JsonObject = Record<string, unknown>;
export interface NativeTaskJsonlOptions {
  beforeForce?: () => void;
}

export class NativeTaskProcessError extends Error {
  readonly _tag = "NativeTaskProcessError";

  constructor(message = "Native task process failed.") {
    super(message);
    this.name = "NativeTaskProcessError";
  }
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

function genericFailure(): NativeTaskProcessError {
  return new NativeTaskProcessError();
}

/**
 * One bounded JSONL transport in one exact delegated-task systemd scope. The
 * task controller is registered synchronously, before any
 * catalogue or protocol await can begin.
 */
export class NativeTaskJsonlProcess {
  readonly signal: AbortSignal;
  readonly quiescence: Promise<void>;

  private readonly abortController = new AbortController();
  private readonly beforeForce: () => void;
  private readonly launchNative: TaskAdapterContext["launchNative"];
  private readonly stopNative: TaskAdapterContext["stopNative"];
  private readonly quiet = deferred<void>();
  private readonly queued: JsonObject[] = [];
  private readonly readers: Array<{
    resolve(value: JsonObject): void;
    reject(reason: unknown): void;
  }> = [];
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private terminal: NativeTaskProcessError | undefined;
  private teardown: Promise<void> | undefined;
  private started = false;
  private forceRequested = false;

  constructor(context: TaskAdapterContext, options: NativeTaskJsonlOptions = {}) {
    this.signal = this.abortController.signal;
    this.quiescence = this.quiet.promise;
    this.beforeForce = options.beforeForce ?? (() => undefined);
    this.launchNative = context.launchNative;
    this.stopNative = context.stopNative;
    context.register({
      force: () => this.force(),
      quiescence: this.quiescence,
    });
    const abort = () => { void this.force().catch(() => undefined); };
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    void this.quiescence.then(
      () => context.signal.removeEventListener("abort", abort),
      () => context.signal.removeEventListener("abort", abort),
    );
  }

  async start(input: Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: Readonly<NodeJS.ProcessEnv>;
  }>): Promise<void> {
    if (this.started || this.signal.aborted || this.teardown) throw genericFailure();
    if (process.platform !== "linux") {
      throw new NativeTaskProcessError("Native delegated tasks require Linux systemd scopes.");
    }
    this.started = true;
    let child: ChildProcess;
    try {
      child = await this.launchNative((spawn) => spawn({
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        environment: input.environment,
        signal: this.signal,
        stderr: "pipe",
      }));
    } catch {
      this.fail();
      throw genericFailure();
    }
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      this.fail();
      throw genericFailure();
    }
    this.child = child as ChildProcessWithoutNullStreams;
    child.stderr.resume();
    child.stdin.on("error", () => this.fail());
    child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk));
    child.once("error", () => this.fail());
    child.once("close", () => this.fail());
    if (this.signal.aborted) void this.force().catch(() => undefined);
  }

  send(frame: JsonObject): void {
    const child = this.child;
    if (!child?.stdin.writable || this.terminal || this.teardown) throw genericFailure();
    let encoded: string;
    try {
      encoded = `${JSON.stringify(frame)}\n`;
    } catch {
      throw genericFailure();
    }
    if (Buffer.byteLength(encoded) > NATIVE_TASK_JSONL_MAX_FRAME_BYTES) {
      throw genericFailure();
    }
    child.stdin.write(encoded);
  }

  receive(): Promise<JsonObject> {
    const frame = this.queued.shift();
    if (frame) return Promise.resolve(frame);
    if (this.terminal) return Promise.reject(this.terminal);
    return new Promise<JsonObject>((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  /** Best-effort native interrupt followed by exact group teardown. */
  force(): Promise<void> {
    if (!this.forceRequested) {
      this.forceRequested = true;
      this.abortController.abort();
      try {
        this.beforeForce();
      } catch {
        // The transient scope remains the authoritative cancellation boundary.
      }
    }
    return this.stop();
  }

  /** Exact group teardown after a normal result; does not send an interrupt. */
  finish(): Promise<void> {
    this.abortController.abort();
    return this.stop();
  }

  private consume(chunk: Buffer | string): void {
    if (this.terminal || this.teardown) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) break;
      const segment = bytes.subarray(offset, newline);
      if (this.buffer.length + segment.length > NATIVE_TASK_JSONL_MAX_FRAME_BYTES) {
        this.fail();
        return;
      }
      let line = this.buffer.length === 0
        ? segment
        : Buffer.concat([this.buffer, segment], this.buffer.length + segment.length);
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) {
        this.fail();
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line.toString("utf8"));
      } catch {
        this.fail();
        return;
      }
      if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
        this.fail();
        return;
      }
      const reader = this.readers.shift();
      if (reader) reader.resolve(frame as JsonObject);
      else if (this.queued.length < NATIVE_TASK_JSONL_MAX_QUEUED_FRAMES) {
        this.queued.push(frame as JsonObject);
      } else {
        this.fail();
        return;
      }
    }
    const remainder = bytes.subarray(offset);
    if (this.buffer.length + remainder.length > NATIVE_TASK_JSONL_MAX_FRAME_BYTES) {
      this.fail();
      return;
    }
    if (remainder.length > 0) {
      this.buffer = this.buffer.length === 0
        ? Buffer.from(remainder)
        : Buffer.concat([this.buffer, remainder], this.buffer.length + remainder.length);
    }
  }

  private fail(): void {
    if (!this.terminal) this.terminal = genericFailure();
    for (const reader of this.readers.splice(0)) reader.reject(this.terminal);
    void this.stop().catch(() => undefined);
  }

  private stop(): Promise<void> {
    if (this.teardown) return this.teardown;
    this.terminal ??= genericFailure();
    for (const reader of this.readers.splice(0)) reader.reject(this.terminal);
    const child = this.child;
    this.teardown = (async () => {
      try {
        await this.stopNative();
      } catch {
        throw genericFailure();
      } finally {
        child?.stdin.destroy();
        child?.stdout.destroy();
        child?.stderr.destroy();
      }
    })();
    void this.teardown.then(this.quiet.resolve, (error) => this.quiet.reject(error));
    return this.teardown;
  }
}
