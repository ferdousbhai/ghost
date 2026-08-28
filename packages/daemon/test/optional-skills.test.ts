import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOptionalMachineSkills } from "../src/optional-skills.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("optional machine skills", () => {
  it("admits only exact recommended entrypoints with their expected names", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-optional-skills-"));
    roots.push(ownerHome);
    const skills = join(ownerHome, ".agents", "skills");
    mkdirSync(join(skills, "basecamp"), { recursive: true });
    mkdirSync(join(skills, "firecrawl"), { recursive: true });
    mkdirSync(join(skills, "firecrawl", "nested"), { recursive: true });
    mkdirSync(join(skills, "gws-gmail"), { recursive: true });
    mkdirSync(join(skills, "hey"), { recursive: true });
    mkdirSync(join(skills, "obsidian-cli"), { recursive: true });
    mkdirSync(join(skills, "ambient"), { recursive: true });
    writeFileSync(
      join(skills, "basecamp", "SKILL.md"),
      "---\nname: firecrawl\ndescription: Must not shadow another integration.\n---\n\nIgnore me.\n",
    );
    writeFileSync(
      join(skills, "firecrawl", "SKILL.md"),
      "---\nname: firecrawl\ndescription: Official Firecrawl CLI skill.\n---\n\nUse firecrawl.\n",
    );
    writeFileSync(
      join(skills, "firecrawl", "nested", "SKILL.md"),
      "---\nname: firecrawl\ndescription: Must not shadow the entrypoint.\n---\n\nIgnore me.\n",
    );
    writeFileSync(
      join(skills, "gws-gmail", "SKILL.md"),
      "---\nname: gws-gmail\ndescription: Official Google Workspace Gmail skill.\n---\n\nUse gws.\n",
    );
    writeFileSync(
      join(skills, "hey", "SKILL.md"),
      "---\nname: hey\ndescription: Official HEY CLI skill.\n---\n\nUse hey.\n",
    );
    writeFileSync(
      join(skills, "obsidian-cli", "SKILL.md"),
      "---\nname: obsidian-cli\ndescription: Obsidian CLI skill.\n---\n\nUse obsidian.\n",
    );
    writeFileSync(
      join(skills, "ambient", "SKILL.md"),
      "---\nname: ambient\ndescription: Must stay invisible.\n---\n\nIgnore me.\n",
    );

    const snapshot = await loadOptionalMachineSkills(ownerHome);
    expect(snapshot?.skills.map((skill) => skill.name)).toEqual([
      "firecrawl",
      "gws-gmail",
      "hey",
      "obsidian-cli",
    ]);
    expect(snapshot?.skills.find((skill) => skill.name === "firecrawl")?.filePath)
      .toBe(join(skills, "firecrawl", "SKILL.md"));
    expect(snapshot?.skills.find((skill) => skill.name === "firecrawl")?.description)
      .toBe("Official Firecrawl CLI skill.");
    expect(snapshot?.skills.find((skill) => skill.name === "hey")?.filePath)
      .toBe(join(skills, "hey", "SKILL.md"));
    expect(snapshot?.contextFiles).toEqual([]);
    expect(snapshot?.rules).toEqual([]);
    expect(snapshot?.warnings).toContainEqual(
      expect.stringContaining("skills/basecamp/SKILL.md was ignored because its skill name is not basecamp"),
    );
  });

  it("does nothing before the optional official skill is installed", async () => {
    const ownerHome = mkdtempSync(join(tmpdir(), "ghost-no-optional-skills-"));
    roots.push(ownerHome);
    await expect(loadOptionalMachineSkills(ownerHome)).resolves.toBeNull();
  });
});
