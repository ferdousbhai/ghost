import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  closeDaemonResources,
  isDirectInvocation,
  main,
  parseArgs,
  runStagedShutdown,
} from "../src/main.js";
import { captureNativeHarnessEnvironments } from "../src/native-harness-runtime.js";

describe("daemon native harness environment capture", () => {
  it("captures explicit selectors separately without retaining provider secrets", () => {
    const captured = captureNativeHarnessEnvironments({
      HOME: "/home/owner",
      PATH: "/usr/bin",
      GHOST_CLAUDE_BINARY: "/opt/wrappers/claude",
      GHOST_CODEX_BINARY: "/opt/wrappers/codex",
      GHOST_PI_BINARY: "/opt/wrappers/pi",
      ANTHROPIC_API_KEY: "must-not-cross",
      OPENAI_API_KEY: "must-not-cross",
    });

    expect(captured).toMatchObject({
      claudeBinary: "/opt/wrappers/claude",
      codexBinary: "/opt/wrappers/codex",
      piBinary: "/opt/wrappers/pi",
    });
    for (const environment of [captured.claude, captured.codex, captured.pi]) {
      expect(environment).toMatchObject({ HOME: "/home/owner", PATH: "/usr/bin" });
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.GHOST_CLAUDE_BINARY).toBeUndefined();
      expect(environment.GHOST_CODEX_BINARY).toBeUndefined();
      expect(environment.GHOST_PI_BINARY).toBeUndefined();
    }
  });
});

describe("parseArgs", () => {
  it("defaults to no overrides", () => {
    expect(parseArgs([])).toEqual({
      overrides: {},
      logLevel: "info",
      help: false,
      version: false,
    });
  });

  it("parses the serve options", () => {
    const parsed = parseArgs([
      "--port", "7788",
      "--ghosts-root", "/tmp/ghosts",
      "--config", "/tmp/config.json",
      "--offline",
      "--log-level", "debug",
    ]);
    expect(parsed.overrides).toEqual({
      port: 7788,
      ghostsRoot: "/tmp/ghosts",
      configPath: "/tmp/config.json",
      offline: true,
    });
    expect(parsed.logLevel).toBe("debug");
  });

  it("accepts the short port flag", () => {
    expect(parseArgs(["-p", "9000"]).overrides.port).toBe(9000);
  });

  it("recognises help and version", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("rejects nonsense rather than guessing", () => {
    expect(() => parseArgs(["--port"])).toThrowError(/requires a value/);
    expect(() => parseArgs(["--port", "70000"])).toThrowError(/Invalid port/);
    expect(() => parseArgs(["--log-level", "loud"])).toThrowError(/Invalid log level/);
    expect(() => parseArgs(["--wat"])).toThrowError(/Unknown option/);
  });
});

describe("ghostd help", () => {
  it("advertises every supported subcommand without the retired import path", async () => {
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await expect(main(["--help"])).resolves.toBe(0);
    } finally {
      write.mockRestore();
    }

    expect(output).not.toContain("ghostd import");
    for (const command of [
      "place-legacy-documents",
      "login",
      "relay-token",
      "api-token",
      "remote",
      "hook-smol-complete",
    ]) {
      expect(output).toContain(`ghostd ${command}`);
    }
  });

  it("rejects the retired import verb as an unknown daemon option", async () => {
    let errorOutput = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errorOutput += String(chunk);
      return true;
    });
    try {
      await expect(main(["import"])).resolves.toBe(2);
    } finally {
      write.mockRestore();
    }
    expect(errorOutput).toContain("Unknown option: import");
  });
});

describe("isDirectInvocation", () => {
  it.each([
    "/opt/Ghost Install/dist/main.js",
    "/opt/Ghōst/dist/main.js",
  ])("recognises an encoded entrypoint URL for %s", (entryPath) => {
    expect(isDirectInvocation(pathToFileURL(entryPath).href, entryPath)).toBe(true);
  });

  it("does not run main when the module was imported", () => {
    expect(isDirectInvocation(import.meta.url, "/opt/ghost/dist/main.js")).toBe(false);
    expect(isDirectInvocation(import.meta.url, undefined)).toBe(false);
  });
});

