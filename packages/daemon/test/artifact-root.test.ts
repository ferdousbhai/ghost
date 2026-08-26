import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listOmpExtensionRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { afterEach, describe, expect, it } from "vitest";
import {
  ghostHookExtensionPaths,
  withGhostArtifactRoot,
} from "../src/artifact-root.js";

let home: string | null = null;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), "ghost-artifact-root-"));
  return home;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("ghost artifact loading", () => {
  it("scopes OMP package discovery to the visible home without writing .omp", async () => {
    const dir = makeHome();

    const roots = await withGhostArtifactRoot(dir, async () => {
      await Promise.resolve();
      return listOmpExtensionRoots({ cwd: dir, home: homedir(), repoRoot: null });
    });

    expect(roots).toEqual([{ path: dir, name: dir.split("/").at(-1), level: "user" }]);
    expect(existsSync(join(dir, ".omp"))).toBe(false);
  });

  it("preloads only executable hook files from the home", async () => {
    const dir = makeHome();
    mkdirSync(join(dir, "hooks", "pre"), { recursive: true });
    mkdirSync(join(dir, "hooks", "post"), { recursive: true });
    writeFileSync(join(dir, "hooks", "pre", "before.ts"), "export default () => {}", "utf8");
    writeFileSync(join(dir, "hooks", "post", "after.js"), "export default () => {}", "utf8");
    writeFileSync(join(dir, "hooks", "post", "notes.md"), "not executable", "utf8");

    expect(await ghostHookExtensionPaths(dir)).toEqual([
      join(dir, "hooks", "pre", "before.ts"),
      join(dir, "hooks", "post", "after.js"),
    ]);
  });
});
