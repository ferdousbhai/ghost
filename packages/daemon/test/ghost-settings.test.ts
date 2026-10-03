import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGhostSettings } from "../src/ghost-settings.js";
import { ghostPaths } from "../src/ghosts.js";
import { MAX_PRIVATE_FILE_BYTES } from "../src/private-file.js";

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
    for (const hidden of [".pi", ".omp"]) mkdirSync(join(home, hidden), { recursive: true });
    writeFileSync(
      paths.settingsFile,
      "harness: codex\nself:\n  checkout: /srv/ghost\nreview:\n  immuneTurns: 3\n  journal: true\n",
      "utf8",
    );
    writeFileSync(join(home, ".pi", "config.yml"), "harness: hostile\nself:\n  checkout: /srv/hostile\n", "utf8");
    writeFileSync(join(home, ".omp", "config.yml"), "harness: hostile\nself:\n  checkout: /srv/hostile\n", "utf8");
    vi.stubEnv("PI_CONFIG_FILES", join(home, ".omp", "config.yml"));

    const settings = loadGhostSettings(home);

    expect(settings.getString("harness")).toBe("codex");
    expect(settings.getString("self.checkout")).toBe("/srv/ghost");
    expect(settings.getString("missing.key")).toBeUndefined();
    // Only strings are strings: a number, a boolean, or a mapping is absent.
    expect(settings.getString("review.immuneTurns")).toBeUndefined();
    expect(settings.getString("review.journal")).toBeUndefined();
    expect(settings.getString("self")).toBeUndefined();
  });

  it("is empty when settings.yml is absent", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    expect(loadGhostSettings(home).getString("self")).toBeUndefined();
  });

  it("refuses a settings.yml over its byte limit", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const paths = ghostPaths(home);
    writeFileSync(paths.settingsFile, `# ${"x".repeat(MAX_PRIVATE_FILE_BYTES)}\n`, "utf8");
    expect(() => loadGhostSettings(home!)).toThrow(/byte limit/);
  });
});
