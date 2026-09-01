/**
 * `DesktopHelperClient`.
 *
 * The process is faked at the spawn boundary: a `FakeProcess` speaks the JSON
 * line protocol (an unsolicited `hello`, then one `{id, ok, result|error}` per
 * line), so these tests cover the transport itself — hello handshake, request/
 * response correlation, sidecar-error mapping, abort propagation, idle shutdown,
 * dispose, and command resolution — without a Python sidecar or a real desktop.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_HELPER_PROTOCOL_VERSION,
  DesktopHelperClient,
  ghostErrorFromSidecar,
  MAX_HELPER_LINE_BYTES,
  resolveHelperCommand,
  type HelloPayload,
  type HelperProcess,
} from "../src/extensions/desktop-helper-client.js";
import { GhostError } from "../src/errors.js";

const HELLO: HelloPayload = {
  type: "hello",
  helper: "ghost-desktop-helper",
  version: "0.1.0",
  protocol: DESKTOP_HELPER_PROTOCOL_VERSION,
  ops: ["state", "capture"],
  in_hyprland_session: true,
  "available-backends": {
    grim: { available: true, foreign_toplevel: true },
    ydotool: { available: false, usable: false },
  },
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeStream(): EventEmitter & { setEncoding(encoding: string): unknown } {
  const emitter = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): unknown };
  (emitter as { setEncoding: (encoding: string) => unknown }).setEncoding = () => emitter;
  return emitter;
}

class FakeProcess extends EventEmitter {
  readonly stdout = makeStream();
  readonly stderr = makeStream();
  readonly stdin: EventEmitter & {
    writable: boolean;
    write(chunk: string): boolean;
    end(): void;
  };
  readonly writes: string[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  killed = false;
  exitOnKill = true;
  writeError: Error | null = null;
  pid = 4321;

  constructor() {
    super();
    const stdin = new EventEmitter() as FakeProcess["stdin"];
    stdin.writable = true;
    stdin.write = (chunk: string): boolean => {
      if (this.writeError) throw this.writeError;
      this.writes.push(chunk);
      return true;
    };
    stdin.end = (): void => {};
    this.stdin = stdin;
  }

  kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.exitOnKill) queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  };

  /** Emit one protocol line on stdout. */
  line(object: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(object)}\n`);
  }

  requestId(index = 0): number {
    return (JSON.parse(this.writes[index] ?? "{}") as { id: number }).id;
  }
}

function clientFor(
  proc: FakeProcess,
  overrides: Record<string, unknown> = {},
): DesktopHelperClient {
  return new DesktopHelperClient({
    spawn: () => proc as unknown as HelperProcess,
    ...overrides,
  });
}

function emitLifecycleEvent(proc: FakeProcess, event: "error" | "exit"): void {
  if (event === "error") {
    proc.emit("error", new Error("helper failed"));
    return;
  }
  proc.emit("exit", 1, null);
}

describe("hello handshake", () => {
  it("reads the unsolicited hello and exposes capabilities", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const pending = client.hello();
    proc.line(HELLO);
    const hello = await pending;
    expect(DESKTOP_HELPER_PROTOCOL_VERSION).toBe(2);
    expect(hello.protocol).toBe(DESKTOP_HELPER_PROTOCOL_VERSION);
    expect(hello.version).toBe("0.1.0");
    expect(hello.in_hyprland_session).toBe(true);
    const backends = await client.capabilities();
    expect(backends.grim?.foreign_toplevel).toBe(true);
    expect(backends.ydotool?.available).toBe(false);
    await client.dispose();
  });

  it("rejects when the process exits before the hello", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const pending = client.hello();
    proc.emit("exit", 1, null);
    await expect(pending).rejects.toThrowError(/exited/);
  });

  it.each([undefined, 0, 1, 3, "2"])(
    "rejects helper protocol %s before sending a request",
    async (protocol) => {
      const proc = new FakeProcess();
      const client = clientFor(proc);
      const pending = client.request("state");

      proc.line({ ...HELLO, protocol });

      await expect(pending).rejects.toMatchObject({
        code: "invalid_format",
        message: expect.stringMatching(/same build/i),
        details: {
          expectedProtocol: DESKTOP_HELPER_PROTOCOL_VERSION,
          actualProtocol: protocol ?? null,
          helperVersion: HELLO.version,
        },
      });
      expect(proc.writes).toEqual([]);
      expect(proc.killSignals).toEqual(["SIGTERM"]);
      await client.dispose();
    },
  );

  it("retries after a synchronous launch failure instead of caching the rejection", async () => {
    const proc = new FakeProcess();
    let attempts = 0;
    const client = new DesktopHelperClient({
      spawn: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("not installed yet");
        return proc as unknown as HelperProcess;
      },
    });

    await expect(client.hello()).rejects.toThrowError(/not installed yet/);
    const ready = client.hello();
    proc.line(HELLO);
    await expect(ready).resolves.toMatchObject({ type: "hello" });
    expect(attempts).toBe(2);
    await client.dispose();
  });
});

describe("request / response", () => {
  it("correlates a response to its request by id", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;

    const pending = client.request<{ ok: boolean }>("state", { foo: 1 });
    await tick();
    const sent = JSON.parse(proc.writes[0] ?? "{}");
    expect(sent.op).toBe("state");
    expect(sent.args).toEqual({ foo: 1 });
    proc.line({ id: proc.requestId(0), ok: true, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
    await client.dispose();
  });

  it("logs a malformed line and continues with the next complete response", async () => {
    const proc = new FakeProcess();
    const logs: string[] = [];
    const client = clientFor(proc, { onLog: (line: string) => logs.push(line) });
    const ready = client.hello();
    proc.line(HELLO);
    await ready;

    const pending = client.request<{ recovered: boolean }>("state", {});
    await tick();
    proc.stdout.emit("data", "not-json\n");
    proc.line({
      id: proc.requestId(0),
      ok: true,
      result: { recovered: true },
    });

    await expect(pending).resolves.toEqual({ recovered: true });
    expect(logs).toEqual(["[unparseable stdout line] not-json"]);
    await client.dispose();
  });

  it("maps a sidecar error onto a GhostError", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;

    const pending = client.request("ax_query", {});
    await tick();
    proc.line({
      id: proc.requestId(0),
      ok: false,
      error: { code: "capability", message: "AT-SPI is not available", details: {} },
    });
    await expect(pending).rejects.toMatchObject({
      code: "not_found",
      details: { sidecarCode: "capability" },
    });
    await client.dispose();
  });

  it("ignores a late response to an aborted request", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;

    const controller = new AbortController();
    const pending = client.request("state", {}, { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(pending).rejects.toThrowError(/aborted/);
    // A late answer for the abandoned id must not throw or resolve anything.
    proc.line({ id: proc.requestId(0), ok: true, result: {} });
    await client.dispose();
  });

  it("refuses immediately when the signal is already aborted", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request("state", {}, { signal: controller.signal }),
    ).rejects.toThrowError(/aborted/);
    await client.dispose();
  });

  it("stops before accumulating an oversized helper response line", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;

    const pending = client.request("capture", {});
    await tick();
    const chunk = "x".repeat(1024 * 1024);
    for (let bytes = 0; bytes <= MAX_HELPER_LINE_BYTES; bytes += chunk.length) {
      proc.stdout.emit("data", chunk);
      if (proc.killed) break;
    }

    await expect(pending).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(proc.killed).toBe(true);
    await client.dispose();
  });
});

describe("lifecycle", () => {
  it("reaps the process after the idle timeout", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc, { idleTimeoutMs: 20 });
    const ready = client.hello();
    proc.line(HELLO);
    await ready;
    expect(proc.killed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proc.killed).toBe(true);
  });

  it("dispose kills the process and refuses further use", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;
    await client.dispose();
    expect(proc.killed).toBe(true);
    await expect(client.hello()).rejects.toThrowError(/disposed/);
  });

  it("dispose promptly rejects a pending hello and is idempotent", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const pending = client.hello();
    await Promise.all([
      expect(pending).rejects.toThrowError(/disposed/),
      client.dispose(),
      client.dispose(),
    ]);
    expect(proc.killSignals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the helper ignores SIGTERM", async () => {
    const proc = new FakeProcess();
    proc.exitOnKill = false;
    const client = clientFor(proc, { stopTimeoutMs: 5 });
    const ready = client.hello();
    proc.line(HELLO);
    await ready;

    await client.dispose();
    expect(proc.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reaps a helper whose stdin write fails", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;
    proc.writeError = new Error("broken pipe");

    await expect(client.request("state", {})).rejects.toThrowError(/Could not send state/);
    await tick();
    expect(proc.killSignals).toEqual(["SIGTERM"]);
    await client.dispose();
  });

  it("handles an asynchronous stdin EPIPE and retries with a fresh helper", async () => {
    const first = new FakeProcess();
    const replacement = new FakeProcess();
    const processes = [first, replacement];
    let spawnIndex = 0;
    const client = new DesktopHelperClient({
      spawn: () => processes[spawnIndex++] as unknown as HelperProcess,
    });
    const firstReady = client.hello();
    first.line(HELLO);
    await firstReady;

    const rejected = client.request("state", {});
    await tick();
    const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    first.stdin.emit("error", pipeError);
    await expect(rejected).rejects.toThrowError(/input pipe failed: write EPIPE/);
    expect(first.killSignals).toEqual(["SIGTERM"]);

    const replacementReady = client.hello();
    await tick();
    replacement.line(HELLO);
    await replacementReady;
    first.stdin.emit("error", new Error("late stale EPIPE"));
    expect(replacement.killed).toBe(false);
    const surviving = client.request<{ recovered: boolean }>("state", {});
    await tick();
    replacement.line({
      id: replacement.requestId(0),
      ok: true,
      result: { recovered: true },
    });
    await expect(surviving).resolves.toEqual({ recovered: true });
    await client.dispose();
  });

  it("does not carry stderr from a failed child into its replacement", async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    const processes = [first, second];
    let spawnIndex = 0;
    const client = new DesktopHelperClient({
      spawn: () => processes[spawnIndex++] as unknown as HelperProcess,
      startTimeoutMs: 5,
    });
    const firstReady = client.hello();
    first.stderr.emit("data", "first-child-only\n");
    await expect(firstReady).rejects.toThrowError(/first-child-only/);
    first.stderr.emit("data", "late-first-child-output\n");

    const secondReady = client.hello();
    await expect(secondReady).rejects.toThrowError(/It produced no output/);
    await client.dispose();
  });

  it("fails in-flight requests when the process exits", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const ready = client.hello();
    proc.line(HELLO);
    await ready;
    const pending = client.request("state", {});
    await tick();
    proc.emit("exit", 0, null);
    await expect(pending).rejects.toThrowError(/exited/);
  });

  it.each(["error", "exit"] as const)(
    "ignores a stale child %s without weakening current-child cleanup",
    async (event) => {
      const first = new FakeProcess();
      const replacement = new FakeProcess();
      const processes = [first, replacement];
      let spawnIndex = 0;
      const client = new DesktopHelperClient({
        spawn: () => processes[spawnIndex++] as unknown as HelperProcess,
      });

      const firstReady = client.hello();
      first.line(HELLO);
      await firstReady;
      emitLifecycleEvent(first, event);
      expect(first.killed).toBe(event === "error");

      const replacementReady = client.hello();
      await tick();
      replacement.line(HELLO);
      await replacementReady;

      const surviving = client.request<{ survived: boolean }>("state", {});
      await tick();
      emitLifecycleEvent(first, event);
      expect(replacement.killed).toBe(false);
      replacement.line({
        id: replacement.requestId(0),
        ok: true,
        result: { survived: true },
      });
      await expect(surviving).resolves.toEqual({ survived: true });

      const rejected = client.request("state", {});
      await tick();
      emitLifecycleEvent(replacement, event);
      await expect(rejected).rejects.toThrowError(
        event === "error" ? /could not be started/ : /exited/,
      );
      expect(replacement.killed).toBe(event === "error");
      await client.dispose();
    },
  );
});

describe("resolveHelperCommand", () => {
  it("honours an explicit override", () => {
    const resolved = resolveHelperCommand({ PATH: "" }, "/opt/ghost-desktop-helper");
    expect(resolved.command).toBe("/opt/ghost-desktop-helper");
    expect(resolved.args).toEqual([]);
  });

  it("honours the env override", () => {
    const resolved = resolveHelperCommand({
      PATH: "",
      GHOST_DESKTOP_HELPER: "my-helper",
    });
    expect(resolved.command).toBe("my-helper");
  });

  it("throws a clear not_found when nothing resolves", () => {
    expect(() => resolveHelperCommand({ PATH: "" })).toThrowError(/not installed/);
  });
});

describe("ghostErrorFromSidecar", () => {
  it("maps codes onto the ghost taxonomy and keeps the raw code", () => {
    expect(ghostErrorFromSidecar({ code: "capability", message: "x" }, "op").code).toBe(
      "not_found",
    );
    expect(ghostErrorFromSidecar({ code: "state_restore", message: "x" }, "op").code).toBe(
      "conflict",
    );
    expect(ghostErrorFromSidecar({ code: "ambiguous_target", message: "x" }, "op").code).toBe(
      "invalid_format",
    );
    const unknown = ghostErrorFromSidecar({ code: "weird", message: "x" }, "op");
    expect(unknown).toBeInstanceOf(GhostError);
    expect(unknown.code).toBe("invalid_format");
    expect(unknown.details["sidecarCode"]).toBe("weird");
  });

  it("maps a stale ref (unknown_ref) but preserves its recovery affordance", () => {
    // The sidecar's unknown_ref details carry the re-run-ax_query signal
    // (reason / snapshot / current_snapshot); the mapping must not drop them.
    const error = ghostErrorFromSidecar(
      {
        code: "unknown_ref",
        message: "Element ref '1:7' is stale",
        details: { reason: "stale", snapshot: 1, current_snapshot: 2 },
      },
      "ax_perform",
    );
    expect(error.code).toBe("invalid_format");
    expect(error.details["sidecarCode"]).toBe("unknown_ref");
    expect(error.details["sidecarDetails"]).toEqual({
      reason: "stale",
      snapshot: 1,
      current_snapshot: 2,
    });
  });
});
