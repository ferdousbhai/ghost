import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GhostError,
  ghostPaths,
  isGhostHome,
  isValidGhostName,
} from "../src/ghosts.js";
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

  it("reports name, dir, and an ISO createdAt", () => {
    temp = makeTempGhosts();
    seedGhost(temp.root, { name: "casper" });
    const [ghost] = temp.registry.list();
    expect(ghost?.name).toBe("casper");
    expect(ghost?.dir).toBe(join(temp.root, "casper"));
    expect(ghost?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("GhostRegistry.create", () => {
  it("seeds character.md and the ghost-home/v1 directories", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const ghost = temp.registry.create("casper");

    expect(isGhostHome(ghost.dir)).toBe(true);
    const character = readFileSync(ghostPaths(ghost.dir).characterFile, "utf8");
    expect(character).toContain("public: true");
    expect(character).toContain("title: casper");
    for (const sub of ["notes", "memory", join("memory", ".visitors"), "conversations"]) {
      expect(existsSync(join(ghost.dir, sub)), sub).toBe(true);
    }
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

describe("GhostRegistry.trash", () => {
  it("moves the home into .trash and takes the ghost out of the listing", () => {
    temp = makeTempGhosts();
    const dir = seedGhost(temp.root, { name: "casper" });
    seedGhost(temp.root, { name: "mina" });
    writeFileSync(join(dir, "memory", "keepsake.md"), "remember this\n", "utf8");

    const { trash } = temp.registry.trash("casper");

    expect(existsSync(dir)).toBe(false);
    expect(trash.startsWith(join(temp.root, ".trash"))).toBe(true);
    expect(trash).toMatch(/casper-\d{8}-\d{6}$/);
    // A move, never an rm: everything the ghost owned is still on disk.
    expect(readFileSync(join(trash, "memory", "keepsake.md"), "utf8")).toBe("remember this\n");
    expect(isGhostHome(trash)).toBe(true);
    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["mina"]);
  });

  it("suffixes a collision rather than overwriting an earlier copy", () => {
    temp = makeTempGhosts();
    const stamp = new Date(2026, 7, 24, 15, 30, 0);
    seedGhost(temp.root, { name: "casper" });
    const first = temp.registry.trash("casper", stamp);
    seedGhost(temp.root, { name: "casper" });
    const second = temp.registry.trash("casper", stamp);

    expect(first.trash).toBe(join(temp.root, ".trash", "casper-20260824-153000"));
    expect(second.trash).toBe(join(temp.root, ".trash", "casper-20260824-153000-2"));
    expect(existsSync(first.trash)).toBe(true);
  });

  it("refuses an unknown ghost and a name that would escape the root", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    try {
      temp.registry.trash("nobody");
      expect.unreachable("trash should have thrown");
    } catch (error) {
      expect((error as GhostError).code).toBe("not_found");
      expect((error as GhostError).status).toBe(404);
    }
    try {
      temp.registry.trash("../escape");
      expect.unreachable("trash should have thrown");
    } catch (error) {
      expect((error as GhostError).code).toBe("invalid_name");
      expect((error as GhostError).status).toBe(400);
    }
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
  it("keeps daemon state in dot-directories inside the home", () => {
    const paths = ghostPaths("/tmp/Ghosts/casper");
    expect(paths.agentDir).toBe("/tmp/Ghosts/casper/.pi");
    expect(paths.sessionDir).toBe("/tmp/Ghosts/casper/.sessions");
  });
});
