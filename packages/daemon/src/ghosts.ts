/**
 * Ghost registry — discovery, creation, and validation of ghost homes.
 *
 * A ghost is one directory under the ghosts root (default `~/Ghosts/`), laid
 * out per `ghost-home/v1` in CONTRACTS.md. The registry owns only the shape
 * of that directory; reading its *contents* (character, notes, memory) is
 * `@ghost/extensions`' job.
 *
 * Everything the daemon adds for itself lives in dot-directories inside the
 * ghost home (`.sessions/`, `.pi/`) so the creator's default view of their
 * own ghost stays the plain files they wrote — the same precedent as
 * `memory/.visitors/`.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One discovered ghost, as served by `GET /api/ghosts`. */
export interface Ghost {
  name: string;
  dir: string;
  createdAt: string;
}

/** Directory names the daemon owns inside a ghost home. */
export const GHOST_SESSIONS_DIRNAME = ".sessions";
export const GHOST_AGENT_DIRNAME = ".pi";
export const GHOST_CHARACTER_FILENAME = "character.md";

/**
 * Ghost names are both URL path segments and directory names, so the
 * character set is deliberately narrow: no separators, no leading dot, no
 * whitespace, no percent-encoding games.
 */
const GHOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class GhostError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "GhostError";
    this.code = code;
    this.status = status;
  }
}

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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
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
 * A directory is a ghost home when it exists and holds a `character.md`.
 * The persona file is the one thing a ghost cannot be without — notes,
 * memory, and conversations are all optional and may be empty.
 */
export function isGhostHome(dir: string): boolean {
  return isDirectory(dir) && isFile(join(dir, GHOST_CHARACTER_FILENAME));
}

function createdAtOf(dir: string): string {
  const stats = statSync(dir);
  // birthtime is 0 on filesystems that do not record it; mtime is the
  // honest fallback.
  const birth = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
  return new Date(birth).toISOString();
}

/** Absolute paths the daemon derives from a ghost home. */
export function ghostPaths(dir: string): {
  home: string;
  agentDir: string;
  sessionDir: string;
  characterFile: string;
} {
  const home = resolve(dir);
  const agentDir = join(home, GHOST_AGENT_DIRNAME);
  return {
    home,
    agentDir,
    sessionDir: join(home, GHOST_SESSIONS_DIRNAME),
    characterFile: join(home, GHOST_CHARACTER_FILENAME),
  };
}

const SEEDED_CHARACTER = (name: string) => `---
public: true
title: ${name}
---

# ${name}

You are ${name}.

## Voice

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Your notes and memory files are yours. Read them before you answer a question
they cover, and write a memory file when you learn something about a visitor
that you would want to remember the next time they come back.
`;

/**
 * The character file's raw bytes, or null when the ghost has none.
 *
 * Raw rather than parsed on purpose: both callers are asking "has the owner
 * been here yet", which is a question about the file as written, not about the
 * persona it parses into.
 */
export function readCharacterFile(dir: string): string | null {
  try {
    return readFileSync(ghostPaths(dir).characterFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * True when `text` is still the file `GhostRegistry.create` wrote — the ghost
 * has been summoned but never met.
 *
 * A populated character file is the durable "this ghost has been onboarded"
 * latch. There is deliberately no flag file beside it: a flag would be a second
 * source of truth about a question the character file already answers, and the
 * two would drift the first time somebody edited one of them by hand.
 *
 * Missing and blank both count as seeded. An empty character.md is not a persona
 * somebody wrote; it is the same "the owner has not been here" the seed means.
 *
 * The comparison is exact. `@ghost/extensions` has its own advisory
 * `isSeededCharacterBody` (it cannot import the daemon, so it matches marker
 * lines instead); this is the authoritative one, and it is deliberately the
 * stricter of the two — being wrong here means offering onboarding to a ghost
 * that has already been written, which is worse than missing it once.
 */
export function isSeededCharacter(name: string, text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  if (text.trim() === "") return true;
  return text === SEEDED_CHARACTER(name);
}

export class GhostRegistry {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Create the ghosts root if it does not exist yet. Idempotent. */
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
      ghosts.push({ name, dir, createdAt: createdAtOf(dir) });
    }
    return ghosts.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One ghost by name, or null when it does not exist. */
  find(name: string): Ghost | null {
    if (!isValidGhostName(name)) return null;
    const dir = join(this.root, name);
    if (!isGhostHome(dir)) return null;
    return { name, dir, createdAt: createdAtOf(dir) };
  }

  /** One ghost by name, or a structured 404. */
  get(name: string): Ghost {
    assertValidGhostName(name);
    const ghost = this.find(name);
    if (!ghost) {
      throw new GhostError("not_found", `No ghost named ${JSON.stringify(name)}.`, 404);
    }
    return ghost;
  }

  /**
   * Create `<root>/<name>/` with a seeded `character.md` and the empty
   * `ghost-home/v1` directories. Refuses to overwrite an existing ghost.
   */
  create(name: string): Ghost {
    assertValidGhostName(name);
    const dir = join(this.root, name);
    if (isGhostHome(dir)) {
      throw new GhostError("already_exists", `A ghost named ${JSON.stringify(name)} already exists.`, 409);
    }
    mkdirSync(dir, { recursive: true });
    for (const sub of ["notes", "memory", join("memory", ".visitors"), "conversations"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, GHOST_CHARACTER_FILENAME), SEEDED_CHARACTER(name), {
      encoding: "utf8",
      // Fail rather than clobber a character.md that appeared between the
      // isGhostHome() check and here.
      flag: "wx",
    });
    return { name, dir, createdAt: createdAtOf(dir) };
  }
}
