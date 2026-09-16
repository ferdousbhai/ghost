import type {
  FileSlashCommand,
  PromptTemplate,
  Rule,
  Skill,
} from "./declarative-types.js";
import type { DeclarativeSnapshot } from "./declarative-resources.js";

export interface EffectiveDeclarativeSnapshot {
  contextFiles: Array<{ path: string; content: string }>;
  skills: Skill[];
  rules: Rule[];
  promptTemplates: PromptTemplate[];
  slashCommands: FileSlashCommand[];
}

function mergeNamed<T extends { name: string }>(
  groups: readonly (readonly T[])[],
): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) merged.set(item.name, item);
  }
  return [...merged.values()];
}

export function mergeDeclarativeSnapshots(
  snapshots: readonly DeclarativeSnapshot[],
): EffectiveDeclarativeSnapshot {
  return {
    contextFiles: snapshots.flatMap((snapshot) => snapshot.contextFiles),
    skills: mergeNamed(snapshots.map((snapshot) => snapshot.skills)),
    rules: mergeNamed(snapshots.map((snapshot) => snapshot.rules)),
    promptTemplates: mergeNamed(snapshots.map((snapshot) => snapshot.promptTemplates)),
    slashCommands: mergeNamed(snapshots.map((snapshot) => snapshot.slashCommands)),
  };
}

export interface PiDeclarativePromptOptions {
  readonly disabledRules?: readonly string[];
}

export function renderPiDeclarativePrompt(
  snapshot: EffectiveDeclarativeSnapshot,
  options: PiDeclarativePromptOptions = {},
): string {
  const disabledRules = new Set(options.disabledRules ?? []);
  const unconditionalRules = snapshot.rules.filter((rule) =>
    !disabledRules.has(rule.name)
    && rule.alwaysApply === true
    && !rule.condition?.length
    && !rule.astCondition?.length);
  const discoverableRules = snapshot.rules.filter((rule) =>
    !disabledRules.has(rule.name)
    && rule.alwaysApply !== true
    && !rule.condition?.length
    && !rule.astCondition?.length
    && Boolean(rule.description));
  const skills = snapshot.skills.filter((skill) => skill.hide !== true);
  const sections: string[] = [];

  if (snapshot.contextFiles.length > 0 || unconditionalRules.length > 0) {
    sections.push([
      "## Instructions",
      ...snapshot.contextFiles.map((file) =>
        `<instruction path=${JSON.stringify(file.path)}>\n${file.content}\n</instruction>`),
      ...unconditionalRules.map((rule) =>
        `<rule name=${JSON.stringify(rule.name)} path=${JSON.stringify(rule.path)}>\n${rule.content}\n</rule>`),
    ].join("\n\n"));
  }

  if (skills.length > 0) {
    sections.push([
      "## Skills",
      "When a skill matches, read its listed `SKILL.md` before acting.",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`),
    ].join("\n"));
  }

  if (discoverableRules.length > 0) {
    sections.push([
      "## Rules",
      "When a rule matches, read `rule://<name>` before acting.",
      ...discoverableRules.map((rule) => {
        const globs = rule.globs?.length ? ` (${rule.globs.join(", ")})` : "";
        return `- ${rule.name}${globs}: ${rule.description}`;
      }),
    ].join("\n"));
  }

  return sections.join("\n\n");
}
