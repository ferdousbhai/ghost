import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonaExtension } from "../src/extensions/persona.js";
import { openGhostHome } from "../src/home.js";
import { visitorScope } from "../src/scope.js";
import {
  ARCHIVED_NOTE_PATH,
  createGhostFixture,
  PRIVATE_NOTE_PATH,
  type GhostFixture,
} from "./support/fixture.js";
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
  it("replaces pi's system prompt wholesale", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = await harness.beforeAgentStart(PI_PROMPT);
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain("coding agent");
    expect(prompt).not.toContain("bash");
    expect(prompt?.startsWith("# Casper")).toBe(true);
  });

  it("assembles character, derived memory index, and derived note catalog", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart()) ?? "";
    expect(prompt).toContain("the ghost of a working typographer");
    expect(prompt).toContain("## Your memory");
    expect(prompt).toContain("- apprentice-question.md: A visitor asked how to start");
    expect(prompt).toContain("## Your notes");
    expect(prompt).toContain("craft/paper-notes.md: Paper that takes a deep impression");
    // The creator's view names what is private, and includes it.
    expect(prompt).toContain(PRIVATE_NOTE_PATH);
    expect(prompt).toContain("(private)");
  });

  it("rebuilds the prompt on every agent start", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    expect(await harness.beforeAgentStart()).not.toContain("freshly-written");
    await openGhostHome(fixture.dir).writeMemory({
      description: "freshly-written memory",
      content: "written between turns",
    });
    expect(await harness.beforeAgentStart()).toContain("freshly-written memory");
  });

  it("shows a visitor only the published notes and that visitor's memory", async () => {
    const harness = await loadExtension(
      createPersonaExtension({ scope: visitorScope("visitor-1") }),
      fixture.dir,
    );
    const prompt = (await harness.beforeAgentStart()) ?? "";
    expect(prompt).toContain("craft/paper-notes.md");
    expect(prompt).not.toContain(PRIVATE_NOTE_PATH);
    expect(prompt).not.toContain("Estate and finances");
    expect(prompt).not.toContain(ARCHIVED_NOTE_PATH);
    // Visitor memory, not the creator's.
    expect(prompt).toContain("asked-about-press.md");
    expect(prompt).not.toContain("working-habit.md");
    expect(prompt).toContain("You are talking to a visitor");
  });

  it("says so plainly when there is no character file", async () => {
    const empty = await createGhostFixture("mina", {});
    try {
      const harness = await loadExtension(createPersonaExtension(), empty.dir);
      const prompt = (await harness.beforeAgentStart()) ?? "";
      expect(prompt).toContain("You are mina.");
      expect(prompt).toContain("character.md");
      expect(prompt).toContain("(no notes yet)");
    } finally {
      await empty.cleanup();
    }
  });

  it("takes the ghost home from the session cwd, so two ghosts do not share one", async () => {
    const other = await createGhostFixture("mina", {
      "character.md": "---\npublic: true\n---\n\n# Mina\n",
    });
    try {
      const factory = createPersonaExtension();
      const casper = await loadExtension(factory, fixture.dir);
      const mina = await loadExtension(factory, other.dir);
      const [casperPrompt, minaPrompt] = await Promise.all([
        casper.beforeAgentStart(),
        mina.beforeAgentStart(),
      ]);
      expect(casperPrompt?.startsWith("# Casper")).toBe(true);
      expect(minaPrompt?.startsWith("# Mina")).toBe(true);
    } finally {
      await other.cleanup();
    }
  });
});
