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
import {
  boundedSignal,
  classifyLauncherStderr,
  classifyScopeStatus,
  readStageDiagnostic,
  serializeCapabilityDiagnostic,
  serializeLifecycleDiagnostic,
  SYSTEMD_SCOPE_CAPABILITY_STEPS,
  systemdScopeCapabilityArgs,
  type CapabilityDiagnostic,
  type StatusDiagnostic,
} from "./native-task-scope-integration-diagnostic.js";

const INTEGRATION_FLAG = "GHOST_NATIVE_TASK_SCOPE_INTEGRATION";
const INTEGRATION_UID = "GHOST_NATIVE_TASK_SCOPE_INTEGRATION_UID";
const CONTROLLER_UNIT = "GHOST_NATIVE_TASK_SCOPE_CONTROLLER_UNIT";
const CONTROLLER_DESCRIPTION = "GHOST_NATIVE_TASK_SCOPE_CONTROLLER_DESCRIPTION";
const CRASH_CONTROLLER_MODE = "--crash-controller";
const CONTROL_OUTPUT_LIMIT = 8 * 1024;
const SCOPE_STATUS_OUTPUT_LIMIT = 4 * 1024;
const SCOPE_STATUS_PROPERTIES = ["Id", "LoadState", "ActiveState", "Description"] as const;
const LAUNCHER_STDERR_LIMIT = 4 * 1024;
const DIAGNOSTIC_STATUS_TIMEOUT_MS = 500;
const CAPABILITY_LAUNCH_TIMEOUT_MS = 5_000;
const CAPABILITY_COLLECTION_TIMEOUT_MS = 1_000;
const CAPABILITY_STDOUT_LIMIT = 1_024;

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

function absentStatusDiagnostic(
  source: string,
  exitCode: number | null,
): Record<string, string | number | null> {
  const diagnostic: Record<string, string | number | null> = { exitCode };
  for (const key of SCOPE_STATUS_PROPERTIES) diagnostic[key] = "<invalid>";
  if (Buffer.byteLength(source, "utf8") > SCOPE_STATUS_OUTPUT_LIMIT
    || source.includes("\0") || source.includes("\r")) return diagnostic;
  const seen = new Set<string>();
  for (const line of source.endsWith("\n")
    ? source.slice(0, -1).split("\n")
    : source.split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (separator < 1 || !SCOPE_STATUS_PROPERTIES.includes(
      key as (typeof SCOPE_STATUS_PROPERTIES)[number],
    ) || seen.has(key) || Buffer.byteLength(value, "utf8") > 512) continue;
    seen.add(key);
    diagnostic[key] = value;
  }
  return diagnostic;
}

async function assertAbsentScopeStatusPreflight(): Promise<void> {
  const unit = nativeTaskScopeUnit(randomTaskId());
  const result = await run(
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      unit,
      ...SCOPE_STATUS_PROPERTIES.map((property) => `--property=${property}`),
      "--no-pager",
    ],
    captureNativeTaskControlEnvironment(process.env),
    true,
  );
  try {
    assert.equal(result.exitCode, 0);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= SCOPE_STATUS_OUTPUT_LIMIT);
    assert.equal(result.stdout.includes("\0"), false);
    assert.equal(result.stdout.includes("\r"), false);
    const properties = parseProperties(result.stdout);
    assert.equal(properties.size, SCOPE_STATUS_PROPERTIES.length);
    assert.deepEqual([...properties.keys()].sort(), [...SCOPE_STATUS_PROPERTIES].sort());
    assert.equal(properties.get("Id"), unit);
    assert.equal(properties.get("LoadState"), "not-found");
    assert.equal(properties.get("ActiveState"), "inactive");
    assert.equal(properties.get("Description"), unit);
  } catch {
    process.stderr.write(
      `native task absent-scope preflight failed: ${JSON.stringify(
        absentStatusDiagnostic(result.stdout, result.exitCode),
      )}\n`,
    );
    throw new Error("systemd absent-scope status is incompatible");
  }
}

