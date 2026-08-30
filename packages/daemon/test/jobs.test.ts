import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createBashTool,
  formatJobResult,
  GhostJobManager,
  type GhostJob,
  jobSnapshot,
} from "../src/jobs.js";

interface FakeProcess {
  command: string;
  timeoutSeconds: number | undefined;
  emit(data: string | Buffer): void;
  exit(code: number | null): void;
}

/** Shell operations whose processes finish only when the test says so. */
function fakeOperations(): { operations: BashOperations; processes: FakeProcess[] } {
  const processes: FakeProcess[] = [];
  const operations: BashOperations = {
    exec: (command, _cwd, options) => new Promise((resolve) => {
      const process: FakeProcess = {
        command,
        timeoutSeconds: options.timeout,
        emit: (data) => options.onData(Buffer.from(data)),
        exit: (exitCode) => resolve({ exitCode }),
      };
      options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
      processes.push(process);
    }),
  };
  return { operations, processes };
}

function manager(options: Partial<ConstructorParameters<typeof GhostJobManager>[0]> = {}) {
  const settled: GhostJob[] = [];
  const fake = fakeOperations();
  let clock = 1_000;
  const jobs = new GhostJobManager({
    operations: fake.operations,
    onSettled: (job) => settled.push(job),
    now: () => clock,
    ...options,
  });
  return { jobs, settled, processes: fake.processes, tick: (ms: number) => { clock += ms; } };
}

