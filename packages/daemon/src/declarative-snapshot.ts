/** Shared accepted-resource merge semantics for the Pi and Claude runtimes. */
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { FileSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
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
  rules: Array<{ name: string; path: string; content: string }>;
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

/** Project resources shadow same-named Ghost resources exactly as Pi has always done. */
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

/** Keep only the accepted typed bytes that a non-OMP prompt runtime consumes. */
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

export function renderDeclarativePrompt(snapshot: DeclarativePromptSnapshot): string {
  const sections = [
    ...snapshot.instructions.map((item) => ({
      kind: "instruction",
      label: `path=${JSON.stringify(item.path)}`,
      content: item.content,
    })),
    ...snapshot.skills.map((item) => ({
      kind: "skill",
      label: `name=${JSON.stringify(item.name)} path=${JSON.stringify(item.path)}`,
      content: item.content,
    })),
    ...snapshot.rules.map((item) => ({
      kind: "rule",
      label: `name=${JSON.stringify(item.name)} path=${JSON.stringify(item.path)}`,
      content: item.content,
    })),
    ...snapshot.prompts.map((item) => ({
      kind: "prompt",
      label: `name=${JSON.stringify(item.name)}`,
      content: item.content,
    })),
    ...snapshot.commands.map((item) => ({
      kind: "command",
      label: `name=${JSON.stringify(item.name)}`,
      content: item.content,
    })),
  ];
  if (sections.length === 0) return "";
  return [
    "<ghost-declarative-resources>",
    ...sections.map((item) =>
      `<${item.kind} ${item.label}>\n${item.content}\n</${item.kind}>`),
    "</ghost-declarative-resources>",
  ].join("\n");
}
