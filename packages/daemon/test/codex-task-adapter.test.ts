import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexTaskAdapter } from "../src/codex-task-adapter.js";
import type { NativeHarnessProbeResult } from "../src/native-harness-catalog.js";
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

function fakeCodex(
  mode: "complete" | "followup" | "wrong-cwd" | "server-request" | "early-flood" | "resistant",
) {
  const root = mkdtempSync(join(tmpdir(), "ghost-codex-task-"));
  roots.push(root);
  const path = join(root, "codex");
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
const threadId = "thread-native";
const turnId = "turn-native";
const answer = { type: "agentMessage", id: "answer", text: "safe answer", phase: null, memoryCitation: null, delivery: null };
const complete = () => {
  process.stdout.write(JSON.stringify({ method: "item/completed", params: {
    threadId, turnId, item: { type: "commandExecution", id: "tool", aggregatedOutput: "raw-tool-secret" },
  } }) + "\\n");
  process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item: answer } }) + "\\n");
  process.stderr.write("raw-stderr-secret");
  process.stdout.write(JSON.stringify({ method: "turn/completed", params: {
    threadId, turn: { id: turnId, status: "completed", items: [answer] },
  } }) + "\\n");
};
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: "frame", frame }) + "\\n");
  if (frame.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: frame.id, result: { serverInfo: { name: "codex" } } }) + "\\n");
  } else if (frame.method === "thread/start") {
    const cwd = mode === "wrong-cwd" ? "/wrong" : process.cwd();
    process.stdout.write(JSON.stringify({ id: frame.id, result: {
      thread: { id: threadId, cwd }, cwd, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" },
    } }) + "\\n");
  } else if (frame.method === "turn/start") {
    if (mode === "complete") complete();
    if (mode === "early-flood") {
      for (let index = 0; index < 64; index += 1) {
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: {
          threadId, turn: { id: "turn-" + index, status: "completed", items: [] },
        } }) + "\\n");
      }
    }
    process.stdout.write(JSON.stringify({ id: frame.id, result: {
      turn: { id: turnId, status: "inProgress", items: [] },
    } }) + "\\n");
    if (mode === "server-request") {
      process.stdout.write(JSON.stringify({ id: "server-private", method: "item/commandExecution/requestApproval", params: { raw: "protocol-secret" } }) + "\\n");
    }
  } else if (frame.method === "turn/steer") {
    process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + "\\n");
    complete();
  } else if (frame.method === "turn/interrupt") {
    process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + "\\n");
  }
}
setInterval(() => {}, 1000);
`);
  chmodSync(path, 0o700);
  return { root, path, log, pids };
}

function probe(path: string): NativeHarnessProbeResult {
  return {
    id: "codex",
    executable: { path, identity: "1:2:3", literalBoundary: true },
    version: "0.151.0",
    authentication: "authenticated",
    runtimeIdentity: "runtime",
  };
}

function taskContext(): {
  context: TaskAdapterContext;
  control(): TaskAdapterControl;
  evidence(): readonly string[];
} {
  const controller = new AbortController();
  let registered: TaskAdapterControl | undefined;
  let evidence: readonly string[] = [];
  const scope = directTaskScope();
  return {
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

function methodRows(path: string): Array<Record<string, unknown>> {
  return rows(path).slice(1).map((row) => row.frame as Record<string, unknown>);
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

describe("Codex delegated task adapter", () => {
  it("uses exact native app-server policy and discards tool, stderr, and credential data", async () => {
    const fake = fakeCodex("complete");
    const context = taskContext();
    const adapter = new CodexTaskAdapter({
      catalog: { async readForStart(id: "codex", signal: AbortSignal) {
        expect(id).toBe("codex"); expect(signal).toBeInstanceOf(AbortSignal); return probe(fake.path);
      } },
      environment: {
        PATH: process.env.PATH,
        HOME: fake.root,
        CODEX_HOME: join(fake.root, "codex-home"),
        OPENAI_API_KEY: "must-not-cross",
        SECRET_SENTINEL: "must-not-cross",
      },
    });
    const handle = await adapter.start({
      id: "task-1", task: "do the work", cwd: fake.root, binding,
    }, context.context);

    await expect(handle.result).resolves.toBe("safe answer");
    const start = rows(fake.log)[0] as { args: string[]; cwd: string; env: NodeJS.ProcessEnv };
    expect(start.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(context.evidence()).toEqual([fake.path]);
    expect(start.cwd).toBe(fake.root);
    expect(start.env.CODEX_HOME).toBe(join(fake.root, "codex-home"));
    expect(start.env.OPENAI_API_KEY).toBeUndefined();
    expect(start.env.SECRET_SENTINEL).toBeUndefined();
    const thread = methodRows(fake.log).find((frame) => frame.method === "thread/start");
    expect(thread?.params).toEqual({
      cwd: fake.root,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("steers only the exact active native turn", async () => {
    const fake = fakeCodex("followup");
    const context = taskContext();
    const adapter = new CodexTaskAdapter({
      catalog: { async readForStart() { return probe(fake.path); } },
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    const handle = await adapter.start({
      id: "task-2", task: "start", cwd: fake.root, binding,
    }, context.context);
    await handle.followUp("change direction");
    await expect(handle.result).resolves.toBe("safe answer");
    const steer = methodRows(fake.log).find((frame) => frame.method === "turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thread-native",
      expectedTurnId: "turn-native",
      input: [{ type: "text", text: "change direction", text_elements: [] }],
    });
  });

  it("fails closed on a rebound cwd or server request without exposing payloads", async () => {
    for (const mode of ["wrong-cwd", "server-request"] as const) {
      const fake = fakeCodex(mode);
      const context = taskContext();
      const adapter = new CodexTaskAdapter({
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
      expect(thrown).toMatchObject({ message: "Codex delegated task failed." });
      expect(String((thrown as Error).message)).not.toContain("protocol-secret");
      await context.control().quiescence;
    }
  });

  it("fails and quiesces on multiple early turn completions without retaining a flood", async () => {
    const fake = fakeCodex("early-flood");
    const context = taskContext();
    const adapter = new CodexTaskAdapter({
      catalog: { async readForStart() { return probe(fake.path); } },
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    await expect(adapter.start({
      id: "task-early", task: "start", cwd: fake.root, binding,
    }, context.context)).rejects.toMatchObject({
      message: "Codex delegated task failed.",
    });
    await context.control().quiescence;
  });

  it("aborts a blocked fresh admission before spawn", async () => {
    const fake = fakeCodex("complete");
    const context = taskContext();
    let admittedSignal: AbortSignal | undefined;
    const adapter = new CodexTaskAdapter({
      catalog: { readForStart(_id: "codex", signal: AbortSignal): Promise<NativeHarnessProbeResult> {
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
    await expect(starting).rejects.toMatchObject({ message: "Codex delegated task failed." });
    expect(admittedSignal?.aborted).toBe(true);
    expect(existsSync(fake.log)).toBe(false);
  });

  it("interrupts then quiesces a TERM-resistant native process group", async () => {
    const fake = fakeCodex("resistant");
    const context = taskContext();
    const adapter = new CodexTaskAdapter({
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
