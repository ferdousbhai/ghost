import { spawn, type ChildProcess } from "node:child_process";

const TASK_ID = /^task-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const CONTROL_ENV_NAMES = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_CONTROL_OUTPUT_BYTES = 4 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 3_000;

type SpawnChild = typeof spawn;

export interface NativeTaskScopeLaunch {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
  stderr?: "pipe" | "ignore";
}

export interface NativeTaskScope {
  readonly unit: string;
  spawn(input: NativeTaskScopeLaunch): ChildProcess;
  stopAndConfirm(): Promise<void>;
}

export interface NativeTaskScopeManager {
  reserve(taskId: string, signal: AbortSignal): Promise<NativeTaskScope>;
  stopAndConfirm(taskId: string): Promise<void>;
  recoverAndConfirm(taskId: string): Promise<void>;
}

export interface NativeTaskControlResult {
  stdout: string;
  exitCode: number | null;
}

export type NativeTaskControlRunner = (
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
) => Promise<NativeTaskControlResult>;

export class NativeTaskOwnershipError extends Error {
  readonly _tag = "NativeTaskOwnershipError";
  readonly code: "collision" | "invalid" | "unconfirmed";

  constructor(
    message = "Native task ownership could not be confirmed.",
    code: "collision" | "invalid" | "unconfirmed" = "unconfirmed",
  ) {
    super(message);
    this.name = "NativeTaskOwnershipError";
    this.code = code;
  }
}

export function nativeTaskScopeUnit(taskId: string): string {
  const match = TASK_ID.exec(taskId);
  if (!match) throw new NativeTaskOwnershipError("Native task identity is invalid.", "invalid");
  return `ghost-task-${match[1]}.scope`;
}

/** Capture only the two owner-session bus selectors required by systemctl. */
export function captureNativeTaskControlEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> {
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of CONTROL_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}

function boundedEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const entries = Object.entries(source).filter((entry): entry is [string, string] =>
    entry[1] !== undefined);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) throw new NativeTaskOwnershipError();
  let bytes = 0;
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of entries) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (name.length < 1 || name.length > 256 || name.includes("=") || name.includes("\0")
      || value.includes("\0") || bytes > MAX_ENVIRONMENT_BYTES) {
      throw new NativeTaskOwnershipError();
    }
    environment[name] = value;
  }
  return environment;
}

function runSystemctl(
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
): Promise<NativeTaskControlResult> {
  if (signal?.aborted) return Promise.reject(new NativeTaskOwnershipError());
  return new Promise<NativeTaskControlResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(SYSTEMCTL, [...args], {
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      reject(new NativeTaskOwnershipError());
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child.stdout?.destroy();
      action();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new NativeTaskOwnershipError()));
    };
    const timeout = setTimeout(abort, CONTROL_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_CONTROL_OUTPUT_BYTES) abort();
      else chunks.push(value);
    });
    child.once("error", abort);
    child.once("close", (exitCode) => finish(() => resolve({
      stdout: Buffer.concat(chunks, bytes).toString("utf8"),
      exitCode,
    })));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

type ScopeStatus = "absent" | "inactive" | "active";

function parseScopeStatus(result: NativeTaskControlResult): ScopeStatus {
  const properties = new Map<string, string>();
  for (const line of result.stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new NativeTaskOwnershipError();
    const key = line.slice(0, separator);
    if (properties.has(key)) throw new NativeTaskOwnershipError();
    properties.set(key, line.slice(separator + 1));
  }
  if (properties.size !== 2
    || !properties.has("LoadState")
    || !properties.has("ActiveState")) {
    throw new NativeTaskOwnershipError();
  }
  if (properties.get("LoadState") === "not-found") return "absent";
  if (result.exitCode !== 0) throw new NativeTaskOwnershipError();
  return properties.get("ActiveState") === "inactive" ? "inactive" : "active";
}

class SystemdNativeTaskScope implements NativeTaskScope {
  readonly unit: string;
  readonly #manager: SystemdNativeTaskScopeManager;
  #spawned = false;
  #stopping?: Promise<void>;

  constructor(manager: SystemdNativeTaskScopeManager, unit: string) {
    this.#manager = manager;
    this.unit = unit;
  }

  spawn(input: NativeTaskScopeLaunch): ChildProcess {
    if (this.#spawned || this.#stopping || input.signal?.aborted) {
      throw new NativeTaskOwnershipError();
    }
    this.#spawned = true;
    return this.#manager.spawn(this.unit, input);
  }

  stopAndConfirm(): Promise<void> {
    this.#stopping ??= this.#manager.stopUnitAndConfirm(this.unit);
    return this.#stopping;
  }
}

