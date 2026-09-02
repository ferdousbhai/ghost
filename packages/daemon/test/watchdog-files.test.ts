import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectConfigCandidates,
  discoverWatchdogFiles,
} from "../src/watchdog-files.js";
import { tempDir, useCleanups } from "./helpers/fixtures.js";

const cleanups = useCleanups();

function fixture() {
  const temp = tempDir("ghost-watchdog-");
  cleanups.push(temp.cleanup);
  const ghostHome = join(temp.path, "ghost-home");
  const project = join(temp.path, "project");
  const leaf = join(project, "packages", "daemon");
  mkdirSync(ghostHome, { recursive: true });
  mkdirSync(join(project, ".ghost"), { recursive: true });
  mkdirSync(leaf, { recursive: true });
  return { ghostHome, project, leaf };
}

describe("WATCHDOG discovery", () => {
  it("orders ghost-home policy first, then project ancestor to leaf", async () => {
    const { ghostHome, project, leaf } = fixture();
    writeFileSync(join(ghostHome, "WATCHDOG.md"), "user", "utf8");
    writeFileSync(join(project, "WATCHDOG.md"), "root", "utf8");
    writeFileSync(join(project, ".ghost", "WATCHDOG.md"), "root-dot", "utf8");
    writeFileSync(join(project, "packages", "WATCHDOG.md"), "packages", "utf8");
    writeFileSync(join(leaf, "WATCHDOG.md"), "leaf", "utf8");

    const items = await collectConfigCandidates(leaf, ghostHome, ["WATCHDOG.md"], {
      trustedProjectRoot: project,
    });
    expect(items.map((item) => item.content)).toEqual([
      "user",
      "root-dot",
      "root",
      "packages",
      "leaf",
    ]);
    expect(items.map((item) => item.level)).toEqual([
      "user",
      "project",
      "project",
      "project",
      "project",
    ]);
  });

  it("never reads project policy without an explicitly trusted root", async () => {
    const { ghostHome, project, leaf } = fixture();
    writeFileSync(join(ghostHome, "WATCHDOG.md"), "user", "utf8");
    writeFileSync(join(project, "WATCHDOG.md"), "project", "utf8");
    expect((await collectConfigCandidates(leaf, ghostHome, ["WATCHDOG.md"]))
      .map((item) => item.content)).toEqual(["user"]);
  });

  it("stops project discovery at a nested Git root inside the trusted binding", async () => {
    const { ghostHome, project } = fixture();
    const nestedRepo = join(project, "nested");
    const leaf = join(nestedRepo, "src");
    mkdirSync(leaf, { recursive: true });
    execFileSync("git", ["init", "-q", nestedRepo]);
    writeFileSync(join(project, "WATCHDOG.md"), "outer", "utf8");
    writeFileSync(join(nestedRepo, "WATCHDOG.md"), "repo", "utf8");
    writeFileSync(join(leaf, "WATCHDOG.md"), "leaf", "utf8");

    const items = await collectConfigCandidates(leaf, ghostHome, ["WATCHDOG.md"], {
      trustedProjectRoot: project,
    });
    expect(items.map((item) => item.content)).toEqual(["repo", "leaf"]);
  });

  it("filters standalone files owned by hidden directories", async () => {
    const { ghostHome, project } = fixture();
    const hidden = join(project, ".hidden");
    mkdirSync(join(hidden, ".ghost"), { recursive: true });
    writeFileSync(join(hidden, "WATCHDOG.md"), "hidden-standalone", "utf8");
    writeFileSync(join(hidden, ".ghost", "WATCHDOG.md"), "native-config", "utf8");
    const items = await collectConfigCandidates(hidden, ghostHome, ["WATCHDOG.md"], {
      trustedProjectRoot: project,
    });
    expect(items.map((item) => item.content)).toEqual(["native-config"]);
  });

  it("skips malformed UTF-8 and warns instead of throwing", async () => {
    const { ghostHome } = fixture();
    writeFileSync(join(ghostHome, "WATCHDOG.md"), Buffer.from([0xc3, 0x28]));
    const warned: string[] = [];
    await expect(collectConfigCandidates(ghostHome, ghostHome, ["WATCHDOG.md"], {
      warn: (path) => warned.push(path),
    })).resolves.toEqual([]);
    expect(warned).toEqual([join(ghostHome, "WATCHDOG.md")]);
  });

  it("wraps each discovered document in an attention block", async () => {
    const { ghostHome } = fixture();
    writeFileSync(join(ghostHome, "WATCHDOG.md"), "Check invariants.", "utf8");
    expect(await discoverWatchdogFiles(ghostHome, ghostHome)).toEqual([
      "Especially pay attention to:\n<attention>\nCheck invariants.\n</attention>",
    ]);
  });
});
