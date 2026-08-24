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
  DesktopHelperClient,
  ghostErrorFromSidecar,
  resolveHelperCommand,
  type HelloPayload,
  type HelperProcess,
} from "../src/extensions/desktop-helper-client.js";
import { GhostError } from "../src/errors.js";

const HELLO: HelloPayload = {
  type: "hello",
  helper: "ghost-desktop-helper",
  version: "0.1.0",
  protocol: 1,
  ops: ["state", "capture"],
  in_hyprland_session: true,
  "available-backends": {
    grim: { available: true, foreign_toplevel: true },
    ydotool: { available: false, usable: false },
  },
};

/** Let the client's `await start()` chain flush so its write lands on stdin. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeStream(): EventEmitter & { setEncoding(encoding: string): unknown } {
  const emitter = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): unknown };
  (emitter as { setEncoding: (encoding: string) => unknown }).setEncoding = () => emitter;
  return emitter;
}

class FakeProcess extends EventEmitter {
  readonly stdout = makeStream();
  readonly stderr = makeStream();
  readonly writes: string[] = [];
  killed = false;
  pid = 4321;
  readonly stdin = {
    writable: true,
    write: (chunk: string): boolean => {
      this.writes.push(chunk);
      return true;
    },
    end: (): void => {},
  };
  kill = (): boolean => {
    this.killed = true;
    return true;
  };

  /** Emit one protocol line on stdout. */
  line(object: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(object)}\n`);
  }

  /** The id of the nth request written to stdin. */
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
    expect(hello.version).toBe("0.1.0");
    expect(hello.in_hyprland_session).toBe(true);
    const backends = await client.capabilities();
    expect(backends.grim?.foreign_toplevel).toBe(true);
    await client.dispose();
  });

  it("rejects when the process exits before the hello", async () => {
    const proc = new FakeProcess();
    const client = clientFor(proc);
    const pending = client.hello();
    proc.emit("exit", 1, null);
    await expect(pending).rejects.toThrowError(/exited/);
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
      expect(first.killed).toBe(true);

      const replacementReady = client.hello();
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
      expect(replacement.killed).toBe(true);
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
