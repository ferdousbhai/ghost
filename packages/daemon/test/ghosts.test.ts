import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths, isGhostHome, theGhost } from "../src/ghosts.js";
import { isSeededCharacter, SEEDED_CHARACTER } from "../src/persona.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe("the machine's one ghost", () => {
  it("is the one ghost home under the root, whatever else is there", () => {
    temp = makeTempGhosts();
    seedGhost(temp.root, { name: "casper" });
    // Not homes: a directory with no character.md, a dot-directory, a plain file.
    mkdirSync(join(temp.root, "scratch"), { recursive: true });
    mkdirSync(join(temp.root, ".daemon"), { recursive: true });
    writeFileSync(join(temp.root, ".daemon", "character.md"), "# nope\n", "utf8");
    writeFileSync(join(temp.root, "README.md"), "hi\n", "utf8");

    expect(theGhost(temp.root)).toEqual({ name: "casper", dir: join(temp.root, "casper") });
  });

  it("is made as `ghost`, with a seeded character, where there is none", () => {
    temp = makeTempGhosts();
    const ghost = theGhost(join(temp.root, "fresh"));

    expect(ghost.name).toBe("ghost");
    expect(isGhostHome(ghost.dir)).toBe(true);
    const character = readFileSync(ghostPaths(ghost.dir).characterFile, "utf8");
    expect(character).toMatch(/^# ghost\n/);
    expect(existsSync(join(ghost.dir, "conversations"))).toBe(false);
    expect(theGhost(join(temp.root, "fresh"))).toEqual(ghost);
  });

  it("refuses a root that holds more than one", () => {
    temp = makeTempGhosts();
    seedGhost(temp.root, { name: "casper" });
    seedGhost(temp.root, { name: "mina" });
    expect(() => theGhost(temp!.root)).toThrowError(/one ghost.*casper, mina/u);
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

describe("ghostPaths", () => {
  it("puts settings and conversations inside the ghost home", () => {
    const paths = ghostPaths("/tmp/ghosts/casper");
    expect(paths.sessionDir).toBe("/tmp/ghosts/casper/sessions");
  });
});
