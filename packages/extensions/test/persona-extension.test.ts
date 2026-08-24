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
  it("appends the ghost persona to pi's native system prompt", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = await harness.beforeAgentStart(PI_PROMPT);
    expect(prompt).toBeDefined();
    expect(prompt?.startsWith(PI_PROMPT)).toBe(true);
    expect(prompt).toContain("# Casper");
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

  it("carries the memory hygiene doctrine, scoped to what the session can do", async () => {
    const creator = await loadExtension(createPersonaExtension(), fixture.dir);
    const creatorPrompt = (await creator.beforeAgentStart()) ?? "";
    // Creator doctrine: dedupe, delete, absolute dates, links, memory-vs-notes.
    expect(creatorPrompt).toContain("delete a memory that turned out wrong");
    expect(creatorPrompt).toContain("[[knee-injury]]");
    expect(creatorPrompt).toContain("belongs in a note");

    const visitor = await loadExtension(
      createPersonaExtension({ scope: visitorScope("visitor-1") }),
      fixture.dir,
    );
    const visitorPrompt = (await visitor.beforeAgentStart()) ?? "";
    // Visitors cannot delete files or write notes; their doctrine omits both.
    expect(visitorPrompt).toContain("near-duplicate");
    expect(visitorPrompt).toContain("[[favorite-openings]]");
    expect(visitorPrompt).not.toContain("delete a memory");
    expect(visitorPrompt).not.toContain("belongs in a note");
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
      expect(casperPrompt).toContain("# Casper");
      expect(minaPrompt).toContain("# Mina");
    } finally {
      await other.cleanup();
    }
  });
});
