import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  declarativePromptSnapshot,
  mergeProjectDeclarativeSnapshots,
  renderDeclarativePrompt,
} from "../src/declarative-snapshot.js";
import { loadProjectDeclarativeSnapshot } from "../src/project-resources.js";
import {
  readPiProjectSnapshot,
  writePiProjectSnapshot,
} from "../src/project-snapshot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("Pi project snapshot schema", () => {
  it("persists each typed resource once and restores rendering without live files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-project-snapshot-schema-"));
    roots.push(root);
    const project = join(root, "project");
    const sessionDir = join(root, "sessions");
    mkdirSync(join(project, ".omp", "skills", "typed"), { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(join(project, ".omp", "prompts"), { recursive: true });
    mkdirSync(join(project, ".omp", "commands"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "TYPED-INSTRUCTION-SENTINEL");
    writeFileSync(
      join(project, ".omp", "skills", "typed", "SKILL.md"),
      "---\nname: typed\ndescription: typed\n---\n\nTYPED-SKILL-SENTINEL",
    );
    writeFileSync(join(project, ".omp", "rules", "typed.md"), "TYPED-RULE-SENTINEL");
    writeFileSync(join(project, ".omp", "prompts", "typed.md"), "TYPED-PROMPT-SENTINEL");
    writeFileSync(join(project, ".omp", "commands", "typed.md"), "TYPED-COMMAND-SENTINEL");

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
    });
    const rendered = renderDeclarativePrompt(
      declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([snapshot])),
    );
    for (const sentinel of [
      "TYPED-INSTRUCTION-SENTINEL",
      "TYPED-SKILL-SENTINEL",
      "TYPED-RULE-SENTINEL",
      "TYPED-PROMPT-SENTINEL",
      "TYPED-COMMAND-SENTINEL",
    ]) {
      expect(rendered).toContain(sentinel);
    }

    const stats = statSync(project, { bigint: true });
    const identity = { dev: stats.dev.toString(), ino: stats.ino.toString() };
    const path = await writePiProjectSnapshot({
      sessionDir,
      conversationId: "typed-only",
      generation: 1,
      root: project,
      identity,
      snapshot,
    });
    const storedText = readFileSync(path, "utf8");
    const stored = JSON.parse(storedText) as {
      version: number;
      snapshot: Record<string, unknown>;
    };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.snapshot).sort()).toEqual([
      "contextFiles",
      "mcp",
      "mcpWarnings",
      "promptTemplates",
      "resources",
      "rules",
      "skills",
      "slashCommands",
      "truncated",
      "warnings",
    ]);
    const typedSnapshotText = JSON.stringify(snapshot);
    for (const sentinel of [
      "TYPED-INSTRUCTION-SENTINEL",
      "TYPED-SKILL-SENTINEL",
      "TYPED-RULE-SENTINEL",
      "TYPED-PROMPT-SENTINEL",
      "TYPED-COMMAND-SENTINEL",
    ]) {
      expect(occurrences(storedText, sentinel))
        .toBe(occurrences(typedSnapshotText, sentinel));
    }

    writeFileSync(join(project, "AGENTS.md"), "MUTATED-LIVE-INSTRUCTION");
    writeFileSync(
      join(project, ".omp", "skills", "typed", "SKILL.md"),
      "---\nname: typed\ndescription: changed\n---\n\nMUTATED-LIVE-SKILL",
    );
    const restored = await readPiProjectSnapshot({
      sessionDir,
      conversationId: "typed-only",
      generation: 1,
      root: project,
      identity,
    });
    const restoredRendering = renderDeclarativePrompt(
      declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([restored])),
    );
    expect(restoredRendering).toBe(rendered);
    expect(restoredRendering).not.toContain("MUTATED-LIVE-INSTRUCTION");
    expect(restoredRendering).not.toContain("MUTATED-LIVE-SKILL");

    stored.snapshot.unexpected = "duplicate representation";
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    await expect(readPiProjectSnapshot({
      sessionDir,
      conversationId: "typed-only",
      generation: 1,
      root: project,
      identity,
    })).rejects.toMatchObject({ code: "project_snapshot_invalid", status: 500 });
  });
});
