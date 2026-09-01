import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const MAX_STAGE_BYTES = 256;
const MAX_STATUS_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;
const MAX_RAW_STDERR_BYTES = 4 * 1024;
const MAX_RAW_DIAGNOSTIC_BYTES = 32 * 1024;

const STAGES = new Set([
  "entered",
  "forked",
  "waiting_input",
  "input_received",
  "emitted",
]);
const FAILURE_CATEGORIES = new Set([
  "none",
  "registration",
  "exec_or_chdir",
  "stdin_or_protocol",
  "resource",
  "other",
]);
const ACTIVE_STATES = new Set([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "maintenance",
  "refreshing",
  "reloading",
]);
const STATUS_ACTIVE_STATES = new Set([...ACTIVE_STATES, "missing", "other"]);
const STATUS_SHAPES = new Set(["valid", "invalid"]);
const STATUS_IDS = new Set(["unit", "other", "missing"]);
const STATUS_LOAD_STATES = new Set(["loaded", "not-found", "other", "missing"]);
const STATUS_DESCRIPTIONS = new Set(["receipt", "unit", "empty", "other", "missing"]);
const STAGE_STATES = new Set(["valid", "missing", "invalid"]);
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/u;
const TASK_SCOPE =
  /^ghost-task-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.scope$/u;
const TASK_RECEIPT =
  /^ghost-task-receipt:v1:task-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):[0-9a-f]{32}$/u;
export const SYSTEMD_SCOPE_CAPABILITY_STEPS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I",
] as const;
export const CAPABILITY_DIAGNOSTIC_ENVIRONMENT_KEYS = [
  "CI",
  "DBUS_SESSION_BUS_ADDRESS",
  "GHOST_NATIVE_TASK_SCOPE_CONTROLLER_DESCRIPTION",
  "GHOST_NATIVE_TASK_SCOPE_CONTROLLER_UNIT",
  "GHOST_NATIVE_TASK_SCOPE_INTEGRATION",
  "GHOST_NATIVE_TASK_SCOPE_INTEGRATION_UID",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "HOME",
  "PATH",
  "RUNNER_ENVIRONMENT",
  "RUNNER_OS",
  "XDG_RUNTIME_DIR",
] as const;
const CAPABILITY_STEP_SET = new Set<string>(SYSTEMD_SCOPE_CAPABILITY_STEPS);

export type IntegrationFailureCategory =
  | "none"
  | "registration"
  | "exec_or_chdir"
  | "stdin_or_protocol"
  | "resource"
  | "other";

export type IntegrationStage =
  | "entered"
  | "forked"
  | "waiting_input"
  | "input_received"
  | "emitted";

export interface StageDiagnostic {
  state: "valid" | "missing" | "invalid";
  private: boolean;
  stage: IntegrationStage | "none";
  failure: IntegrationFailureCategory;
}

export interface StatusDiagnostic {
  exitCode: number | null;
  shape: "valid" | "invalid";
  id: "unit" | "other" | "missing";
  loadState: "loaded" | "not-found" | "other" | "missing";
  activeState: string;
  description: "receipt" | "unit" | "empty" | "other" | "missing";
}

export interface LifecycleDiagnostic {
  version: 1;
  launcherExitCode: number | null;
  launcherSignal: string;
  launcherFailure: IntegrationFailureCategory;
  scopeObservedOwnedLoaded: boolean;
  scopeStatus: StatusDiagnostic;
  fixture: StageDiagnostic;
}

export type CapabilityStep = (typeof SYSTEMD_SCOPE_CAPABILITY_STEPS)[number];

export interface CapabilityDiagnostic {
  version: 1;
  step: CapabilityStep;
  launcherExitCode: number | null;
  launcherSignal: string;
  launcherFailure: IntegrationFailureCategory;
  scopeObservedOwnedLoaded: boolean;
  scopeStatus: StatusDiagnostic;
}

export interface StepARawDiagnostic extends CapabilityDiagnostic {
  step: "A";
  command: "/usr/bin/true";
  stderr: Uint8Array;
  stderrTruncated: boolean;
}

function safeExitCode(value: number | null): number | null {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 255)
    ? value
    : null;
}

export function classifyLauncherStderr(
  source: string,
  truncated: boolean,
): IntegrationFailureCategory {
  if (truncated) return "other";
  if (source.trim() === "") return "none";
  if ([
    "Failed to start transient scope unit",
    "Failed to add PIDs to scope's control group",
    "Couldn't move process",
    "UnitExists",
  ].some((literal) => source.includes(literal))) return "registration";
  if ([
    "Failed to change to specified working directory",
    "Failed at step CHDIR",
    "Failed to execute",
    "Failed at step EXEC",
  ].some((literal) => source.includes(literal))) return "exec_or_chdir";
  if ([
    "Broken pipe",
    "Failed to set up standard input",
    "Failed to rearrange standard input",
    "JSONDecodeError",
  ].some((literal) => source.includes(literal))) return "stdin_or_protocol";
  if ([
    "Resource temporarily unavailable",
    "Cannot allocate memory",
    "Failed with result 'resources'",
    "Too many open files",
  ].some((literal) => source.includes(literal))) return "resource";
  return "other";
}

