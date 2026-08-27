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
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("- apprentice-question.md: I explained how to start");
    expect(prompt).toContain("## Docs");
    expect(prompt).toContain("craft/paper-guide.md: Paper that takes a deep impression");
    expect(prompt).toContain(FINANCE_DOC_PATH);
  });

  it("teaches the model the exact v2 doc format on every session", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart()) ?? "";

    expect(prompt).toContain("read, grep, glob, write, edit");
    expect(prompt).toContain("starts at byte 0 with `# Title`");
    expect(prompt).toContain("one line of lowercase `#hashtags`");
    expect(prompt).toContain("`#[a-z0-9]+(?:-[a-z0-9]+)*`");
    expect(prompt).toContain("`#archived` archives it");
    expect(prompt).toContain("Never YAML frontmatter");
    expect(prompt).not.toContain(fixture.dir);
  });

  it("carries the memory hygiene doctrine", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const prompt = (await harness.beforeAgentStart()) ?? "";
    expect(prompt).toContain("delete what is no longer true");
    expect(prompt).toContain("[[its-slug]]");
    // The dividing line: docs are written down on purpose, memory is remembered.
    expect(prompt).toContain("a doc is what someone sat down and wrote");
  });

  it("drops the harness sections a ghost does not carry", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const harnessPrompt = [
      "<system-conventions>",
      "RFC 2119 applies.",
      "</system-conventions>",
      "",
      "\u00a7 Role",
      "Helpful, trusted assistant for load-bearing changes in Oh My Pi coding harness.",
      "",
      "# Engineering",
      "- Correctness first.",
      "",
      "\u00a7 Runtime",
      "# Tool Inventory",
      "- Read: `read`",
      "",
      "\u00a7 Tool Policy",
      "- Prefer glob over find.",
      "",
      "\u00a7 Workflow",
      "# 1. Scope",
      "- Read the request.",
      "",
      "\u00a7 Delivery",
      "<contract>",
      "Finish the task.",
      "</contract>",
      "",
      "\u00a7 Critical",
      "- NEVER yield while actionable work remains.",
    ].join("\n");

    const prompt = (await harness.beforeAgentStart(harnessPrompt)) ?? "";

    expect(prompt).not.toContain("\u00a7 Role");
    expect(prompt).not.toContain("Oh My Pi coding harness");
    expect(prompt).not.toContain("# Engineering");
    expect(prompt).not.toContain("\u00a7 Workflow");
    expect(prompt).not.toContain("\u00a7 Delivery");
    expect(prompt).not.toContain("\u00a7 Critical");
    expect(prompt).not.toContain("NEVER yield");
    // Everything about operating the machine stays.
    expect(prompt).toContain("<system-conventions>");
    expect(prompt).toContain("\u00a7 Runtime");
    expect(prompt).toContain("- Read: `read`");
    expect(prompt).toContain("\u00a7 Tool Policy");
    expect(prompt).toContain("- Prefer glob over find.");
  });

  it("leaves a harness prompt without those markers untouched", async () => {
    const harness = await loadExtension(createPersonaExtension(), fixture.dir);
    const renamed = "\u00a7 Purpose\nSomething upstream rewrote.\n";

    const prompt = (await harness.beforeAgentStart(renamed)) ?? "";

    expect(prompt).toContain("Something upstream rewrote.");
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
      expect(prompt).toContain("starts at byte 0 with `# Title`");
    } finally {
      await empty.cleanup();
    }
  });

  it("takes the ghost home from the session cwd, so two ghosts do not share one", async () => {
    const other = await createGhostFixture("mina", {
      "character.md": "# Mina\n",
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
