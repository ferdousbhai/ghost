import { spawn } from "node:child_process";
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
import {
  NATIVE_TASK_JSONL_MAX_FRAME_BYTES,
  NativeTaskJsonlProcess,
} from "../src/native-task-jsonl.js";
import type { TaskAdapterContext, TaskAdapterControl } from "../src/tasks.js";
import { directTaskScope } from "./helpers/task-scope.js";

const roots: string[] = [];
const unrelated: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
  for (const child of unrelated.splice(0)) {
    if (!child.killed) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(source: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "ghost-native-task-jsonl-"));
  roots.push(root);
  const path = join(root, "harness");
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o700);
  return { root, path };
}

function context(controller = new AbortController()): {
  context: TaskAdapterContext;
  control(): TaskAdapterControl;
  controller: AbortController;
} {
  let registered: TaskAdapterControl | undefined;
  return {
    controller,
    context: {
      signal: controller.signal,
      scope: directTaskScope(),
      register(control) {
        if (registered) throw new Error("duplicate control");
        registered = control;
      },
      async emit() {},
    },
    control() {
      if (!registered) throw new Error("control was not registered");
      return registered;
    },
  };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
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
    if (Date.now() >= deadline) throw new Error("process did not publish its pid file");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("native task JSONL process", () => {
  it("registers synchronously, uses the exact cwd, and bounds valid frames", async () => {
    const { root, path } = executable(`
process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: "ready" }) + "\\n");
setInterval(() => {}, 1000);
`);
    const fixture = context();
    const processBoundary = new NativeTaskJsonlProcess(fixture.context);
    expect(fixture.control().quiescence).toBe(processBoundary.quiescence);

    processBoundary.start({
      executable: path,
      args: [],
      cwd: root,
      environment: { PATH: process.env.PATH },
    });
    await expect(processBoundary.receive()).resolves.toEqual({ cwd: root, value: "ready" });
    await processBoundary.finish();
    await expect(fixture.control().quiescence).resolves.toBeUndefined();
  });

  it("rejects hostile output generically and quiesces every resistant descendant", async () => {
    const { root, path } = executable(`
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
appendFileSync(process.env.PID_FILE, process.pid + " " + child.pid);
process.stderr.write("raw-secret-from-stderr");
process.stdout.write("{" + "x".repeat(${NATIVE_TASK_JSONL_MAX_FRAME_BYTES}) + "raw-secret-from-frame");
setInterval(() => {}, 1000);
`);
    const pidFile = join(root, "pids");
    const fixture = context();
    const processBoundary = new NativeTaskJsonlProcess(fixture.context);
    processBoundary.start({
      executable: path,
      args: [],
      cwd: root,
      environment: { PATH: process.env.PATH, PID_FILE: pidFile },
    });
    await waitForFile(pidFile);

    let thrown: unknown;
    try {
      await processBoundary.receive();
    } catch (error) {
      thrown = error;
    }
    await fixture.control().quiescence;
    const pids = readFileSync(pidFile, "utf8").split(/\s+/u).map(Number);
    expect(thrown).toMatchObject({ message: "Native task process failed." });
    expect(String((thrown as Error).message)).not.toContain("raw-secret");
    expect(pids.filter(pidExists)).toEqual([]);
  });

  it("pre-abort prevents spawn and force never touches an unrelated process", async () => {
    const { root, path } = executable(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.MARKER, "spawned");
`);
    const marker = join(root, "spawned");
    const controller = new AbortController();
    controller.abort();
    const fixture = context(controller);
    const processBoundary = new NativeTaskJsonlProcess(fixture.context);
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    unrelated.push(other);

    expect(() => processBoundary.start({
      executable: path,
      args: [],
      cwd: root,
      environment: { PATH: process.env.PATH, MARKER: marker },
    })).toThrow("Native task process failed.");
    await fixture.control().quiescence;
    expect(existsSync(marker)).toBe(false);
    expect(other.pid === undefined ? false : pidExists(other.pid)).toBe(true);
  });
});