export async function readStageDiagnostic(path: string): Promise<StageDiagnostic> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    const uid = process.getuid?.();
    const privateFile = uid !== undefined
      && stat.uid === uid
      && stat.isFile()
      && stat.nlink === 1
      && (stat.mode & 0o777) === 0o600
      && stat.size > 0
      && stat.size <= MAX_STAGE_BYTES;
    if (!privateFile) {
      return { state: "invalid", private: false, stage: "none", failure: "other" };
    }
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STAGE_BYTES) throw new Error();
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).sort().join("\0") !== "failure\0stage\0version"
      || row.version !== 1
      || typeof row.stage !== "string" || !STAGES.has(row.stage)
      || typeof row.failure !== "string" || !FAILURE_CATEGORIES.has(row.failure)
      || JSON.stringify(row) !== source) throw new Error();
    return {
      state: "valid",
      private: true,
      stage: row.stage as IntegrationStage,
      failure: row.failure as IntegrationFailureCategory,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", private: false, stage: "none", failure: "none" };
    }
    return { state: "invalid", private: false, stage: "none", failure: "other" };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export function classifyScopeStatus(
  unit: string,
  receipt: string,
  result: { stdout: string; exitCode: number | null },
): StatusDiagnostic {
  const diagnostic: StatusDiagnostic = {
    exitCode: safeExitCode(result.exitCode),
    shape: "invalid",
    id: "missing",
    loadState: "missing",
    activeState: "missing",
    description: "missing",
  };
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_STATUS_BYTES
    || result.stdout.includes("\0") || result.stdout.includes("\r")) return diagnostic;
  const properties = new Map<string, string>();
  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  for (const line of lines) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || properties.has(key)
      || !["Id", "LoadState", "ActiveState", "Description"].includes(key)) return diagnostic;
    properties.set(key, line.slice(separator + 1));
  }
  const id = properties.get("Id");
  const loadState = properties.get("LoadState");
  const activeState = properties.get("ActiveState");
  const description = properties.get("Description");
  diagnostic.id = id === undefined ? "missing" : id === unit ? "unit" : "other";
  diagnostic.loadState = loadState === "loaded" || loadState === "not-found"
    ? loadState
    : loadState === undefined ? "missing" : "other";
  diagnostic.activeState = activeState !== undefined && ACTIVE_STATES.has(activeState)
    ? activeState
    : activeState === undefined ? "missing" : "other";
  diagnostic.description = description === undefined
    ? "missing"
    : description === receipt
      ? "receipt"
      : description === unit
        ? "unit"
        : description === "" ? "empty" : "other";
  if (properties.size === 4 && result.exitCode === 0) diagnostic.shape = "valid";
  return diagnostic;
}

export function boundedSignal(signal: string | null): string {
  return signal !== null && SIGNAL.test(signal) ? signal : "none";
}

export function assertCapabilityDiagnosticEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): void {
  const keys = Object.keys(source).sort();
  if (keys.length !== CAPABILITY_DIAGNOSTIC_ENVIRONMENT_KEYS.length
    || keys.some((key, index) => key !== CAPABILITY_DIAGNOSTIC_ENVIRONMENT_KEYS[index])
    || CAPABILITY_DIAGNOSTIC_ENVIRONMENT_KEYS.some((key) =>
      typeof source[key] !== "string" || source[key]?.includes("\0"))) {
    throw new Error("integration capability environment is invalid");
  }
}

function safeStatus(input: StatusDiagnostic): StatusDiagnostic {
  return {
    exitCode: safeExitCode(input.exitCode),
    shape: STATUS_SHAPES.has(input.shape) ? input.shape : "invalid",
    id: STATUS_IDS.has(input.id) ? input.id : "other",
    loadState: STATUS_LOAD_STATES.has(input.loadState) ? input.loadState : "other",
    activeState: STATUS_ACTIVE_STATES.has(input.activeState) ? input.activeState : "other",
    description: STATUS_DESCRIPTIONS.has(input.description) ? input.description : "other",
  } as StatusDiagnostic;
}

