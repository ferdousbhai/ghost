import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeTaskScopeUnit,
  nativeTaskScopeDescription,
  SystemdNativeTaskScopeManager,
  type NativeTaskControlRunner,
} from "../src/native-task-scope.js";

const TASK_ID = "task-11111111-1111-4111-8111-111111111111";
const UNIT = "ghost-task-11111111-1111-4111-8111-111111111111.scope";
const RECEIPT = {
  version: 1,
  kind: "systemd-scope",
  nonce: "11111111111111111111111111111111",
} as const;
const DESCRIPTION = nativeTaskScopeDescription(TASK_ID, RECEIPT);
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && pidExists(child.pid)) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

async function eventuallyStopped(pids: number[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (pids.some(pidExists)) {
    if (Date.now() >= deadline) throw new Error("test scope did not quiesce");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function status(load: string, active: string, description = ""): string {
  return `LoadState=${load}\nActiveState=${active}\nDescription=${description}\n`;
}

describe("systemd native task scope ownership", () => {
  it("derives one exact unit and launches literal argv, cwd, and bounded environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-task-scope-"));
    roots.push(root);
    let state: "absent" | "active" | "inactive" = "absent";
    let spawned: ChildProcess | undefined;
    const controlCalls: Array<{ args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
    const runControl: NativeTaskControlRunner = async (args, environment) => {
      controlCalls.push({ args: [...args], environment: { ...environment } });
      if (args.includes("stop")) {
        if (spawned?.pid !== undefined) spawned.kill("SIGKILL");
        state = "inactive";
        return { stdout: "", exitCode: 0 };
      }
      return {
        stdout: state === "absent"
          ? status("not-found", "inactive")
          : status("loaded", state, DESCRIPTION),
        exitCode: 0,
      };
    };
    const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    const spawnChild = ((command: string, args: string[], options: SpawnOptions) => {
      launches.push({ command, args: [...args], options });
      const separator = args.indexOf("--");
      spawned = spawn(args[separator + 1]!, args.slice(separator + 2), {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio,
      });
      children.push(spawned);
      state = "active";
      return spawned;
    }) as typeof spawn;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/bus",
        XDG_RUNTIME_DIR: "/private/runtime",
        OPENAI_API_KEY: "must-not-cross-control-boundary",
      },
      runControl,
      spawnChild,
    });

    const scope = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    expect(scope.unit).toBe(UNIT);
    scope.spawn({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)", "literal argument"],
      cwd: root,
      environment: { PATH: process.env.PATH, GHOST_TEST_VALUE: "literal value" },
    });
    expect(launches[0]).toMatchObject({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        `--unit=${UNIT}`,
        `--description=${DESCRIPTION}`,
        "--slice-inherit",
        "--collect",
        "--quiet",
        "--pipe",
        "--expand-environment=no",
        `--working-directory=${root}`,
        "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes",
        "--property=TimeoutStopSec=1s",
        "--",
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
        "literal argument",
      ],
      options: {
        cwd: root,
        env: { PATH: process.env.PATH, GHOST_TEST_VALUE: "literal value" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    });
    await scope.stopAndConfirm();
    expect(controlCalls.some((call) => call.args.includes("stop"))).toBe(true);
    expect(controlCalls.every((call) =>
      Object.keys(call.environment).sort().join(",")
        === "DBUS_SESSION_BUS_ADDRESS,XDG_RUNTIME_DIR")).toBe(true);
  });

  it("models control-group teardown of a setsid resistant descendant without touching a sentinel", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-task-scope-tree-"));
    roots.push(root);
    const pidFile = join(root, "pids");
    let state: "absent" | "active" | "inactive" = "absent";
    let ownedPids: number[] = [];
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(unrelated);
    const runControl: NativeTaskControlRunner = async (args) => {
      if (args.includes("stop")) {
        ownedPids = readFileSync(pidFile, "utf8").trim().split(/\s+/u).map(Number);
        for (const pid of ownedPids) {
          try { process.kill(pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        state = "inactive";
        return { stdout: "", exitCode: 0 };
      }
      return {
        stdout: state === "absent"
          ? status("not-found", "inactive")
          : status("loaded", state, DESCRIPTION),
        exitCode: 0,
      };
    };
    const spawnChild = ((_command: string, args: string[], options: SpawnOptions) => {
      const separator = args.indexOf("--");
      const child = spawn(args[separator + 1]!, args.slice(separator + 2), {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio,
      });
      children.push(child);
      state = "active";
      return child;
    }) as typeof spawn;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl,
      spawnChild,
    });
    const source = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { detached: true, stdio: 'ignore' });",
      "writeFileSync(process.env.PID_FILE, process.pid + ' ' + child.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const scope = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    scope.spawn({
      executable: process.execPath,
      args: ["-e", source],
      cwd: root,
      environment: { PATH: process.env.PATH, PID_FILE: pidFile },
    });
    const deadline = Date.now() + 2_000;
    while (true) {
      try { if (readFileSync(pidFile, "utf8").trim() !== "") break; } catch {}
      if (Date.now() >= deadline) throw new Error("owned processes did not start");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await scope.stopAndConfirm();
    await eventuallyStopped(ownedPids);
    expect(unrelated.pid === undefined ? false : pidExists(unrelated.pid)).toBe(true);
  });

  it("rejects existing or ambiguous scope state without launching or stopping it", async () => {
    for (const stdout of [
      status("loaded", "active", "foreign"),
      "LoadState=loaded\n",
    ]) {
      const calls: string[][] = [];
      let spawned = false;
      const manager = new SystemdNativeTaskScopeManager({
        controlEnvironment: {},
        runControl: async (args) => {
          calls.push([...args]);
          return { stdout, exitCode: 0 };
        },
        spawnChild: (() => { spawned = true; throw new Error("must not spawn"); }) as typeof spawn,
      });
      await expect(manager.reserve(TASK_ID, RECEIPT, new AbortController().signal))
        .rejects.toThrow(/ownership|scope/u);
      await expect(manager.stopAndConfirm(TASK_ID, RECEIPT)).rejects.toThrow(/ownership|scope/u);
      expect(spawned).toBe(false);
      expect(calls.some((call) => call.includes("stop"))).toBe(false);
    }
    expect(() => nativeTaskScopeUnit("task-not-a-uuid")).toThrow(/identity/u);
  });

  it("never confirms an active scope after a control or status failure", async () => {
    let reads = 0;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      confirmationTimeoutMs: 0,
      runControl: async (args) => {
        if (args.includes("stop")) throw new Error("private bus failure");
        reads += 1;
        return { stdout: status("loaded", "active", DESCRIPTION), exitCode: 0 };
      },
    });
    await expect(manager.recoverAndConfirm(TASK_ID, RECEIPT)).rejects.toThrow(/ownership/u);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("waits for registration settlement before accepting a missing spawned scope", async () => {
    let child: ChildProcess | undefined;
    let stopped = false;
    let reads = 0;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl: async (args) => {
        if (args.includes("stop")) stopped = true;
        else reads += 1;
        return { stdout: status("not-found", "inactive"), exitCode: 4 };
      },
      spawnChild: ((_command: string, _args: string[], options: SpawnOptions) => {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          cwd: options.cwd,
          env: options.env,
          stdio: options.stdio,
        });
        children.push(child);
        return child;
      }) as typeof spawn,
    });
    const scope = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    const taskAbort = new AbortController();
    scope.spawn({
      executable: process.execPath,
      args: ["-e", ""],
      cwd: tmpdir(),
      environment: {},
      signal: taskAbort.signal,
    });
    taskAbort.abort();
    let settled = false;
    const stopping = scope.stopAndConfirm().then(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(child?.killed).toBe(false);
    expect(stopped).toBe(false);
    child?.kill("SIGKILL");
    await stopping;
    expect(reads).toBeGreaterThanOrEqual(2);

    const reused = await manager.reserve(
      TASK_ID,
      RECEIPT,
      new AbortController().signal,
    );
    await reused.stopAndConfirm();
  });

  it("uses the receipt description to reject a registration collision without signaling it", async () => {
    let state = "absent";
    let stops = 0;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl: async (args) => {
        if (args.includes("stop")) stops += 1;
        return state === "absent"
          ? { stdout: status("not-found", "inactive"), exitCode: 4 }
          : { stdout: status("loaded", "active", "foreign-owner"), exitCode: 0 };
      },
      spawnChild: ((_command: string, _args: string[], options: SpawnOptions) => {
        state = "foreign";
        const child = spawn(process.execPath, ["-e", ""], {
          cwd: options.cwd,
          env: options.env,
          stdio: options.stdio,
        });
        children.push(child);
        return child;
      }) as typeof spawn,
    });
    const scope = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    scope.spawn({
      executable: process.execPath,
      args: ["-e", ""],
      cwd: tmpdir(),
      environment: {},
    });
    await expect(scope.stopAndConfirm()).rejects.toMatchObject({ code: "collision" });
    expect(stops).toBe(0);
    state = "absent";
    const retried = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    await retried.stopAndConfirm();
  });

  it("strictly rejects malformed or ambiguous systemctl properties", async () => {
    const malformed = [
      "LoadState=loaded\nActiveState=active\n",
      status("loaded", "unknown", DESCRIPTION),
      status("not-found", "inactive", DESCRIPTION),
      `${status("loaded", "active", DESCRIPTION)}Description=${DESCRIPTION}\n`,
      `LoadState=loaded\nActiveState=active\nDescription=${"x".repeat(513)}\n`,
      `${"x".repeat(4_097)}\n`,
    ];
    for (const stdout of malformed) {
      const manager = new SystemdNativeTaskScopeManager({
        controlEnvironment: {},
        runControl: async () => ({ stdout, exitCode: 0 }),
      });
      await expect(manager.reserve(TASK_ID, RECEIPT, new AbortController().signal))
        .rejects.toThrow(/ownership/u);
    }
  });

  it("clears a failed spawn reservation so an absent unit can be retried", async () => {
    let shouldFail = true;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl: async () => ({
        stdout: status("not-found", "inactive"),
        exitCode: 4,
      }),
      spawnChild: ((_command: string, _args: string[], options: SpawnOptions) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("registration failed");
        }
        const child = spawn(process.execPath, ["-e", ""], {
          cwd: options.cwd,
          env: options.env,
          stdio: options.stdio,
        });
        children.push(child);
        return child;
      }) as typeof spawn,
    });
    const first = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    expect(() => first.spawn({
      executable: process.execPath,
      args: [],
      cwd: tmpdir(),
      environment: {},
    })).toThrow(/ownership/u);
    const second = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    await second.stopAndConfirm();
  });
});
