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
    writeSkill(join(managed, "diagnose-crash"), "diagnose-crash", "Diagnose a system crash.");
    mkdirSync(piSkills, { recursive: true });
    symlinkSync(join(managed, "omarchy"), join(piSkills, "omarchy"));
    symlinkSync(join(managed, "diagnose-crash"), join(piSkills, "diagnose-crash"));

    const snapshot = await loadMachineSkills(ownerHome);

    expect(snapshot?.skills.map((skill) => skill.name).sort()).toEqual([
      "ambient",
      "diagnose-crash",
      "omarchy",
    ]);
    expect(snapshot?.skills.find((skill) => skill.name === "omarchy")?.filePath)
      .toBe(join(piSkills, "omarchy", "SKILL.md"));
    expect(snapshot?.skills.find((skill) => skill.name === "omarchy")?.snapshotContent)
      .toContain("Use omarchy.");
    expect(snapshot?.contextFiles).toEqual([]);
    expect(snapshot?.rules).toEqual([]);
  });

  it("deduplicates one managed skill linked into both standard roots", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-machine-dedupe-"));
    const packaged = mkdtempSync(join(tmpdir(), "ghost-packaged-skills-"));
    roots.push(ownerHome, packaged);
    const skillDir = join(packaged, "omarchy");
    writeSkill(skillDir, "omarchy", "The packaged Omarchy CLI skill.");
    const agentsSkills = join(ownerHome, ".agents", "skills");
    const piSkills = join(ownerHome, ".pi", "agent", "skills");
    mkdirSync(agentsSkills, { recursive: true });
    mkdirSync(piSkills, { recursive: true });
    symlinkSync(skillDir, join(agentsSkills, "omarchy"));
    symlinkSync(skillDir, join(piSkills, "omarchy"));

    const snapshot = await loadMachineSkills(ownerHome);

    expect(snapshot?.skills.map((skill) => skill.name)).toEqual(["omarchy"]);
    expect(machineSkillPaths(ownerHome)).toEqual([
      agentsSkills,
      piSkills,
    ]);
  });

  it("does nothing when no machine skill path exists", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-no-machine-skills-"));
    roots.push(ownerHome);
    await expect(loadMachineSkills(ownerHome)).resolves.toBeNull();
  });
});
