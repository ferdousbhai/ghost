import {
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CHARACTER_FILENAME, SEEDED_CHARACTER } from "./persona.js";

export interface Ghost {
  name: string;
  dir: string;
}

export const GHOST_SESSIONS_DIRNAME = "sessions";
/** The home a first start makes. */
const FIRST_GHOST_NAME = "ghost";

/** A ghost home's directory name: no separators, no leading dot, no whitespace. */
const GHOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  sessionDir: string;
  characterFile: string;
} {
  const home = resolve(dir);
  return {
    sessionDir: join(home, GHOST_SESSIONS_DIRNAME),
    characterFile: join(home, CHARACTER_FILENAME),
  };
}

/**
 * The machine's one ghost: the ghost home under `root`, made as `ghost` when
 * there is none. Non-directories, dot-directories, and directories without a
 * `character.md` are not homes: the root is a user directory and may hold
 * anything. More than one home is refused rather than one being picked.
 */
export function theGhost(root: string): Ghost {
  const base = resolve(root);
  mkdirSync(base, { recursive: true });
  const homes = readdirSync(base).filter((name) => GHOST_NAME_PATTERN.test(name) && isGhostHome(join(base, name))).sort();
  if (homes.length > 1) {
    throw new Error(`A machine has one ghost, and ${base} holds ${homes.length} (${homes.join(", ")}): move all but one away.`);
  }
  const [name = FIRST_GHOST_NAME] = homes;
  const dir = join(base, name);
  if (homes.length === 0) {
    mkdirSync(dir, { recursive: true });
    // Fail rather than clobber a character.md that appeared since the listing.
    writeFileSync(join(dir, CHARACTER_FILENAME), SEEDED_CHARACTER(name), { encoding: "utf8", flag: "wx" });
  }
  return { name, dir };
}
