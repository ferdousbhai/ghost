import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGhostArtifactRoot, ghostOmpSettingsPath } from "../src/artifact-root.js";

let home: string | null = null;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), "ghost-artifact-root-"));
  return home;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(ghostOmpSettingsPath(dir), "utf8")) as Record<string, unknown>;
}

describe("ensureGhostArtifactRoot", () => {
  it("declares the ghost home as its own extension root", () => {
    const dir = makeHome();

    ensureGhostArtifactRoot(dir);

    expect(readSettings(dir)).toEqual({ extensions: ["."] });
  });

  it("writes once and leaves the file alone afterwards", () => {
    const dir = makeHome();
    ensureGhostArtifactRoot(dir);
    const first = readFileSync(ghostOmpSettingsPath(dir), "utf8");

    ensureGhostArtifactRoot(dir);

    expect(readFileSync(ghostOmpSettingsPath(dir), "utf8")).toBe(first);
  });

  it("keeps settings the owner already wrote", () => {
    const dir = makeHome();
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(
      ghostOmpSettingsPath(dir),
      JSON.stringify({ "tools.maxTimeout": 60, extensions: ["~/shared-pack"] }),
      "utf8",
    );

    ensureGhostArtifactRoot(dir);

    expect(readSettings(dir)).toEqual({
      "tools.maxTimeout": 60,
      extensions: [".", "~/shared-pack"],
    });
  });

  it("replaces a settings file OMP could not read anyway", () => {
    const dir = makeHome();
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(ghostOmpSettingsPath(dir), "{ not json", "utf8");

    ensureGhostArtifactRoot(dir);

    expect(readSettings(dir)).toEqual({ extensions: ["."] });
  });
});
