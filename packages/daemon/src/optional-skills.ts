import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProjectDeclarativeSnapshot, type ProjectDeclarativeSnapshot } from "./project-resources.js";

const RECOMMENDED_MACHINE_SKILLS = [
  "basecamp",
  "firecrawl",
  "gws-calendar",
  "gws-chat",
  "gws-docs",
  "gws-drive",
  "gws-forms",
  "gws-gmail",
  "gws-keep",
  "gws-meet",
  "gws-people",
  "gws-shared",
  "gws-sheets",
  "gws-slides",
  "gws-tasks",
  "gws-workflow",
  "hey",
  "json-canvas",
  "obsidian-bases",
  "obsidian-cli",
  "obsidian-markdown",
] as const;

/** Load only recommended machine skills from their canonical global entrypoints. */
export async function loadOptionalMachineSkills(ownerHome: string): Promise<ProjectDeclarativeSnapshot | null> {
  const agentsRoot = join(ownerHome, ".agents");
  const skillFiles = RECOMMENDED_MACHINE_SKILLS
    .map((name) => ({ name, relativePath: `skills/${name}/SKILL.md` }))
    .filter((skill) => existsSync(join(agentsRoot, skill.relativePath)));
  if (skillFiles.length === 0) return null;
  const snapshot = await loadProjectDeclarativeSnapshot(agentsRoot, {
    level: "native",
    skillFiles,
  });
  return snapshot.skills.length > 0 ? snapshot : null;
}
