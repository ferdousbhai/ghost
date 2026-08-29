import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { ProjectDeclarativeSnapshot } from "./project-resources.js";

export const OMARCHY_SKILL_PATH = "/usr/share/omarchy/default/agents/skills/omarchy/SKILL.md";

export const OMARCHY_COMPUTER_USE_POLICY = [
  "## Computer use",
  "For laptop, shell, and Omarchy-system actions, first inspect `omarchy commands --json` or the relevant `omarchy <group> --help`, then use the stable `omarchy <group> <action>` route through Bash.",
  "Use `ghost_desktop` and `ghost_screen` only when Omarchy has no route, a tried CLI route fails, or the task must manipulate content inside an arbitrary application. Use `ghost_browser` for browser pages.",
].join("\n");

export interface MachineSkillOptions {
  /** Exact path override for deterministic tests. */
  omarchySkillPath?: string;
  /** Complete path override shared with pi's native resource loader. */
  paths?: readonly string[];
}

/** The owner-trusted machine roots pi scans, plus Omarchy's packaged entrypoint. */
export function machineSkillPaths(
  ownerHome: string,
  options: MachineSkillOptions = {},
): string[] {
  if (options.paths) return [...options.paths];
  return [
    join(ownerHome, ".agents", "skills"),
    join(ownerHome, ".pi", "agent", "skills"),
    options.omarchySkillPath ?? OMARCHY_SKILL_PATH,
  ];
}

function diagnosticMessage(diagnostic: ReturnType<typeof loadSkills>["diagnostics"][number]): string {
  return [diagnostic.path, diagnostic.message].filter(Boolean).join(": ");
}

/** Snapshot every skill pi admits from the owner-trusted machine paths. */
export async function loadMachineSkills(
  ownerHome: string,
  options: MachineSkillOptions = {},
): Promise<ProjectDeclarativeSnapshot | null> {
  const paths = machineSkillPaths(ownerHome, options).filter((path) => existsSync(path));
  if (paths.length === 0) return null;
  const loaded = loadSkills({
    cwd: ownerHome,
    agentDir: join(ownerHome, ".pi", "agent"),
    skillPaths: paths,
    includeDefaults: false,
  });
  const warnings = loaded.diagnostics.map(diagnosticMessage);
  const skills = loaded.skills.flatMap((skill) => {
    try {
      return [{
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        source: "via Ghost machine",
        snapshotContent: readFileSync(skill.filePath, "utf8"),
        hide: skill.disableModelInvocation,
        _source: {
          provider: "ghost-machine",
          providerName: "Ghost machine",
          path: skill.filePath,
          level: "native" as const,
        },
      }];
    } catch (error) {
      warnings.push(`${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  if (skills.length === 0) return null;
  return {
    contextFiles: [],
    skills,
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    mcp: { claimedNames: [], servers: [], skipped: [] },
    mcpWarnings: [],
    resources: {
      instructions: 0,
      skills: skills.length,
      rules: 0,
      prompts: 0,
      commands: 0,
      agents: 0,
      mcpServers: 0,
      ignoredExecutable: 0,
    },
    warnings,
    truncated: false,
  };
}
