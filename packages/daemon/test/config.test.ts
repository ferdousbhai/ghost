import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  it("defaults to ~/ghosts on 127.0.0.1, online", () => {
    const root = makeHome();
    const config = loadConfig({ env: {}, home: root });
    expect(config).toMatchObject({
      port: DEFAULT_PORT,
      ghostsRoot: join(root, "ghosts"),
      remote: { apps: ["https://summonghost.com"] },
      configPath: join(root, ".config", "ghost", "config.json"),
    });
  });

  it("reads the local model, expanding ~, with defaults, and has none unless configured", () => {
    const root = makeHome();
    expect(loadConfig({ env: {}, home: root }).local).toBeNull();
    writeConfig(root, { local: { model: "~/models/gemma.gguf" } });
    expect(loadConfig({ env: {}, home: root }).local).toEqual({
      model: join(root, "models", "gemma.gguf"), server: "llama-server", contextSize: 32_768, idleMs: 300_000,
    });
    writeConfig(root, { local: { model: "/m.gguf", server: "~/bin/llama-server", contextSize: 8192, idleMinutes: 1 } });
    expect(loadConfig({ env: {}, home: root }).local).toEqual({ model: "/m.gguf", server: join(root, "bin", "llama-server"), contextSize: 8192, idleMs: 60_000 });
    for (const local of [{}, { model: "" }, { model: "/m.gguf", idleMinutes: 0 }, "gemma"]) {
      writeConfig(root, { local });
      expect(() => loadConfig({ env: {}, home: root }), JSON.stringify(local)).toThrow(/local/);
    }
  });

  it("reads the remote owner and guests", () => {
    const root = makeHome();
    writeConfig(root, { remote: { owner: "Owner@example.com", guests: "none" } });
    expect(loadConfig({ env: {}, home: root }).remote).toEqual({ owner: "Owner@example.com", guests: "none", apps: ["https://summonghost.com"] });
  });

  it("reads remote.apps, [] admitting none, and refuses anything but https origins", () => {
    const root = makeHome();
    writeConfig(root, { remote: { apps: [] } });
    expect(loadConfig({ env: {}, home: root }).remote.apps).toEqual([]);
    writeConfig(root, { remote: { apps: ["https://lab.summonghost.com", "https://app.example:8443"] } });
    expect(loadConfig({ env: {}, home: root }).remote.apps).toEqual(["https://lab.summonghost.com", "https://app.example:8443"]);
    for (const apps of ["https://summonghost.com", ["http://summonghost.com"], ["https://summonghost.com/"], ["summonghost.com"], [7]]) {
      writeConfig(root, { remote: { apps } });
      expect(() => loadConfig({ env: {}, home: root }), JSON.stringify(apps)).toThrow(/remote\.apps/);
    }
  });

  it("reads the XDG config file", () => {
    const root = makeHome();
    const path = writeConfig(root, { port: 8123, ghostsRoot: "~/Spirits", offline: true });
    const config = loadConfig({ env: {}, home: root });
    expect(config.port).toBe(8123);
    expect(config.ghostsRoot).toBe(join(root, "Spirits"));
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
      env: { GHOSTD_PORT: "7000", GHOSTS_ROOT: join(root, "FromEnv") },
      home: root,
    });
    expect(config.port).toBe(7000);
    expect(config.ghostsRoot).toBe(join(root, "FromEnv"));
  });

  it("ignores an empty GHOSTD_CONFIG and falls back to the default path", () => {
    const root = makeHome();
    const config = loadConfig({ env: { GHOSTD_CONFIG: "  " }, home: root });
    expect(config.configPath).toBe(join(root, ".config", "ghost", "config.json"));
  });

  it("lets explicit overrides beat the environment", () => {
    const root = makeHome();
    const config = loadConfig({
      env: { GHOSTD_PORT: "7000" },
      home: root,
      port: 7788,
    });
    expect(config.port).toBe(7788);
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

  it("ignores keys it does not read, such as the retired host and remote.peers", () => {
    const root = makeHome();
    writeConfig(root, { host: "0.0.0.0", someday: true, remote: { guests: "none", peers: [{ login: "wife@example.com" }], later: 1 } });
    const config = loadConfig({ env: {}, home: root });
    expect(config).not.toHaveProperty("host");
    expect(config).not.toHaveProperty("someday");
    expect(config.remote).toEqual({ guests: "none", apps: ["https://summonghost.com"] });
  });

  it("refuses a nonsense port", () => {
    const root = makeHome();
    expect(() => loadConfig({ env: { GHOSTD_PORT: "not-a-port" }, home: root }))
      .toThrowError(/Invalid port/);
  });
});
