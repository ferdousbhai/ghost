import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPersonaExtension } from "../src/extensions/persona.js";
import { openGhostHome } from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import { loadExtension } from "./support/harness.js";

const PI_PROMPT = "You are pi, a coding agent. Use the bash tool to run commands.";

let fixture: GhostFixture;

beforeEach(async () => {
  fixture = await createGhostFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("persona extension", () => {
  it("replaces pi's native system prompt with the ghost prompt", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = await harness.beforeAgentStart(PI_PROMPT);
    expect(prompt?.startsWith("# Casper")).toBe(true);
    expect(prompt).not.toContain(PI_PROMPT);
  });

  it("preserves the complete nonblank plain-Markdown character body", async () => {
    const body = " \t\n   # Boundary Persona\n\n  Keep this indentation.  \nTrailing hard break.  \n\n";
    await writeFile(join(fixture.dir, "character.md"), body, "utf8");
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = await harness.beforeAgentStart(PI_PROMPT);

    expect(prompt?.slice(0, body.length)).toBe(body);
    expect(prompt?.slice(body.length)).toMatch(/^\n\n## Character file\n/);
    expect(prompt).not.toContain("---\ntitle:");
  });

  it("assembles character and the derived private memory index", async () => {
    await utimes(
      join(fixture.dir, "memory", "apprentice-question.md"),
      new Date("2026-08-26T08:00:00.000Z"),
      new Date("2026-08-26T08:00:00.000Z"),
    );
    await utimes(
      join(fixture.dir, "memory", "working-habit.md"),
      new Date("2026-08-27T08:00:00.000Z"),
      new Date("2026-08-27T08:00:00.000Z"),
    );
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart()) ?? "";

    expect(prompt).toContain("the ghost of a working typographer");
    expect(prompt).toContain(JSON.stringify(join(fixture.dir, "character.md")));
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain(JSON.stringify(join(fixture.dir, "memory")));
    expect(prompt).toContain("Never use private memory for owner facts or preferences");
    expect(prompt).toContain("Put those in Obsidian through its CLI");
    expect(prompt).toContain("apprentice-question");
    expect(prompt).not.toContain("I explained how to start");
    expect(prompt.indexOf("working-habit")).toBeLessThan(prompt.indexOf("apprentice-question"));
    expect(prompt).not.toContain("## Documents");
  });

  it("does not carry text from the inherited harness prompt", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart("UNIQUE-UPSTREAM-HARNESS-INSTRUCTION")) ?? "";
    expect(prompt).not.toContain("UNIQUE-UPSTREAM-HARNESS-INSTRUCTION");
  });

  it("derives the prompt once per session", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const first = await harness.beforeAgentStart();
    expect(first).not.toContain("freshly-written");
    await openGhostHome(fixture.dir).writeMemory({
      content: "freshly-written memory between turns",
    });
    expect(await harness.beforeAgentStart()).toBe(first);
  });

  it("picks up a memory written between sessions", async () => {
    const before = await loadExtension(createPersonaExtension(), fixture.dir);
    expect(await before.beforeAgentStart()).not.toContain("freshly-written");
    await openGhostHome(fixture.dir).writeMemory({
      content: "freshly-written memory between turns",
    });
    const after = await loadExtension(createPersonaExtension(), fixture.dir);
    expect(await after.beforeAgentStart()).toContain("freshly-written-memory-between-turns");
  });

  it("says so plainly when there is no character file", async () => {
    const empty = await createGhostFixture("mina", {});
    try {
      const harness = await loadExtension(createPersonaExtension(), empty.dir);
      const prompt = (await harness.beforeAgentStart()) ?? "";
      expect(prompt).toContain("You are mina.");
      expect(prompt).toContain("Your character is unwritten.");
    } finally {
      await empty.cleanup();
    }
  });

  it("takes the ghost home from the session cwd", async () => {
    const other = await createGhostFixture("mina", { "character.md": "# Mina\n" });
    try {
      const factory = createPersonaExtension();
      const [casperPrompt, minaPrompt] = await Promise.all([
        (await loadExtension(factory, fixture.dir)).beforeAgentStart(),
        (await loadExtension(factory, other.dir)).beforeAgentStart(),
      ]);
      expect(casperPrompt).toContain("# Casper");
      expect(minaPrompt).toContain("# Mina");
    } finally {
      await other.cleanup();
    }
  });
});