export function systemdScopeCapabilityArgs(input: {
  step: CapabilityStep;
  unit: string;
  description: string;
  cwd: string;
  worker: string;
}): readonly string[] {
  const unit = TASK_SCOPE.exec(input.unit);
  const description = TASK_RECEIPT.exec(input.description);
  if (!CAPABILITY_STEP_SET.has(input.step)
    || !unit || !description || unit[1] !== description[1]
    || !input.cwd.startsWith("/") || input.cwd.includes("\0")
    || !input.worker.startsWith("/") || input.worker.includes("\0")) {
    throw new Error("integration capability identity is invalid");
  }
  const level = SYSTEMD_SCOPE_CAPABILITY_STEPS.indexOf(input.step);
  const args = [
    "--user",
    "--scope",
    `--unit=${input.unit}`,
    `--description=${input.description}`,
  ];
  if (level >= 1) args.push("--slice-inherit");
  args.push("--collect", "--quiet", "--pipe");
  if (level >= 2) args.push("--expand-environment=no");
  if (level >= 3) args.push(`--working-directory=${input.cwd}`);
  if (level >= 4) args.push("--property=KillMode=control-group");
  if (level >= 5) args.push("--property=SendSIGKILL=yes");
  if (level >= 6) args.push("--property=TimeoutStopSec=1s");
  args.push("--");
  if (input.step === "H") {
    args.push(
      "/usr/bin/python3",
      "-c",
      "import json; print(json.dumps({'ready': True}, separators=(',', ':')), flush=True)",
    );
  } else if (input.step === "I") {
    args.push("/usr/bin/python3", input.worker, "--readiness-only");
  } else {
    args.push("/usr/bin/true");
  }
  return Object.freeze(args);
}

export function serializeCapabilityDiagnostic(input: CapabilityDiagnostic): string {
  const source = JSON.stringify({
    version: 1,
    step: CAPABILITY_STEP_SET.has(input.step) ? input.step : "A",
    launcherExitCode: safeExitCode(input.launcherExitCode),
    launcherSignal: boundedSignal(input.launcherSignal === "none" ? null : input.launcherSignal),
    launcherFailure: FAILURE_CATEGORIES.has(input.launcherFailure)
      ? input.launcherFailure
      : "other",
    scopeObservedOwnedLoaded: input.scopeObservedOwnedLoaded === true,
    scopeStatus: safeStatus(input.scopeStatus),
  });
  if (Buffer.byteLength(source, "utf8") > MAX_DIAGNOSTIC_BYTES) {
    throw new Error("integration capability diagnostic exceeded bound");
  }
  return source;
}

function escapeDiagnosticControls(source: string): string {
  return [...source].map((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f)
      || point === 0x2028 || point === 0x2029
      ? `\\u${point.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}

export function serializeStepARawDiagnostic(input: StepARawDiagnostic): string {
  if (input.step !== "A" || input.command !== "/usr/bin/true"
    || input.stderrTruncated
    || input.stderr.byteLength > MAX_RAW_STDERR_BYTES) {
    throw new Error("integration capability raw diagnostic is invalid");
  }
  const source = JSON.stringify({
    version: 1,
    step: "A",
    launcherExitCode: safeExitCode(input.launcherExitCode),
    launcherSignal: boundedSignal(input.launcherSignal === "none" ? null : input.launcherSignal),
    launcherFailure: FAILURE_CATEGORIES.has(input.launcherFailure)
      ? input.launcherFailure
      : "other",
    scopeObservedOwnedLoaded: input.scopeObservedOwnedLoaded === true,
    scopeStatus: safeStatus(input.scopeStatus),
    stderr: escapeDiagnosticControls(Buffer.from(input.stderr).toString("utf8")),
  });
  if (Buffer.byteLength(source, "utf8") > MAX_RAW_DIAGNOSTIC_BYTES) {
    throw new Error("integration capability raw diagnostic exceeded bound");
  }
  return source;
}

export function serializeLifecycleDiagnostic(input: LifecycleDiagnostic): string {
  const source = JSON.stringify({
    version: 1,
    launcherExitCode: safeExitCode(input.launcherExitCode),
    launcherSignal: boundedSignal(input.launcherSignal === "none" ? null : input.launcherSignal),
    launcherFailure: FAILURE_CATEGORIES.has(input.launcherFailure)
      ? input.launcherFailure
      : "other",
    scopeObservedOwnedLoaded: input.scopeObservedOwnedLoaded === true,
    scopeStatus: safeStatus(input.scopeStatus),
    fixture: {
      state: STAGE_STATES.has(input.fixture.state) ? input.fixture.state : "invalid",
      private: input.fixture.private === true,
      stage: STAGES.has(input.fixture.stage) ? input.fixture.stage : "none",
      failure: FAILURE_CATEGORIES.has(input.fixture.failure) ? input.fixture.failure : "other",
    },
  });
  if (Buffer.byteLength(source, "utf8") > MAX_DIAGNOSTIC_BYTES) {
    throw new Error("integration diagnostic exceeded bound");
  }
  return source;
}
