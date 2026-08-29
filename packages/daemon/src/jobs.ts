/**
 * Background jobs for one pi conversation. Every `bash` call the model makes
 * runs as a job of the session; a foreground call waits for its job up to the
 * auto-background budget and otherwise leaves it running. Jobs die with the
 * session and report back into the conversation when they settle.
 */
import { StringDecoder } from "node:string_decoder";
import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type GhostJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface GhostJob {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly status: GhostJobStatus;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  /** `null` when the process was killed or never reported a code. */
  readonly exitCode: number | null | undefined;
  /** The most recent output, bounded to `maxOutputBytes`. */
  readonly output: string;
  readonly outputTruncated: boolean;
}

/** A job as the API and the HUD see it. */
export interface GhostJobSnapshot {
  id: string;
  label: string;
  command: string;
  status: GhostJobStatus;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  exitCode?: number | null;
  output: string;
  outputTruncated: boolean;
}

export interface GhostJobManagerOptions {
  operations: BashOperations;
  /** Called once per job when it settles, after its state is final. */
  onSettled?: (job: GhostJob) => void;
  now?: () => number;
  maxOutputBytes?: number;
}

export interface StartJobInput {
  command: string;
  cwd: string;
  label?: string;
  timeoutMs?: number;
  /** Each raw output chunk, for a caller streaming a foreground wait. */
  onOutput?: (job: GhostJob) => void;
}

export type CancelJobOutcome = "cancelled" | "not_found" | "already_settled";

const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_SETTLED_JOBS = 50;

function defaultLabel(command: string): string {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** A job and its bounded output tail, kept as raw chunks until it is read. */
class Job implements GhostJob {
  status: GhostJobStatus = "running";
  endedAt: number | undefined;
  exitCode: number | null | undefined;
  outputTruncated = false;
  cancelled = false;
  settled: Promise<void> = Promise.resolve();
  private chunks: Buffer[] = [];
  private bytes = 0;
  private trailer = "";

  constructor(
    readonly id: string,
    readonly label: string,
    readonly command: string,
    readonly startedAt: number,
    readonly cancel: () => void,
    private readonly maxOutputBytes: number,
  ) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxOutputBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()?.length ?? 0;
      this.outputTruncated = true;
    }
  }

  /** Text appended after the process output, such as pi's failure reason. */
  appendText(text: string): void {
    this.trailer += text;
  }

  get output(): string {
    const decoder = new StringDecoder("utf8");
    return this.chunks.map((chunk) => decoder.write(chunk)).join("") + decoder.end() + this.trailer;
  }
}

export class GhostJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly operations: BashOperations;
  private readonly onSettled: ((job: GhostJob) => void) | undefined;
  private readonly now: () => number;
  private readonly maxOutputBytes: number;
  private nextSequence = 1;
  private runningCount = 0;
  private disposed = false;

  constructor(options: GhostJobManagerOptions) {
    this.operations = options.operations;
    this.onSettled = options.onSettled;
    this.now = options.now ?? Date.now;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  start(input: StartJobInput): GhostJob {
    if (this.disposed) throw new Error("This conversation's background jobs have been closed.");
    const controller = new AbortController();
    const job = new Job(
      `job-${this.nextSequence++}`,
      input.label?.trim() || defaultLabel(input.command),
      input.command,
      this.now(),
      () => controller.abort(),
      this.maxOutputBytes,
    );
    this.jobs.set(job.id, job);
    this.runningCount += 1;
    job.settled = this.operations.exec(input.command, input.cwd, {
      onData: (data) => {
        job.append(data);
        input.onOutput?.(job);
      },
      signal: controller.signal,
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
    }).then(
      (result) => this.settle(job, result.exitCode === 0 ? "completed" : "failed", result.exitCode),
      (error) => {
        job.appendText(`\n${error instanceof Error ? error.message : String(error)}`);
        this.settle(job, "failed", null);
      },
    );
    return job;
  }

  get(id: string): GhostJob | undefined {
    return this.jobs.get(id);
  }

  list(): GhostJob[] {
    return [...this.jobs.values()];
  }

  hasRunning(): boolean {
    return this.runningCount > 0;
  }

  cancel(id: string): CancelJobOutcome {
    const job = this.jobs.get(id);
    if (!job) return "not_found";
    if (job.status !== "running") return "already_settled";
    this.abort(job);
    return "cancelled";
  }

  /**
   * Resolve when every listed job (default: all) has settled, the timeout
   * elapses, or the signal aborts; the jobs reflect whatever state was reached.
   */
  async wait(ids: readonly string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<GhostJob[]> {
    const watched = ids === undefined
      ? [...this.jobs.values()]
      : ids.flatMap((id) => {
          const job = this.jobs.get(id);
          return job ? [job] : [];
        });
    const pending = watched.filter((job) => job.status === "running");
    if (pending.length > 0 && timeoutMs > 0 && !signal?.aborted) {
      const timer = Promise.withResolvers<void>();
      const handle = setTimeout(timer.resolve, timeoutMs);
      const onAbort = () => timer.resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([Promise.all(pending.map((job) => job.settled)), timer.promise]);
      } finally {
        clearTimeout(handle);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    return watched;
  }

  /** Cancel every running job; settled jobs stay listed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    for (const job of running) this.abort(job);
    await Promise.allSettled(running.map((job) => job.settled));
  }

  private abort(job: Job): void {
    job.cancelled = true;
    job.cancel();
  }

  private settle(job: Job, status: GhostJobStatus, exitCode: number | null): void {
    if (job.status !== "running") return;
    job.status = job.cancelled ? "cancelled" : status;
    job.endedAt = this.now();
    job.exitCode = exitCode;
    this.runningCount -= 1;
    this.evictSettled();
    if (!this.disposed) this.onSettled?.(job);
  }

  /** Keep the newest settled jobs so a long conversation's list stays bounded. */
  private evictSettled(): void {
    const settled = [...this.jobs.values()].filter((job) => job.status !== "running");
    for (const job of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_JOBS))) {
      this.jobs.delete(job.id);
    }
  }
}

