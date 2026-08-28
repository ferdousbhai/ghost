import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GhostError,
  ghostPaths,
  isGhostHome,
  isSeededCharacter,
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
  it("seeds character.md and steady-state ghost-home/v2 directories", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const ghost = temp.registry.create("casper");

    expect(isGhostHome(ghost.dir)).toBe(true);
    const character = readFileSync(ghostPaths(ghost.dir).characterFile, "utf8");
    expect(character).toMatch(/^# casper\n/);
    expect(character).not.toContain("title:");
    for (const sub of ["memory", "conversations"]) {
      expect(existsSync(join(ghost.dir, sub)), sub).toBe(true);
    }
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

describe("GhostRegistry.rename", () => {
  it("moves the home and re-renders an untouched seed under the new name", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const dir = temp.registry.create("casper").dir;

    const renamed = temp.registry.rename("casper", "wisp");

    expect(renamed).toMatchObject({ name: "wisp", dir: join(temp.root, "wisp") });
    expect(existsSync(dir)).toBe(false);
    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["wisp"]);
    const character = readFileSync(ghostPaths(renamed.dir).characterFile, "utf8");
    expect(character).toMatch(/^# wisp\n/);
    expect(character).toContain("You are wisp.");
    expect(character).not.toContain("title:");
    expect(isSeededCharacter("wisp", character)).toBe(true);
  });

  it("leaves owner-authored Markdown alone", () => {
    temp = makeTempGhosts();
    const archivist = "## The Archivist\n\nHello.\n";
    const markdown = "# mina\n\nNo frontmatter here.\n";
    seedGhost(temp.root, { name: "casper", character: archivist });
    seedGhost(temp.root, { name: "mina", character: markdown });

    expect(readFileSync(ghostPaths(temp.registry.rename("casper", "wisp").dir).characterFile, "utf8"))
      .toBe(archivist);
    expect(readFileSync(ghostPaths(temp.registry.rename("mina", "vera").dir).characterFile, "utf8"))
      .toBe(markdown);
  });

  it("preserves every byte and the mode of an owner-authored character", () => {
    temp = makeTempGhosts();
    const character = "## Letterpress\r\n\r\nKeep  two spaces.\r\n";
    const dir = seedGhost(temp.root, {
      name: "casper",
      character,
    });
    chmodSync(ghostPaths(dir).characterFile, 0o640);

    const renamed = temp.registry.rename("casper", "wisp");

    expect(readFileSync(ghostPaths(renamed.dir).characterFile, "utf8"))
      .toBe(character);
    expect(statSync(ghostPaths(renamed.dir).characterFile).mode & 0o777).toBe(0o640);
  });

  it("leaves the old home and character untouched when a renamed seed cannot be prepared", () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const dir = temp.registry.create("casper").dir;
    const before = readFileSync(ghostPaths(dir).characterFile, "utf8");
    chmodSync(dir, 0o500);

    try {
      expect(() => temp!.registry.rename("casper", "wisp")).toThrow();
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(temp.root, "wisp"))).toBe(false);
      expect(readFileSync(ghostPaths(dir).characterFile, "utf8")).toBe(before);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("refuses an unknown ghost, an invalid name, and any occupied target", () => {
    temp = makeTempGhosts();
    const dir = seedGhost(temp.root, { name: "casper" });
    // Not a ghost home, but the owner's directory all the same.
    mkdirSync(join(temp.root, "notes"), { recursive: true });

    expect(() => temp!.registry.rename("nobody", "wisp")).toThrowError(GhostError);
    expect(() => temp!.registry.rename("casper", "../escape")).toThrowError(/Ghost names/);
    expect(() => temp!.registry.rename("casper", "notes"))
      .toThrowError(/already taken/);
    expect(existsSync(dir)).toBe(true);
  });
});

const SHM = "/dev/shm";
const shmIsAnotherFilesystem = (() => {
  try {
    return statSync(SHM).isDirectory() && statSync(SHM).dev !== statSync(tmpdir()).dev;
  } catch {
    return false;
  }
})();

function readTrashInfo(path: string): { path: string; deletionDate: string } {
  const text = readFileSync(path, "utf8");
  expect(text.startsWith("[Trash Info]\n")).toBe(true);
  const field = (key: string) =>
    text.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  return { path: field("Path"), deletionDate: field("DeletionDate") };
}

describe("GhostRegistry.trash", () => {
  it("moves the home into the XDG trash and takes the ghost out of the listing", () => {
    temp = makeTempGhosts();
    const dir = seedGhost(temp.root, { name: "casper" });
    seedGhost(temp.root, { name: "mina" });
    writeFileSync(join(dir, "memory", "keepsake.md"), "remember this\n", "utf8");

    const { trash } = temp.registry.trash("casper", new Date(2026, 7, 24, 15, 30, 0));

    expect(existsSync(dir)).toBe(false);
    expect(trash).toBe(join(temp.trashDir, "files", "casper"));
    // A move, never an rm: everything the ghost owned is still on disk.
    expect(readFileSync(join(trash, "memory", "keepsake.md"), "utf8")).toBe("remember this\n");
    expect(isGhostHome(trash)).toBe(true);
    expect(temp.registry.list().map((ghost) => ghost.name)).toEqual(["mina"]);
  });

  it("writes a .trashinfo any trash tool can restore from", () => {
    temp = makeTempGhosts();
    const dir = seedGhost(temp.root, { name: "casper" });

    temp.registry.trash("casper", new Date(2026, 7, 24, 15, 30, 0));

    const info = readTrashInfo(join(temp.trashDir, "info", "casper.trashinfo"));
    expect(decodeURIComponent(info.path)).toBe(dir);
    // A URI path: separators raw, everything questionable percent-encoded.
    expect(info.path.startsWith("/")).toBe(true);
    expect(info.path).not.toMatch(/[^\w%/.~!*'()-]/);
    // Local time, no zone suffix.
    expect(info.deletionDate).toBe("2026-08-24T15:30:00");
  });

  it("suffixes a collision rather than overwriting an earlier copy", () => {
    temp = makeTempGhosts();
    const stamp = new Date(2026, 7, 24, 15, 30, 0);
    seedGhost(temp.root, { name: "casper" });
    const first = temp.registry.trash("casper", stamp);
    seedGhost(temp.root, { name: "casper" });
    const second = temp.registry.trash("casper", stamp);

    expect(first.trash).toBe(join(temp.trashDir, "files", "casper"));
    expect(second.trash).toBe(join(temp.trashDir, "files", "casper.2"));
    expect(existsSync(first.trash)).toBe(true);
    expect(existsSync(join(temp.trashDir, "info", "casper.trashinfo"))).toBe(true);
    expect(existsSync(join(temp.trashDir, "info", "casper.2.trashinfo"))).toBe(true);
  });

  it("steps past an orphaned files/ entry instead of renaming onto it", () => {
    temp = makeTempGhosts();
    seedGhost(temp.root, { name: "casper" });
    // Somebody else's trashed directory, with no .trashinfo naming it.
    mkdirSync(join(temp.trashDir, "files", "casper"), { recursive: true });
    writeFileSync(join(temp.trashDir, "files", "casper", "theirs.md"), "not ours\n", "utf8");

    const { trash } = temp.registry.trash("casper");

    expect(trash).toBe(join(temp.trashDir, "files", "casper.2"));
    expect(readFileSync(join(temp.trashDir, "files", "casper", "theirs.md"), "utf8"))
      .toBe("not ours\n");
    // The claim on the name we did not take is released.
    expect(existsSync(join(temp.trashDir, "info", "casper.trashinfo"))).toBe(false);
  });

  it.skipIf(!shmIsAnotherFilesystem)(
    "falls back to <root>/.trash when the home trash is on another filesystem",
    () => {
      temp = makeTempGhosts();
      const crossDeviceXdg = mkdtempSync(join(SHM, "ghostd-test-xdg-"));
      process.env.XDG_DATA_HOME = crossDeviceXdg;
      try {
        seedGhost(temp.root, { name: "casper" });

        const { trash } = temp.registry.trash("casper", new Date(2026, 7, 24, 15, 30, 0));

        expect(trash).toBe(join(temp.root, ".trash", "casper-20260824-153000"));
        expect(isGhostHome(trash)).toBe(true);
        // No .trashinfo left describing a file that never reached the trash.
        expect(existsSync(join(crossDeviceXdg, "Trash", "info", "casper.trashinfo"))).toBe(false);
      } finally {
        process.env.XDG_DATA_HOME = temp.xdgDataHome;
        rmSync(crossDeviceXdg, { recursive: true, force: true });
      }
    },
  );

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
  it("separates visible identity config from machine-bound runtime state", () => {
    const paths = ghostPaths("/tmp/ghosts/casper");
    expect(paths.agentDir).toBe("/tmp/ghosts/casper/.pi");
    expect(paths.settingsRuntimeDir).toBe("/tmp/ghosts/casper/.pi/runtime");
    expect(paths.settingsFile).toBe("/tmp/ghosts/casper/settings.yml");
    expect(paths.sessionDir).toBe("/tmp/ghosts/casper/sessions");
  });
});
