import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHarnessSetting, writeGhostSetting } from "../src/ghost-settings.js";
import { ghostPaths } from "../src/ghosts.js";
import { MAX_PRIVATE_FILE_BYTES } from "../src/private-file.js";

let home: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("ghost settings", () => {
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

    expect(readHarnessSetting(home)).toBe("codex");
  });

  it("has no harness unless the setting is a string", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    writeFileSync(ghostPaths(home).settingsFile, "harness:\n  name: codex\n", "utf8");
    expect(readHarnessSetting(home)).toBeNull();
  });

  it("is empty when settings.yml is absent", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    expect(readHarnessSetting(home)).toBeNull();
  });

  it("refuses a settings.yml over its byte limit", () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const paths = ghostPaths(home);
    writeFileSync(paths.settingsFile, `# ${"x".repeat(MAX_PRIVATE_FILE_BYTES)}\n`, "utf8");
    expect(() => readHarnessSetting(home!)).toThrow(/settings.yml exceeds the 1 MiB limit/);
  });

  it("writes one key, keeping the owner's other keys and comments, and leaves no `{}` behind", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-settings-"));
    const { settingsFile } = ghostPaths(home);
    await writeGhostSetting(home, "harness", null);
    expect(existsSync(settingsFile)).toBe(false);
    await writeGhostSetting(home, "harness", "codex");
    expect(readFileSync(settingsFile, "utf8")).toBe("harness: codex\n");
    await writeGhostSetting(home, "harness", null);
    expect(readFileSync(settingsFile, "utf8")).toBe("");
    writeFileSync(settingsFile, "# mine\nother: 1\n");
    await writeGhostSetting(home, "harness", "pi");
    expect(readFileSync(settingsFile, "utf8")).toBe("# mine\nother: 1\nharness: pi\n");
    expect(readHarnessSetting(home)).toBe("pi");
  });
});
