import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationIdentity } from "../src/conversation-identity.js";
import {
  captureNativeTaskControlEnvironment,
  nativeTaskScopeDescription,
  nativeTaskScopeUnit,
  SystemdNativeTaskScopeManager,
  type NativeTaskOwnershipReceipt,
} from "../src/native-task-scope.js";
import {
  TaskController,
  TaskStore,
  type TaskAdapter,
  type TaskBindingReceipt,
  type TaskRecord,
} from "../src/tasks.js";

const INTEGRATION_FLAG = "GHOST_NATIVE_TASK_SCOPE_INTEGRATION";
const INTEGRATION_UID = "GHOST_NATIVE_TASK_SCOPE_INTEGRATION_UID";
const OWNER_UID = "GHOST_NATIVE_TASK_SCOPE_OWNER_UID";
const CONTROL_OUTPUT_LIMIT = 8 * 1024;
const TASK_IDS = {
  lifecycle: "task-11111111-1111-4111-8111-111111111111",
  collision: "task-22222222-2222-4222-8222-222222222222",
  recovery: "task-33333333-3333-4333-8333-333333333333",
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real native-task integration requires ${name}`);
  return value;
}

function receipt(nonce: string): NativeTaskOwnershipReceipt {
  return { version: 1, kind: "systemd-scope", nonce };
}

function taskEnvironment(
  additions: Readonly<Record<string, string>> = {},
): Readonly<NodeJS.ProcessEnv> {
  return {
    HOME: required("HOME"),
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: required("XDG_RUNTIME_DIR"),
    DBUS_SESSION_BUS_ADDRESS: required("DBUS_SESSION_BUS_ADDRESS"),
    ...additions,
  };
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
    return !["X", "Z"].includes(stat.slice(close + 2, close + 3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(
  description: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

function run(
  executable: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  allowNonzero = false,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > CONTROL_OUTPUT_LIMIT) child.kill("SIGKILL");
      else target.push(value);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (bytes > CONTROL_OUTPUT_LIMIT) reject(new Error("control output exceeded bound"));
      else if (!allowNonzero && exitCode !== 0) {
        reject(new Error(error || "control command failed"));
      }
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), exitCode });
    });
  });
}

async function systemctl(args: readonly string[]): Promise<string> {
  return (await run(
    "/usr/bin/systemctl",
    ["--user", ...args],
    captureNativeTaskControlEnvironment(process.env),
    args.includes("show"),
  )).stdout;
}

function parseProperties(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of source.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1 || result.has(line.slice(0, separator))) {
      throw new Error("systemctl returned ambiguous properties");
    }
    result.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return result;
}

async function unitProperties(unit: string): Promise<Map<string, string>> {
  return parseProperties(await systemctl([
    "show",
    unit,
    "--property=LoadState",
    "--property=ActiveState",
    "--property=Description",
    "--property=ControlGroup",
    "--no-pager",
  ]));
}

async function unitAbsentOrInactive(unit: string): Promise<boolean> {
  try {
    const status = await unitProperties(unit);
    return status.get("LoadState") === "not-found"
      || status.get("ActiveState") === "inactive";
  } catch {
    return false;
  }
}

function lineFrom(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, value]);
      if (buffer.length > 64 * 1024) {
        reject(new Error("fixture output exceeded bound"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      child.stdout?.removeListener("data", onData);
      try {
        const parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("fixture output is not an object");
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("close", () => reject(new Error("fixture exited before output")));
  });
}

async function writeFixtures(root: string): Promise<{
  worker: string;
  delayedLauncher: string;
}> {
  const worker = join(root, "worker.py");
  const delayedLauncher = join(root, "delayed-launcher.py");
  await writeFile(worker, [
    "import json, os, signal, sys, time",
    "child = os.fork()",
    "if child == 0:",
    "    os.setsid()",
    "    grandchild = os.fork()",
    "    if grandchild > 0: os._exit(0)",
    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "    os.close(0); os.close(1); os.close(2)",
    "    with open(os.environ['GHOST_DESCENDANT_PID'], 'w') as target: target.write(str(os.getpid()))",
    "    while True: time.sleep(1)",
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "line = sys.stdin.readline()",
    "print(json.dumps({'pid': os.getpid(), 'cwd': os.getcwd(), 'argv': sys.argv[1:], 'marker': os.environ.get('GHOST_LITERAL_MARKER'), 'provider': os.environ.get('OPENAI_API_KEY'), 'input': json.loads(line)}), flush=True)",
    "while True: time.sleep(1)",
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(delayedLauncher, [
    "import os, sys, time",
    "time.sleep(0.25)",
    "os.execve(sys.argv[1], sys.argv[1:], os.environ)",
    "",
  ].join("\n"), { mode: 0o700 });
  return { worker, delayedLauncher };
}

async function proveLifecycle(
  root: string,
  worker: string,
  ownedUnits: Set<string>,
  sentinels: ChildProcess[],
): Promise<void> {
  const taskId = TASK_IDS.lifecycle;
  const ownership = receipt("11111111111111111111111111111111");
  const unit = nativeTaskScopeUnit(taskId);
  ownedUnits.add(unit);
  const descendantPidFile = join(root, "descendant.pid");
  const sentinel = spawn("/usr/bin/python3", [
    "-c",
    "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)",
  ], { stdio: "ignore" });
  sentinels.push(sentinel);
  assert.ok(sentinel.pid);

  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  const scope = await manager.reserve(taskId, ownership, new AbortController().signal);
  const child = scope.spawn({
    executable: "/usr/bin/python3",
    args: [worker, "literal argument", "--looks=like-option"],
    cwd: root,
    environment: {
      PATH: "/usr/bin",
      HOME: required("HOME"),
      XDG_RUNTIME_DIR: required("XDG_RUNTIME_DIR"),
      DBUS_SESSION_BUS_ADDRESS: required("DBUS_SESSION_BUS_ADDRESS"),
      GHOST_DESCENDANT_PID: descendantPidFile,
      GHOST_LITERAL_MARKER: "literal value with spaces",
    },
  });
  child.stdin?.write(`${JSON.stringify({ ping: "literal" })}\n`);
  const output = await lineFrom(child);
  assert.equal(output.cwd, root);
  assert.deepEqual(output.argv, ["literal argument", "--looks=like-option"]);
  assert.equal(output.marker, "literal value with spaces");
  assert.equal(output.provider, null);
  assert.deepEqual(output.input, { ping: "literal" });
  const workerPid = Number(output.pid);
  await waitFor("double-fork descendant pid", async () => {
    try { return (await readFile(descendantPidFile, "utf8")).trim().length > 0; } catch { return false; }
  });
  const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim());
  assert.ok(Number.isInteger(workerPid) && Number.isInteger(descendantPid));
  const properties = await unitProperties(unit);
  assert.equal(properties.get("Description"), nativeTaskScopeDescription(taskId, ownership));
  const controlGroup = properties.get("ControlGroup");
  if (!controlGroup?.startsWith("/")) throw new Error("scope has no exact cgroup");
  for (const pid of [workerPid, descendantPid]) {
    const cgroup = (await readFile(`/proc/${pid}/cgroup`, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    assert.equal(cgroup, controlGroup);
  }

  await scope.stopAndConfirm();
  await waitFor("scope processes to stop", () =>
    !pidExists(workerPid) && !pidExists(descendantPid));
  assert.equal(pidExists(sentinel.pid!), true);
  assert.equal(await unitAbsentOrInactive(unit), true);
  ownedUnits.delete(unit);
}

async function proveCollision(
  root: string,
  ownedUnits: Set<string>,
  sentinels: ChildProcess[],
): Promise<void> {
  const taskId = TASK_IDS.collision;
  const ownership = receipt("22222222222222222222222222222222");
  const unit = nativeTaskScopeUnit(taskId);
  ownedUnits.add(unit);
  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  const reserved = await manager.reserve(taskId, ownership, new AbortController().signal);
  const foreignPid = join(root, "foreign.pid");
  const foreign = spawn("/usr/bin/systemd-run", [
    "--user",
    "--scope",
    `--unit=${unit}`,
    "--description=foreign-native-task-owner",
    "--collect",
    "--quiet",
    "--pipe",
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    "--property=TimeoutStopSec=1s",
    "--",
    "/usr/bin/python3",
    "-c",
    "import os,signal,time; open(os.environ['PID_FILE'],'w').write(str(os.getpid())); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)",
  ], {
    cwd: root,
    env: taskEnvironment({ PID_FILE: foreignPid }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  sentinels.push(foreign);
  await waitFor("foreign collision unit", async () => {
    try {
      return (await unitProperties(unit)).get("Description") === "foreign-native-task-owner";
    } catch { return false; }
  });
  const rejectedLauncher = reserved.spawn({
    executable: "/usr/bin/python3",
    args: ["-c", "time.sleep(3600)"],
    cwd: root,
    environment: taskEnvironment(),
  });
  rejectedLauncher.stderr?.resume();
  await assert.rejects(reserved.stopAndConfirm(), { code: "collision" });
  const foreignWorker = Number((await readFile(foreignPid, "utf8")).trim());
  assert.equal(pidExists(foreignWorker), true);
  assert.equal((await unitProperties(unit)).get("Description"), "foreign-native-task-owner");
  await systemctl(["stop", "--no-block", unit]);
  await waitFor("foreign unit cleanup", () => unitAbsentOrInactive(unit));
  const retried = await manager.reserve(taskId, ownership, new AbortController().signal);
  await retried.stopAndConfirm();
  ownedUnits.delete(unit);
}

function taskRecord(
  root: string,
  taskId: string,
  ownership: NativeTaskOwnershipReceipt,
): TaskRecord {
  const timestamp = new Date().toISOString();
  const binding: TaskBindingReceipt = {
    version: 1,
    root,
    rootIdentity: "integration-root",
    cwd: root,
    cwdIdentity: "integration-cwd",
    generation: 1,
  };
  return {
    version: 2,
    id: taskId,
    generation: 1,
    parent: conversationIdentity("pi", "real-systemd-recovery"),
    harness: "integration",
    agent: null,
    task: "Recover the real systemd scope.",
    binding,
    ownership,
    state: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
    eventCursor: { nextSequence: 1, dropped: 0 },
    result: null,
    resultTruncated: false,
    error: null,
  };
}

async function proveCrashRecovery(
  root: string,
  ownedUnits: Set<string>,
): Promise<void> {
  const taskId = TASK_IDS.recovery;
  const ownership = receipt("33333333333333333333333333333333");
  const unit = nativeTaskScopeUnit(taskId);
  ownedUnits.add(unit);
  const firstManager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  const abandoned = await firstManager.reserve(
    taskId,
    ownership,
    new AbortController().signal,
  );
  const launcher = abandoned.spawn({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)",
    ],
    cwd: root,
    environment: taskEnvironment(),
  });
  launcher.stderr?.resume();
  await waitFor("recoverable scope", async () => {
    try {
      return (await unitProperties(unit)).get("Description")
        === nativeTaskScopeDescription(taskId, ownership);
    } catch { return false; }
  });

  const ghostHome = join(root, "recovery-home");
  await mkdir(ghostHome, { mode: 0o700 });
  const store = new TaskStore(ghostHome);
  await store.initialize();
  await store.write(taskRecord(root, taskId, ownership));
  const recoveryManager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  const controller = new TaskController(
    store,
    new Map(),
    {
      async revalidate(value) { return value; },
      async launchNative(value, _signal, _parent, launch) { return launch(value); },
    },
    recoveryManager,
  );
  await controller.initialize();
  const recovered = await store.read(taskId);
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.state, "interrupted");
  assert.deepEqual(recovered.ownership, ownership);
  assert.deepEqual(recovered.error, {
    code: "daemon_restarted",
    message: "The daemon restarted before the task became quiescent.",
  });
  assert.equal(await unitAbsentOrInactive(unit), true);
  ownedUnits.delete(unit);
  await store.dispose();
}

async function proveImmediateCancellation(
  root: string,
  delayedLauncher: string,
  ownedUnits: Set<string>,
): Promise<void> {
  const registrationSpawned = Promise.withResolvers<void>();
  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
    spawnChild: ((command: string, args: string[], options: SpawnOptions) => {
      const child = spawn("/usr/bin/python3", [delayedLauncher, command, ...args], options);
      registrationSpawned.resolve();
      return child;
    }) as typeof spawn,
  });
  const never = new Promise<string>(() => undefined);
  const adapter: TaskAdapter = {
    start(_input, context) {
      const quiet = Promise.withResolvers<void>();
      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= context.stopNative()
          .then(quiet.resolve, (error) => {
            quiet.reject(error);
            throw error;
          });
        return stopping;
      };
      context.register({ force: stop, quiescence: quiet.promise });
      return context.launchNative((spawn) => spawn({
          executable: "/usr/bin/python3",
          args: [
            "-c",
            "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)",
          ],
          cwd: root,
          environment: taskEnvironment(),
        })).then(() => ({ result: never, async followUp() {} }));
    },
  };
  const ghostHome = join(root, "cancel-home");
  await mkdir(ghostHome, { mode: 0o700 });
  const store = new TaskStore(ghostHome);
  const controller = new TaskController(
    store,
    new Map([["integration", adapter]]),
    {
      async revalidate(value) { return value; },
      async launchNative(value, _signal, _parent, launch) { return launch(value); },
    },
    manager,
  );
  await controller.initialize();
  const binding: TaskBindingReceipt = {
    version: 1,
    root,
    rootIdentity: "integration-root",
    cwd: root,
    cwdIdentity: "integration-cwd",
    generation: 1,
  };
  const task = await controller.start({
    parent: conversationIdentity("pi", "immediate-registration-cancel"),
    harness: "integration",
    task: "Cancel during systemd registration.",
    binding,
  });
  const unit = nativeTaskScopeUnit(task.id);
  ownedUnits.add(unit);
  await registrationSpawned.promise;
  const cancelled = await controller.cancel(task.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(await unitAbsentOrInactive(unit), true);
  ownedUnits.delete(unit);
  await controller.dispose();
}

async function main(): Promise<void> {
  assert.equal(required(INTEGRATION_FLAG), "1");
  assert.equal(required("CI"), "true");
  assert.equal(required("GITHUB_ACTIONS"), "true");
  const uid = process.getuid?.();
  assert.ok(uid !== undefined && uid > 0, "integration must run as a dedicated non-root UID");
  assert.equal(String(uid), required(INTEGRATION_UID));
  assert.notEqual(String(uid), required(OWNER_UID));
  assert.equal((await readFile("/proc/1/comm", "utf8")).trim(), "systemd");
  const runtime = required("XDG_RUNTIME_DIR");
  assert.equal(runtime, `/run/user/${uid}`);
  assert.equal(required("DBUS_SESSION_BUS_ADDRESS"), `unix:path=${runtime}/bus`);
  const [runtimeStats, busStats, homeStats] = await Promise.all([
    lstat(runtime),
    lstat(join(runtime, "bus")),
    lstat(required("HOME")),
  ]);
  assert.equal(runtimeStats.uid, uid);
  assert.equal(homeStats.uid, uid);
  assert.equal(busStats.isSocket(), true);
  const version = await run("/usr/bin/systemctl", ["--version"], { PATH: "/usr/bin" });
  const parsedVersion = /^systemd ([0-9]+)$/mu.exec(version.stdout)?.[1];
  assert.ok(parsedVersion && Number(parsedVersion) >= 254);
  await systemctl(["show-environment"]);

  const root = await mkdtemp(join(tmpdir(), "ghost-real-native-task-"));
  await chmod(root, 0o700);
  const ownedUnits = new Set<string>();
  const sentinels: ChildProcess[] = [];
  try {
    const fixtures = await writeFixtures(root);
    await proveLifecycle(root, fixtures.worker, ownedUnits, sentinels);
    await proveCollision(root, ownedUnits, sentinels);
    await proveCrashRecovery(root, ownedUnits);
    await proveImmediateCancellation(root, fixtures.delayedLauncher, ownedUnits);
  } finally {
    for (const unit of ownedUnits) {
      await systemctl(["stop", "--no-block", unit]).catch(() => undefined);
      await waitFor(`cleanup ${unit}`, () => unitAbsentOrInactive(unit)).catch(() => undefined);
    }
    for (const child of sentinels) {
      if (child.pid !== undefined && pidExists(child.pid)) child.kill("SIGKILL");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    await rm(root, { recursive: true, force: true });
  }
  process.stdout.write("real native-task systemd scope integration passed\n");
}

await main();
