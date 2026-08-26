/**
 * Ghost registry — discovery, creation, and validation of ghost homes.
 *
 * A ghost is one directory under the ghosts root (default `~/ghosts/`), laid
 * out per `ghost-home/v1` in CONTRACTS.md. The registry owns only the shape
 * of that directory; reading its *contents* (character, docs, memory) is
 * `@ghost/extensions`' job.
 *
 * A ghost home is plain files the owner can open, `sessions/` included. The
 * one exception is `.pi/`, which holds provider credentials and OMP's
 * machine-bound runtime state until those move out of the home entirely.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { trashPath } from "./trash.js";

export { homeTrashDir } from "./trash.js";

/** One discovered ghost, as served by `GET /api/ghosts`. */
export interface Ghost {
  name: string;
  dir: string;
  createdAt: string;
}

/** Directory names the daemon owns inside a ghost home. */
export const GHOST_SESSIONS_DIRNAME = "sessions";
export const GHOST_AGENT_DIRNAME = ".pi";
export const GHOST_CHARACTER_FILENAME = "character.md";
export const GHOST_SETTINGS_FILENAME = "settings.yml";

/**
 * Where a deleted ghost goes when the freedesktop home trash is on another
 * filesystem (`EXDEV`) — a dot-directory inside the ghosts root, so `list()`
 * skips it and a trashed ghost is gone from the API while its files are still
 * on disk. The ordinary path is the home trash; see `GhostRegistry.trash`.
 */
export const GHOST_TRASH_DIRNAME = ".trash";

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
 * The persona file is the one thing a ghost cannot be without — docs,
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
  settingsRuntimeDir: string;
  settingsFile: string;
  sessionDir: string;
  characterFile: string;
} {
  const home = resolve(dir);
  const agentDir = join(home, GHOST_AGENT_DIRNAME);
  return {
    home,
    agentDir,
    settingsRuntimeDir: join(agentDir, "runtime"),
    settingsFile: join(home, GHOST_SETTINGS_FILENAME),
    sessionDir: join(home, GHOST_SESSIONS_DIRNAME),
    characterFile: join(home, GHOST_CHARACTER_FILENAME),
  };
}

const SEEDED_CHARACTER = (name: string) => `---
title: ${name}
---

# ${name}

You are ${name}.

## Voice

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Your docs and memory files are yours. Read them before you answer a question
they cover, and write a memory file when you learn something worth keeping.
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

/**
 * Follow a rename into the persona file's frontmatter `title`, but only when
 * that title is the old name.
 *
 * `character.md` is the ghost's own words. A title that says something other
 * than the directory name is one of them — the owner wrote it, and a rename is
 * not a licence to rewrite it. A title that IS the old name is the seed's, and
 * leaving it behind would introduce the ghost by a name nothing else uses.
 * Only that one line is rewritten; every other byte of the file is preserved.
 */
function retitledCharacter(text: string, previous: string, next: string): string | null {
  const firstBreak = text.indexOf("\n");
  const firstLine = text.slice(0, firstBreak < 0 ? text.length : firstBreak);
  if (firstLine.trim() !== "---" || firstBreak < 0) return null;

  let start = firstBreak + 1;
  while (start <= text.length) {
    const nextBreak = text.indexOf("\n", start);
    const end = nextBreak < 0 ? text.length : nextBreak;
    const rawLine = text.slice(start, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const fence = line.trim();
    if (fence === "---" || fence === "...") return null;
    if (line.startsWith("title:")) {
      if (line.slice("title:".length).trim() !== previous) return null;
      const carriageReturn = rawLine.endsWith("\r") ? "\r" : "";
      return `${text.slice(0, start)}title: ${next}${carriageReturn}${text.slice(end)}`;
    }
    if (nextBreak < 0) return null;
    start = nextBreak + 1;
  }
  return null;
}

/**
 * Stage a complete replacement beside `character.md`, without changing the
 * live file. The staging path travels with the home rename, so publishing it
 * afterwards is another same-filesystem rename and cannot expose a partial
 * character file.
 */
function prepareCharacterRetitle(dir: string, previous: string, next: string): string | null {
  const file = ghostPaths(dir).characterFile;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // A ghost home with no readable persona is not a rename failure; the
    // directory moved, which is what the rename was.
    return null;
  }
  const replacement = retitledCharacter(text, previous, next);
  if (replacement === null) return null;

  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const mode = statSync(file).mode & 0o777;
  try {
    writeFileSync(temporary, replacement, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    // Creation mode is filtered through umask; the atomic replacement should
    // not quietly change the permissions of an owner-managed character file.
    chmodSync(temporary, mode);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${file} could not be prepared for rename and its temporary file could not be removed.`,
      );
    }
    throw error;
  }
  return temporary;
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
    for (const sub of ["docs", "memory", "conversations"]) {
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

  /**
   * Rename `<root>/<name>/` to `<root>/<nextName>/` — which renames the ghost,
   * because the directory name is the name. One same-filesystem rename carries
   * the persona, memory, docs, conversations, pins, and credentials across
   * together, and leaves every conversation id (a transcript filename inside
   * the home) valid.
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
    const preparedCharacter = prepareCharacterRetitle(ghost.dir, name, nextName);
    try {
      renameSync(ghost.dir, target);
    } catch (error) {
      if (preparedCharacter !== null) {
        try {
          rmSync(preparedCharacter, { force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Ghost ${JSON.stringify(name)} was not moved, but its staged character file could not be removed.`,
          );
        }
      }
      throw error;
    }
    if (preparedCharacter !== null) {
      const preparedName = basename(preparedCharacter);
      const movedTemporary = join(target, preparedName);
      try {
        renameSync(movedTemporary, ghostPaths(target).characterFile);
      } catch (error) {
        try {
          renameSync(target, ghost.dir);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Ghost ${JSON.stringify(name)} moved to ${JSON.stringify(nextName)}, `
              + "but its character title could not be published and the home move could not be rolled back.",
          );
        }
        try {
          rmSync(join(ghost.dir, preparedName), { force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Ghost ${JSON.stringify(name)} was moved back after its character title could not be published, `
              + "but the staged character file could not be removed.",
          );
        }
        throw error;
      }
    }
    return { name: nextName, dir: target, createdAt: createdAtOf(target) };
  }

  /**
   * Move `<root>/<name>/` into the freedesktop home trash and return where it
   * went — `<trash>/files/<name>`, with a `<trash>/info/<name>.trashinfo`
   * recording where it came from. A deleted ghost is therefore an ordinary
   * trashed directory: `gio trash --list`, `gio trash --restore`, and every
   * file manager's Trash see it and can put it back.
   *
   * Deleting a ghost is a rename, never a recursive removal: the ghost home
   * holds the only copy of a persona, its memory, and its docs, and no HTTP
   * route may be one bug away from erasing that. That also fixes the failure
   * mode when the trash is on another filesystem — a cross-device `rename`
   * raises `EXDEV`, and rather than degrade into copy-then-delete we fall back
   * to `<root>/.trash/<name>-<stamp>/`, still a move.
   */
  trash(name: string, now: Date = new Date()): { trash: string } {
    const ghost = this.get(name);
    const trashed = trashPath(ghost.dir, {
      now,
      fallbackRoot: join(this.root, GHOST_TRASH_DIRNAME),
    });
    return { trash: trashed.trash };
  }
}
