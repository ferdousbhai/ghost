import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLoopback,
  DEFAULT_ASK_TIMEOUT_SECONDS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultConfigPath,
  loadConfig,
  writeConfigFile,
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
  it("defaults to ~/ghosts on 127.0.0.1, online", () => {
    const root = makeHome();
    const config = loadConfig({ env: {}, home: root });
    expect(config).toMatchObject({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      ghostsRoot: join(root, "ghosts"),
      offline: false,
      remote: { enabled: false },
      configPath: join(root, ".config", "ghost", "config.json"),
    });
  });

  it("reads remote.enabled and rejects a non-boolean value", () => {
    const root = makeHome();
    writeConfig(root, { remote: { enabled: true, guests: "none" } });
    expect(loadConfig({ env: {}, home: root }).remote).toEqual({
      enabled: true,
      guests: "none",
    });
    writeConfig(root, { remote: { enabled: "yes" } });
    expect(() => loadConfig({ env: {}, home: root }))
      .toThrowError(/"remote.enabled" must be a boolean/);
  });

  it("atomically creates and merges a private config while preserving unknown keys", async () => {
    const root = makeHome();
    const path = join(root, "new", "ghost", "config.json");
    await writeConfigFile(path, {
      remote: { enabled: true, owner: "owner@example.com" },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, JSON.stringify({
      future: { keep: true },
      remote: { enabled: true, owner: "owner@example.com", futurePolicy: "keep" },
    }), { mode: 0o600 });

    await writeConfigFile(path, { remote: { enabled: false } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      future: { keep: true },
      remote: {
        enabled: false,
        owner: "owner@example.com",
        futurePolicy: "keep",
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
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

  it("defaults compaction to enabled with no explicit thresholds", () => {
    const root = makeHome();
    const config = loadConfig({ env: {}, home: root });
    expect(config.compaction).toEqual({ enabled: true });
  });

  it("reads compaction from the file and lets env and overrides win", () => {
    const root = makeHome();
    writeConfig(root, {
      compaction: { enabled: false, thresholdTokens: 50_000, thresholdFraction: 0.5 },
    });
    expect(loadConfig({ env: {}, home: root }).compaction).toEqual({
      enabled: false,
      thresholdTokens: 50_000,
      thresholdFraction: 0.5,
    });
    // env overrides the file's enabled flag
    expect(loadConfig({ env: { GHOSTD_COMPACTION: "1" }, home: root }).compaction.enabled).toBe(true);
    // env can retune the threshold
    expect(
      loadConfig({ env: { GHOSTD_COMPACTION_THRESHOLD_TOKENS: "1234" }, home: root }).compaction
        .thresholdTokens,
    ).toBe(1234);
    // explicit override beats env
    expect(
      loadConfig({
        env: { GHOSTD_COMPACTION: "0" },
        home: root,
        compaction: { enabled: true },
      }).compaction.enabled,
    ).toBe(true);
  });

  it("defaults the ask timeout, and lets the file and env retune it", () => {
    const root = makeHome();
    expect(loadConfig({ env: {}, home: root }).askTimeoutSeconds)
      .toBe(DEFAULT_ASK_TIMEOUT_SECONDS);
    writeConfig(root, { askTimeoutSeconds: 45 });
    expect(loadConfig({ env: {}, home: root }).askTimeoutSeconds).toBe(45);
    expect(loadConfig({ env: { GHOSTD_ASK_TIMEOUT: "10" }, home: root }).askTimeoutSeconds)
      .toBe(10);
    expect(loadConfig({ env: {}, home: root, askTimeoutSeconds: 5 }).askTimeoutSeconds).toBe(5);
  });

  it("takes zero as wait-forever, and rejects a negative ask timeout", () => {
    const root = makeHome();
    // Zero is a real setting, not an unset one: a question that must never
    // answer itself. It has to survive the ?? chain rather than fall through
    // to the default.
    writeConfig(root, { askTimeoutSeconds: 0 });
    expect(loadConfig({ env: {}, home: root }).askTimeoutSeconds).toBe(0);
    expect(() => loadConfig({ env: { GHOSTD_ASK_TIMEOUT: "-1" }, home: root }))
      .toThrowError(/Invalid non-negative number/);
    writeConfig(root, { askTimeoutSeconds: -5 });
    expect(() => loadConfig({ env: {}, home: root }))
      .toThrowError(/"askTimeoutSeconds" must be a non-negative number/);
  });

  it("rejects an out-of-range compaction fraction", () => {
    const root = makeHome();
    expect(() => loadConfig({ env: { GHOSTD_COMPACTION_THRESHOLD_FRACTION: "2" }, home: root }))
      .toThrowError(/Invalid fraction/);
    writeConfig(root, { compaction: { thresholdFraction: 0 } });
    expect(() => loadConfig({ env: {}, home: root }))
      .toThrowError(/"compaction.thresholdFraction" must be a number/);
  });
});
