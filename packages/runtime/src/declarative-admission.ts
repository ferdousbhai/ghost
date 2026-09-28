import type { FileSlashCommand, PromptTemplate, Rule, Skill, SourceMeta } from "./declarative-types.js";
import type { createDeclarativeParser } from "./declarative-types.js";
import type { DeclarativeSnapshot } from "./declarative-snapshot.js";
export const SCAN_MAX_ENTRIES = 512;
export const SCAN_MAX_BYTES = 1_048_576;
export const SCAN_MAX_FILE_BYTES = 262_144;
export const SCAN_MAX_DEPTH = 8;
export const SCAN_TIMEOUT_MS = 1_000;
export const GHOST_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export interface MarkdownFile {
  relativePath: string;
  absolutePath: string;
  content: string;
}
function sourceFor(path: string, level: "user" | "native"): SourceMeta {
  return {
    provider: level === "native" ? "ghost-recommended" : "ghost-pinned",
    providerName: level === "native" ? "Ghost recommended" : "Ghost",
    path,
    level,
  };
}
function description(body: string, frontmatter: Record<string, unknown>): string {
  const configured = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (configured) return configured;
  const first = body.split("\n").find((line) => line.trim())?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}...` : first;
}
function basename(path: string, suffix = ""): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/** Interpret already-admitted immutable bytes. The host owns traversal and location syntax. */
export function admitDeclarativeResources(input: {
  contextFiles: DeclarativeSnapshot["contextFiles"];
  skillFiles: readonly MarkdownFile[];
  ruleFiles: readonly MarkdownFile[];
  promptFiles: readonly MarkdownFile[];
  commandFiles: readonly MarkdownFile[];
  level: "user" | "native";
  warnings: string[];
  truncated: boolean;
  parentPath(path: string): string;
}, parser: ReturnType<typeof createDeclarativeParser>): DeclarativeSnapshot {
  const { contextFiles, skillFiles, ruleFiles, promptFiles, commandFiles, level, warnings, truncated, parentPath } = input;
  const { parseFrontmatter, buildRuleFromMarkdown } = parser;
    const skillEntries = new Map<string, Skill>();
    for (const file of skillFiles) {
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(file.content);
      } catch {
        warnings.push(`${file.relativePath} was ignored because its skill metadata is invalid.`);
        continue;
      }
      const { frontmatter } = parsed;
      const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
      const detail = typeof frontmatter.description === "string"
        ? frontmatter.description.trim()
        : "";
      if (!name || !detail) {
        warnings.push(`${file.relativePath} was ignored because its skill name or description is missing.`);
        continue;
      }
      skillEntries.set(name, {
        name,
        description: detail,
        filePath: file.absolutePath,
        baseDir: parentPath(file.absolutePath),
        containRoot: parentPath(file.absolutePath),
        source: level === "native" ? "ghost-recommended:native" : `ghost-pinned:${level}`,
        snapshotContent: file.content,
        hide: frontmatter.hide === true || frontmatter.disableModelInvocation === true,
        _source: sourceFor(file.absolutePath, level),
      });
    }
    const skills = [...skillEntries.values()];

    const ruleEntries = new Map<string, Rule>();
    for (const file of ruleFiles) {
      try {
        parseFrontmatter(file.content);
      } catch {
        warnings.push(`${file.relativePath} was ignored because its rule metadata is invalid.`);
        continue;
      }
      const name = basename(file.relativePath, ".md");
      ruleEntries.set(name, buildRuleFromMarkdown(
        name,
        file.content,
        file.absolutePath,
        sourceFor(file.absolutePath, level),
      ));
    }
    const rules = [...ruleEntries.values()];
    const promptEntries = new Map<string, PromptTemplate>();
    for (const file of promptFiles) {
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(file.content);
      } catch {
        warnings.push(`${file.relativePath} was ignored because its prompt metadata is invalid.`);
        continue;
      }
      const { frontmatter, body } = parsed;
      const source = `(${level}:ghost-pinned)`;
      const detail = description(body, frontmatter);
      const name = basename(file.relativePath, ".md");
      promptEntries.set(name, {
        name,
        description: detail ? `${detail} ${source}` : source,
        content: body,
        source,
      });
    }
    const promptTemplates = [...promptEntries.values()];
    const commandEntries = new Map<string, FileSlashCommand>();
    for (const file of commandFiles) {
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(file.content);
      } catch {
        warnings.push(`${file.relativePath} was ignored because its command metadata is invalid.`);
        continue;
      }
      const { frontmatter, body } = parsed;
      const name = basename(file.relativePath, ".md");
      commandEntries.set(name, {
        name,
        description: description(body, frontmatter),
        content: body,
        source: `via Ghost ${level}`,
        _source: { providerName: "Ghost", level: level },
      });
    }
    const slashCommands = [...commandEntries.values()];

    return {
      contextFiles,
      skills,
      rules,
      promptTemplates,
      slashCommands,
      warnings: warnings,
      truncated,
    };
}
