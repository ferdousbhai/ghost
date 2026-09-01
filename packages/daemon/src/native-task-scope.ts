import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

const TASK_ID = /^task-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const CONTROL_ENV_NAMES = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_CONTROL_OUTPUT_BYTES = 4 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 3_000;
const RECEIPT_NONCE = /^[0-9a-f]{32}$/u;
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

type SpawnChild = typeof spawn;

export interface NativeTaskScopeLaunch {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
  stderr?: "pipe" | "ignore";
}

export interface NativeTaskOwnershipReceipt {
  version: 1;
  kind: "systemd-scope";
  nonce: string;
}

export interface NativeTaskScope {
  readonly unit: string;
  spawn(input: NativeTaskScopeLaunch): ChildProcess;
  stopAndConfirm(): Promise<void>;
}

export interface NativeTaskScopeManager {
  reserve(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
    signal: AbortSignal,
  ): Promise<NativeTaskScope>;
  stopAndConfirm(taskId: string, receipt: NativeTaskOwnershipReceipt): Promise<void>;
  recoverAndConfirm(taskId: string, receipt: NativeTaskOwnershipReceipt): Promise<void>;
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

export function createNativeTaskOwnershipReceipt(): NativeTaskOwnershipReceipt {
  return Object.freeze({
    version: 1,
    kind: "systemd-scope",
    nonce: randomBytes(16).toString("hex"),
  });
}

export function isNativeTaskOwnershipReceipt(
  value: unknown,
): value is NativeTaskOwnershipReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join("\0") === "kind\0nonce\0version"
    && row.version === 1
    && row.kind === "systemd-scope"
    && typeof row.nonce === "string"
    && RECEIPT_NONCE.test(row.nonce);
}

export function nativeTaskScopeDescription(
  taskId: string,
  receipt: NativeTaskOwnershipReceipt,
): string {
  nativeTaskScopeUnit(taskId);
  if (!isNativeTaskOwnershipReceipt(receipt)) {
    throw new NativeTaskOwnershipError("Native task ownership receipt is invalid.", "invalid");
  }
  return `ghost-task-receipt:v1:${taskId}:${receipt.nonce}`;
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

type ScopeStatus = Readonly<{
  id: string;
  loadState: "not-found";
  activeState: "inactive";
  description: string;
}> | Readonly<{
  id: string;
  loadState: "loaded";
  activeState: string;
  description: string;
}>;

function parseScopeStatus(unit: string, result: NativeTaskControlResult): ScopeStatus {
  if (result.exitCode !== 0
    || Buffer.byteLength(result.stdout, "utf8") > MAX_CONTROL_OUTPUT_BYTES
    || result.stdout.includes("\0") || result.stdout.includes("\r")) {
    throw new NativeTaskOwnershipError();
  }
  const properties = new Map<string, string>();
  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new NativeTaskOwnershipError();
    const key = line.slice(0, separator);
    if (properties.has(key)) throw new NativeTaskOwnershipError();
    properties.set(key, line.slice(separator + 1));
  }
  if (properties.size !== 4
    || !properties.has("Id")
    || !properties.has("LoadState")
    || !properties.has("ActiveState")
    || !properties.has("Description")) {
    throw new NativeTaskOwnershipError();
  }
  const id = properties.get("Id");
  const loadState = properties.get("LoadState");
  const activeState = properties.get("ActiveState");
  const description = properties.get("Description");
  if (id !== unit || typeof description !== "string"
    || Buffer.byteLength(description, "utf8") > 512) {
    throw new NativeTaskOwnershipError();
  }
  if (loadState === "not-found") {
    if (activeState !== "inactive" || description !== unit) {
      throw new NativeTaskOwnershipError();
    }
    return { id, loadState, activeState, description };
  }
  if (loadState !== "loaded"
    || typeof activeState !== "string" || !ACTIVE_STATES.has(activeState)
  ) {
    throw new NativeTaskOwnershipError();
  }
  return { id, loadState, activeState, description };
}

class SystemdNativeTaskScope implements NativeTaskScope {
  readonly unit: string;
  readonly #manager: SystemdNativeTaskScopeManager;
  readonly #taskId: string;
  readonly #receipt: NativeTaskOwnershipReceipt;
  #spawned = false;
  #stopping?: Promise<void>;