async function diagnosticScopeStatus(
  unit: string,
  description: string,
): Promise<StatusDiagnostic> {
  const result = await new Promise<{ stdout: string; exitCode: number | null }>((resolve) => {
    const child = spawn(
      "/usr/bin/systemctl",
      [
        "--user",
        "show",
        unit,
        ...SCOPE_STATUS_PROPERTIES.map((property) => `--property=${property}`),
        "--no-pager",
      ],
      {
        env: captureNativeTaskControlEnvironment(process.env),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (stdout: string, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy();
      resolve({ stdout, exitCode });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish("", null);
    }, DIAGNOSTIC_STATUS_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > SCOPE_STATUS_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish("", null);
      } else {
        chunks.push(value);
      }
    });
    child.once("error", () => finish("", null));
    child.once("close", (exitCode) => {
      finish(Buffer.concat(chunks, bytes).toString("utf8"), exitCode);
    });
  });
  return classifyScopeStatus(unit, description, result);
}

async function observeOwnedLoadedScope(
  unit: string,
  description: string,
  child: ChildProcess,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const status = await diagnosticScopeStatus(unit, description);
    if (status.shape === "valid"
      && status.id === "unit"
      && status.loadState === "loaded"
      && status.activeState !== "missing"
      && status.activeState !== "other"
      && status.description === "receipt") return true;
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      return false;
    }
    await Bun.sleep(10);
  }
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
    "import errno, json, os, signal, sys, time",
    "stage_path = os.environ['GHOST_STAGE_RECEIPT']",
    "def record_stage(stage, failure='none'):",
    "    source = json.dumps({'failure': failure, 'stage': stage, 'version': 1}, separators=(',', ':'), sort_keys=True).encode()",
    "    temporary = stage_path + '.' + str(os.getpid()) + '.tmp'",
    "    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)",
    "    try:",
    "        os.fchmod(descriptor, 0o600)",
    "        offset = 0",
    "        while offset < len(source): offset += os.write(descriptor, source[offset:])",
    "        os.fsync(descriptor)",
    "    finally:",
    "        os.close(descriptor)",
    "    os.replace(temporary, stage_path)",
    "    directory = os.open(os.path.dirname(stage_path), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)",
    "    try: os.fsync(directory)",
    "    finally: os.close(directory)",
    "record_stage('entered')",
    "if sys.argv[1:] == ['--readiness-only']:",
    "    print(json.dumps({'ready': True}, separators=(',', ':')), flush=True)",
    "    record_stage('emitted')",
    "    raise SystemExit(0)",
    "try: child = os.fork()",
    "except OSError as error:",
    "    record_stage('entered', 'resource' if error.errno in (errno.EAGAIN, errno.ENOMEM) else 'other')",
    "    raise",
    "if child == 0:",
    "    os.setsid()",
    "    grandchild = os.fork()",
    "    if grandchild > 0: os._exit(0)",
    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "    os.close(0); os.close(1); os.close(2)",
    "    with open(os.environ['GHOST_DESCENDANT_PID'], 'w') as target: target.write(str(os.getpid()))",
    "    while True: time.sleep(1)",
    "record_stage('forked')",
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "record_stage('waiting_input')",
    "line = sys.stdin.readline()",
    "if not line:",
    "    record_stage('waiting_input', 'stdin_or_protocol')",
    "    raise SystemExit(65)",
    "record_stage('input_received')",
    "try: payload = json.loads(line)",
    "except Exception:",
    "    record_stage('input_received', 'stdin_or_protocol')",
    "    raise",
    "try: print(json.dumps({'pid': os.getpid(), 'cwd': os.getcwd(), 'argv': sys.argv[1:], 'marker': os.environ.get('GHOST_LITERAL_MARKER'), 'provider': os.environ.get('OPENAI_API_KEY'), 'input': payload}), flush=True)",
    "except Exception:",
    "    record_stage('input_received', 'stdin_or_protocol')",
    "    raise",
    "record_stage('emitted')",
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

interface CapabilityLaunchResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  observedOwnedLoaded: boolean;
}