describe("GhostJobManager", () => {
  it("runs a job to completion, keeps a bounded output tail, and reports it once", async () => {
    const { jobs, settled, processes, tick } = manager({ maxOutputBytes: 12 });
    const job = jobs.start({ command: "make build", cwd: "/tmp", label: "build" });
    expect(job).toMatchObject({ id: "job-1", label: "build", status: "running" });
    expect(jobs.hasRunning()).toBe(true);

    processes[0]!.emit("line one\n");
    processes[0]!.emit("line two\n");
    tick(2_500);
    processes[0]!.exit(0);
    await jobs.wait(["job-1"], 1_000);

    expect(job).toMatchObject({
      status: "completed",
      exitCode: 0,
      output: "ne\nline two\n",
      outputTruncated: true,
    });
    expect(settled).toEqual([job]);
  });

  it("keeps split and truncated multibyte output on UTF-8 boundaries", async () => {
    const split = manager({ maxOutputBytes: 8 });
    const updates: string[] = [];
    const splitJob = split.jobs.start({
      command: "split",
      cwd: "/tmp",
      onOutput: (job) => updates.push(job.output),
    });
    const face = Buffer.from("😀");
    split.processes[0]!.emit(face.subarray(0, 2));
    expect(updates).toEqual([""]);
    expect(jobSnapshot(splitJob).output).toBe("");
    expect(splitJob.output).not.toContain("�");
    split.processes[0]!.emit(face.subarray(2));
    expect(updates).toEqual(["", "😀"]);
    expect(jobSnapshot(splitJob).output).toBe("😀");
    expect(splitJob.output).toBe("😀");
    split.processes[0]!.exit(0);
    await split.jobs.wait([splitJob.id], 1_000);

    const incomplete = manager({ maxOutputBytes: 8 });
    const incompleteJob = incomplete.jobs.start({ command: "incomplete", cwd: "/tmp" });
    incomplete.processes[0]!.emit(face.subarray(0, 2));
    expect(jobSnapshot(incompleteJob).output).toBe("");
    incomplete.processes[0]!.exit(0);
    await incomplete.jobs.wait([incompleteJob.id], 1_000);
    expect(jobSnapshot(incompleteJob).output).toBe("�");

    const truncated = manager({ maxOutputBytes: 6 });
    const truncatedJob = truncated.jobs.start({ command: "truncate", cwd: "/tmp" });
    const source = Buffer.from("old😀tail");
    truncated.processes[0]!.emit(source.subarray(0, 5));
    truncated.processes[0]!.emit(source.subarray(5));
    expect(truncatedJob).toMatchObject({ output: "tail", outputTruncated: true });
    expect(truncatedJob.output).not.toContain("�");
    expect(Buffer.byteLength(truncatedJob.output)).toBeLessThanOrEqual(6);
    truncated.processes[0]!.exit(0);
    await truncated.jobs.wait([truncatedJob.id], 1_000);
  });

  it("bounds the complete UTF-8 settlement delivery, including its framing", async () => {
    const { jobs, processes, tick } = manager({ maxOutputBytes: 96 });
    const job = jobs.start({ command: "unicode", cwd: "/tmp", label: "unicode" });
    processes[0]!.emit("😀".repeat(100));
    tick(500);
    processes[0]!.exit(0);
    await jobs.wait([job.id], 1_000);

    const delivered = formatJobResult(job);
    expect(delivered).toMatch(/^Background job job-1 \(unicode\) completed after 500ms\./);
    expect(delivered).toContain("earlier output dropped");
    expect(delivered).not.toContain("�");
    expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(job.maxOutputBytes);
  });

  it("trims one oversized process buffer to the exact newest-byte budget", async () => {
    const { jobs, processes } = manager({ maxOutputBytes: 12 });
    const job = jobs.start({ command: "oversized", cwd: "/tmp" });

    processes[0]!.emit("0123456789abcdef");
    expect(job).toMatchObject({ output: "456789abcdef", outputTruncated: true });
    expect(Buffer.byteLength(job.output)).toBe(12);
    processes[0]!.exit(0);
    await jobs.wait([job.id], 1_000);
  });

  it("bounds a rejected process reason together with its preceding output", async () => {
    const reason = "failure-0123456789abcdef";
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("process-prefix"));
        throw new Error(reason);
      },
    };
    const { jobs } = manager({ operations, maxOutputBytes: 12 });
    const job = jobs.start({ command: "reject", cwd: "/tmp" });
    await jobs.wait([job.id], 1_000);

    expect(job).toMatchObject({
      status: "failed",
      output: reason.slice(-12),
      outputTruncated: true,
    });
    expect(Buffer.byteLength(job.output)).toBe(12);
  });

  it("marks a non-zero exit as failed and an aborted job as cancelled", async () => {
    const { jobs, settled, processes } = manager();
    jobs.start({ command: "false", cwd: "/tmp" });
    jobs.start({ command: "sleep 100", cwd: "/tmp" });
    processes[0]!.exit(3);
    expect(jobs.cancel("job-2")).toBe("cancelled");
    expect(jobs.cancel("nope")).toBe("not_found");
    await jobs.wait(undefined, 1_000);
    expect(jobs.cancel("job-1")).toBe("already_settled");

    expect(jobs.get("job-1")).toMatchObject({ status: "failed", exitCode: 3 });
    expect(jobs.get("job-2")).toMatchObject({ status: "cancelled", exitCode: null });
    expect(settled.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(formatJobResult(jobs.get("job-1")!)).toContain("failed with exit code 3");
    expect(formatJobResult(jobs.get("job-2")!)).toContain("was cancelled");
  });

  it("wait returns on timeout with the jobs still running", async () => {
    const { jobs, processes } = manager();
    jobs.start({ command: "sleep 100", cwd: "/tmp" });
    const waited = await jobs.wait(["job-1"], 20);
    expect(waited.map((job) => job.status)).toEqual(["running"]);
    processes[0]!.exit(0);
  });

  it("waits without a deadline until the jobs settle", async () => {
    const { jobs, processes } = manager();
    jobs.start({ command: "sleep 100", cwd: "/tmp" });
    let resolved = false;
    const waiting = jobs.wait(["job-1"], undefined).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    processes[0]!.exit(0);
    await expect(waiting).resolves.toMatchObject([{ status: "completed" }]);
  });

  it("dispose cancels every running job without reporting them", async () => {
    const { jobs, settled } = manager();
    jobs.start({ command: "sleep 100", cwd: "/tmp" });
    jobs.start({ command: "sleep 100", cwd: "/tmp" });
    await jobs.dispose();
    expect(jobs.list().map((job) => job.status)).toEqual(["cancelled", "cancelled"]);
    expect(settled).toEqual([]);
    expect(() => jobs.start({ command: "echo", cwd: "/tmp" })).toThrow(/closed/);
  });
});