  constructor(
    manager: SystemdNativeTaskScopeManager,
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
    unit: string,
  ) {
    this.#manager = manager;
    this.#taskId = taskId;
    this.#receipt = receipt;
    this.unit = unit;
  }

  spawn(input: NativeTaskScopeLaunch): ChildProcess {
    if (this.#spawned || this.#stopping || input.signal?.aborted) {
      throw new NativeTaskOwnershipError();
    }
    this.#spawned = true;
    return this.#manager.spawn(this.#taskId, this.#receipt, input);
  }

  stopAndConfirm(): Promise<void> {
    this.#stopping ??= this.#manager.stopAndConfirm(this.#taskId, this.#receipt);
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

interface ScopeReservation {
  readonly description: string;
  spawned: boolean;
  launchSettled?: Promise<void>;
}

interface ScopeStop {
  readonly description: string;
  readonly promise: Promise<void>;
}

/** Own each delegated native worker in one collected transient user scope. */
export class SystemdNativeTaskScopeManager implements NativeTaskScopeManager {
  readonly #controlEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly #spawnChild: SpawnChild;
  readonly #runControl: NativeTaskControlRunner;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #confirmationTimeoutMs: number;
  readonly #stops = new Map<string, ScopeStop>();
  readonly #reservations = new Map<string, ScopeReservation>();

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

  async reserve(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
    signal: AbortSignal,
  ): Promise<NativeTaskScope> {
    const unit = nativeTaskScopeUnit(taskId);
    const description = nativeTaskScopeDescription(taskId, receipt);
    if (signal.aborted) throw new NativeTaskOwnershipError();
    if (this.#reservations.has(unit)) {
      throw new NativeTaskOwnershipError("Native task scope is already reserved.", "collision");
    }
    if ((await this.#status(unit, signal)).loadState !== "not-found") {
      throw new NativeTaskOwnershipError("Native task scope already exists.", "collision");
    }
    if (signal.aborted) throw new NativeTaskOwnershipError();
    if (this.#reservations.has(unit)) {
      throw new NativeTaskOwnershipError("Native task scope is already reserved.", "collision");
    }
    const durableReceipt = Object.freeze({ ...receipt });
    this.#reservations.set(unit, {
      description,
      spawned: false,
    });
    return new SystemdNativeTaskScope(this, taskId, durableReceipt, unit);
  }

  async stopAndConfirm(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
  ): Promise<void> {
    const unit = nativeTaskScopeUnit(taskId);
    const description = nativeTaskScopeDescription(taskId, receipt);
    const reservation = this.#reservations.get(unit);
    if (reservation && reservation.description !== description) {
      throw new NativeTaskOwnershipError("Native task scope receipt does not match.", "collision");
    }
    await this.#stopUnitAndConfirmShared(unit, description, reservation);
  }

  recoverAndConfirm(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
  ): Promise<void> {
    const unit = nativeTaskScopeUnit(taskId);
    const description = nativeTaskScopeDescription(taskId, receipt);
    const reservation = this.#reservations.get(unit);
    if (reservation && reservation.description !== description) {
      return Promise.reject(new NativeTaskOwnershipError(
        "Native task scope receipt does not match.",
        "collision",
      ));
    }
    return this.#stopUnitAndConfirmShared(unit, description, reservation);
  }

  spawn(
    taskId: string,
    receipt: NativeTaskOwnershipReceipt,
    input: NativeTaskScopeLaunch,
  ): ChildProcess {
    const unit = nativeTaskScopeUnit(taskId);
    const description = nativeTaskScopeDescription(taskId, receipt);
    const reservation = this.#reservations.get(unit);
    if (!reservation || reservation.spawned || reservation.description !== description) {
      throw new NativeTaskOwnershipError();
    }
    let environment: NodeJS.ProcessEnv;
    try {
      environment = boundedEnvironment(input.environment);
    } catch (error) {
      this.#reservations.delete(unit);
      throw error;
    }
    let child: ChildProcess;
    try {
      child = this.#spawnChild(SYSTEMD_RUN, [
        "--user",
        "--scope",
        `--unit=${unit}`,
        `--description=${description}`,
        "--slice-inherit",
        "--collect",
        "--quiet",
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
        stdio: ["pipe", "pipe", input.stderr ?? "pipe"],
        windowsHide: true,
      });
    } catch {
      this.#reservations.delete(unit);
      throw new NativeTaskOwnershipError();
    }
    reservation.spawned = true;
    reservation.launchSettled = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        child.removeListener("error", finish);
        child.removeListener("close", finish);
        resolve();
      };
      child.once("error", finish);
      child.once("close", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    return child;
  }

  #stopUnitAndConfirmShared(
    unit: string,
    description: string,
    reservation: ScopeReservation | undefined,
  ): Promise<void> {
    const existing = this.#stops.get(unit);
    if (existing) {
      return existing.description === description
        ? existing.promise
        : Promise.reject(new NativeTaskOwnershipError(
            "Native task scope receipt does not match.",
            "collision",
          ));
    }
    const stopping = this.#stopUnitAndConfirm(
      unit,
      description,
      reservation,
    );
    const entry = { description, promise: stopping };
    this.#stops.set(unit, entry);
    void stopping.finally(() => {
      if (this.#stops.get(unit) === entry) this.#stops.delete(unit);
    }).catch(() => undefined);
    return stopping;
  }

  async #stopUnitAndConfirm(
    unit: string,
    description: string,
    reservation: ScopeReservation | undefined,
  ): Promise<void> {
    let confirmed = false;
    try {
      let status = await this.#status(unit);
      if (status.loadState === "not-found") {
        status = await this.#confirmMissingAfterLaunch(unit, reservation);
        if (status.loadState === "not-found") {
          confirmed = true;
          return;
        }
      }
      this.#assertOwnedStatus(status, description);
      if (status.activeState === "inactive") {
        confirmed = true;
        return;
      }
      try {
        await this.#runControl(
          ["--user", "stop", "--no-block", unit],
          this.#controlEnvironment,
        );
      } catch {
        // A failed request is safe only when later authoritative reads prove
        // exact receipt ownership and quiescence.
      }
      const deadline = Date.now() + this.#confirmationTimeoutMs;
      for (;;) {
        status = await this.#status(unit);
        if (status.loadState === "not-found") {
          status = await this.#confirmMissingAfterLaunch(unit, reservation);
          if (status.loadState === "not-found") {
            confirmed = true;
            return;
          }
        }
        this.#assertOwnedStatus(status, description);
        if (status.activeState === "inactive") {
          confirmed = true;
          return;
        }
        if (Date.now() >= deadline) throw new NativeTaskOwnershipError();
        await this.#wait(25);
      }
    } catch (error) {
      if (error instanceof NativeTaskOwnershipError
        && error.code === "collision"
        && reservation?.launchSettled) {
        await reservation.launchSettled;
        if (this.#reservations.get(unit) === reservation) {
          this.#reservations.delete(unit);
        }
      }
      throw error;
    } finally {
      if (confirmed && this.#reservations.get(unit) === reservation) {
        this.#reservations.delete(unit);
      }
    }
  }

  async #confirmMissingAfterLaunch(
    unit: string,
    reservation: ScopeReservation | undefined,
  ): Promise<ScopeStatus> {
    if (!reservation?.spawned) {
      return { id: unit, loadState: "not-found", activeState: "inactive", description: unit };
    }
    const launchSettled = reservation.launchSettled;
    if (!launchSettled) throw new NativeTaskOwnershipError();
    let settled = false;
    void launchSettled.then(() => { settled = true; });
    const deadline = Date.now() + this.#confirmationTimeoutMs;
    for (;;) {
      await Promise.race([launchSettled, this.#wait(25)]);
      const status = await this.#status(unit);
      if (status.loadState !== "not-found" || settled) return status;
      if (Date.now() >= deadline) throw new NativeTaskOwnershipError();
    }
  }

  #assertOwnedStatus(status: ScopeStatus, description: string): void {
    if (status.loadState !== "loaded" || status.description !== description) {
      throw new NativeTaskOwnershipError(
        "Native task scope belongs to a different receipt.",
        "collision",
      );
    }
  }

  async #status(unit: string, signal?: AbortSignal): Promise<ScopeStatus> {
    const result = await this.#runControl([
      "--user",
      "show",
      unit,
      "--property=Id",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=Description",
      "--no-pager",
    ], this.#controlEnvironment, signal);
    return parseScopeStatus(unit, result);
  }
}
