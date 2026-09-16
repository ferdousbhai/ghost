/**
 * The declarative capabilities a ghost home or trusted project contributes to
 * a session: skills, rules, prompt templates, and Markdown slash commands,
 * plus the frontmatter parsing they share. The shapes follow the Markdown
 * conventions Oh My Pi and Claude Code established so existing homes keep
 * loading; Ghost renders them into its own prompt.
 */
import { parseFrontmatter as piParseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface SourceMeta {
  provider: string;
  providerName: string;
  path: string;
  level: "user" | "project" | "native";
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  /** The exact bytes admitted at scan time; never re-read from disk. */
  snapshotContent?: string;
  hide?: boolean;
  containRoot?: string;
  _source?: SourceMeta;
}

export interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  _source: SourceMeta;
}

export interface PromptTemplate {
  name: string;
  description: string;
  content: string;
  source: string;
}

export interface FileSlashCommand {
  name: string;
  description: string;
  content: string;
  source: string;
  _source?: { providerName: string; level: "user" | "project" | "native" };
}

/**
 * pi's frontmatter split (`{ frontmatter, body }` with the body trimmed),
 * plus Ghost's rule that a frontmatter block must be a mapping.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const parsed = piParseFrontmatter(content);
  if (parsed.frontmatter === null || typeof parsed.frontmatter !== "object" || Array.isArray(parsed.frontmatter)) {
    throw new TypeError("Frontmatter must be a mapping.");
  }
  return parsed;
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const token = value.trim();
    return token ? [token] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const tokens = value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}

export function buildRuleFromMarkdown(
  name: string,
  content: string,
  filePath: string,
  source: SourceMeta,
): Rule {
  const { frontmatter, body } = parseFrontmatter(content);
  const rawMode = frontmatter.interruptMode;
  const interruptMode = rawMode === "never" || rawMode === "prose-only" || rawMode === "tool-only" || rawMode === "always"
    ? rawMode
    : undefined;
  const lists = {
    globs: stringList(frontmatter.globs),
    condition: stringList(frontmatter.condition),
    astCondition: stringList(frontmatter.astCondition),
    scope: stringList(frontmatter.scope),
  };
  return {
    name,
    path: filePath,
    content: body,
    alwaysApply: frontmatter.alwaysApply === true,
    ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
    ...Object.fromEntries(Object.entries(lists).filter(([, value]) => value !== undefined)),
    ...(interruptMode ? { interruptMode } : {}),
    _source: source,
  };
}
