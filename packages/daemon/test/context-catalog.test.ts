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
  it("reads character, nested docs, atomic memory, and per-file diagnostics", async () => {
    const home = makeGhostHome();
    write(home, "character.md", [
      "---",
      "title: The Navigator",
      "---",
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
    write(home, "memory/zeta.md", [
      "---",
      "description: The last remembered fact",
      "updated: 2026-08-24",
      "---",
      "",
      "Zeta content, including the full body.",
      "",
    ].join("\n"));
    write(home, "memory/alpha.md", [
      "---",
      "description: The first remembered fact",
      "---",
      "",
      "Alpha content.",
      "",
    ].join("\n"));
    write(home, "memory/broken.md", "---\nupdated: 2026-08-25\n---\n\nNo description.");

    const snapshot = await readGhostContext(home);

    expect(snapshot.character).toEqual({ path: "character.md", title: "The Navigator" });
    expect(snapshot.docs).toEqual([
      {
        path: "docs/guides/first-stop.md",
        relativePath: "guides/first-stop.md",
        title: "First Stop",
        tags: [],
        archived: false,
      },
      {
        path: "docs/z-last.md",
        relativePath: "z-last.md",
        title: "Last Note",
        tags: ["reference", "route-planning"],
        archived: true,
      },
    ]);
    expect(snapshot.memory).toEqual([
      {
        path: "memory/alpha.md",
        slug: "alpha",
        description: "The first remembered fact",
        content: "Alpha content.",
        updated: null,
      },
      {
        path: "memory/zeta.md",
        slug: "zeta",
        description: "The last remembered fact",
        content: "Zeta content, including the full body.",
        updated: "2026-08-24",
      },
    ]);
    expect(snapshot.skipped).toHaveLength(2);
    expect(snapshot.skipped.map(({ section, path }) => ({ section, path }))).toEqual([
      { section: "docs", path: "docs/broken.md" },
      { section: "memory", path: "memory/broken.md" },
    ]);
    expect(snapshot.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("uses OMP agent precedence and effective disabled-agent settings", async () => {
    const home = makeGhostHome();
    write(home, "settings.yml", [
      "task:",
      "  disabledAgents:",
      "    - hidden-helper",
      "    - reviewer",
      "",
    ].join("\n"));
    write(home, "agents/scout.md", [
      "---",
      "name: scout",
      "description: Project scout override",
      "tools: [read, grep]",
      "model: [\"@smol\", \"openai/test-model\"]",
      "spawns: [task, librarian]",
      "---",
      "Project-only investigation instructions.",
    ].join("\n"));
    write(home, "agents/plain-helper.md", [
      "---",
      "name: plain-helper",
      "description: Minimal project helper",
      "---",
      "Project helper instructions.",
    ].join("\n"));
    write(home, "agents/hidden-helper.md", [
      "---",
      "name: hidden-helper",
      "description: Disabled project helper",
      "---",
      "Never visible.",
    ].join("\n"));

    const snapshot = await readGhostContext(home);
    const scout = snapshot.agents.find((agent) => agent.name === "scout");
    const plain = snapshot.agents.find((agent) => agent.name === "plain-helper");

    expect(scout).toEqual({
      name: "scout",
      description: "Project scout override",
      source: "user",
      tools: ["read", "grep", "yield"],
      model: ["@smol", "openai/test-model"],
      spawns: ["task", "librarian"],
    });
    expect(plain).toEqual({
      name: "plain-helper",
      description: "Minimal project helper",
      source: "user",
      tools: null,
      model: [],
      spawns: null,
    });
    expect(snapshot.agents.some((agent) => agent.name === "task" && agent.source === "bundled"))
      .toBe(true);
    expect(snapshot.agents.some((agent) => agent.name === "hidden-helper")).toBe(false);
    expect(snapshot.agents.some((agent) => agent.name === "reviewer")).toBe(false);
    expect(snapshot.agents.map((agent) => agent.name)).toEqual(
      [...snapshot.agents.map((agent) => agent.name)].sort((left, right) => left.localeCompare(right)),
    );
    const serializedAgents = JSON.stringify(snapshot.agents);
    expect(snapshot.agents.every((agent) => !("filePath" in agent))).toBe(true);
    expect(snapshot.agents.every((agent) => !("systemPrompt" in agent))).toBe(true);
    expect(serializedAgents).not.toContain(home);
    expect(serializedAgents).not.toContain("Project-only investigation instructions.");
    expect(serializedAgents).not.toContain("Project helper instructions.");
  });
});