describe("runStagedShutdown", () => {
  it("stops admission and aborts active work before awaiting graceful teardown", async () => {
    const events: string[] = [];
    await expect(runStagedShutdown({
      stopAdmission: () => events.push("stop"),
      abortActive: () => events.push("abort"),
      graceful: async () => {
        events.push("graceful");
      },
      force: () => { events.push("force"); },
      wait: () => new Promise(() => {}),
    })).resolves.toBe("graceful");
    expect(events).toEqual(["stop", "abort", "graceful"]);
  });

  it("force-closes after grace and returns after a second bounded deadline", async () => {
    const events: string[] = [];
    const waits: number[] = [];
    await expect(runStagedShutdown({
      stopAdmission: () => events.push("stop"),
      abortActive: () => events.push("abort"),
      graceful: () => new Promise(() => {}),
      force: () => { events.push("force"); },
      graceMs: 11,
      forceMs: 7,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    })).resolves.toBe("forced");
    expect(events).toEqual(["stop", "abort", "force"]);
    expect(waits).toEqual([11, 7]);
  });

  it("does not return from the forced stage before native cleanup settles", async () => {
    const cleanup = Promise.withResolvers<void>();
    let settled = false;
    const shutdown = runStagedShutdown({
      stopAdmission() {},
      abortActive() {},
      graceful: () => new Promise(() => {}),
      force: () => cleanup.promise,
      graceMs: 1,
      forceMs: 1,
      wait: async () => {},
    }).then(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    cleanup.resolve();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("force-closes before reporting a graceful teardown failure", async () => {
    const events: string[] = [];
    await expect(runStagedShutdown({
      stopAdmission: () => events.push("stop"),
      abortActive: () => events.push("abort"),
      graceful: async () => {
        events.push("graceful");
        throw new Error("graceful teardown failed");
      },
      force: () => { events.push("force"); },
      wait: () => new Promise(() => {}),
    })).rejects.toThrow("graceful teardown failed");
    expect(events).toEqual(["stop", "abort", "graceful", "force"]);
  });

  it("reports a graceful teardown failure that settles during the force window", async () => {
    const events: string[] = [];
    let rejectGraceful!: (error: Error) => void;
    const graceful = new Promise<void>((_resolvePromise, rejectPromise) => {
      rejectGraceful = rejectPromise;
    });
    await expect(runStagedShutdown({
      stopAdmission: () => events.push("stop"),
      abortActive: () => events.push("abort"),
      graceful: () => graceful,
      force: () => {
        events.push("force");
        rejectGraceful(new Error("late graceful teardown failure"));
      },
      graceMs: 11,
      forceMs: 7,
      wait: (delayMs) => delayMs === 11 ? Promise.resolve() : new Promise(() => {}),
    })).rejects.toThrow("late graceful teardown failure");
    expect(events).toEqual(["stop", "abort", "force"]);
  });

  it("keeps the same signal handler installed so a repeated signal forces the process", async () => {
    const mainUrl = new URL("../src/main.ts", import.meta.url).href;
    const source = `
      import { waitForShutdownSignal } from ${JSON.stringify(mainUrl)};
      let settle;
      const graceful = new Promise((resolve) => { settle = resolve; });
      const holdProcess = setInterval(() => {}, 1_000);
      const server = {
        close() {},
        closeIdleConnections() {},
        closeAllConnections() { console.log("FORCED"); settle(); },
      };
      const waiting = waitForShutdownSignal({
        login: { dispose() {} },
        listening: { server, relay: undefined, close: () => graceful },
        host: {
          beginShutdown() {},
          disposeAll: () => graceful,
          forceDisposeAll() { console.log("HOST_FORCE"); settle(); },
        },
        browsers: {
          async closeAll() { console.log("BROWSERS"); },
        },
        logger: {
          info(message) { if (message === "shutting down") console.log("STARTED"); },
          warn() {},
        },
      });
      console.log("LISTENERS", process.listenerCount("SIGINT"));
      console.log("READY");
      await waiting;
      clearInterval(holdProcess);
      console.log("DONE");
    `;
    const child = spawn(process.execPath, ["--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const output = childOutput(child);
    await output.waitFor("LISTENERS");
    expect(output.read()).toContain("LISTENERS 1");
    await output.waitFor("READY");
    expect(spawnSync("/usr/bin/kill", ["-INT", String(child.pid)]).status).toBe(0);
    await output.waitFor("STARTED");
    await output.waitFor("BROWSERS");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(child.exitCode).toBeNull();
    expect(spawnSync("/usr/bin/kill", ["-INT", String(child.pid)]).status).toBe(0);
    await output.waitFor("FORCED");
    await output.waitFor("HOST_FORCE");
    await output.waitFor("DONE");
    await expect(exited).resolves.toBe(0);
  });
});

describe("closeDaemonResources", () => {
  it("retires browser sessions before closing their live relay", async () => {
    const events: string[] = [];
    await closeDaemonResources({
      listening: {
        server: {} as never,
        relay: undefined,
        close: async () => { events.push("listener"); },
      },
      host: {
        beginShutdown() {},
        forceDisposeAll() {},
        disposeAll: async () => { events.push("host"); },
      },
      browsers: {
        closeAll: async () => { events.push("browsers"); },
      },
    });

    expect(events.indexOf("browsers")).toBeLessThan(events.indexOf("listener"));
  });

  it("attempts every stage and reports every cleanup failure", async () => {
    const events: string[] = [];
    const closing = closeDaemonResources({
      listening: {
        server: {} as never,
        relay: undefined,
        close: async () => {
          events.push("listener");
          throw new Error("listener close failed");
        },
      },
      host: {
        beginShutdown() {},
        forceDisposeAll() {},
        disposeAll: async () => {
          events.push("host");
          throw new Error("host close failed");
        },
      },
      browsers: {
        closeAll: async () => {
          events.push("browsers");
          throw new Error("browser close failed");
        },
      },
    });

    await expect(closing).rejects.toMatchObject({
      name: "AggregateError",
      errors: expect.arrayContaining([
        expect.objectContaining({ message: "host close failed" }),
        expect.objectContaining({ message: "browser close failed" }),
        expect.objectContaining({ message: "listener close failed" }),
      ]),
    });
    expect(events).toEqual(expect.arrayContaining(["host", "browsers", "listener"]));
    expect(events.indexOf("browsers")).toBeLessThan(events.indexOf("listener"));
  });
});

function childOutput(child: {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}): {
  read(): string;
  waitFor(needle: string): Promise<void>;
} {
  let output = "";
  const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const receive = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    for (const [needle, waiter] of waiters) {
      if (!output.includes(needle)) continue;
      waiters.delete(needle);
      waiter.resolve();
    }
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  return {
    read: () => output,
    waitFor(needle) {
      if (output.includes(needle)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.set(needle, { resolve, reject });
        const timer = setTimeout(() => {
          if (!waiters.delete(needle)) return;
          reject(new Error(`Timed out waiting for ${needle}; output: ${output}`));
        }, 5_000);
        timer.unref?.();
      });
    },
  };
}