async function launchCapabilityStep(
  args: readonly string[],
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  unit: string,
  description: string,
): Promise<CapabilityLaunchResult> {
  const child = spawn("/usr/bin/systemd-run", [...args], {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const observedOwnedLoaded = observeOwnedLoadedScope(unit, description, child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const collect = (
    chunks: Buffer[],
    limit: number,
    bytes: () => number,
    update: (value: number) => void,
    truncate: () => void,
  ) => (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = limit - bytes();
    if (remaining > 0) chunks.push(value.subarray(0, remaining));
    update(Math.min(limit, bytes() + value.length));
    if (value.length > remaining) truncate();
  };
  child.stdout?.on("data", collect(
    stdout,
    CAPABILITY_STDOUT_LIMIT,
    () => stdoutBytes,
    (value) => { stdoutBytes = value; },
    () => { stdoutTruncated = true; },
  ));
  child.stderr?.on("data", collect(
    stderr,
    LAUNCHER_STDERR_LIMIT,
    () => stderrBytes,
    (value) => { stderrBytes = value; },
    () => { stderrTruncated = true; },
  ));
  const closed = await new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve) => {
      let settled = false;
      let forcedSignal: string | null = null;
      const finish = (exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ exitCode, signal: signal ?? forcedSignal });
      };
      const timeout = setTimeout(() => {
        forcedSignal = "SIGKILL";
        child.kill("SIGKILL");
      }, CAPABILITY_LAUNCH_TIMEOUT_MS);
      child.once("error", () => finish(null, null));
      child.once("close", finish);
    },
  );
  return {
    ...closed,
    stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
    stdoutTruncated,
    stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
    stderrTruncated,
    observedOwnedLoaded: await observedOwnedLoaded.catch(() => false),
  };
}

function exactAbsentStatus(status: StatusDiagnostic): boolean {
  return status.exitCode === 0
    && status.shape === "valid"
    && status.id === "unit"
    && status.loadState === "not-found"
    && status.activeState === "inactive"
    && status.description === "unit";
}

async function waitForCapabilityCollection(
  unit: string,
  description: string,
): Promise<StatusDiagnostic> {
  const deadline = Date.now() + CAPABILITY_COLLECTION_TIMEOUT_MS;
  let status = await diagnosticScopeStatus(unit, description);
  while (!exactAbsentStatus(status) && Date.now() < deadline) {
    if (status.shape !== "valid"
      || status.id !== "unit"
      || status.loadState !== "loaded"
      || status.description !== "receipt") return status;
    await Bun.sleep(10);
    status = await diagnosticScopeStatus(unit, description);
  }
  return status;
}

async function cleanupCapabilityScope(
  taskId: string,
  ownership: NativeTaskOwnershipReceipt,
  status: StatusDiagnostic,
): Promise<StatusDiagnostic> {
  if (exactAbsentStatus(status)) return status;
  if (status.shape !== "valid"
    || status.id !== "unit"
    || status.loadState !== "loaded"
    || status.description !== "receipt") return status;
  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
  });
  await manager.recoverAndConfirm(taskId, ownership);
  return diagnosticScopeStatus(
    nativeTaskScopeUnit(taskId),
    nativeTaskScopeDescription(taskId, ownership),
  );
}