export function jobSnapshot(job: GhostJob, now: number = Date.now()): GhostJobSnapshot {
  return {
    id: job.id,
    label: job.label,
    command: job.command,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    ...(job.endedAt === undefined ? {} : { endedAt: new Date(job.endedAt).toISOString() }),
    durationMs: Math.max(0, (job.endedAt ?? now) - job.startedAt),
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    output: job.output,
    outputTruncated: job.outputTruncated,
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function describeOutcome(job: GhostJob): string {
  switch (job.status) {
    case "running":
      return "is still running";
    case "completed":
      return "completed";
    case "cancelled":
      return "was cancelled";
    case "failed":
      return job.exitCode === null || job.exitCode === undefined
        ? "failed"
        : `failed with exit code ${job.exitCode}`;
  }
}

/** One line per job, for `/jobs` and the `jobs` tool. */
export function formatJobList(jobs: readonly GhostJob[], now: number = Date.now()): string {
  if (jobs.length === 0) return "No background jobs in this conversation.";
  return jobs
    .map((job) => `- ${job.id} [${job.status}] ${job.label} (${formatDuration((job.endedAt ?? now) - job.startedAt)})`)
    .join("\n");
}

/** The model-facing report delivered when a job settles. */
export function formatJobResult(job: GhostJob): string {
  const duration = formatDuration((job.endedAt ?? job.startedAt) - job.startedAt);
  const header = `Background job ${job.id} (${job.label}) ${describeOutcome(job)} after ${duration}.`;
  const output = job.output.trim();
  if (!output) return `${header}\n\n(no output)`;
  const note = job.outputTruncated ? " (earlier output dropped)" : "";
  return `${header}\n\nOutput${note}:\n${output}`;
}

export const JOB_RESULT_MESSAGE_TYPE = "ghost-job-result";

export const jobsToolSchema = Type.Object({
  op: Type.Union([Type.Literal("list"), Type.Literal("wait"), Type.Literal("cancel")], {
    description: "list: every job of this conversation; wait: block until the given jobs (default: all) settle or the timeout passes; cancel: stop the given jobs.",
  }),
  ids: Type.Optional(Type.Array(Type.String(), { description: "Job ids for wait/cancel." })),
  timeout: Type.Optional(Type.Number({ description: "Seconds to wait (default 30, max 300)." })),
});

export interface JobsToolDetails {
  op: "list" | "wait" | "cancel";
  jobs: GhostJobSnapshot[];
  cancelled?: Array<{ id: string; outcome: CancelJobOutcome }>;
}

const MAX_WAIT_SECONDS = 300;

export function createJobsTool(manager: GhostJobManager): ToolDefinition<typeof jobsToolSchema, JobsToolDetails> {
  return {
    name: "jobs",
    label: "Background jobs",
    description: "Inspect, wait for, or cancel this conversation's background jobs (commands started with bash background:true or moved to the background by Ghost). A finished job's result is also delivered to you automatically.",
    parameters: jobsToolSchema,
    async execute(_toolCallId, params, signal) {
      if (params.op === "cancel") {
        const ids = params.ids ?? [];
        if (ids.length === 0) throw new Error("cancel needs at least one job id.");
        const cancelled = ids.map((id) => ({ id, outcome: manager.cancel(id) }));
        const jobs = ids.flatMap((id) => {
          const job = manager.get(id);
          return job ? [jobSnapshot(job)] : [];
        });
        const text = cancelled.map((entry) => `- ${entry.id}: ${entry.outcome.replaceAll("_", " ")}`).join("\n");
        return { content: [{ type: "text", text }], details: { op: "cancel", jobs, cancelled } };
      }
      const jobs = params.op === "wait"
        ? await manager.wait(
            params.ids,
            Math.min(Math.max(params.timeout ?? 30, 0), MAX_WAIT_SECONDS) * 1_000,
            signal,
          )
        : manager.list();
      return {
        content: [{ type: "text", text: formatJobList(jobs) }],
        details: { op: params.op, jobs: jobs.map((job) => jobSnapshot(job)) },
      };
    },
  };
}

export const bashToolSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  background: Type.Optional(Type.Boolean({
    description: "Start the command as a background job and return its id at once; the result is delivered to you when it finishes.",
  })),
  label: Type.Optional(Type.String({ description: "A short name for a background job." })),
});

