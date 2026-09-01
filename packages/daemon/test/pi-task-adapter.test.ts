import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  parseArgs as parsePiArgs,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeHarnessProbeResult } from "../src/native-harness-catalog.js";
import { PiTaskAdapter } from "../src/pi-task-adapter.js";
import type {
  TaskAdapterContext,
  TaskAdapterControl,
  TaskBindingReceipt,
} from "../src/tasks.js";
import { directTaskScope } from "./helpers/task-scope.js";

const roots: string[] = [];
const binding: TaskBindingReceipt = {
  version: 1,
  root: "/project",
  rootIdentity: "1:2",
  cwd: "/project/exact",
  cwdIdentity: "1:3",
  generation: 1,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakePi(mode: "complete" | "followup" | "malformed" | "resistant") {
  const root = mkdtempSync(join(tmpdir(), "ghost-pi-task-"));
  roots.push(root);
  const path = join(root, "pi");
  const log = join(root, "log.jsonl");
  const pids = join(root, "pids");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const mode = ${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  kind: "start", args: process.argv.slice(2), cwd: process.cwd(), env: process.env,
}) + "\\n");
if (mode === "resistant") {
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  appendFileSync(${JSON.stringify(pids)}, process.pid + " " + child.pid);
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: "frame", frame }) + "\\n");
  if (frame.type === "prompt") {
    if (mode === "malformed") {
      process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "prompt", success: true }) + "\\n");
      process.stdout.write("{raw-protocol-secret\\n");
    } else {
      if (mode === "complete") process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "prompt", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", payload: "raw-tool-secret" }) + "\\n");
      process.stderr.write("raw-stderr-secret");
    }
  } else if (frame.type === "steer") {
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "steer", success: true }) + "\\n");
  } else if (frame.type === "get_last_assistant_text") {
    process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: frame.type, success: true, data: { text: "safe answer" } }) + "\\n");
  } else if (frame.type === "abort") {
    process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "abort", success: true }) + "\\n");
  }
}
setInterval(() => {}, 1000);
`);
  chmodSync(path, 0o700);
  return { root, path, log, pids };
}

function probe(path: string): NativeHarnessProbeResult {
  return {
    id: "pi",
    executable: { path, identity: "1:2:3", literalBoundary: true },
    version: "0.84.3",
    authentication: "unknown",
    runtimeIdentity: "runtime",
  };
}

function taskContext(): {
  context: TaskAdapterContext;
  control(): TaskAdapterControl;
  controller: AbortController;
  evidence(): readonly string[];
} {
  const controller = new AbortController();
  let registered: TaskAdapterControl | undefined;
  let evidence: readonly string[] = [];
  const scope = directTaskScope();
  return {
    controller,
    context: {
      signal: controller.signal,
      async launchNative(executables, launch) {
        evidence = executables.map((row) => row.path);
        return launch((input) => scope.spawn(input));
      },
      stopNative: () => scope.stopAndConfirm(),
      register(control) { registered = control; },
      async emit() {},
    },
    control() {
      if (!registered) throw new Error("missing control");
      return registered;
    },
    evidence: () => evidence,
  };
}

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return !["Z", "X"].includes(stat.slice(close + 2, close + 3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("missing pid file");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("Pi delegated task adapter", () => {
  it("uses Pi's one-run approval to load a disposable project's resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-pi-trust-proof-"));
    roots.push(root);
    const project = join(root, "project");
    const agentDir = join(root, "empty-pi-home");
    const promptDir = join(project, ".pi", "prompts");
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "ghost-trust-proof.md"), [
      "---",
      "description: Project trust proof",
      "---",
      "Loaded only from this disposable project.",
      "",
    ].join("\n"));

    const parsed = parsePiArgs(["--mode", "rpc", "--approve"]);
    expect(parsed.projectTrustOverride).toBe(true);
    expect(existsSync(agentDir)).toBe(false);
    const untrustedSettings = SettingsManager.create(project, agentDir, {
      projectTrusted: false,
    });
    const untrustedLoader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager: untrustedSettings,
    });
    await untrustedLoader.reload();
    expect(untrustedLoader.getPrompts().prompts).toEqual([]);

    const settings = SettingsManager.create(project, agentDir, {
      projectTrusted: parsed.projectTrustOverride,
    });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager: settings });
    await loader.reload();
    expect(loader.getPrompts().diagnostics).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([
      expect.objectContaining({
        name: "ghost-trust-proof",
        description: "Project trust proof",
        filePath: join(promptDir, "ghost-trust-proof.md"),
      }),
    ]);
    expect(existsSync(agentDir)).toBe(false);
  });

  it("uses native RPC defaults in the exact cwd and discards raw frames and credentials", async () => {
    const fake = fakePi("complete");
    const context = taskContext();
    const adapter = new PiTaskAdapter({
      catalog: { async readForStart(id: "pi", signal: AbortSignal) {
        expect(id).toBe("pi"); expect(signal).toBeInstanceOf(AbortSignal); return probe(fake.path);
      } },
      environment: {
        PATH: process.env.PATH,
        HOME: fake.root,
        PI_CODING_AGENT_DIR: join(fake.root, "pi-home"),
        ANTHROPIC_API_KEY: "must-not-cross",
        SECRET_SENTINEL: "must-not-cross",
      },
    });
    const handle = await adapter.start({
      id: "task-1", task: "do the work", cwd: fake.root,
      binding,
    }, context.context);

    await expect(handle.result).resolves.toBe("safe answer");
    const start = rows(fake.log)[0] as { args: string[]; cwd: string; env: NodeJS.ProcessEnv };
    expect(start.args).toEqual(["--mode", "rpc", "--approve"]);
    expect(context.evidence()).toEqual([fake.path]);
    expect(start.cwd).toBe(fake.root);
    expect(start.env.PI_CODING_AGENT_DIR).toBe(join(fake.root, "pi-home"));
    expect(start.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(start.env.SECRET_SENTINEL).toBeUndefined();
  });

  it("serializes a running follow-up as native steer", async () => {
    const fake = fakePi("followup");
    const context = taskContext();
    const adapter = new PiTaskAdapter({
      catalog: { async readForStart() { return probe(fake.path); } },
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    const handle = await adapter.start({
      id: "task-2", task: "start", cwd: fake.root, binding,
    }, context.context);
    await handle.followUp("change direction");
    await expect(handle.result).resolves.toBe("safe answer");
    const commands = rows(fake.log).slice(1).map((row) =>
      (row.frame as Record<string, unknown>).type);
    expect(commands).toEqual(["prompt", "steer", "get_last_assistant_text"]);
  });

  it("maps malformed protocol to a generic failure without raw bytes", async () => {
    const fake = fakePi("malformed");
    const context = taskContext();
    const adapter = new PiTaskAdapter({
      catalog: { async readForStart() { return probe(fake.path); } },
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    let thrown: unknown;
    try {
      const handle = await adapter.start({
        id: "task-3", task: "start", cwd: fake.root, binding,
      }, context.context);
      await handle.result;
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ message: "Pi delegated task failed." });
    expect(String((thrown as Error).message)).not.toContain("raw-protocol-secret");
    await context.control().quiescence;
  });

  it("aborts a blocked admission before spawn", async () => {
    const fake = fakePi("complete");
    const context = taskContext();
    let admittedSignal: AbortSignal | undefined;
    const adapter = new PiTaskAdapter({
      catalog: { readForStart(_id: "pi", signal: AbortSignal): Promise<NativeHarnessProbeResult> {
        admittedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("private probe detail")), { once: true });
        });
      } },
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    const starting = adapter.start({
      id: "task-4", task: "start", cwd: fake.root, binding,
    }, context.context);
    await context.control().force();
    await expect(starting).rejects.toMatchObject({ message: "Pi delegated task failed." });
    expect(admittedSignal?.aborted).toBe(true);
    expect(existsSync(fake.log)).toBe(false);
  });

  it("quiesces a TERM-resistant process and descendant", async () => {
    const fake = fakePi("resistant");
    const context = taskContext();
    const adapter = new PiTaskAdapter({
      catalog: { async readForStart() { return probe(fake.path); } },
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    const handle = await adapter.start({
      id: "task-5", task: "start", cwd: fake.root, binding,
    }, context.context);
    void handle.result.catch(() => undefined);
    await waitForFile(fake.pids);
    await context.control().force();
    await context.control().quiescence;
    const pids = readFileSync(fake.pids, "utf8").split(/\s+/u).map(Number);
    expect(pids.filter(pidExists)).toEqual([]);
  });
});