export interface SystemdNativeTaskScopeManagerOptions {
  controlEnvironment: Readonly<NodeJS.ProcessEnv>;
  spawnChild?: SpawnChild;
  runControl?: NativeTaskControlRunner;
  wait?: (milliseconds: number) => Promise<void>;
  confirmationTimeoutMs?: number;
}

/** Own each delegated native worker in one collected transient user scope. */
export class SystemdNativeTaskScopeManager implements NativeTaskScopeManager {
  readonly #controlEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly #spawnChild: SpawnChild;
  readonly #runControl: NativeTaskControlRunner;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #confirmationTimeoutMs: number;
  readonly #stops = new Map<string, Promise<void>>();
  readonly #reservedUnits = new Set<string>();

  constructor(options: SystemdNativeTaskScopeManagerOptions) {
    this.#controlEnvironment = captureNativeTaskControlEnvironment(options.controlEnvironment);
    this.#spawnChild = options.spawnChild ?? spawn;
    this.#runControl = options.runControl ?? runSystemctl;
    this.#wait = options.wait ?? ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.#confirmationTimeoutMs = options.confirmationTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    if (!Number.isFinite(this.#confirmationTimeoutMs) || this.#confirmationTimeoutMs < 0) {
      throw new RangeError("Native task confirmation timeout is invalid.");
    }
  }

  async reserve(taskId: string, signal: AbortSignal): Promise<NativeTaskScope> {
    const unit = nativeTaskScopeUnit(taskId);
    if (signal.aborted) throw new NativeTaskOwnershipError();
    if (await this.#status(unit, signal) !== "absent") {
      throw new NativeTaskOwnershipError("Native task scope already exists.", "collision");
    }
    if (signal.aborted) throw new NativeTaskOwnershipError();
    this.#reservedUnits.add(unit);
    return new SystemdNativeTaskScope(this, unit);
  }

  async stopAndConfirm(taskId: string): Promise<void> {
    const unit = nativeTaskScopeUnit(taskId);
    if (!this.#reservedUnits.has(unit)) {
      const status = await this.#status(unit);
      if (status === "absent" || status === "inactive") return;
      throw new NativeTaskOwnershipError("Unreserved native task scope exists.", "collision");
    }
    await this.stopUnitAndConfirm(unit);
    this.#reservedUnits.delete(unit);
  }

  recoverAndConfirm(taskId: string): Promise<void> {
    return this.stopUnitAndConfirm(nativeTaskScopeUnit(taskId));
  }

  spawn(unit: string, input: NativeTaskScopeLaunch): ChildProcess {
    const environment = boundedEnvironment(input.environment);
    try {
      return this.#spawnChild(SYSTEMD_RUN, [
        "--user",
        "--scope",
        `--unit=${unit}`,
        "--slice-inherit",
        "--collect",
        "--quiet",
        "--pipe",
        "--expand-environment=no",
        `--working-directory=${input.cwd}`,
        "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes",
        "--property=TimeoutStopSec=1s",
        "--",
        input.executable,
        ...input.args,
      ], {
        cwd: input.cwd,
        env: environment,
        signal: input.signal,
        stdio: ["pipe", "pipe", input.stderr ?? "pipe"],
        windowsHide: true,
      });
    } catch {
      throw new NativeTaskOwnershipError();
    }
  }

  stopUnitAndConfirm(unit: string): Promise<void> {
    const existing = this.#stops.get(unit);
    if (existing) return existing;
    const stopping = this.#stopUnitAndConfirm(unit);
    this.#stops.set(unit, stopping);
    void stopping.finally(() => {
      if (this.#stops.get(unit) === stopping) this.#stops.delete(unit);
    }).catch(() => undefined);
    return stopping;
  }

  async #stopUnitAndConfirm(unit: string): Promise<void> {
    const initial = await this.#status(unit);
    if (initial === "absent" || initial === "inactive") return;
    try {
      await this.#runControl(
        ["--user", "stop", "--no-block", unit],
        this.#controlEnvironment,
      );
    } catch {
      // A failed request is safe only when the following authoritative read
      // independently confirms that the scope is already quiescent.
    }
    const deadline = Date.now() + this.#confirmationTimeoutMs;
    for (;;) {
      const status = await this.#status(unit);
      if (status === "absent" || status === "inactive") return;
      if (Date.now() >= deadline) throw new NativeTaskOwnershipError();
      await this.#wait(25);
    }
  }

  async #status(unit: string, signal?: AbortSignal): Promise<ScopeStatus> {
    const result = await this.#runControl([
      "--user",
      "show",
      unit,
      "--property=LoadState",
      "--property=ActiveState",
      "--no-pager",
    ], this.#controlEnvironment, signal);
    return parseScopeStatus(result);
  }
}
