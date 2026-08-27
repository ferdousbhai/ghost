import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGhostContext } from "../src/context-catalog.js";

const homes: string[] = [];

function makeGhostHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ghost-context-"));
  homes.push(home);
  mkdirSync(join(home, "docs"), { recursive: true });
  mkdirSync(join(home, "memory"), { recursive: true });
  return home;
}

function write(home: string, relativePath: string, content: string): void {
  const path = join(home, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("readGhostContext", () => {
  it("reads character, atomic memory, and per-file diagnostics", async () => {
    const home = makeGhostHome();
    write(home, "character.md", [
      "## The Navigator",
      "",
      "You keep the route.",
    ].join("\n"));
    write(home, "docs/z-last.md", [
      "# Last Note",
      "",
      "Last body.",
      "",
      "#reference #route-planning #archived",
    ].join("\n"));
    write(home, "docs/guides/first-stop.md", "# First Stop\n\nA canonical guide.\n");
    write(home, "docs/broken.md", "---\ntitle: Legacy Metadata\n---\n\nNo H1.");
    write(home, "memory/zeta.md", "The last remembered fact. Zeta content, including the full body.\n");
    write(home, "memory/alpha.md", "The first remembered fact. Alpha content.\n");
    write(home, "memory/broken.md", "\n");

    const snapshot = await readGhostContext(home);

    expect(snapshot.character).toEqual({ path: "character.md", title: "The Navigator" });
    expect(snapshot.memory).toEqual([
      {
        path: "memory/alpha.md",
        slug: "alpha",
        description: "The first remembered fact...",
        content: "The first remembered fact. Alpha content.",
        updated: expect.any(String),
      },
      {
        path: "memory/zeta.md",
        slug: "zeta",
        description: "The last remembered fact...",
        content: "The last remembered fact. Zeta content, including the full body.",
        updated: expect.any(String),
      },
    ]);
    expect(snapshot.skipped).toHaveLength(1);
    expect(snapshot.skipped.map(({ section, path }) => ({ section, path }))).toEqual([
      { section: "memory", path: "memory/broken.md" },
    ]);
    expect(snapshot.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("does not expose ambient or ghost agent definitions while task is disabled", async () => {
    const home = makeGhostHome();
    write(home, ".omp/config.yml", [
      "task:",
      "  disabledAgents:",
      "    - hidden-helper",
      "    - reviewer",
      "",
    ].join("\n"));
    write(home, ".omp/agents/scout.md", [
      "---",
      "name: scout",
      "description: Project scout override",
      "tools: [read, grep]",
      "model: [\"@smol\", \"openai/test-model\"]",
      "spawns: [task, librarian]",
      "---",
      "Project-only investigation instructions.",
    ].join("\n"));
    write(home, ".omp/agents/plain-helper.md", [
      "---",
      "name: plain-helper",
      "description: Minimal project helper",
      "---",
      "Project helper instructions.",
    ].join("\n"));
    write(home, ".omp/agents/hidden-helper.md", [
      "---",
      "name: hidden-helper",
      "description: Disabled project helper",
      "---",
      "Never visible.",
    ].join("\n"));

    const snapshot = await readGhostContext(home);
    expect(snapshot.agents).toEqual([]);
  });
});
