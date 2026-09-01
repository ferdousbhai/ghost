import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function status(
  load: string,
  active: string,
  description = load === "not-found" ? UNIT : "",
  id = UNIT,
): string {
  return `Id=${id}\nLoadState=${load}\nActiveState=${active}\nDescription=${description}\n`;
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
    expect(controlCalls.find((call) => call.args.includes("show"))?.args).toEqual([
      "--user",
      "show",
      UNIT,
      "--property=Id",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=Description",
      "--no-pager",
    ]);
    expect(controlCalls.every((call) =>
      Object.keys(call.environment).sort().join(",")
        === "DBUS_SESSION_BUS_ADDRESS,XDG_RUNTIME_DIR")).toBe(true);
  });

  it("preserves JSONL stdio through a synchronous scope wrapper without --pipe", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-task-scope-stdio-"));
    roots.push(root);
    const wrapper = join(root, "systemd-run-wrapper.mjs");
    const worker = join(root, "worker.mjs");
    writeFileSync(wrapper, [
      'import { spawn } from "node:child_process";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--pipe")) process.exit(91);',
      'const separator = args.indexOf("--");',
      "const child = spawn(args[separator + 1], args.slice(separator + 2), {",
      "  cwd: process.cwd(), env: process.env, stdio: ['inherit', 'inherit', 'inherit'],",
      "});",
      "child.once('error', () => process.exit(92));",
      "child.once('close', (code, signal) => {",
      "  if (signal) process.kill(process.pid, signal);",
      "  else process.exit(code ?? 93);",
      "});",
    ].join("\n"));
    writeFileSync(worker, [
      'import { createInterface } from "node:readline";',
      "for await (const line of createInterface({ input: process.stdin })) {",
      "  const frame = JSON.parse(line);",
      '  process.stderr.write("e".repeat(1024));',
      "  process.stdout.write(JSON.stringify({ cwd: process.cwd(), frame }) + '\\n');",
      "  break;",
      "}",
    ].join("\n"));

    let state: "absent" | "active" = "absent";
    let launchArgs: string[] = [];
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl: async () => ({
        stdout: state === "absent"
          ? status("not-found", "inactive")
          : status("loaded", "active", DESCRIPTION),
        exitCode: 0,
      }),
      spawnChild: ((command: string, args: string[], options: SpawnOptions) => {
        expect(command).toBe("/usr/bin/systemd-run");
        launchArgs = [...args];
        state = "active";
        const child = spawn(process.execPath, [wrapper, ...args], options);
        child.once("close", () => { state = "absent"; });
        children.push(child);
        return child;
      }) as typeof spawn,
    });
    const scope = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    const child = scope.spawn({
      executable: process.execPath,
      args: [worker],
      cwd: root,
      environment: { PATH: process.env.PATH },
    });
    const stdout = new Promise<Record<string, unknown>>((resolve, reject) => {
      let source = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        source += chunk.toString();
        if (Buffer.byteLength(source) > 4 * 1024) reject(new Error("stdout exceeded bound"));
        const newline = source.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(source.slice(0, newline)));
      });
      child.once("error", reject);
      child.once("close", () => {
        if (!source.includes("\n")) reject(new Error("wrapper exited before JSONL output"));
      });
    });
    const stderr = new Promise<string>((resolve, reject) => {
      let source = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        source += chunk.toString();
        if (Buffer.byteLength(source) > 1024) reject(new Error("stderr exceeded bound"));
      });
      child.once("error", reject);
      child.once("close", () => resolve(source));
    });
    child.stdin?.end(`${JSON.stringify({ ping: "literal" })}\n`);

    await expect(stdout).resolves.toEqual({ cwd: root, frame: { ping: "literal" } });
    await expect(stderr).resolves.toBe("e".repeat(1024));
    expect(launchArgs).not.toContain("--pipe");
    await scope.stopAndConfirm();
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
      await expect(manager.recoverAndConfirm(TASK_ID, RECEIPT))
        .rejects.toThrow(/ownership|scope/u);
      expect(spawned).toBe(false);
      expect(calls.some((call) => call.includes("stop"))).toBe(false);
    }
    expect(() => nativeTaskScopeUnit("task-not-a-uuid")).toThrow(/identity/u);
  });

  it("treats every loaded unit as a reservation collision, including its own receipt", async () => {
    let spawned = false;
    let stopped = false;
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl: async (args) => {
        if (args.includes("stop")) stopped = true;
        return { stdout: status("loaded", "inactive", DESCRIPTION), exitCode: 0 };
      },
      spawnChild: (() => { spawned = true; throw new Error("must not spawn"); }) as typeof spawn,
    });
    await expect(manager.reserve(TASK_ID, RECEIPT, new AbortController().signal))
      .rejects.toMatchObject({ code: "collision" });
    expect(spawned).toBe(false);
    expect(stopped).toBe(false);
  });

  it("accepts the exact absent systemd stub independent of property order", async () => {
    const manager = new SystemdNativeTaskScopeManager({
      controlEnvironment: {},
      runControl: async () => ({
        stdout: `Description=${UNIT}\nActiveState=inactive\nId=${UNIT}\nLoadState=not-found\n`,
        exitCode: 0,
      }),
    });
    const scope = await manager.reserve(TASK_ID, RECEIPT, new AbortController().signal);
    await scope.stopAndConfirm();
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
        return { stdout: status("not-found", "inactive"), exitCode: 0 };
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
          ? { stdout: status("not-found", "inactive"), exitCode: 0 }
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
    const malformed: Array<{ stdout: string; exitCode: number }> = [
      { stdout: "", exitCode: 0 },
      { stdout: "Id=missing-properties\n", exitCode: 0 },
      { stdout: status("loaded", "unknown", DESCRIPTION), exitCode: 0 },
      { stdout: status("failed", "inactive", DESCRIPTION), exitCode: 0 },
      { stdout: status("not-found", "inactive", ""), exitCode: 0 },
      { stdout: status("not-found", "inactive", DESCRIPTION), exitCode: 0 },
      { stdout: status("not-found", "inactive", "foreign"), exitCode: 0 },
      { stdout: status("not-found", "active"), exitCode: 0 },
      { stdout: status("not-found", "inactive", UNIT, "foreign.scope"), exitCode: 0 },
      { stdout: status("loaded", "active", DESCRIPTION, "foreign.scope"), exitCode: 0 },
      {
        stdout: `${status("loaded", "active", DESCRIPTION)}Description=${DESCRIPTION}\n`,
        exitCode: 0,
      },
      {
        stdout: `${status("loaded", "active", DESCRIPTION)}Unexpected=value\n`,
        exitCode: 0,
      },
      {
        stdout: status("loaded", "active", "x".repeat(513)),
        exitCode: 0,
      },
      { stdout: `${"x".repeat(4_097)}\n`, exitCode: 0 },
      { stdout: status("not-found", "inactive").replace("\n", "\r\n"), exitCode: 0 },
      { stdout: status("not-found", "inactive").replace("Id=", "Id=\0"), exitCode: 0 },
      { stdout: status("not-found", "inactive"), exitCode: 4 },
      { stdout: status("loaded", "active", DESCRIPTION), exitCode: 1 },
    ];
    for (const result of malformed) {
      const manager = new SystemdNativeTaskScopeManager({
        controlEnvironment: {},
        runControl: async () => result,
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
        exitCode: 0,
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
