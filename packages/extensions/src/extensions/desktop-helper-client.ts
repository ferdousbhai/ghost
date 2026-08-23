/**
 * The one long-lived link to `ghost-desktop-helper`, the Python computer-use
 * sidecar (docs/DESKTOP_HELPER.md).
 *
 * Both desktop tools — `ghost_desktop` (hyprland.ts) and `ghost_screen`
 * (screen.ts) — steer the same desktop, which is a single machine resource, so
 * they share **one** helper process per daemon. It is spawned lazily on the
 * first desktop or screen use and reused for the life of the process; an idle
 * timer reaps it so a ghost that never looks at the screen does not leave a
 * Python process resident forever.
 *
 * The transport is the line protocol the sidecar defines: one JSON request
 * object per line on stdin, one JSON response object per line on stdout,
 * correlated by an integer `id`; stderr is logs. The sidecar emits an
 * unsolicited `hello` line first, reporting its version, the Hyprland version,
 * the detected dispatcher grammar, and which backends (hyprctl / grim / wtype /
 * ydotool / atspi / foreign-toplevel) are actually usable. Everything the model
 * emits crosses as a JSON value inside `args` — nothing is ever handed to a
 * shell, here or in the sidecar (it has no `exec` op).
 *
 * Failures are structured: a sidecar error `{code, message, details}` becomes a
 * {@link GhostError} whose message is the sidecar's own remediation and whose
 * details preserve the raw `sidecarCode`. The sidecar refuses rather than fakes,
 * so a missing backend or a locked session arrives as an actionable error, never
 * as a blank screenshot or an empty tree.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { GhostError, type GhostErrorCode } from "../errors.js";

// ---------------------------------------------------------------------------
// Protocol shapes (docs/DESKTOP_HELPER.md; packages/desktop-helper)
// ---------------------------------------------------------------------------

/** A tool the sidecar probed for at startup. */
export interface BackendTool {
  readonly available?: boolean;
  readonly path?: string | null;
  readonly version?: string | null;
  readonly [key: string]: unknown;
}

/** `hello.available-backends`: which capabilities this machine actually has. */
export interface AvailableBackends {
  readonly hyprctl?: BackendTool;
  readonly grim?: BackendTool & { foreign_toplevel?: boolean; notes?: string[] };
  readonly wtype?: BackendTool;
  readonly ydotool?: BackendTool & { usable?: boolean; socket?: unknown };
  readonly atspi?: {
    available?: boolean;
    interpreter?: string | null;
    reason?: string | null;
    remediation?: string[];
  };
  readonly foreign_toplevel_protocol?: { supported?: boolean; error?: string | null };
  readonly [key: string]: unknown;
}

/** The sidecar's `hello` handshake, its one honest capability report. */
export interface HelloPayload {
  readonly type?: "hello";
  readonly helper?: string;
  readonly version?: string;
  readonly protocol?: number;
  readonly ops?: string[];
  readonly in_hyprland_session?: boolean;
  readonly "hyprland-version"?: { tag?: string; commit?: string } | null;
  readonly "detected-dispatch-grammar"?: Record<string, unknown>;
  readonly "available-backends"?: AvailableBackends;
  readonly [key: string]: unknown;
}

/**
 * The four honesty fields every capture / input / perform op carries, so the
 * model knows whether an action disturbed the desktop and whether the pixels or
 * tree it got back are complete.
 */
export interface HonestyMetadata {
  readonly backend?: string;
  readonly background_safe?: boolean;
  readonly interference?: string[];
  readonly warnings?: string[];
  readonly [key: string]: unknown;
}

/** `capture` result: base64 PNG plus the ladder rung and its honesty. */
export interface HelperCaptureResult extends HonestyMetadata {
  readonly png_base64: string;
  readonly width: number;
  readonly height: number;
  readonly capture_mode?: string;
  readonly output?: string;
  readonly region?: unknown;
  readonly bounds?: unknown;
  readonly address?: string;
  readonly app?: string;
}

/** One AT-SPI element from `ax_query`; its `ref` drives ax_perform/ax_set/click/type. */
export interface AxElement {
  readonly ref: number;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: unknown;
  readonly description?: string;
  readonly states?: string[];
  readonly actions?: string[];
  readonly bounds?: unknown;
  readonly [key: string]: unknown;
}

