import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMachineSkills, machineSkillPaths } from "../src/machine-skills.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSkill(path: string, name: string, description: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`,
  );
}

describe("machine skills", () => {
  it("admits ambient skills without a name allowlist and follows standard symlinks", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-machine-skills-"));
    const managed = mkdtempSync(join(tmpdir(), "ghost-managed-skills-"));
    roots.push(ownerHome, managed);
    const agentsSkills = join(ownerHome, ".agents", "skills");
    const piSkills = join(ownerHome, ".pi", "agent", "skills");
    writeSkill(join(agentsSkills, "ambient"), "ambient", "An owner-installed ambient skill.");
    writeSkill(join(managed, "omarchy"), "omarchy", "The managed Omarchy CLI skill.");
    mkdirSync(piSkills, { recursive: true });
    symlinkSync(join(managed, "omarchy"), join(piSkills, "omarchy"));

    const snapshot = await loadMachineSkills(ownerHome, { omarchySkillPath: join(ownerHome, "missing.md") });

    expect(snapshot?.skills.map((skill) => skill.name)).toEqual(["ambient", "omarchy"]);
    expect(snapshot?.skills.find((skill) => skill.name === "omarchy")?.filePath)
      .toBe(join(piSkills, "omarchy", "SKILL.md"));
    expect(snapshot?.skills.find((skill) => skill.name === "omarchy")?.snapshotContent)
      .toContain("Use omarchy.");
    expect(snapshot?.contextFiles).toEqual([]);
    expect(snapshot?.rules).toEqual([]);
  });

  it("deduplicates a packaged skill and its user symlink by real path", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-machine-dedupe-"));
    const packaged = mkdtempSync(join(tmpdir(), "ghost-packaged-skills-"));
    roots.push(ownerHome, packaged);
    const skillDir = join(packaged, "omarchy");
    writeSkill(skillDir, "omarchy", "The packaged Omarchy CLI skill.");
    const agentsSkills = join(ownerHome, ".agents", "skills");
    mkdirSync(agentsSkills, { recursive: true });
    symlinkSync(skillDir, join(agentsSkills, "omarchy"));

    const skillFile = join(skillDir, "SKILL.md");
    const snapshot = await loadMachineSkills(ownerHome, { omarchySkillPath: skillFile });

    expect(snapshot?.skills.map((skill) => skill.name)).toEqual(["omarchy"]);
    expect(machineSkillPaths(ownerHome, { omarchySkillPath: skillFile })).toEqual([
      agentsSkills,
      join(ownerHome, ".pi", "agent", "skills"),
      skillFile,
    ]);
  });

  it("does nothing when no machine skill path exists", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-no-machine-skills-"));
    roots.push(ownerHome);
    await expect(loadMachineSkills(ownerHome, { omarchySkillPath: join(ownerHome, "missing.md") }))
      .resolves.toBeNull();
  });
});
