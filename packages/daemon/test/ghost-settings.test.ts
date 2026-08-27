import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGhostSettings } from "../src/ghost-settings.js";
import { ghostPaths } from "../src/ghosts.js";

let home: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("loadGhostSettings", () => {
  it("loads only the visible Ghost path and evaluates it against the home", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const paths = ghostPaths(home);
    mkdirSync(paths.agentDir, { recursive: true });
    mkdirSync(join(home, ".omp"), { recursive: true });
    writeFileSync(paths.settingsFile, "retry:\n  modelFallback: false\n", "utf8");
    writeFileSync(join(paths.agentDir, "config.yml"), "retry:\n  modelFallback: true\n", "utf8");
    writeFileSync(join(home, ".omp", "config.yml"), "retry:\n  modelFallback: true\n", "utf8");

    const settings = await loadGhostSettings(home);

    expect(settings.get("retry.modelFallback")).toBe(false);
    expect(settings.getCwd()).toBe(paths.home);
    expect(settings.getAgentDir()).toBe(paths.settingsRuntimeDir);
  });

  it("uses OMP defaults when settings.yml is absent", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const hostile = join(home, "hostile.yml");
    writeFileSync(hostile, "retry:\n  modelFallback: false\n", "utf8");
    vi.stubEnv("PI_CONFIG_FILES", hostile);

    const settings = await loadGhostSettings(home);

    expect(settings.get("retry.modelFallback")).toBe(true);
  });
});