/** `ax_query` result: matching elements, each with a `ref`, plus tree warnings. */
export interface AxQueryResult {
  readonly app?: string;
  readonly pid?: number;
  readonly elements: AxElement[];
  readonly count: number;
  readonly truncated?: boolean;
  readonly warnings?: string[];
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** The sidecar's own error vocabulary (protocol.py `_ERROR_CODES`). */
export type SidecarErrorCode =
  | "capability"
  | "ambiguous_target"
  | "state_restore"
  | "harness"
  | "invalid_args"
  | "unknown_op"
  | "invalid_json"
  | "invalid_request"
  | "internal";

/**
 * Map a sidecar error code onto the ghost taxonomy. A missing backend is a
 * `not_found` (the same code the direct-binary tools used for "not installed"),
 * a focus-restore race is a `conflict` (concurrent compositor state), and
 * everything else is `invalid_format` — the request did not work as specified.
 * The raw code always survives in `details.sidecarCode`.
 */
export const SIDECAR_ERROR_TO_GHOST: Readonly<Record<string, GhostErrorCode>> = {
  capability: "not_found",
  state_restore: "conflict",
  ambiguous_target: "invalid_format",
  invalid_args: "invalid_format",
  unknown_op: "invalid_format",
  invalid_json: "invalid_format",
  invalid_request: "invalid_format",
  harness: "invalid_format",
  internal: "invalid_format",
};

interface SidecarError {
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

/** Turn a sidecar `{code, message, details}` into a `GhostError`. */
export function ghostErrorFromSidecar(error: SidecarError, op: string): GhostError {
  const sidecarCode = error.code ?? "internal";
  const ghostCode = SIDECAR_ERROR_TO_GHOST[sidecarCode] ?? "invalid_format";
  const message = error.message?.trim()
    || `The desktop helper refused ${op} without a message.`;
  return new GhostError(ghostCode, message, {
    op,
    sidecarCode,
    ...(error.details && Object.keys(error.details).length > 0
      ? { sidecarDetails: error.details }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Capability predicates (for tools that degrade before a round trip)
// ---------------------------------------------------------------------------

/** True when the sidecar reported a usable AT-SPI accessibility bus. */
export function atspiAvailable(hello: HelloPayload): boolean {
  return hello["available-backends"]?.atspi?.available === true;
}

/** Why AT-SPI is unavailable, with remediation, or null when it is available. */
export function atspiUnavailableReason(hello: HelloPayload): string | null {
  const atspi = hello["available-backends"]?.atspi;
  if (atspi?.available === true) return null;
  const reason = atspi?.reason?.trim();
  const remediation = (atspi?.remediation ?? []).join("; ");
  return [reason, remediation].filter(Boolean).join(" — ")
    || "the accessibility bus is not available";
}

/** True when ydotool (the only injected-pointer/evdev backend) is usable. */
export function ydotoolUsable(hello: HelloPayload): boolean {
  return hello["available-backends"]?.ydotool?.usable === true;
}

/** Why ydotool is not usable, or null when it is. */
export function ydotoolUnusableReason(hello: HelloPayload): string | null {
  const ydotool = hello["available-backends"]?.ydotool;
  if (ydotool?.usable === true) return null;
  const socket = ydotool?.socket as { problem?: string } | undefined;
  return socket?.problem?.trim()
    || (ydotool?.available ? "the ydotool daemon socket is not ready" : "ydotool is not installed");
}

// ---------------------------------------------------------------------------
// The client interface (what the tools depend on; the real client and the
// test fakes both implement it)
// ---------------------------------------------------------------------------

export interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** Override the per-request timeout. */
  readonly timeoutMs?: number;
}

export interface DesktopHelper {
  /** Start if needed and return the (cached) hello handshake. */
  hello(): Promise<HelloPayload>;
  /** Convenience: the backend map from the hello handshake. */
  capabilities(): Promise<AvailableBackends>;
  /** Send one op, resolve its result or throw a mapped `GhostError`. */
  request<T = unknown>(
    op: string,
    args?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T>;
  /** Stop the process and reject anything in flight. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

/** The environment variable a deployment can point at an explicit helper binary. */
export const HELPER_COMMAND_ENV = "GHOST_DESKTOP_HELPER";

/** The executable name a normal install puts on PATH. */
export const HELPER_BINARY = "ghost-desktop-helper";

export interface ResolvedHelperCommand {
  readonly command: string;
  readonly args: readonly string[];
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  if (name.includes(sep)) return isExecutableFile(name) ? name : null;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    if (isExecutableFile(full)) return full;
  }
  return null;
}

/**
 * Locate the helper: an explicit override first, then `ghost-desktop-helper` on
 * PATH, then `python -m ghost_desktop_helper`. If none resolves, throw a
 * `not_found` naming exactly how to install it — the doctor surfaces the same
 * gap. Resolution never runs anything; it only checks that an executable exists.
 */
export function resolveHelperCommand(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): ResolvedHelperCommand {
  const explicit = override ?? env[HELPER_COMMAND_ENV];
  if (explicit?.trim()) {
    const found = findOnPath(explicit.trim(), env);
    return { command: found ?? explicit.trim(), args: [] };
  }
  const onPath = findOnPath(HELPER_BINARY, env);
  if (onPath) return { command: onPath, args: [] };
  for (const python of ["python3", "python"]) {
    const found = findOnPath(python, env);
    if (found) return { command: found, args: ["-m", "ghost_desktop_helper"] };
  }
  throw new GhostError(
    "not_found",
    `The desktop helper (${HELPER_BINARY}) is not installed. The ghost's `
    + "computer-use tools (ghost_desktop, ghost_screen) drive a Python sidecar; "
    + "install it so `" + HELPER_BINARY + "` is on PATH (or a Python with the "
    + "`ghost_desktop_helper` module), or point "
    + `${HELPER_COMMAND_ENV} at its executable.`,
    { binary: HELPER_BINARY },
  );
}

// ---------------------------------------------------------------------------
// The process seam (real spawn, or a fake for tests)
// ---------------------------------------------------------------------------

/** The minimal child-process surface the client drives. `node:child_process` fits. */
export interface HelperProcess {
  readonly stdin: {
    write(chunk: string): boolean;
    writable?: boolean;
    end(): void;
  };
  readonly stdout: NodeJS.EventEmitter & { setEncoding(encoding: string): unknown };
  readonly stderr?: (NodeJS.EventEmitter & { setEncoding(encoding: string): unknown }) | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** How the client launches the sidecar. Injectable so tests never spawn Python. */
export type HelperSpawner = () => HelperProcess;

export interface DesktopHelperClientOptions {
  /** Test seam: launch the process. Defaults to spawning the resolved command. */
  readonly spawn?: HelperSpawner;
  /** Environment for command resolution and the child. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit helper command, overriding PATH resolution. */
  readonly command?: string;
  /** How long to wait for the `hello` line before giving up. Defaults to 20s. */
  readonly startTimeoutMs?: number;
  /** Default per-request timeout. Defaults to 30s. */
  readonly requestTimeoutMs?: number;
  /** Reap the process after this long with no requests. Defaults to 5min. 0 disables. */
  readonly idleTimeoutMs?: number;
  /** Sink for the sidecar's stderr log lines. */
  readonly onLog?: (line: string) => void;
}

export const DEFAULT_START_TIMEOUT_MS = 20_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  detachAbort: (() => void) | undefined;
}

/**
 * One reusable link to the sidecar. Not exported as a singleton itself:
 * {@link getSharedDesktopHelper} owns the per-daemon instance so both tools
 * share it, while the class stays constructable with a fake spawn for tests.
 */
export class DesktopHelperClient implements DesktopHelper {
  private readonly options: DesktopHelperClientOptions;
  private child: HelperProcess | null = null;
  private ready: Promise<HelloPayload> | null = null;
  private helloPayload: HelloPayload | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: DesktopHelperClientOptions = {}) {
    this.options = options;
  }

  async hello(): Promise<HelloPayload> {
    return this.start();
  }

  async capabilities(): Promise<AvailableBackends> {
    const hello = await this.start();
    return hello["available-backends"] ?? {};
  }

  private start(): Promise<HelloPayload> {
    if (this.disposed) {
      return Promise.reject(
        new GhostError("not_found", "The desktop helper client was disposed.", {}),
      );
    }
    if (this.ready) return this.ready;

    this.ready = new Promise<HelloPayload>((resolve, reject) => {
      let child: HelperProcess;
      try {
        child = this.launch();
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;

      const startTimer = setTimeout(() => {
        reject(
          new GhostError(
            "not_found",
            `The desktop helper did not send its hello handshake within `
            + `${Math.round((this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS) / 1000)}s. `
            + (this.stderrBuffer.trim()
              ? `It logged: ${this.stderrBuffer.trim().slice(-500)}`
              : "It produced no output."),
            {},
          ),
        );
        this.teardown();
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.onStdout(chunk, (hello) => {
          clearTimeout(startTimer);
          this.helloPayload = hello;
          this.armIdleTimer();
          resolve(hello);
        });
      });

      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
      }

      child.on("error", (error: Error) => {
        if (this.child !== child) return;
        clearTimeout(startTimer);
        const wrapped = new GhostError(
          "not_found",
          `The desktop helper could not be started: ${error.message}. Install `
          + `${HELPER_BINARY} or point ${HELPER_COMMAND_ENV} at it.`,
          { cause: error.message },
        );
        reject(wrapped);
        this.failAll(wrapped);
        this.teardown();
      });

      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        clearTimeout(startTimer);
        const detail = this.stderrBuffer.trim().slice(-500);
        const exited = new GhostError(
          "not_found",
          `The desktop helper exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
          + (detail ? `: ${detail}` : "."),
          { code, signal },
        );
        // If it died before the hello, the start promise is still pending.
        reject(exited);
        this.failAll(exited);
        this.teardown();
      });
    });

    return this.ready;
  }

  private launch(): HelperProcess {
    if (this.options.spawn) return this.options.spawn();
    const env = this.options.env ?? process.env;
    const resolved = resolveHelperCommand(env, this.options.command);
    return nodeSpawn(resolved.command, [...resolved.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    }) as unknown as HelperProcess;
  }

  private onStdout(chunk: string, onHello: (hello: HelloPayload) => void): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(line, onHello);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onLine(line: string, onHello: (hello: HelloPayload) => void): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.onLog?.(`[unparseable stdout line] ${line.slice(0, 200)}`);
      return;
    }
    if (message === null || typeof message !== "object") return;
    const record = message as Record<string, unknown>;

    // The unsolicited startup handshake, the only line with no `id`.
    if (this.helloPayload === null && record["type"] === "hello") {
      onHello(record as HelloPayload);
      return;
    }

    const id = record["id"];
    if (typeof id !== "number") {
      // A protocol-level error not tied to a request (e.g. invalid_request).
      this.options.onLog?.(`[helper] ${line.slice(0, 300)}`);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return; // Late response to an aborted/timed-out request.
    this.settle(id, pending, record);
  }

  private settle(id: number, pending: Pending, record: Record<string, unknown>): void {
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.detachAbort?.();
    this.armIdleTimer();
    if (record["ok"] === true) {
      pending.resolve(record["result"]);
      return;
    }
    const error = (record["error"] ?? {}) as SidecarError;
    pending.reject(ghostErrorFromSidecar(error, "request"));
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
    if (!this.options.onLog) return;
    let newline = chunk.indexOf("\n");
    let rest = chunk;
    while (newline !== -1) {
      const line = rest.slice(0, newline).trim();
      if (line) this.options.onLog(line);
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
  }

  async request<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw abortError(op);
    await this.start();
    const child = this.child;
    if (!child?.stdin || child.stdin.writable === false) {
      throw new GhostError(
        "not_found",
        `The desktop helper is not running, so ${op} cannot be sent.`,
        { op },
      );
    }

    const id = this.nextId++;
    this.clearIdleTimer();
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const pending: Pending = { resolve: resolve as (v: unknown) => void, reject, timer: undefined, detachAbort: undefined };

      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        pending.detachAbort?.();
        this.armIdleTimer();
        reject(
          new GhostError(
            "not_found",
            `The desktop helper did not answer ${op} within ${Math.round(timeoutMs / 1000)}s.`,
            { op, timeoutMs },
          ),
        );
      }, timeoutMs);

      if (options.signal) {
        const signal = options.signal;
        const onAbort = (): void => {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          this.armIdleTimer();
          reject(abortError(op));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.detachAbort = () => signal.removeEventListener("abort", onAbort);
        // Aborted between the entry guard and here: fire now, don't send.
        if (signal.aborted) {
          onAbort();
          return;
        }
      }

      this.pending.set(id, pending);
      try {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
      } catch (error) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.detachAbort?.();
        reject(
          new GhostError("not_found", `Could not send ${op} to the desktop helper.`, {
            op,
            cause: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const idle = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (idle <= 0) return;
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.teardown();
    }, idle);
    // A reaper must never hold the event loop open on its own.
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private failAll(error: GhostError): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.detachAbort?.();
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /** Drop the process handle and reset so the next request re-spawns. */
  private teardown(): void {
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.helloPayload = null;
    this.stdoutBuffer = "";
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.failAll(new GhostError("not_found", "The desktop helper client was disposed.", {}));
    this.teardown();
  }
}

function abortError(op: string): GhostError {
  return new GhostError(
    "not_found",
    `${op} was aborted before the desktop helper answered.`,
    { op, reason: "aborted" },
  );
}

// ---------------------------------------------------------------------------
// The shared per-daemon instance
// ---------------------------------------------------------------------------

let shared: DesktopHelperClient | null = null;

/**
 * The one helper both tools share for the life of the process. Created on first
 * use; the options are honoured only on that first call (a machine has one
 * desktop, so one link is correct regardless of how many ghosts run).
 */
export function getSharedDesktopHelper(
  options: DesktopHelperClientOptions = {},
): DesktopHelperClient {
  if (!shared) shared = new DesktopHelperClient(options);
  return shared;
}

/** Tear down and forget the shared instance. For tests and daemon shutdown. */
export async function resetSharedDesktopHelper(): Promise<void> {
  if (shared) {
    await shared.dispose();
    shared = null;
  }
}
