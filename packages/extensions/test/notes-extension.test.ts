import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNotesExtension,
  createNotesVisibilityGate,
  GHOST_NOTES_GREP,
  GHOST_NOTES_LIST,
  GHOST_NOTES_READ,
} from "../src/extensions/notes.js";
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
  it("uses OMP's native filesystem tools instead of duplicate note tools", async () => {
    const harness = await loadExtension(createNotesExtension(), fixture.dir);
    expect(harness.toolNames()).toEqual([]);
    expect(harness.handlers.get("tool_call")).toBeUndefined();
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