export interface BashToolOptions {
  cwd: string;
  manager: GhostJobManager;
  /** Milliseconds a foreground command may run before it becomes a job; 0 disables. */
  autoBackgroundMs: number;
}

const TIMEOUT_BUFFER_MS = 1_000;
const UPDATE_THROTTLE_MS = 250;

/**
 * Ghost's `bash` tool, replacing pi's by name. Every command is a job of the
 * conversation: `background: true` answers with the id at once, and a
 * foreground command that outlives the wait budget keeps running as a job
 * while the model gets the output so far and the id.
 */
export function createBashTool(options: BashToolOptions): ToolDefinition<typeof bashToolSchema, unknown> {
  return {
    name: "bash",
    label: "Bash",
    description: `Execute a bash command in the conversation's working directory. Set background:true for a long-running command; a foreground command that runs longer than ${Math.round(options.autoBackgroundMs / 1_000)}s becomes a background job automatically and its result is delivered when it finishes.`,
    parameters: bashToolSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      let lastUpdate = 0;
      const job = options.manager.start({
        command: params.command,
        cwd: options.cwd,
        ...(params.label ? { label: params.label } : {}),
        ...(params.timeout === undefined ? {} : { timeoutMs: params.timeout * 1_000 }),
        onOutput: (running) => {
          const now = Date.now();
          if (!onUpdate || now - lastUpdate < UPDATE_THROTTLE_MS) return;
          lastUpdate = now;
          onUpdate({ content: [{ type: "text", text: running.output }], details: undefined });
        },
      });
      const notice = `background job ${job.id} (${job.label}). Its result will be delivered when it finishes; use the jobs tool to wait or cancel.`;
      if (params.background) {
        return { content: [{ type: "text", text: `Started ${notice}` }], details: { backgroundJobId: job.id } };
      }
      // A deadline about to fire resolves inline rather than backgrounding
      // moments before the command times out anyway.
      const waitMs = params.timeout === undefined
        ? options.autoBackgroundMs
        : Math.max(0, Math.min(options.autoBackgroundMs, params.timeout * 1_000 - TIMEOUT_BUFFER_MS));
      await options.manager.wait([job.id], options.autoBackgroundMs > 0 ? waitMs : Number.MAX_SAFE_INTEGER, signal);
      if (signal?.aborted && job.status === "running") {
        options.manager.cancel(job.id);
        await options.manager.wait([job.id], 5_000);
      }
      if (job.status === "running") {
        const soFar = job.output.trim();
        return {
          content: [{
            type: "text",
            text: `${soFar ? `${soFar}\n\n` : ""}Still running after ${formatDuration(waitMs)}; continuing as ${notice}`,
          }],
          details: { backgroundJobId: job.id },
        };
      }
      const output = job.output.trim() || "(no output)";
      if (job.status === "cancelled") throw new Error(`${output}\n\nCommand aborted`);
      if (job.status === "failed") {
        throw new Error(job.exitCode === null ? output : `${output}\n\nCommand exited with code ${job.exitCode}`);
      }
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  };
}
