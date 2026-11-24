import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import { ghostPaths, isGhostHome, isValidGhostName } from "../src/ghosts.js";
import { isSeededCharacter, SEEDED_CHARACTER } from "../src/persona.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe("ghost names", () => {
  it("accepts ordinary names", () => {
    for (const name of ["casper", "Mina", "a", "ghost-2", "a.b_c", "0"]) {
      expect(isValidGhostName(name), name).toBe(true);
    }
  });

  it("rejects traversal, separators, dot-prefixes, and empties", () => {
    for (const name of ["", ".", "..", ".hidden", "a/b", "a\\b", "a b", "../x", "x".repeat(65)]) {
      expect(isValidGhostName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("GhostRegistry.list", () => {
  it("returns nothing when the root does not exist", () => {
    temp = makeTempGhosts();
    temp.cleanup();
    expect(temp.registry.list()).toEqual([]);
    temp = null;
  });

  it("finds ghost homes and skips everything else", () => {
    temp = makeTempGhosts();
    seedGhost(temp.root, { name: "casper" });
    seedGhost(temp.root, { name: "mina" });
    // A directory with no character.md is not a ghost.
    mkdirSync(join(temp.root, "scratch"), { recursive: true });
    // Dot-directories are the daemon's own business.
    mkdirSync(join(temp.root, ".daemon"), { recursive: true });
    writeFileSync(join(temp.root, ".daemon", "character.md"), "# nope\n", "utf8");
    // A plain file is not a ghost.
    writeFileSync(join(temp.root, "README.md"), "hi\n", "utf8");

    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["casper", "mina"]);
  });

  it("reports name and dir", () => {
    temp = makeTempGhosts();
    seedGhost(temp.root, { name: "casper" });
    const [ghost] = temp.registry.list();
    expect(ghost).toEqual({ name: "casper", dir: join(temp.root, "casper") });
  });
});

describe("GhostRegistry.create", () => {
  it("seeds character.md without retired hosted state", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const ghost = temp.registry.create("casper");

    expect(isGhostHome(ghost.dir)).toBe(true);
    const character = readFileSync(ghostPaths(ghost.dir).characterFile, "utf8");
    expect(character).toMatch(/^# casper\n/);
    expect(character).not.toContain("title:");
    expect(existsSync(join(ghost.dir, "conversations"))).toBe(false);
    expect(existsSync(join(ghost.dir, "docs"))).toBe(false);
    expect(temp.registry.list().map((entry) => entry.name)).toEqual(["casper"]);
  });

  it("refuses an existing ghost", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    temp.registry.create("casper");
    expect(() => temp!.registry.create("casper")).toThrowError(GhostError);
    try {
      temp.registry.create("casper");
    } catch (error) {
      expect((error as GhostError).code).toBe("already_exists");
      expect((error as GhostError).status).toBe(409);
    }
  });

  it("refuses a name that would escape the root", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    expect(() => temp!.registry.create("../escape")).toThrowError(/Ghost names/);
    expect(existsSync(join(temp.root, "..", "escape"))).toBe(false);
  });
});

describe("a seeded character", () => {
  // A ghost seeded before "## Voice" became "## How you write" is still
  // unshaped: it keeps its first meeting.
  it("still knows a seed written before the heading changed", () => {
    const legacy = SEEDED_CHARACTER("mina").replace("\n## How you write\n", "\n## Voice\n");
    expect(legacy).not.toBe(SEEDED_CHARACTER("mina"));
    expect(isSeededCharacter("mina", legacy)).toBe(true);
    expect(isSeededCharacter("mina", legacy.replace("You are mina.", "You are Mina, a printer."))).toBe(false);
  });
});

describe("GhostRegistry.get", () => {
  it("throws a 404-shaped error for an unknown ghost", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    try {
      temp.registry.get("nobody");
      expect.unreachable("get should have thrown");
    } catch (error) {
      expect((error as GhostError).status).toBe(404);
      expect((error as GhostError).code).toBe("not_found");
    }
  });
});

describe("ghostPaths", () => {
  it("puts settings and conversations inside the ghost home", () => {
    const paths = ghostPaths("/tmp/ghosts/casper");
    expect(paths.sessionDir).toBe("/tmp/ghosts/casper/sessions");
  });
});
