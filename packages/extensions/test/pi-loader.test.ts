import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GHOST_MEMORY_WRITE,
} from "../src/extensions/memory.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";

const SRC = fileURLToPath(new URL("../src/extensions", import.meta.url));

let fixture: GhostFixture;

beforeEach(async () => {
  fixture = await createGhostFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

/**
 * The rest of the suite drives a scripted stand-in for OMP's extension runtime.
 * This one loads the real thing: pi's own loader, jiti-compiling these files
 * from source, registering against the real ExtensionAPI. It is the check that
 * the harness elsewhere is not testing a fiction.
 */
describe("pi's own extension loader", () => {
  it("loads the three extension files with no errors", async () => {
    const result = await discoverAndLoadExtensions(
      ["persona", "memory", "notes"].map((name) => join(SRC, `${name}.ts`)),
      fixture.dir,
      undefined,
      undefined,
      { ambient: false },
    );
    expect(result.errors).toEqual([]);

    const byFile = new Map(
      result.extensions.map((extension) => [
        extension.path.split("/").at(-1),
        extension,
      ]),
    );
    expect([...byFile.get("persona.ts")!.handlers.keys()]).toEqual(["before_agent_start"]);
    expect([...byFile.get("memory.ts")!.tools.keys()]).toEqual([GHOST_MEMORY_WRITE]);
    expect([...byFile.get("notes.ts")!.tools.keys()]).toEqual([]);
  });
});
