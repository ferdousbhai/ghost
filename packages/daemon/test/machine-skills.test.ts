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
import {
  loadMachineSkills,
  machineSkillPaths,
  SHARED_OBSIDIAN_POLICY,
} from "../src/machine-skills.js";

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
  it("keeps shared-state policy separate from normal machine-skill discovery", () => {
    expect(SHARED_OBSIDIAN_POLICY).toContain("shared by every ghost on this machine");
    expect(SHARED_OBSIDIAN_POLICY).toContain("Never infer or scan for a vault path");
    expect(SHARED_OBSIDIAN_POLICY).toContain("do not fall back to direct vault-file access");
    expect(SHARED_OBSIDIAN_POLICY).not.toContain("SKILL.md");
    expect(SHARED_OBSIDIAN_POLICY).not.toContain(".agents/skills");
  });

  it("admits ambient skills without a name allowlist and follows standard symlinks", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-machine-skills-"));
    const managed = mkdtempSync(join(tmpdir(), "ghost-managed-skills-"));
    roots.push(ownerHome, managed);
    const agentsSkills = join(ownerHome, ".agents", "skills");
    const piSkills = join(ownerHome, ".pi", "agent", "skills");
    writeSkill(
      join(agentsSkills, "obsidian-cli"),
      "obsidian-cli",
      "Official Obsidian CLI skill.",
    );
    writeSkill(join(agentsSkills, "ambient"), "ambient", "An owner-installed ambient skill.");
    writeSkill(join(managed, "omarchy"), "omarchy", "The managed Omarchy CLI skill.");
    writeSkill(join(managed, "diagnose-crash"), "diagnose-crash", "Diagnose a system crash.");
    mkdirSync(piSkills, { recursive: true });
    symlinkSync(join(managed, "omarchy"), join(piSkills, "omarchy"));
    symlinkSync(join(managed, "diagnose-crash"), join(piSkills, "diagnose-crash"));

    const snapshot = await loadMachineSkills(ownerHome);

    expect(snapshot?.skills.map((skill) => skill.name)).toEqual([
      "ambient",
      "diagnose-crash",
      "obsidian-cli",
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

  it("retains diagnostics when a configured machine root admits no skills", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-invalid-machine-skills-"));
    roots.push(ownerHome);
    const invalid = join(ownerHome, ".agents", "skills", "obsidian-cli");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(join(invalid, "SKILL.md"), "not valid skill frontmatter\n");

    const snapshot = await loadMachineSkills(ownerHome);

    expect(snapshot?.skills).toEqual([]);
    expect(snapshot?.skillDiagnostics).toEqual([
      expect.objectContaining({
        path: join(invalid, "SKILL.md"),
        reason: expect.any(String),
      }),
    ]);
  });
});
