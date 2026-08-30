import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createBashTool, formatJobResult, GhostJobManager, type GhostJob } from "../src/jobs.js";

interface FakeProcess {
  command: string;
  timeoutSeconds: number | undefined;
  emit(text: string): void;
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
        emit: (text) => options.onData(Buffer.from(text)),
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

    expect(job).toMatchObject({ status: "completed", exitCode: 0, output: "line two\n", outputTruncated: true });
    expect(settled).toEqual([job]);
    expect(formatJobResult(job)).toContain("Background job job-1 (build) completed after 2.5s.");
    expect(formatJobResult(job)).toContain("earlier output dropped");
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
