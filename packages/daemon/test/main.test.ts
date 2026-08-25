import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  isDirectInvocation,
  parseArgs,
  runStagedShutdown,
} from "../src/main.js";

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
      "--ghosts-root", "/tmp/Ghosts",
      "--config", "/tmp/config.json",
      "--offline",
      "--log-level", "debug",
    ]);
    expect(parsed.overrides).toEqual({
      port: 7788,
      ghostsRoot: "/tmp/Ghosts",
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
      force: () => events.push("force"),
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
      force: () => events.push("force"),
      graceMs: 11,
      forceMs: 7,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    })).resolves.toBe("forced");
    expect(events).toEqual(["stop", "abort", "force"]);
    expect(waits).toEqual([11, 7]);
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
