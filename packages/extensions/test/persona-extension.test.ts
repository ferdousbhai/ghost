import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonaExtension } from "../src/extensions/persona.js";
import { openGhostHome } from "../src/home.js";
import {
  createGhostFixture,
  FINANCE_DOC_PATH,
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

  it("assembles character, derived memory index, and derived doc catalog", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart()) ?? "";
    expect(prompt).toContain("the ghost of a working typographer");
    expect(prompt).toContain("## Your memory");
    expect(prompt).toContain("- apprentice-question.md: I explained how to start");
    expect(prompt).toContain("## Your docs");
    expect(prompt).toContain("craft/paper-guide.md: Paper that takes a deep impression");
    expect(prompt).toContain(FINANCE_DOC_PATH);
  });

  it("carries the memory hygiene doctrine", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart()) ?? "";
    expect(prompt).toContain("delete a memory that is wrong or no longer true");
    expect(prompt).toContain("[[knee-injury]]");
    // The dividing line: docs are written down on purpose, memory is remembered.
    expect(prompt).toContain("writes down on purpose");
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

  it("says so plainly when there is no character file", async () => {
    const empty = await createGhostFixture("mina", {});
    try {
      const harness = await loadExtension(createPersonaExtension(), empty.dir);
      const prompt = (await harness.beforeAgentStart()) ?? "";
      expect(prompt).toContain("You are mina.");
      expect(prompt).toContain("character.md");
      expect(prompt).toContain("(no docs yet)");
    } finally {
      await empty.cleanup();
    }
  });

  it("takes the ghost home from the session cwd, so two ghosts do not share one", async () => {
    const other = await createGhostFixture("mina", {
      "character.md": "---\ntitle: Mina\n---\n\n# Mina\n",
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
