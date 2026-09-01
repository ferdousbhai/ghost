import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const MAX_STAGE_BYTES = 256;
const MAX_STATUS_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;

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

export function serializeLifecycleDiagnostic(input: LifecycleDiagnostic): string {
  const source = JSON.stringify({
    version: 1,
    launcherExitCode: safeExitCode(input.launcherExitCode),
    launcherSignal: boundedSignal(input.launcherSignal === "none" ? null : input.launcherSignal),
    launcherFailure: FAILURE_CATEGORIES.has(input.launcherFailure)
      ? input.launcherFailure
      : "other",
    scopeObservedOwnedLoaded: input.scopeObservedOwnedLoaded === true,
    scopeStatus: {
      exitCode: safeExitCode(input.scopeStatus.exitCode),
      shape: STATUS_SHAPES.has(input.scopeStatus.shape) ? input.scopeStatus.shape : "invalid",
      id: STATUS_IDS.has(input.scopeStatus.id) ? input.scopeStatus.id : "other",
      loadState: STATUS_LOAD_STATES.has(input.scopeStatus.loadState)
        ? input.scopeStatus.loadState
        : "other",
      activeState: STATUS_ACTIVE_STATES.has(input.scopeStatus.activeState)
        ? input.scopeStatus.activeState
        : "other",
      description: STATUS_DESCRIPTIONS.has(input.scopeStatus.description)
        ? input.scopeStatus.description
        : "other",
    },
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
