import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectInvocation, parseArgs } from "../src/main.js";

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
