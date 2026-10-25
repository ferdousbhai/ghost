import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CHARACTER_FILENAME, SEEDED_CHARACTER } from "./persona.js";
import { GhostError } from "./errors.js";

export interface Ghost {
  name: string;
  dir: string;
}

export const GHOST_SESSIONS_DIRNAME = "sessions";
const GHOST_SETTINGS_FILENAME = "settings.yml";

/**
 * Ghost names are both URL path segments and directory names, so the
 * character set is deliberately narrow: no separators, no leading dot, no
 * whitespace, no percent-encoding games.
 */
const GHOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidGhostName(name: string): boolean {
  if (!GHOST_NAME_PATTERN.test(name)) return false;
  // The pattern already forbids a leading dot, but be explicit about the
  // traversal shapes: a name is never allowed to mean "somewhere else".
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export function assertValidGhostName(name: string): void {
  if (!isValidGhostName(name)) {
    throw new GhostError(
      "invalid_name",
      `Ghost names must be 1-64 characters of letters, digits, ".", "_", or "-", `
        + `and may not start with a dot (got ${JSON.stringify(name)}).`,
      400,
    );
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A directory is a ghost home when it holds a `character.md` (which also
 * proves it is a directory). The persona file is the one thing a ghost cannot
 * be without; everything else in a home is optional.
 */
export function isGhostHome(dir: string): boolean {
  return isFile(join(dir, CHARACTER_FILENAME));
}

export function ghostPaths(dir: string): {
  settingsFile: string;
  sessionDir: string;
  characterFile: string;
} {
  const home = resolve(dir);
  return {
    settingsFile: join(home, GHOST_SETTINGS_FILENAME),
    sessionDir: join(home, GHOST_SESSIONS_DIRNAME),
    characterFile: join(home, CHARACTER_FILENAME),
  };
}

export class GhostRegistry {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  ensureRoot(): void {
    mkdirSync(this.root, { recursive: true });
  }

  /**
   * Every ghost under the root, name-sorted. Non-directories, dot-directories
   * (the daemon's own state), and directories without a `character.md` are
   * skipped rather than reported as errors — the root is a user directory and
   * may hold anything.
   */
  list(): Ghost[] {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ghosts: Ghost[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (!isValidGhostName(name)) continue;
      const dir = join(this.root, name);
      if (!isGhostHome(dir)) continue;
      ghosts.push({ name, dir });
    }
    return ghosts.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Ghost {
    assertValidGhostName(name);
    const dir = join(this.root, name);
    if (!isGhostHome(dir)) {
      throw new GhostError("not_found", `No ghost named ${JSON.stringify(name)}.`, 404);
    }
    return { name, dir };
  }

  /**
   * Create `<root>/<name>/` with a seeded `character.md`. Refuses to overwrite an existing ghost.
   */
  create(name: string): Ghost {
    assertValidGhostName(name);
    const dir = join(this.root, name);
    if (isGhostHome(dir)) {
      throw new GhostError("already_exists", `A ghost named ${JSON.stringify(name)} already exists.`, 409);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CHARACTER_FILENAME), SEEDED_CHARACTER(name), {
      encoding: "utf8",
      // Fail rather than clobber a character.md that appeared between the
      // isGhostHome() check and here.
      flag: "wx",
    });
    return { name, dir };
  }

  /**
   * Rename `<root>/<name>/` to `<root>/<nextName>/` — which renames the ghost,
   * because the directory name is the name. One same-filesystem rename carries
   * the persona, sessions, and owner state together, and leaves every
   * conversation id (a conversation directory name inside the home) valid. Machine
   * credentials are service/account scoped and are not renamed.
   *
   * The target must not exist at all, not merely "not be a ghost": renaming
   * onto an occupied path would either fail deep in `rename` or bury whatever
   * the owner had put there.
   */
  rename(name: string, nextName: string): Ghost {
    const ghost = this.get(name);
    assertValidGhostName(nextName);
    const target = join(this.root, nextName);
    if (existsSync(target)) {
      throw new GhostError(
        "already_exists",
        `${JSON.stringify(nextName)} is already taken in the ghosts root.`,
        409,
      );
    }
    renameSync(ghost.dir, target);
    // The daemon-written seed names the ghost, so an untouched one is
    // re-rendered under the new name; owner-authored text stays byte for byte.
    // A failure here leaves the old name in the seed, not a half-renamed ghost.
    const file = ghostPaths(target).characterFile;
    try {
      if (readFileSync(file, "utf8") === SEEDED_CHARACTER(name)) {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, SEEDED_CHARACTER(nextName), { flag: "wx", mode: statSync(file).mode & 0o777 });
        renameSync(temporary, file);
      }
    } catch {
      // The home moved, which is what the rename was.
    }
    return { name: nextName, dir: target };
  }
}
