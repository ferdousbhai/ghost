import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLoopback,
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultConfigPath,
  loadConfig,
} from "../src/config.js";

let home: string | null = null;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), "ghostd-home-"));
  return home;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function writeConfig(configHome: string, body: unknown): string {
  const dir = join(configHome, ".config", "ghost");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

describe("loadConfig", () => {
  it("defaults to ~/Ghosts on 127.0.0.1, online", () => {
    const root = makeHome();
    const config = loadConfig({ env: {}, home: root });
    expect(config).toMatchObject({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      ghostsRoot: join(root, "Ghosts"),
      offline: false,
      configPath: null,
    });
  });

  it("reads the XDG config file", () => {
    const root = makeHome();
    const path = writeConfig(root, { port: 8123, ghostsRoot: "~/Spirits", offline: true });
    const config = loadConfig({ env: {}, home: root });
    expect(config.port).toBe(8123);
    expect(config.ghostsRoot).toBe(join(root, "Spirits"));
    expect(config.offline).toBe(true);
    expect(config.configPath).toBe(path);
  });

  it("honours XDG_CONFIG_HOME", () => {
    const root = makeHome();
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "ghost"), { recursive: true });
    writeFileSync(join(xdg, "ghost", "config.json"), JSON.stringify({ port: 9001 }), "utf8");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: xdg }, root))
      .toBe(join(xdg, "ghost", "config.json"));
    expect(loadConfig({ env: { XDG_CONFIG_HOME: xdg }, home: root }).port).toBe(9001);
  });

  it("lets the environment override the file", () => {
    const root = makeHome();
    writeConfig(root, { port: 8123, ghostsRoot: join(root, "FromFile"), offline: true });
    const config = loadConfig({
      env: { GHOSTD_PORT: "7000", GHOSTS_ROOT: join(root, "FromEnv"), GHOSTD_OFFLINE: "0" },
      home: root,
    });
    expect(config.port).toBe(7000);
    expect(config.ghostsRoot).toBe(join(root, "FromEnv"));
    expect(config.offline).toBe(false);
  });

  it("lets explicit overrides beat the environment", () => {
    const root = makeHome();
    const config = loadConfig({
      env: { GHOSTD_PORT: "7000" },
      home: root,
      port: 7788,
      offline: true,
    });
    expect(config.port).toBe(7788);
    expect(config.offline).toBe(true);
  });

  it("refuses a malformed config file rather than silently defaulting", () => {
    const root = makeHome();
    const dir = join(root, ".config", "ghost");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json", "utf8");
    expect(() => loadConfig({ env: {}, home: root })).toThrowError(/not valid JSON/);
  });

  it("refuses a wrongly typed field", () => {
    const root = makeHome();
    writeConfig(root, { port: "7717" });
    expect(() => loadConfig({ env: {}, home: root })).toThrowError(/"port" must be a number/);
  });

  it("refuses a non-loopback bind", () => {
    const root = makeHome();
    expect(() => loadConfig({ env: { GHOSTD_HOST: "0.0.0.0" }, home: root }))
      .toThrowError(/loopback only/);
    expect(() => assertLoopback("192.168.1.10")).toThrowError(/loopback only/);
    expect(() => assertLoopback("::1")).not.toThrow();
  });

  it("refuses a nonsense port", () => {
    const root = makeHome();
    expect(() => loadConfig({ env: { GHOSTD_PORT: "not-a-port" }, home: root }))
      .toThrowError(/Invalid port/);
  });
});