async function proveScopeCapabilities(
  root: string,
  worker: string,
  ownedUnits: OwnedUnits,
): Promise<void> {
  for (const step of SYSTEMD_SCOPE_CAPABILITY_STEPS) {
    const taskId = randomTaskId();
    const ownership = randomReceipt();
    const unit = nativeTaskScopeUnit(taskId);
    const description = nativeTaskScopeDescription(taskId, ownership);
    const preflight = await diagnosticScopeStatus(unit, description);
    if (!exactAbsentStatus(preflight)) {
      process.stderr.write(`${serializeCapabilityDiagnostic({
        version: 1,
        step,
        launcherExitCode: null,
        launcherSignal: "none",
        launcherFailure: "other",
        scopeObservedOwnedLoaded: false,
        scopeStatus: preflight,
      })}\n`);
      throw new Error("systemd scope capability preflight failed");
    }
    const stageReceipt = join(root, `capability-${step}-stage.json`);
    const finiteEnvironment = step === "H" || step === "I"
      ? taskEnvironment(step === "I" ? { GHOST_STAGE_RECEIPT: stageReceipt } : {})
      : captureNativeTaskControlEnvironment(process.env);
    ownedUnits.set(unit, description);
    const result = await launchCapabilityStep(
      systemdScopeCapabilityArgs({ step, unit, description, cwd: root, worker }),
      root,
      finiteEnvironment,
      unit,
      description,
    );
    const postLaunch = await waitForCapabilityCollection(unit, description);
    let postCleanup = postLaunch;
    let cleanupConfirmed = false;
    try {
      postCleanup = await cleanupCapabilityScope(taskId, ownership, postLaunch);
      cleanupConfirmed = exactAbsentStatus(postCleanup);
      if (cleanupConfirmed) ownedUnits.delete(unit);
    } catch {
      postCleanup = await diagnosticScopeStatus(unit, description);
    }
    const expectedOutput = step === "H" || step === "I" ? "{\"ready\":true}\n" : "";
    const stageReady = step !== "I" || await readStageDiagnostic(stageReceipt).then(
      (fixture) => fixture.state === "valid"
        && fixture.private
        && fixture.stage === "emitted"
        && fixture.failure === "none",
      () => false,
    );
    const succeeded = result.exitCode === 0
      && result.signal === null
      && !result.stdoutTruncated
      && result.stdout === expectedOutput
      && exactAbsentStatus(postLaunch)
      && cleanupConfirmed
      && stageReady;
    if (!succeeded) {
      const diagnostic: CapabilityDiagnostic = {
        version: 1,
        step,
        launcherExitCode: result.exitCode,
        launcherSignal: boundedSignal(result.signal),
        launcherFailure: classifyLauncherStderr(result.stderr, result.stderrTruncated),
        scopeObservedOwnedLoaded: result.observedOwnedLoaded,
        scopeStatus: postLaunch,
      };
      process.stderr.write(`${serializeCapabilityDiagnostic(diagnostic)}\n`);
      throw new Error("systemd scope capability step failed");
    }
  }
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
  const description = nativeTaskScopeDescription(taskId, ownership);
  ownedUnits.set(unit, description);
  const descendantPidFile = join(root, "descendant.pid");
  const stageReceipt = join(root, "lifecycle-stage.json");
  const launcherStderr: Buffer[] = [];
  let launcherStderrBytes = 0;
  let launcherStderrTruncated = false;
  let launcherExitCode: number | null = null;
  let launcherSignal: string | null = null;

  const manager = new SystemdNativeTaskScopeManager({
    controlEnvironment: process.env,
    confirmationTimeoutMs: 10_000,
    spawnChild: ((command: string, args: string[], options: SpawnOptions) => {
      const launched = spawn(command, args, options);
      launched.stderr?.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = LAUNCHER_STDERR_LIMIT - launcherStderrBytes;
        if (remaining > 0) {
          launcherStderr.push(value.subarray(0, remaining));
          launcherStderrBytes += Math.min(value.length, remaining);
        }
        if (value.length > remaining) launcherStderrTruncated = true;
      });
      launched.once("close", (exitCode, signal) => {
        launcherExitCode = exitCode;
        launcherSignal = signal;
      });
      return launched;
    }) as typeof spawn,
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
      GHOST_STAGE_RECEIPT: stageReceipt,
    },
  });
  const observedOwnedLoaded = observeOwnedLoadedScope(unit, description, child);
  try {
    child.stdin?.write(`${JSON.stringify({ ping: "literal" })}\n`);
    const output = await lineFrom(child);
    assert.equal(output.cwd, root);
    assert.deepEqual(output.argv, ["literal argument", "--looks=like-option"]);
    assert.equal(output.marker, "literal value with spaces");
    assert.equal(output.provider, null);
    assert.deepEqual(output.input, { ping: "literal" });
    const workerPid = Number(output.pid);
    await waitFor("double-fork descendant pid", async () => {
      try { return (await readFile(descendantPidFile, "utf8")).trim().length > 0; }
      catch { return false; }
    });
    const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim());
    assert.ok(Number.isInteger(workerPid) && Number.isInteger(descendantPid));
    const properties = await unitProperties(unit);
    assert.equal(properties.get("Description"), description);
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
  } catch (error) {
    const [scopeObservedOwnedLoaded, scopeStatus, fixture] = await Promise.all([
      observedOwnedLoaded.catch(() => false),
      diagnosticScopeStatus(unit, description),
      readStageDiagnostic(stageReceipt),
    ]);
    process.stderr.write(`${serializeLifecycleDiagnostic({
      version: 1,
      launcherExitCode: child.exitCode ?? launcherExitCode,
      launcherSignal: boundedSignal(child.signalCode ?? launcherSignal),
      launcherFailure: classifyLauncherStderr(
        Buffer.concat(launcherStderr, launcherStderrBytes).toString("utf8"),
        launcherStderrTruncated,
      ),
      scopeObservedOwnedLoaded,
      scopeStatus,
      fixture,
    })}\n`);
    throw error;
  }
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
    await assertAbsentScopeStatusPreflight();
    const fixtures = await writeFixtures(root);
    await proveScopeCapabilities(root, fixtures.worker, ownedUnits);
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
