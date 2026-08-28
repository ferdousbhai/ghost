import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

// The development daemon deliberately does not rediscover the checkout that
// happens to launch it. This content-free fixture represents the exact source
// roots admitted by ghostd, including first-provider instruction precedence.
export const MOCK_PROJECT_SCAN_LIMITS = Object.freeze({
  entries: 512,
  bytes: 1_048_576,
  fileBytes: 262_144,
  depth: 8,
  timeoutMs: 1_000,
});

export const MOCK_PROJECT_SOURCES = Object.freeze({
  instructionCandidates: Object.freeze([
    ".omp/AGENTS.md",
    ".claude/CLAUDE.md",
    ".agents/AGENTS.md",
    "AGENTS.md",
    "CLAUDE.md",
  ]),
  skills: Object.freeze([
    "skills/review/SKILL.md",
    ".agents/skills/research/SKILL.md",
    ".claude/skills/design/SKILL.md",
    ".pi/skills/release/SKILL.md",
    ".omp/skills/local/SKILL.md",
  ]),
  rules: Object.freeze([
    "rules/safety.md",
    ".claude/rules/style.md",
    ".omp/rules/review.md",
  ]),
  prompts: Object.freeze([
    "prompts/brief.md",
    ".claude/prompts/plan.md",
    ".omp/prompts/release.md",
  ]),
  commands: Object.freeze([
    "commands/check.md",
    ".claude/commands/test.md",
    ".omp/commands/review.md",
  ]),
  agents: Object.freeze([
    "agents/scout.md",
    ".claude/agents/designer.md",
    ".omp/agents/reviewer.md",
  ]),
  mcpFiles: Object.freeze([
    Object.freeze({ path: ".omp/mcp.json", names: Object.freeze(["browser", "shared"]) }),
    Object.freeze({ path: ".omp/.mcp.json", names: Object.freeze(["legacy", "shared"]) }),
  ]),
  executable: Object.freeze([
    ".omp/extensions/example.ts",
    ".pi/extensions/example.ts",
    ".omp/hooks/pre-turn.sh",
    ".omp/tools/local.mjs",
    ".claude/hooks/post-turn.sh",
  ]),
});

export const MOCK_PROJECT_WARNING_TEXT = Object.freeze({
  entryLimit: "Project preview stopped at its entry limit.",
  timeLimit: "Project preview stopped at its time limit.",
  truncated: "This preview is truncated; only the displayed counts were admitted.",
});

export function mockProjectResources() {
  const mcpNames = new Set(MOCK_PROJECT_SOURCES.mcpFiles.flatMap((source) => source.names));
  return {
    // All candidates are represented, but Pi provider precedence admits only the first.
    instructions: MOCK_PROJECT_SOURCES.instructionCandidates.length > 0 ? 1 : 0,
    skills: MOCK_PROJECT_SOURCES.skills.length,
    rules: MOCK_PROJECT_SOURCES.rules.length,
    prompts: MOCK_PROJECT_SOURCES.prompts.length,
    commands: MOCK_PROJECT_SOURCES.commands.length,
    agents: MOCK_PROJECT_SOURCES.agents.length,
    mcpServers: mcpNames.size,
    ignoredExecutable: MOCK_PROJECT_SOURCES.executable.length,
  };
}

export function mockProjectWarnings(resources, options = {}) {
  const scanWarnings = Array.isArray(options.scanWarnings)
    ? options.scanWarnings.filter((warning) => typeof warning === "string") : [];
  return [
    ...scanWarnings,
    ...(resources.ignoredExecutable > 0
      ? [`${resources.ignoredExecutable} executable project resource(s) will remain disabled until isolated workers are available.`]
      : []),
    ...(options.truncated === true ? [MOCK_PROJECT_WARNING_TEXT.truncated] : []),
  ];
}

/**
 * Resolve a mock project without following a symbolic link in any component.
 * The live daemon pins descriptors; this synchronous walk gives the development
 * server the same admission result without pretending to be its security layer.
 */
export function resolveMockProjectRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const root = resolve(path);
  let current = sep;
  try {
    const rootInfo = lstatSync(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
    for (const part of root.split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    return root;
  } catch {
    return null;
  }
}
