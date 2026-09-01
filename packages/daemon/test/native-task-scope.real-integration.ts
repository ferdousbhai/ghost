import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationIdentity } from "../src/conversation-identity.js";
import { resolveNativeHarnessExecutable } from "../src/native-harness-identity.js";
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
import { parseSupportedSystemdMajor } from "./native-task-scope-integration-version.js";

const INTEGRATION_FLAG = "GHOST_NATIVE_TASK_SCOPE_INTEGRATION";
const INTEGRATION_UID = "GHOST_NATIVE_TASK_SCOPE_INTEGRATION_UID";
const CONTROLLER_UNIT = "GHOST_NATIVE_TASK_SCOPE_CONTROLLER_UNIT";
const CONTROLLER_DESCRIPTION = "GHOST_NATIVE_TASK_SCOPE_CONTROLLER_DESCRIPTION";
const CRASH_CONTROLLER_MODE = "--crash-controller";
const CONTROL_OUTPUT_LIMIT = 8 * 1024;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real native-task integration requires ${name}`);
  return value;
}

function receipt(nonce: string): NativeTaskOwnershipReceipt {
  return { version: 1, kind: "systemd-scope", nonce };
}

function randomReceipt(): NativeTaskOwnershipReceipt {
  return receipt(randomBytes(16).toString("hex"));
}

function randomTaskId(): string {
  return `task-${randomUUID()}`;
}

function randomService(prefix: string): { unit: string; description: string } {
  const identity = randomUUID();
  return {
    unit: `${prefix}-${identity}.service`,
    description: `${prefix}-receipt:v1:${identity}`,
  };
}

function expectedControllerDescription(unit: string): string {
  const workflow = /^ghost-native-task-ci-([1-9][0-9]{0,19})-([1-9][0-9]{0,4})-([0-9a-f]{32})\.service$/u.exec(unit);
  if (workflow) {
    return `ghost-native-task-ci-receipt:v1:${workflow[1]}:${workflow[2]}:${workflow[3]}`;
  }
  const crash = /^ghost-native-task-crash-controller-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.service$/u.exec(unit);
  if (crash) return `ghost-native-task-crash-controller-receipt:v1:${crash[1]}`;
  throw new Error("integration controller identity is invalid");
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
    "--property=MainPID",
    "--no-pager",
  ]));
}

async function unitAbsent(unit: string): Promise<boolean> {
  try {
    const status = await unitProperties(unit);
    return status.get("LoadState") === "not-found";
  } catch {
    return false;
  }
}

async function assertUnitAbsent(unit: string): Promise<void> {
  assert.equal((await unitProperties(unit)).get("LoadState"), "not-found");
}

type OwnedUnits = Map<string, string>;

async function processControlGroup(pid: number): Promise<string | undefined> {
  return (await readFile(`/proc/${pid}/cgroup`, "utf8"))
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
}

async function assertOwnedUnit(
  unit: string,
  description: string,
  expectedPid?: number,
): Promise<Map<string, string>> {
  const properties = await unitProperties(unit);
  assert.equal(properties.get("LoadState"), "loaded");
  assert.equal(properties.get("ActiveState"), "active");
  assert.equal(properties.get("Description"), description);
  const controlGroup = properties.get("ControlGroup");
  if (!controlGroup?.startsWith("/")) throw new Error("unit has no exact cgroup");
  if (expectedPid !== undefined) {
    assert.equal(Number(properties.get("MainPID")), expectedPid);
    assert.equal(await processControlGroup(expectedPid), controlGroup);
  }
  return properties;
}

async function startOwnedService(
  ownedUnits: OwnedUnits,
  unit: string,
  description: string,
  command: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = taskEnvironment(),
): Promise<void> {
  await assertUnitAbsent(unit);
  ownedUnits.set(unit, description);
  await run("/usr/bin/systemd-run", [
    "--user",
    `--unit=${unit}`,
    `--description=${description}`,
    "--service-type=exec",
    "--slice=session.slice",
    "--collect",
    "--quiet",
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    "--property=TimeoutStopSec=1s",
    "--",
    ...command,
  ], environment);
}

async function stopOwnedUnit(
  ownedUnits: OwnedUnits,
  unit: string,
): Promise<void> {
  const description = ownedUnits.get(unit);
  if (!description) throw new Error("cleanup unit is not recorded");
  let properties = await unitProperties(unit);
  if (properties.get("LoadState") === "not-found") {
    ownedUnits.delete(unit);
    return;
  }
  assert.equal(properties.get("Description"), description);
  await systemctl(["stop", unit]);
  properties = await unitProperties(unit);
  if (properties.get("LoadState") !== "not-found") {
    assert.equal(properties.get("Description"), description);
    await systemctl(["reset-failed", unit]);
  }
  await waitFor(`cleanup ${unit}`, () => unitAbsent(unit));
  ownedUnits.delete(unit);
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

interface Sentinel {
  unit: string;
  description: string;
  pid: number;
}

async function startSentinel(root: string, ownedUnits: OwnedUnits): Promise<Sentinel> {
  const { unit, description } = randomService("ghost-native-task-sentinel");
  const pidFile = join(root, "sentinel.pid");
  await startOwnedService(ownedUnits, unit, description, [
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    `PID_FILE=${pidFile}`,
    "/usr/bin/python3",
    "-c",
    "import os,signal,time; open(os.environ['PID_FILE'],'w').write(str(os.getpid())); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)",
  ]);
  await waitFor("sentinel pid", async () => {
    try { return (await readFile(pidFile, "utf8")).trim().length > 0; }
    catch { return false; }
  });
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  await assertOwnedUnit(unit, description, pid);
  return { unit, description, pid };
}

async function assertSentinel(sentinel: Sentinel): Promise<void> {
  assert.equal(pidExists(sentinel.pid), true);
  await assertOwnedUnit(sentinel.unit, sentinel.description, sentinel.pid);
}

async function proveLifecycle(
  root: string,
  worker: string,
  ownedUnits: OwnedUnits,
): Promise<void> {
  const taskId = randomTaskId();
  const ownership = randomReceipt();
  const unit = nativeTaskScopeUnit(taskId);
  await assertUnitAbsent(unit);
  ownedUnits.set(unit, nativeTaskScopeDescription(taskId, ownership));
  const descendantPidFile = join(root, "descendant.pid");

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
    assert.equal(await processControlGroup(pid), controlGroup);
  }

  await scope.stopAndConfirm();
  await waitFor("scope processes to stop", () =>
    !pidExists(workerPid) && !pidExists(descendantPid));
  await waitFor("scope collection", () => unitAbsent(unit));
  ownedUnits.delete(unit);
}

async function proveCollision(
  root: string,
  ownedUnits: OwnedUnits,
): Promise<void> {
  const taskId = randomTaskId();
  const ownership = randomReceipt();
  const unit = nativeTaskScopeUnit(taskId);
  await assertUnitAbsent(unit);
  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  const reserved = await manager.reserve(taskId, ownership, new AbortController().signal);
  const foreignPid = join(root, "foreign.pid");
  const foreignDescription = `foreign-native-task-owner:${randomUUID()}`;
  ownedUnits.set(unit, foreignDescription);
  const foreign = spawn("/usr/bin/systemd-run", [
    "--user",
    "--scope",
    `--unit=${unit}`,
    `--description=${foreignDescription}`,
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
  foreign.stderr?.resume();
  await waitFor("foreign collision unit", async () => {
    try {
      return (await unitProperties(unit)).get("Description") === foreignDescription;
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
  assert.equal((await unitProperties(unit)).get("Description"), foreignDescription);
  await stopOwnedUnit(ownedUnits, unit);
  const retried = await manager.reserve(taskId, ownership, new AbortController().signal);
  await retried.stopAndConfirm();
  await assertUnitAbsent(unit);
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
  ownedUnits: OwnedUnits,
): Promise<void> {
  const taskId = randomTaskId();
  const ownership = randomReceipt();
  const unit = nativeTaskScopeUnit(taskId);
  const description = nativeTaskScopeDescription(taskId, ownership);
  await assertUnitAbsent(unit);
  ownedUnits.set(unit, description);
  const ghostHome = join(root, "recovery-home");
  await mkdir(ghostHome, { mode: 0o700 });
  const readyFile = join(root, "crash-controller-ready.json");
  const crash = randomService("ghost-native-task-crash-controller");
  const testFile = await realpath(process.argv[1]!);
  await startOwnedService(ownedUnits, crash.unit, crash.description, [
    "/usr/bin/env",
    "-i",
    `HOME=${required("HOME")}`,
    "PATH=/usr/bin:/bin",
    `XDG_RUNTIME_DIR=${required("XDG_RUNTIME_DIR")}`,
    `DBUS_SESSION_BUS_ADDRESS=${required("DBUS_SESSION_BUS_ADDRESS")}`,
    `CI=${required("CI")}`,
    `GITHUB_ACTIONS=${required("GITHUB_ACTIONS")}`,
    `RUNNER_ENVIRONMENT=${required("RUNNER_ENVIRONMENT")}`,
    `RUNNER_OS=${required("RUNNER_OS")}`,
    `GITHUB_RUN_ID=${required("GITHUB_RUN_ID")}`,
    `GITHUB_RUN_ATTEMPT=${required("GITHUB_RUN_ATTEMPT")}`,
    `${INTEGRATION_FLAG}=1`,
    `${INTEGRATION_UID}=${required(INTEGRATION_UID)}`,
    `${CONTROLLER_UNIT}=${crash.unit}`,
    `${CONTROLLER_DESCRIPTION}=${crash.description}`,
    process.execPath,
    "--bun",
    testFile,
    CRASH_CONTROLLER_MODE,
    root,
    taskId,
    ownership.nonce,
    readyFile,
  ]);
  await waitFor("crash controller readiness", async () => {
    try { return (await readFile(readyFile, "utf8")).trim().length > 0; }
    catch { return false; }
  });
  const readySource = await readFile(readyFile, "utf8");
  assert.ok(Buffer.byteLength(readySource) <= 1_024);
  const ready = JSON.parse(readySource) as {
    controllerPid: unknown;
    workerPid: unknown;
  };
  const controllerPid = Number(ready.controllerPid);
  const workerPid = Number(ready.workerPid);
  assert.ok(Number.isInteger(controllerPid) && controllerPid > 0);
  assert.ok(Number.isInteger(workerPid) && workerPid > 0);
  await assertOwnedUnit(crash.unit, crash.description, controllerPid);
  let taskProperties = await assertOwnedUnit(unit, description);
  assert.equal(await processControlGroup(workerPid), taskProperties.get("ControlGroup"));
  assert.equal(pidExists(workerPid), true);

  await assertOwnedUnit(crash.unit, crash.description, controllerPid);
  await systemctl(["kill", "--kill-whom=all", "--signal=SIGKILL", crash.unit]);
  await waitFor("crashed controller collection", () => unitAbsent(crash.unit));
  ownedUnits.delete(crash.unit);
  assert.equal(pidExists(controllerPid), false);
  taskProperties = await assertOwnedUnit(unit, description);
  assert.equal(await processControlGroup(workerPid), taskProperties.get("ControlGroup"));
  assert.equal(pidExists(workerPid), true);

  const store = new TaskStore(ghostHome);
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
  await waitFor("recovered scope collection", () => unitAbsent(unit));
  assert.equal(pidExists(workerPid), false);
  ownedUnits.delete(unit);
  await controller.dispose();
}

async function runCrashController(
  root: string,
  taskId: string,
  nonce: string,
  readyFile: string,
): Promise<never> {
  const ownership = receipt(nonce);
  const unit = nativeTaskScopeUnit(taskId);
  await assertUnitAbsent(unit);
  const ghostHome = join(root, "recovery-home");
  const workerPidFile = join(root, "crash-worker.pid");
  const store = new TaskStore(ghostHome);
  await store.initialize();
  await store.write(taskRecord(root, taskId, ownership));
  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  const scope = await manager.reserve(taskId, ownership, new AbortController().signal);
  const launcher = scope.spawn({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import os,signal,time; open(os.environ['PID_FILE'],'w').write(str(os.getpid())); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)",
    ],
    cwd: root,
    environment: taskEnvironment({ PID_FILE: workerPidFile }),
  });
  launcher.stderr?.resume();
  await waitFor("recoverable scope", async () => {
    try {
      return (await unitProperties(unit)).get("Description")
        === nativeTaskScopeDescription(taskId, ownership);
    } catch { return false; }
  });
  await waitFor("recoverable worker pid", async () => {
    try { return (await readFile(workerPidFile, "utf8")).trim().length > 0; }
    catch { return false; }
  });
  const workerPid = Number((await readFile(workerPidFile, "utf8")).trim());
  assert.ok(Number.isInteger(workerPid) && workerPid > 0);
  await writeFile(readyFile, JSON.stringify({ controllerPid: process.pid, workerPid }));
  return new Promise<never>(() => undefined);
}

async function proveImmediateCancellation(
  root: string,
  delayedLauncher: string,
  ownedUnits: OwnedUnits,
): Promise<void> {
  const python = await resolveNativeHarnessExecutable({
    harness: "pi",
    explicitBinary: "/usr/bin/python3",
    environment: taskEnvironment(),
    timeoutMs: 10_000,
  });
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
      return context.launchNative([python], (spawn) => spawn({
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
  ownedUnits.set(unit, nativeTaskScopeDescription(task.id, task.ownership));
  await registrationSpawned.promise;
  const cancelled = await controller.cancel(task.id);
  assert.equal(cancelled.state, "cancelled");
  await waitFor("cancelled scope collection", () => unitAbsent(unit));
  ownedUnits.delete(unit);
  await controller.dispose();
}

async function verifyIntegrationBoundary(): Promise<void> {
  assert.equal(required(INTEGRATION_FLAG), "1");
  assert.equal(required("CI"), "true");
  assert.equal(required("GITHUB_ACTIONS"), "true");
  assert.equal(required("RUNNER_ENVIRONMENT"), "github-hosted");
  assert.equal(required("RUNNER_OS"), "Linux");
  const uid = process.getuid?.();
  assert.ok(uid !== undefined && uid > 0, "integration must run as a non-root UID");
  assert.equal(String(uid), required(INTEGRATION_UID));
  assert.equal((await readFile("/proc/1/comm", "utf8")).trim(), "systemd");
  const runtime = required("XDG_RUNTIME_DIR");
  assert.equal(runtime, `/run/user/${uid}`);
  assert.equal(await realpath(runtime), runtime);
  assert.equal(required("DBUS_SESSION_BUS_ADDRESS"), `unix:path=${runtime}/bus`);
  const home = required("HOME");
  assert.equal(await realpath(home), home);
  const [runtimeStats, busStats, homeStats] = await Promise.all([
    lstat(runtime),
    lstat(join(runtime, "bus")),
    lstat(home),
  ]);
  assert.equal(runtimeStats.uid, uid);
  assert.equal(homeStats.uid, uid);
  assert.equal(busStats.isSocket(), true);
  assert.equal(busStats.uid, uid);
  const version = await run("/usr/bin/systemctl", ["--version"], { PATH: "/usr/bin" });
  assert.ok(parseSupportedSystemdMajor(version.stdout) !== undefined);
  await systemctl(["show-environment"]);
  const controllerUnit = required(CONTROLLER_UNIT);
  const controllerDescription = required(CONTROLLER_DESCRIPTION);
  assert.equal(controllerDescription, expectedControllerDescription(controllerUnit));
  await assertOwnedUnit(controllerUnit, controllerDescription, process.pid);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ghost-real-native-task-"));
  await chmod(root, 0o700);
  const ownedUnits: OwnedUnits = new Map();
  let sentinel: Sentinel | undefined;
  let testError: unknown;
  try {
    const fixtures = await writeFixtures(root);
    sentinel = await startSentinel(root, ownedUnits);
    await proveLifecycle(root, fixtures.worker, ownedUnits);
    await assertSentinel(sentinel);
    await proveCollision(root, ownedUnits);
    await assertSentinel(sentinel);
    await proveCrashRecovery(root, ownedUnits);
    await assertSentinel(sentinel);
    await proveImmediateCancellation(root, fixtures.delayedLauncher, ownedUnits);
    await assertSentinel(sentinel);
  } catch (error) {
    testError = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const unit of [...ownedUnits.keys()]) {
    if (unit === sentinel?.unit) continue;
    try { await stopOwnedUnit(ownedUnits, unit); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (sentinel) {
    try {
      await assertSentinel(sentinel);
      await stopOwnedUnit(ownedUnits, sentinel.unit);
      await waitFor("sentinel process cleanup", () => !pidExists(sentinel.pid));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await rm(root, { recursive: true, force: true });
  if (ownedUnits.size > 0 || cleanupErrors.length > 0) {
    throw new AggregateError(
      testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
      "real native-task cleanup was not confirmed",
    );
  }
  if (testError !== undefined) throw testError;
  process.stdout.write("real native-task systemd scope integration passed\n");
}

await verifyIntegrationBoundary();
if (process.argv[2] === CRASH_CONTROLLER_MODE) {
  assert.equal(process.argv.length, 7);
  await runCrashController(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!);
} else {
  assert.equal(process.argv.length, 2);
  await main();
}
