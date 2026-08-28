import type { FileSlashCommand, PromptTemplate, Rule, Skill } from "./declarative-types.js";
import type { ProjectDeclarativeSnapshot } from "./project-resources.js";

export interface EffectiveDeclarativeSnapshot {
  contextFiles: Array<{ path: string; content: string }>;
  skills: Skill[];
  rules: Rule[];
  promptTemplates: PromptTemplate[];
  slashCommands: FileSlashCommand[];
}

export interface DeclarativePromptSnapshot {
  instructions: Array<{ path: string; content: string }>;
  skills: Array<{ name: string; path: string; content: string }>;
  rules: Array<{ name: string; path: string; content: string; alwaysApply?: boolean }>;
  prompts: Array<{ name: string; content: string }>;
  commands: Array<{ name: string; content: string }>;
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

function requiredContent(value: string | undefined, category: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Accepted ${category} snapshot is missing its admitted content.`);
  }
  return value;
}

export function mergeProjectDeclarativeSnapshots(
  snapshots: readonly ProjectDeclarativeSnapshot[],
): EffectiveDeclarativeSnapshot {
  return {
    contextFiles: snapshots.flatMap((snapshot) => snapshot.contextFiles),
    skills: mergeNamed(snapshots.map((snapshot) => snapshot.skills)),
    rules: mergeNamed(snapshots.map((snapshot) => snapshot.rules)),
    promptTemplates: mergeNamed(snapshots.map((snapshot) => snapshot.promptTemplates)),
    slashCommands: mergeNamed(snapshots.map((snapshot) => snapshot.slashCommands)),
  };
}

export function declarativePromptSnapshot(
  snapshot: EffectiveDeclarativeSnapshot,
): DeclarativePromptSnapshot {
  return {
    instructions: snapshot.contextFiles.map((file) => ({ ...file })),
    skills: snapshot.skills.map((skill) => ({
      name: skill.name,
      path: skill.filePath,
      content: requiredContent(skill.snapshotContent, "skill"),
    })),
    rules: snapshot.rules.map((rule) => ({
      name: rule.name,
      path: rule.path,
      content: requiredContent(rule.content, "rule"),
      ...(rule.alwaysApply === true ? { alwaysApply: true } : {}),
    })),
    prompts: snapshot.promptTemplates.map((prompt) => ({
      name: prompt.name,
      content: prompt.content,
    })),
    commands: snapshot.slashCommands.map((command) => ({
      name: command.name,
      content: command.content,
    })),
  };
}

export function mergeDeclarativePromptSnapshots(
  snapshots: readonly DeclarativePromptSnapshot[],
): DeclarativePromptSnapshot {
  return {
    instructions: snapshots.flatMap((snapshot) => snapshot.instructions),
    skills: mergeNamed(snapshots.map((snapshot) => snapshot.skills)),
    rules: mergeNamed(snapshots.map((snapshot) => snapshot.rules)),
    prompts: mergeNamed(snapshots.map((snapshot) => snapshot.prompts)),
    commands: mergeNamed(snapshots.map((snapshot) => snapshot.commands)),
  };
}

export function renderClaudeDeclarativePrompt(snapshot: DeclarativePromptSnapshot): string {
  const sections = [
    ...snapshot.instructions.map((item) => ({
      kind: "instruction",
      label: `path=${JSON.stringify(item.path)}`,
      content: item.content,
    })),
    ...snapshot.rules.filter((item) => item.alwaysApply === true).map((item) => ({
      kind: "rule",
      label: `name=${JSON.stringify(item.name)} path=${JSON.stringify(item.path)}`,
      content: item.content,
    })),
  ];
  if (sections.length === 0) return "";
  return [
    "## Instructions",
    ...sections.map((item) =>
      `<${item.kind} ${item.label}>\n${item.content}\n</${item.kind}>`),
  ].join("\n");
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
      "When a skill matches, read `skill://<name>` before acting.",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
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
