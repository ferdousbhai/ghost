import type { loadSkills } from "@earendil-works/pi-coding-agent";
import type { DeclarativeSnapshot } from "./declarative-snapshot.js";

/** Host I/O remains explicit. Pi owns discovery, ignores, symlinks and collisions. */
export interface MachineSkillHost {
  join(...parts: string[]): string;
  exists(path: string): boolean;
  read(path: string): string;
  loadSkills: typeof loadSkills;
}

export interface MachineSkillOptions {
  /** Complete path override shared with pi's native resource loader. */
  paths?: readonly string[];
}

export interface MachineSkillDiagnostic {
  path?: string;
  reason: string;
  shadowedBy?: string;
}

export interface MachineSkillSnapshot extends DeclarativeSnapshot {
  skillDiagnostics: MachineSkillDiagnostic[];
}

/** The standard owner-trusted machine roots shared by agent skill installers. */
export function machineSkillPaths(
  ownerHome: string,
  options: MachineSkillOptions = {},
  join: (...parts: string[]) => string,
): string[] {
  if (options.paths) return [...options.paths];
  return [
    join(ownerHome, ".agents", "skills"),
    join(ownerHome, ".pi", "agent", "skills"),
  ];
}

function diagnosticMessage(diagnostic: ReturnType<typeof loadSkills>["diagnostics"][number]): string {
  return [diagnostic.path, diagnostic.message].filter(Boolean).join(": ");
}

function compareSkillName(left: { name: string }, right: { name: string }): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/** Snapshot every skill pi admits from the owner-trusted machine paths. */
export async function snapshotMachineSkills(
  ownerHome: string,
  options: MachineSkillOptions,
  host: MachineSkillHost,
): Promise<MachineSkillSnapshot | null> {
  const { join, exists, read, loadSkills } = host;
  const paths = machineSkillPaths(ownerHome, options, join).filter((path) => exists(path));
  if (paths.length === 0) return null;
  const loaded = loadSkills({
    cwd: ownerHome,
    agentDir: join(ownerHome, ".pi", "agent"),
    skillPaths: paths,
    includeDefaults: false,
  });
  const skillDiagnostics = loaded.diagnostics.map((diagnostic): MachineSkillDiagnostic => ({
    ...(diagnostic.path || diagnostic.collision?.loserPath
      ? { path: diagnostic.path ?? diagnostic.collision?.loserPath }
      : {}),
    reason: diagnostic.message,
    ...(diagnostic.collision?.winnerPath
      ? { shadowedBy: diagnostic.collision.winnerPath }
      : {}),
  }));
  const warnings = loaded.diagnostics.map(diagnosticMessage);
  const skills = [...loaded.skills].sort(compareSkillName).flatMap((skill) => {
    try {
      return [{
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        source: "via Ghost machine",
        snapshotContent: read(skill.filePath),
        hide: skill.disableModelInvocation,
        _source: {
          provider: "ghost-machine",
          providerName: "Ghost machine",
          path: skill.filePath,
          level: "native" as const,
        },
      }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${skill.filePath}: ${reason}`);
      skillDiagnostics.push({ path: skill.filePath, reason });
      return [];
    }
  });
  return {
    contextFiles: [],
    skills,
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    warnings,
    skillDiagnostics,
    truncated: false,
  };
}
