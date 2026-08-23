import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNotesExtension,
  createNotesVisibilityGate,
  GHOST_NOTES_GREP,
  GHOST_NOTES_LIST,
  GHOST_NOTES_READ,
  GHOST_NOTES_WRITE,
} from "../src/extensions/notes.js";
import { openGhostHome } from "../src/home.js";
import { CREATOR_SCOPE, visitorScope } from "../src/scope.js";
import {
  ARCHIVED_NOTE_PATH,
  createGhostFixture,
  PRIVATE_NOTE_PATH,
  PUBLIC_NOTE_PATH,
  type GhostFixture,
} from "./support/fixture.js";
import { loadExtension, resultText } from "./support/harness.js";

const VISITOR = visitorScope("visitor-1");
const SECRET = "The studio lease is held under my sister's name";

let fixture: GhostFixture;

beforeEach(async () => {
  fixture = await createGhostFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("creator mode", () => {
  it("registers the full tool set including the writer", async () => {
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    expect(harness.toolNames()).toEqual([
      GHOST_NOTES_LIST,
      GHOST_NOTES_READ,
      GHOST_NOTES_GREP,
      GHOST_NOTES_WRITE,
    ]);
    expect(harness.handlers.get("tool_call")).toBeUndefined();
  });

  it("reads a private note without complaint", async () => {
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    expect(resultText(await harness.call(GHOST_NOTES_READ, { path: PRIVATE_NOTE_PATH })))
      .toContain(SECRET);
  });

  it("lists notes with their visibility and hides archived ones by default", async () => {
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    const listed = resultText(await harness.call(GHOST_NOTES_LIST));
    expect(listed).toContain(`${PRIVATE_NOTE_PATH}: Estate and finances (private)`);
    expect(listed).not.toContain(ARCHIVED_NOTE_PATH);
    const withArchived = resultText(
      await harness.call(GHOST_NOTES_LIST, { include_archived: true }),
    );
    expect(withArchived).toContain(ARCHIVED_NOTE_PATH);
  });

  it("writes a note, private unless published", async () => {
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    await harness.call(GHOST_NOTES_WRITE, { path: "ideas/new", body: "a thought" });
    const note = await openGhostHome(fixture.dir).readNote("ideas/new.md");
    expect(note.body).toBe("a thought");
    expect(note.meta.public).toBe(false);
  });

  it("greps note bodies", async () => {
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    const found = resultText(await harness.call(GHOST_NOTES_GREP, { query: "carriage" }));
    expect(found).toContain("press-restoration.md:1:");
  });

  it("truncates a huge note body with an accurate footer", async () => {
    await openGhostHome(fixture.dir).writeNote("big.md", { body: "x".repeat(20_000) });
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    const text = resultText(await harness.call(GHOST_NOTES_READ, { path: "big.md" }));
    expect(text).toContain("showing the first 8000 of 20000 characters");
    // The footer's numbers are honest: the returned body really is capped.
    expect(text.length).toBeLessThan(9_000);
  });

  it("caps an over-long grep match line", async () => {
    await openGhostHome(fixture.dir).writeNote("long.md", {
      body: `needle ${"y".repeat(500)}`,
    });
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    const text = resultText(await harness.call(GHOST_NOTES_GREP, { query: "needle" }));
    const line = text.split("\n").find((entry) => entry.startsWith("long.md:"));
    expect(line).toBeDefined();
    expect(line).toContain("…");
    expect((line as string).length).toBeLessThan(260);
  });
});

describe("visitor mode", () => {
  it("registers a gate and no note writer", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    expect(harness.toolNames()).toEqual([
      GHOST_NOTES_LIST,
      GHOST_NOTES_READ,
      GHOST_NOTES_GREP,
    ]);
    expect(harness.handlers.get("tool_call")).toHaveLength(1);
  });

  // The spike's adversarial case: the model asks for the private note by exact
  // path, and the gate must stop the call before the body is ever read.
  it("blocks a private note requested by exact path", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    const blocked = await harness.toolCall(GHOST_NOTES_READ, { path: PRIVATE_NOTE_PATH });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("not available");
    expect(blocked?.reason).not.toContain(SECRET);
  });

  it("gives the same answer for a private note and one that does not exist", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    const priv = await harness.toolCall(GHOST_NOTES_READ, { path: PRIVATE_NOTE_PATH });
    const missing = await harness.toolCall(GHOST_NOTES_READ, { path: "does-not-exist.md" });
    expect(priv?.reason?.replace(PRIVATE_NOTE_PATH, "X"))
      .toBe(missing?.reason?.replace("does-not-exist.md", "X"));
  });

  it("lets a published note through", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    expect(await harness.toolCall(GHOST_NOTES_READ, { path: PUBLIC_NOTE_PATH }))
      .toBeUndefined();
    expect(resultText(await harness.call(GHOST_NOTES_READ, { path: PUBLIC_NOTE_PATH })))
      .toContain("Damp the sheet");
  });

  it("blocks the archived note even though it is marked public", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    expect((await harness.toolCall(GHOST_NOTES_READ, { path: ARCHIVED_NOTE_PATH }))?.block)
      .toBe(true);
  });

  it("blocks path-traversal spellings of a private note", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    for (const path of [
      `../notes/${PRIVATE_NOTE_PATH}`,
      `craft/../${PRIVATE_NOTE_PATH}`,
      "estate-finances",
      "/estate-finances.md",
      "..\\..\\character.md",
    ]) {
      const blocked = await harness.toolCall(GHOST_NOTES_READ, { path });
      expect(blocked?.block, `expected ${path} to be blocked`).toBe(true);
    }
  });

  it("blocks pi's own file and shell tools outright", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    for (const tool of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
      expect((await harness.toolCall(tool, { command: "cat notes/estate-finances.md" }))?.block)
        .toBe(true);
    }
  });

  it("refuses the read even if the gate was never registered", async () => {
    // Defence in depth: the tool itself checks visibility, so a daemon that
    // forgets to wire the gate is still not leaking private notes.
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    await expect(harness.call(GHOST_NOTES_READ, { path: PRIVATE_NOTE_PATH }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps private notes out of the list and out of search results", async () => {
    const harness = await loadExtension(
      createNotesExtension({ scope: VISITOR }),
      fixture.dir,
    );
    const listed = resultText(await harness.call(GHOST_NOTES_LIST));
    expect(listed).not.toContain(PRIVATE_NOTE_PATH);
    expect(listed).toContain(PUBLIC_NOTE_PATH);

    const searched = resultText(await harness.call(GHOST_NOTES_GREP, { query: "lease" }));
    expect(searched).toBe("(no matches)");
  });

  it("leaves a creator-scope gate inert", async () => {
    const gate = createNotesVisibilityGate({ scope: CREATOR_SCOPE, home: fixture.dir });
    const event = {
      type: "tool_call",
      toolCallId: "c1",
      toolName: GHOST_NOTES_READ,
      input: { path: PRIVATE_NOTE_PATH },
    } as never;
    expect(await gate(event, { cwd: fixture.dir } as never)).toBeUndefined();
  });
});
