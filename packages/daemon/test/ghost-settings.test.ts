import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GHOST_SETTINGS_MAX_BYTES, loadGhostSettings } from "../src/ghost-settings.js";
import { ghostPaths } from "../src/ghosts.js";

let home: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("loadGhostSettings", () => {
  it("reads only the visible settings.yml, never a runtime or ambient overlay", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const paths = ghostPaths(home);
    mkdirSync(paths.agentDir, { recursive: true });
    mkdirSync(join(home, ".omp"), { recursive: true });
    writeFileSync(paths.settingsFile, "collab:\n  relayUrl: wss://relay.example\nttsr:\n  disabledRules: [noisy]\n", "utf8");
    writeFileSync(join(paths.agentDir, "config.yml"), "collab:\n  relayUrl: wss://hostile\n", "utf8");
    writeFileSync(join(home, ".omp", "config.yml"), "collab:\n  relayUrl: wss://hostile\n", "utf8");
    vi.stubEnv("PI_CONFIG_FILES", join(home, ".omp", "config.yml"));

    const settings = loadGhostSettings(home);

    expect(settings.getString("collab.relayUrl")).toBe("wss://relay.example");
    expect(settings.getStringList("ttsr.disabledRules")).toEqual(["noisy"]);
    expect(settings.getString("missing.key")).toBeUndefined();
    expect(settings.getStringList("collab.relayUrl")).toBeUndefined();
  });

  it("is empty when settings.yml is absent", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    expect(loadGhostSettings(home).getString("collab")).toBeUndefined();
  });

  it("refuses a settings.yml over its byte limit", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const paths = ghostPaths(home);
    writeFileSync(paths.settingsFile, `# ${"x".repeat(GHOST_SETTINGS_MAX_BYTES)}\n`, "utf8");
    expect(() => loadGhostSettings(home!)).toThrow(/byte limit/);
  });
});