describe("createBashTool", () => {
  it("forwards timeout seconds unchanged", async () => {
    const { jobs, processes } = manager();
    const tool = createBashTool({ cwd: process.cwd(), manager: jobs, autoBackgroundMs: 150 });

    await tool.execute(
      "call-timeout",
      { command: "sleep 100", timeout: 10, background: true },
      undefined,
      undefined,
      {} as never,
    );

    expect(processes[0]).toMatchObject({ timeoutSeconds: 10 });
    expect(jobs.hasRunning()).toBe(true);

    processes[0]!.exit(0);
    await jobs.wait(["job-1"], 1_000);

    expect(jobs.get("job-1")).toMatchObject({ status: "completed" });
    expect(jobs.hasRunning()).toBe(false);
  });

  it("runs every command as a job: background at once, foreground until the wait budget", async () => {
    const settled: GhostJob[] = [];
    const jobs = new GhostJobManager({
      operations: createLocalBashOperations(),
      onSettled: (job) => settled.push(job),
    });
    const tool = createBashTool({ cwd: process.cwd(), manager: jobs, autoBackgroundMs: 150 });

    const started = await tool.execute("call-1", { command: "echo hi", background: true, label: "greet" }, undefined, undefined, {} as never);
    expect(started.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Started background job") });
    await jobs.wait(undefined, 2_000);
    expect(settled.map((job) => job.label)).toEqual(["greet"]);

    const fast = await tool.execute("call-2", { command: "echo quick" }, undefined, undefined, {} as never);
    expect(fast.content[0]).toMatchObject({ type: "text", text: "quick" });
    await expect(tool.execute("call-3", { command: "echo oops >&2; exit 3" }, undefined, undefined, {} as never))
      .rejects.toThrow(/oops[\s\S]*exited with code 3/);
    expect(jobs.list()).toHaveLength(3);

    const slow = await tool.execute("call-4", { command: "echo early; sleep 0.6; echo late" }, undefined, undefined, {} as never);
    expect(slow.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^early[\s\S]*continuing as background job/) });
    expect(jobs.hasRunning()).toBe(true);
    await jobs.wait(undefined, 5_000);
    expect(jobs.list().at(-1)).toMatchObject({ status: "completed", output: expect.stringContaining("late") });
    expect(jobs.hasRunning()).toBe(false);
  });

  it("keeps a foreground command inline when automatic backgrounding is disabled", async () => {
    const { jobs, processes } = manager();
    const tool = createBashTool({ cwd: process.cwd(), manager: jobs, autoBackgroundMs: 0 });
    const execution = tool.execute(
      "call-no-deadline",
      { command: "sleep 100" },
      undefined,
      undefined,
      {} as never,
    );

    expect(tool.description).toContain("remain foreground");
    await expect(Promise.race([
      execution.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ])).resolves.toBe("pending");

    processes[0]!.exit(0);
    await expect(execution).resolves.toMatchObject({
      content: [{ type: "text", text: "(no output)" }],
      details: undefined,
    });
  });

  it("bounds decorated foreground failure and background messages as valid UTF-8", async () => {
    const failed = manager({ maxOutputBytes: 32 });
    const failedTool = createBashTool({ cwd: process.cwd(), manager: failed.jobs, autoBackgroundMs: 0 });
    const execution = failedTool.execute(
      "call-failed",
      { command: "fail" },
      undefined,
      undefined,
      {} as never,
    );
    failed.processes[0]!.emit("😀".repeat(20));
    failed.processes[0]!.exit(3);
    let failure: unknown;
    try {
      await execution;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/Command exited with code 3$/);
    expect(message).not.toContain("�");
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(32);

    const background = manager({ maxOutputBytes: 32 });
    const backgroundTool = createBashTool({ cwd: process.cwd(), manager: background.jobs, autoBackgroundMs: 10 });
    const started = await backgroundTool.execute(
      "call-background",
      { command: "wait", background: true, label: "😀".repeat(40) },
      undefined,
      undefined,
      {} as never,
    );
    const text = (started.content[0] as { text: string }).text;
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32);
    background.processes[0]!.exit(0);
    await background.jobs.wait(undefined, 1_000);
  });

  it("keeps a no-deadline foreground wait abortable", async () => {
    const { jobs } = manager();
    const tool = createBashTool({ cwd: process.cwd(), manager: jobs, autoBackgroundMs: 0 });
    const controller = new AbortController();
    const execution = tool.execute(
      "call-abort",
      { command: "sleep 100" },
      controller.signal,
      undefined,
      {} as never,
    );

    controller.abort();
    await expect(execution).rejects.toThrow("Command aborted");
    expect(jobs.get("job-1")).toMatchObject({ status: "cancelled" });
  });
});
